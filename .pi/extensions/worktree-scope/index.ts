import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const TERMINAL_BD_STATUSES = new Set(["closed", "blocked", "deferred"]);
const NON_TERMINAL_WORKFLOW_STATES = new Set(["claimed", "planning", "plan_approved", "implementing", "inreview", "reviewing", "accepted", "landing"]);

export interface TaskScopeWorkflowState {
	activeBead?: string;
	state?: string;
	bdStatus?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	sessionKey?: string;
	runtimeOwnerKey?: string;
	planApproved?: boolean | string;
}

export type TaskScopeOwnership = "runtime" | "session" | "approved-plan";

export interface TaskScope {
	activeBead?: string;
	branch: string;
	worktreePath: string;
	startCommit?: string;
	endCommit?: string;
	ownership?: TaskScopeOwnership;
}

export interface TaskScopeError {
	code:
		| "NO_ACTIVE_SCOPE"
		| "TERMINAL_STATUS"
		| "MISSING_OWNERSHIP"
		| "MISSING_WORKTREE"
		| "MISSING_BRANCH"
		| "WORKTREE_NOT_FOUND"
		| "INVALID_WORKTREE"
		| "PROTECTED_BRANCH"
		| "BRANCH_MISMATCH"
		| "OUTSIDE_SCOPE";
	message: string;
}

export type TaskScopeResult = { ok: true; scope: TaskScope } | { ok: false; error: TaskScopeError };

export interface TaskScopePathValidationOptions {
	expectedBranch?: string;
	currentRuntimeOwnerKey?: string;
	getRepoRoot?: (cwd: string) => string | undefined;
	getBranch?: (cwd: string) => string | undefined;
	exists?: (cwd: string) => boolean;
}

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function stripQuotes(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
	return value;
}

export function canonicalizeTaskScopePath(value: string, base = process.cwd()): string {
	return path.resolve(base, expandHome(stripQuotes(value)));
}

function nearestExistingPath(targetPath: string): string {
	let cursor = targetPath;
	while (!fs.existsSync(cursor)) {
		const next = path.dirname(cursor);
		if (next === cursor) break;
		cursor = next;
	}
	return cursor;
}

export function realpathExistingOrParent(targetPath: string): string {
	const existing = nearestExistingPath(targetPath);
	try {
		const realExisting = fs.realpathSync(existing);
		return existing === targetPath ? realExisting : path.join(realExisting, path.relative(existing, targetPath));
	} catch {
		return targetPath;
	}
}

export function isPathInsideOrEqual(targetPath: string, rootPath: string): boolean {
	const resolvedTarget = realpathExistingOrParent(targetPath);
	const resolvedRoot = realpathExistingOrParent(rootPath);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export function validateTaskScopePath(worktreePath: string | undefined, options: TaskScopePathValidationOptions = {}): TaskScopeResult {
	if (!worktreePath) {
		return { ok: false, error: { code: "MISSING_WORKTREE", message: "recorded task worktree path отсутствует" } };
	}
	const canonicalWorktree = canonicalizeTaskScopePath(worktreePath);
	const exists = options.exists ?? fs.existsSync;
	if (!exists(canonicalWorktree)) {
		return { ok: false, error: { code: "WORKTREE_NOT_FOUND", message: `task worktree отсутствует: ${canonicalWorktree}` } };
	}
	const getRepoRoot = options.getRepoRoot ?? ((cwd: string) => runGit(cwd, ["rev-parse", "--show-toplevel"]));
	const repoRoot = getRepoRoot(canonicalWorktree);
	if (!repoRoot || !isPathInsideOrEqual(canonicalWorktree, repoRoot) || !isPathInsideOrEqual(repoRoot, canonicalWorktree)) {
		return { ok: false, error: { code: "INVALID_WORKTREE", message: `task worktree не является repo root: ${canonicalWorktree}` } };
	}
	const getBranch = options.getBranch ?? ((cwd: string) => runGit(cwd, ["branch", "--show-current"]));
	const actualBranch = getBranch(canonicalWorktree);
	const branch = options.expectedBranch ?? actualBranch;
	if (!branch) return { ok: false, error: { code: "MISSING_BRANCH", message: `branch для task worktree не определён: ${canonicalWorktree}` } };
	if (PROTECTED_BRANCHES.has(branch)) return { ok: false, error: { code: "PROTECTED_BRANCH", message: `task worktree не должен указывать на protected branch ${branch}` } };
	if (options.expectedBranch && actualBranch && actualBranch !== options.expectedBranch) {
		return { ok: false, error: { code: "BRANCH_MISMATCH", message: `task worktree ${canonicalWorktree} находится на ${actualBranch}, expected ${options.expectedBranch}` } };
	}
	return { ok: true, scope: { branch, worktreePath: canonicalWorktree } };
}

function isTerminalScopeState(workflowState: TaskScopeWorkflowState): boolean {
	if (workflowState.bdStatus) return TERMINAL_BD_STATUSES.has(workflowState.bdStatus);
	const state = workflowState.state;
	return Boolean(state && !NON_TERMINAL_WORKFLOW_STATES.has(state));
}

function taskScopeOwnership(workflowState: TaskScopeWorkflowState, currentRuntimeOwnerKey?: string): TaskScopeOwnership | undefined {
	if (workflowState.runtimeOwnerKey && currentRuntimeOwnerKey && workflowState.runtimeOwnerKey === currentRuntimeOwnerKey) return "runtime";
	if (workflowState.sessionKey) return "session";
	if (workflowState.planApproved === true || workflowState.planApproved === "true") return "approved-plan";
	return undefined;
}

export function resolveActiveTaskScope(workflowState: TaskScopeWorkflowState | undefined, options: TaskScopePathValidationOptions = {}): TaskScopeResult {
	if (!workflowState?.activeBead) {
		return { ok: false, error: { code: "NO_ACTIVE_SCOPE", message: "active task bead отсутствует" } };
	}
	if (isTerminalScopeState(workflowState)) {
		return { ok: false, error: { code: "TERMINAL_STATUS", message: `active task bead ${workflowState.activeBead} уже terminal: ${workflowState.bdStatus ?? workflowState.state}` } };
	}
	const ownership = taskScopeOwnership(workflowState, options.currentRuntimeOwnerKey);
	if (!ownership) {
		return { ok: false, error: { code: "MISSING_OWNERSHIP", message: `active task bead ${workflowState.activeBead} не имеет session/runtime/approved-plan ownership evidence` } };
	}
	const validated = validateTaskScopePath(workflowState.worktreePath, { ...options, expectedBranch: workflowState.branch });
	if (!validated.ok) return validated;
	return {
		ok: true,
		scope: {
			activeBead: workflowState.activeBead,
			branch: validated.scope.branch,
			worktreePath: validated.scope.worktreePath,
			startCommit: workflowState.startCommit,
			endCommit: workflowState.endCommit,
			ownership,
		},
	};
}

export function taskScopeErrorToPolicyReason(error: TaskScopeError, beadId?: string, action = "workflow operation"): string {
	const bead = beadId ? `active bead ${beadId}` : "active bead";
	switch (error.code) {
		case "MISSING_WORKTREE":
			return `Заблокировано: ${bead} имеет WORKTREE_LOCK, но recorded worktree path отсутствует. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover перед ${action}.`;
		case "WORKTREE_NOT_FOUND":
			return `Заблокировано: ${bead} привязан к отсутствующему worktree. ${error.message}. Пересоздай worktree, используй workflow_reset для stale state или явно подтверди takeover перед ${action}.`;
		case "BRANCH_MISMATCH":
			return `Заблокировано: ${bead} имеет WORKTREE_LOCK branch mismatch для ${action}: expected branch ${error.message.includes("expected ") ? error.message.split("expected ").at(-1) : "unknown"}, ${error.message}. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover.`;
		case "PROTECTED_BRANCH":
		case "INVALID_WORKTREE":
		case "MISSING_BRANCH":
		case "TERMINAL_STATUS":
		case "MISSING_OWNERSHIP":
			return `Заблокировано: ${bead} имеет невалидный task worktree scope для ${action}. ${error.message}. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover.`;
		case "OUTSIDE_SCOPE":
			return `Заблокировано: ${action} должен target task worktree ${bead}. ${error.message}.`;
		default:
			return `Заблокировано: не найден structured task worktree scope для ${action}. ${error.message}.`;
	}
}

export function requireTaskToolTarget(toolName: string, input: Record<string, unknown>, workflowState: TaskScopeWorkflowState | undefined): TaskScopeResult {
	const resolved = resolveActiveTaskScope(workflowState);
	if (!resolved.ok) return resolved;
	const provided = input.cwd ?? input.worktreePath;
	if (provided !== undefined && provided !== null && String(provided).trim() !== "") {
		const target = canonicalizeTaskScopePath(String(provided));
		if (!isPathInsideOrEqual(target, resolved.scope.worktreePath)) {
			return { ok: false, error: { code: "OUTSIDE_SCOPE", message: `${toolName} target=${target}, required=${resolved.scope.worktreePath}` } };
		}
	}
	return resolved;
}

export function latestWorkflowStateEntry(entries: Array<{ type: string; customType?: string; data?: unknown }> | undefined): TaskScopeWorkflowState | undefined {
	return entries?.filter((entry) => entry.type === "custom" && entry.customType === "workflow-state").map((entry) => entry.data as TaskScopeWorkflowState).filter(Boolean).at(-1);
}

export function taskScopeFromContext(ctx: { sessionManager?: { getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }> } } | undefined): TaskScopeWorkflowState | undefined {
	return latestWorkflowStateEntry(ctx?.sessionManager?.getEntries?.());
}

export default function worktreeScopeExtension(_pi: unknown): void {
	// Shared helper entrypoint: Pi requires default factories for .pi/extensions/*/index.ts.
}
