import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
interface ExtensionAPI {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: any): void;
}

interface ExtensionContext {
	cwd: string;
	sessionManager: {
		getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | undefined;
		getLeafId?: () => string | undefined;
	};
	ui: {
		notify(message: string, level: string): void;
		setStatus(key: string, value: string): void;
		theme: { fg(style: string, value: string): string };
	};
}

type PolicyName =
	| "blockGitAddAll"
	| "requireMergeSlotForPush"
	| "protectPaths"
	| "blockDestructiveCommand"
	| "blockBdCloseWithoutReview"
	| "blockEpicCloseWithIncompleteChildren"
	| "blockUnmergedBranchCompletion"
	| "validateReviewChain"
	| "enforceBeadEnrichment"
	| "enforceBeadRussianLocale"
	| "blockMutationsInPlanning"
	| "blockRawBdClaim"
	| "blockSupervisorClose"
	| "blockWorktreeInsideRepo"
	| "enforceActiveWorktreeCwd"
	| "blockMainMutation"
	| "staleWorktreeGuard"
	| "fastPathDiscipline"
	| "enforceActiveBeadLifecycle";

interface PolicyDecision {
	policy: PolicyName;
	block: boolean;
	reason: string;
}

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	sessionKey?: string;
	runtimeOwnerKey?: string;
	mergeSlotHeld?: boolean;
	planMode?: string;
	planApproved?: boolean | string;
	sessionMode?: string;
	bdStatus?: string;
}

interface BashPolicyOptions {
	cwd?: string;
	bdMergeSlotIssue?: BdMergeSlotIssue | null;
	currentActor?: string;
}

const PRIVATE_KEY_OR_CERT_PATTERN = /(^|[\/])[^\/]+\.(pem|key|p12|pfx|crt|cer)$/i;
const ENV_FILE_PATTERN = /(^|[\/])\.env(?:$|[.\/])/;
const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: ENV_FILE_PATTERN, reason: "env files may contain secrets" },
	{ pattern: /(^|[\/])\.ssh(?:$|[\/])|(^|[\/])id_(rsa|dsa|ecdsa|ed25519)(?:$|[.\/])/, reason: "SSH credentials are protected" },
	{ pattern: /(^|[\/])\.aws[\/]credentials(?:$|[\/])|(^|[\/])\.aws[\/]config(?:$|[\/])/, reason: "AWS credentials/config are protected" },
	{ pattern: /(^|[\/])\.config[\/]gcloud(?:$|[\/])|(^|[\/])\.azure(?:$|[\/])/, reason: "cloud credentials/config are protected" },
	{ pattern: /(^|[\/])\.kube[\/]config(?:$|[\/])/, reason: "Kubernetes config is protected" },
	{ pattern: /(^|[\/])terraform\.tfstate(?:\.backup)?$|\.tfstate(?:\.backup)?$/, reason: "Terraform state is protected" },
	{ pattern: PRIVATE_KEY_OR_CERT_PATTERN, reason: "private key/cert files are protected" },
];
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const WORKTREE_ROOT = path.join(os.homedir(), "Projects", "worktrees", "beads-task-issue-tracker");
const META_ONLY_PATTERN = /^(\.beads\/|\.pi\/plans\/|.*\.(md|json|jsonl)$)/;
const CODE_FILE_PATTERN = /^(app|src-tauri|tests|i18n|\.pi\/extensions|\.pi\/agents|\.pi\/skills|scripts)\/|\.(ts|tsx|vue|rs|js|mjs|cjs|css|scss|sh)$/;
const FAST_PATH_FILE_THRESHOLD = 3;
const FAST_PATH_ADDED_LINE_THRESHOLD = 80;
const TERMINAL_WORKFLOW_STATES = new Set(["closed", "blocked", "deferred", "merged"]);
const NON_TERMINAL_WORKFLOW_STATES = new Set(["claimed", "planning", "plan_approved", "implementing", "inreview", "reviewing", "accepted", "landing"]);
const TERMINAL_BD_STATUSES = new Set(["closed", "blocked", "deferred"]);
const NON_TERMINAL_BD_STATUSES = new Set(["open", "in_progress", "inreview", "simplified", "reviewed", "accepted"]);
const RISKY_FILE_PREFIXES = [
	".pi/extensions/beads-policy/",
	".pi/extensions/beads-dispatch/",
	".pi/extensions/review-workflow/",
	".pi/extensions/workflow-state/",
	".pi/skills/merge-to-main/",
	".pi/skills/release/",
	".pi/skills/dispatch-supervisor/",
	".pi/skills/review-bead/",
	".pi/agents/",
	"scripts/",
];

function getSkipPolicies(): Set<string> {
	return new Set(
		(process.env.PI_SKIP_POLICY ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

function isSkipped(policy: PolicyName): boolean {
	const skipped = getSkipPolicies();
	return skipped.has("all") || skipped.has(policy);
}

function applySkip(decision: PolicyDecision | undefined): PolicyDecision | undefined {
	if (!decision) return undefined;
	if (isSkipped(decision.policy)) return undefined;
	return decision;
}

function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function protectedPathReason(targetPath: string): string | undefined {
	const normalizedPath = targetPath.replace(/\\/g, "/");
	if (normalizedPath.includes(".git/")) return ".git internals are protected";
	if (normalizedPath.includes("node_modules/")) return "node_modules is protected from direct tool access";
	for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
		if (pattern.test(normalizedPath)) return reason;
	}
	return undefined;
}

function commandTouchesSensitivePath(command: string): string | undefined {
	const normalized = command.replace(/\\/g, "/");
	for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
		if (pattern.test(normalized)) return reason;
	}
	return undefined;
}

function commandHasRecursiveForceDelete(command: string): boolean {
	return /(^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f|-i?[^\s]*f[^\s]*r|--recursive\s+--force|--force\s+--recursive)\b/.test(command);
}

function commandHasHardReset(command: string): boolean {
	return /(^|[;&|]\s*)git\s+reset\s+(?:[^;&|]*\s)?--hard\b/.test(command);
}

function commandHasForcedClean(command: string): boolean {
	return /(^|[;&|]\s*)git\s+clean\b(?=[^;&|]*(?:\s-f|\s-[a-zA-Z]*f|--force\b))/.test(command);
}

function commandHasUnsafeForcePush(command: string): boolean {
	if (!/(^|[;&|]\s*)git\s+push\b/.test(command)) return false;
	const withoutLease = command.replace(/--force-with-lease(?:=\S+)?/g, "");
	return /(^|\s)(?:--force|-f)(?:\s|$)/.test(withoutLease);
}

function commandHasRemoteBranchDeletion(command: string): boolean {
	return /(^|[;&|]\s*)git\s+push\b[^;&|]*(?:--delete\b|\s:[^\s;&|]+)/.test(command);
}

function commandHasStashDeletion(command: string): boolean {
	return /(^|[;&|]\s*)git\s+stash\s+(?:drop|clear)\b/.test(command);
}

function commandHasCloudResourceDeletion(command: string): boolean {
	return /(^|[;&|]\s*)(?:kubectl\s+delete\b|terraform\s+destroy\b|aws\s+\S+\s+delete-\S+\b|gcloud\s+[^;&|]*\sdelete\b|az\s+[^;&|]*\sdelete\b)/.test(command);
}

function commandHasDestructiveSql(command: string): boolean {
	return /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i.test(command) || /\bTRUNCATE\s+TABLE\b/i.test(command) || /\bDELETE\s+FROM\b(?![^;&|]*\bWHERE\b)/i.test(command);
}

function destructiveCommandReason(command: string): string | undefined {
	const sensitivePathReason = commandTouchesSensitivePath(command);
	if (sensitivePathReason) return `Blocked: command references protected path (${sensitivePathReason}).`;
	if (commandHasRecursiveForceDelete(command)) return "Blocked: recursive force delete is not allowed from Pi bash.";
	if (commandHasHardReset(command)) return "Blocked: git reset --hard is destructive. Use an explicit documented override only if approved.";
	if (commandHasForcedClean(command)) return "Blocked: forced git clean can delete untracked work.";
	if (commandHasUnsafeForcePush(command)) return "Blocked: unsafe force push is not allowed; --force-with-lease is the safer explicit form.";
	if (commandHasRemoteBranchDeletion(command)) return "Blocked: remote branch deletion requires explicit confirmation outside the normal Pi bash flow.";
	if (commandHasStashDeletion(command)) return "Blocked: stash deletion can destroy recovery points.";
	if (commandHasCloudResourceDeletion(command)) return "Blocked: cloud/infrastructure resource deletion is destructive.";
	if (commandHasDestructiveSql(command)) return "Blocked: destructive SQL requires explicit human approval and a rollback plan.";
	return undefined;
}

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function runCommand(cwd: string, command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function commandSucceeds(cwd: string, command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { cwd, encoding: "utf8", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
	return value;
}

function normalizeFsPath(value: string, cwd = process.cwd()): string {
	const expanded = expandHome(stripQuotes(value));
	return path.resolve(cwd, expanded);
}

function realpathExistingOrParent(targetPath: string): string {
	let cursor = targetPath;
	while (!fs.existsSync(cursor)) {
		const next = path.dirname(cursor);
		if (next === cursor) return path.resolve(targetPath);
		cursor = next;
	}
	try {
		const real = fs.realpathSync(cursor);
		return path.join(real, path.relative(cursor, targetPath));
	} catch {
		return path.resolve(targetPath);
	}
}

function nearestExistingDirectory(targetPath: string): string {
	let cursor = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
	while (!fs.existsSync(cursor)) {
		const next = path.dirname(cursor);
		if (next === cursor) return path.dirname(targetPath);
		cursor = next;
	}
	return cursor;
}

function getBranchForPath(filePath: string): string | undefined {
	return runGit(nearestExistingDirectory(filePath), ["branch", "--show-current"]);
}

function getRepoRoot(cwd: string): string | undefined {
	return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function isProtectedBranch(cwd: string): boolean {
	const branch = runGit(cwd, ["branch", "--show-current"]);
	return branch ? PROTECTED_BRANCHES.has(branch) : false;
}

function inferCommandCwd(command: string, defaultCwd?: string): string {
	const base = defaultCwd ?? process.cwd();
	const match = command.match(/^\s*cd\s+([^;&|]+?)\s*&&/);
	const cdPath = match?.[1];
	if (!cdPath) return base;
	return normalizeFsPath(cdPath.trim(), base);
}


function isPathInsideOrEqual(targetPath: string, rootPath: string): boolean {
	const resolvedTarget = realpathExistingOrParent(targetPath);
	const resolvedRoot = realpathExistingOrParent(rootPath);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function isWorkflowStateNonTerminal(workflowState: WorkflowStateSnapshot): boolean {
	const bdStatus = workflowState.bdStatus;
	if (bdStatus) return !TERMINAL_BD_STATUSES.has(bdStatus);
	const state = workflowState.state ?? "idle";
	return NON_TERMINAL_WORKFLOW_STATES.has(state);
}

function hasWorktreeLockOwnershipEvidence(workflowState: WorkflowStateSnapshot): boolean {
	if (!workflowState.activeBead) return false;
	if (workflowState.runtimeOwnerKey && workflowState.runtimeOwnerKey === currentRuntimeOwnerKey()) return true;
	if (workflowState.sessionKey) return true;
	if (workflowState.planApproved === true || workflowState.planApproved === "true") return true;
	return false;
}

function hasActiveWorktreeLockRequirement(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(
		workflowState.activeBead &&
		isWorkflowStateNonTerminal(workflowState) &&
		hasWorktreeLockOwnershipEvidence(workflowState) &&
		(workflowState.worktreePath || workflowState.branch),
	);
}

function hasActiveWorktreeLock(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(workflowState.worktreePath && hasActiveWorktreeLockRequirement(workflowState));
}

function commandHasTestOrGateOperation(command: string): boolean {
	const shellWord = String.raw`(?:"[^"]+"|'[^']+'|\S+)`;
	const optionalPnpmPathOptions = String.raw`(?:(?:--dir|-C)(?:\s+|=)${shellWord}\s+)*`;
	const optionalNpxPathOptions = String.raw`(?:(?:--prefix)(?:\s+|=)${shellWord}\s+)*`;
	const gatePattern = new RegExp(
		String.raw`(^|[;&|]\s*)(?:pnpm\s+${optionalPnpmPathOptions}(?:test|exec\s+vitest|vitest|tauri:dev|build)|npm\s+(?:test|run\s+(?:test|build|typecheck))|npx\s+${optionalNpxPathOptions}vue-tsc\b|cargo\s+(?:check|test|build)|make\s+(?:test|check)|just\s+(?:test|check))\b`,
	);
	return gatePattern.test(command);
}

function commandRequiresActiveWorktreeCwd(command: string, processCwd: string): boolean {
	return commandHasMutatingBd(command) || commandHasMutatingGitOrFs(command) || commandHasTestOrGateOperation(command) || commandHasRepoContainedRedirection(command, processCwd);
}

function activeWorktreeCwdDecision(command: string, processCwd: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	if (!commandRequiresActiveWorktreeCwd(command, processCwd)) return undefined;
	const required = workflowState.worktreePath;
	if (!required) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK but no recorded worktree path. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before mutating work.`,
		};
	}
	if (!fs.existsSync(required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to missing worktree ${required}. Recreate the worktree, use workflow_reset for stale state, or explicitly confirm takeover before mutating work.`,
		};
	}
	const effectiveCwd = inferCommandCwd(command, processCwd);
	const gitCwdMatch = command.match(/(^|[;&|]\s*)git\s+-C\s+(\S+)/);
	const explicitGitCwd = gitCwdMatch?.[2] ? normalizeFsPath(gitCwdMatch[2], processCwd) : undefined;
	const outsideCwd = [processCwd, effectiveCwd, explicitGitCwd].filter(Boolean).find((cwd) => !isPathInsideOrEqual(String(cwd), required));
	if (outsideCwd) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK. Run mutating commands, tests, bd writes, and git operations with cwd ${required} or inside it; current/effective cwd is ${outsideCwd}. Read-only inspection from main is allowed.`,
		};
	}
	const expectedBranch = workflowState.branch;
	const actualBranch = getCurrentBranch(required);
	if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to branch ${expectedBranch}, but worktree ${required} is on ${actualBranch}. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before mutating work.`,
		};
	}
	return undefined;
}

function activeWorktreePathDecision(toolName: string, targetPath: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if ((toolName !== "edit" && toolName !== "write") || !hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	const required = workflowState.worktreePath;
	if (!required) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK but no recorded worktree path. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before edit/write.`,
		};
	}
	if (!fs.existsSync(required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to missing worktree ${required}. Recreate the worktree, use workflow_reset for stale state, or explicitly confirm takeover before edit/write.`,
		};
	}
	const resolvedTarget = normalizeFsPath(targetPath);
	if (!isPathInsideOrEqual(resolvedTarget, required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: edit/write for active bead ${workflowState.activeBead} must target ${required} or a path inside it; target is ${targetPath}.`,
		};
	}
	const expectedBranch = workflowState.branch;
	const actualBranch = getCurrentBranch(required);
	if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to branch ${expectedBranch}, but worktree ${required} is on ${actualBranch}. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before edit/write.`,
		};
	}
	return undefined;
}

function requiredToolCwdDecision(toolName: string, input: Record<string, unknown>, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	if (!["dispatch_supervisor", "dispatch_reviewer", "dispatch_docs_agent", "review_bead"].includes(toolName)) return undefined;
	const required = workflowState.worktreePath;
	if (!required) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK but no recorded worktree path. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before running ${toolName}.`,
		};
	}
	if (!fs.existsSync(required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to missing worktree ${required}. Recreate the worktree, use workflow_reset for stale state, or explicitly confirm takeover before running ${toolName}.`,
		};
	}
	const provided = String(input.cwd ?? input.worktreePath ?? "");
	if (!provided || !isPathInsideOrEqual(normalizeFsPath(provided), required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: ${toolName} for active bead ${workflowState.activeBead} must run with cwd/worktreePath ${required}.`,
		};
	}
	const expectedBranch = workflowState.branch;
	const actualBranch = getCurrentBranch(required);
	if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} is locked to branch ${expectedBranch}, but worktree ${required} is on ${actualBranch}. Use workflow_reset for stale state, recreate the worktree, or explicitly confirm takeover before running ${toolName}.`,
		};
	}
	return undefined;
}

function commandHasGitPush(command: string): boolean {
	return /(^|[;&|]\s*)git\s+push\b/.test(command);
}

function commandAcquiresMergeSlotBeforePush(command: string): boolean {
	const acquireIndex = command.search(/\bbd\s+merge-slot\s+acquire\b/);
	const pushIndex = command.search(/\bgit\s+push\b/);
	return acquireIndex >= 0 && pushIndex >= 0 && acquireIndex < pushIndex;
}

function commandHasMutatingBd(command: string): boolean {
	return /\bbd\s+(create|new|update|close|reopen|delete|comments\s+(add|delete|rm)|dep\s+(add|remove|rm)|merge-slot\s+(acquire|release)|dolt\s+(commit|push|pull))\b/.test(
		command,
	);
}

function commandHasMutatingGitOrFs(command: string): boolean {
	return /\b(git\s+(?:-C\s+\S+\s+)?(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(
		command,
	);
}

function commandHasMainLocalMutation(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(add|stage|commit)\b/.test(command);
}

function commandHasProtectedBranchFsMutation(command: string, cwd: string): boolean {
	return /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(command) || commandHasRepoContainedRedirection(command, cwd);
}

function commandHasRepoContainedRedirection(command: string, cwd: string): boolean {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return false;
	const resolvedRepoRoot = realpathExistingOrParent(repoRoot);
	return extractShellRedirectionTargets(command).some((target) => {
		const resolvedTarget = realpathExistingOrParent(normalizeFsPath(target, cwd));
		return resolvedTarget === resolvedRepoRoot || resolvedTarget.startsWith(`${resolvedRepoRoot}${path.sep}`);
	});
}

function extractShellRedirectionTargets(command: string): string[] {
	const targets: string[] = [];
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char !== '>') continue;
		if (command[index - 1] === '<') continue;

		let cursor = command[index + 1] === '>' ? index + 2 : index + 1;
		while (/\s/.test(command[cursor] ?? '')) cursor += 1;
		if (command[cursor] === '&') continue;

		const { token, end } = readShellToken(command, cursor);
		if (token) targets.push(stripQuotes(token));
		index = Math.max(index, end - 1);
	}
	return targets;
}

function readShellToken(command: string, start: number): { token: string; end: number } {
	let token = '';
	let quote: '"' | "'" | undefined;
	let index = start;
	for (; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (quote) {
			token += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			token += char;
			continue;
		}
		if (/\s/.test(char) || char === ';' || char === '&' || char === '|') break;
		token += char;
	}
	return { token, end: index };
}

function commandHasCommitLikeOperation(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(commit|rebase|merge|cherry-pick|revert)\b/.test(command);
}

const REQUIRED_HANDOFF_SECTIONS = [
	"### Origin",
	"### Files",
	"### Current state",
	"### Target state",
	"### Investigation findings",
	"### Decisions",
	"### Rejected alternatives",
	"### Dependencies / blockers",
	"### Acceptance criteria",
	"### Verification / acceptance checks",
	"### Out of scope",
];

const VAGUE_ACCEPTANCE_PATTERN = /\b(done|works|fixed|complete|completed|ok|looks good|as expected|готово|работает|исправлено|завершено|нормально)\b/i;

function hasCreateExemption(command: string): boolean {
	return /--type[=\s]epic\b/.test(command) || /\s-t\s+epic\b/.test(command) || /--ephemeral\b|--from-markdown\b|--from-graph\b|--file\b|--body-file\b|--design-file\b/.test(command) || /SKIP_ENRICH_CHECK=1/.test(command);
}

function hasLabel(command: string): boolean {
	return /(?:--label|--labels|-l)(?:=|\s+)\S+/.test(command);
}

function extractSection(command: string, heading: string): string {
	const index = command.indexOf(heading);
	if (index < 0) return "";
	const after = command.slice(index + heading.length);
	const next = after.search(/\s###\s+[A-ZА-Я]/);
	return (next >= 0 ? after.slice(0, next) : after).trim();
}

function hasBullet(section: string): boolean {
	return /(^|\s)([-*]|\d+\.)\s+\S+/.test(section);
}

function isVagueOnly(section: string): boolean {
	const compact = section
		.replace(/(^|\s)([-*]|\d+\.)\s+/g, " ")
		.replace(/[`*_"']/g, "")
		.trim();
	return compact.length > 0 && compact.length < 80 && VAGUE_ACCEPTANCE_PATTERN.test(compact);
}

const COMMON_ENGLISH_PROSE_WORDS = new Set([
	"add",
	"allows",
	"alternative",
	"and",
	"ask",
	"be",
	"bug",
	"check",
	"checks",
	"child",
	"command",
	"complete",
	"completed",
	"concrete",
	"create",
	"current",
	"details",
	"discovered",
	"done",
	"expected",
	"feature",
	"fix",
	"found",
	"from",
	"how",
	"issue",
	"manual",
	"needed",
	"observable",
	"out",
	"reason",
	"request",
	"result",
	"source",
	"state",
	"target",
	"task",
	"the",
	"this",
	"with",
	"work",
	"works",
	"why",
]);

const TECHNICAL_ENGLISH_TOKENS = new Set([
	"api",
	"bd",
	"bead",
	"beads",
	"blocks",
	"cli",
	"ci",
	"css",
	"deps",
	"dolt",
	"dx",
	"epic",
	"frontend",
	"backend",
	"json",
	"jsonl",
	"md",
	"nuxt",
	"pi",
	"rust",
	"tauri",
	"ts",
	"tsx",
	"ui",
	"url",
	"vue",
]);

function stripLocaleExemptText(text: string): string {
	let stripped = text;
	for (const heading of REQUIRED_HANDOFF_SECTIONS) {
		stripped = stripped.replace(new RegExp(escapeRegExp(heading), "gi"), " ");
	}
	return stripped
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\b[a-z0-9_.\/-]+\.(ts|tsx|vue|rs|js|json|jsonl|md|sh|css)\b/gi, " ")
		.replace(/\b(parent-child|discovered-from|blocks):[\w.-]+\b/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/--?[\w-]+(?:=\S+)?/g, " ");
}

function localeEvidence(text: string): { cyrillic: number; latinProse: number; commonEnglish: number } {
	const stripped = stripLocaleExemptText(text);
	const cyrillic = stripped.match(/[А-Яа-яЁё]/g)?.length ?? 0;
	const latinWords = stripped.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
	const proseWords = latinWords
		.map((word) => word.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
		.filter((word) => word.length >= 3)
		.filter((word) => !TECHNICAL_ENGLISH_TOKENS.has(word))
		.filter((word) => !/^[a-z]+\d+$/.test(word));
	const commonEnglish = proseWords.filter((word) => COMMON_ENGLISH_PROSE_WORDS.has(word)).length;
	return { cyrillic, latinProse: proseWords.length, commonEnglish };
}

function isClearlyEnglishBeadText(text: string, field: "title" | "description"): boolean {
	const evidence = localeEvidence(text);
	if (field === "title") return evidence.cyrillic === 0 && (evidence.commonEnglish >= 1 || evidence.latinProse >= 2);
	return evidence.cyrillic < 10 && (evidence.commonEnglish >= 3 || evidence.latinProse >= 8);
}

function valueAfterFlag(segment: string, flags: string[]): string | undefined {
	for (const flag of flags) {
		const escaped = escapeRegExp(flag);
		const quoted = segment.match(new RegExp(`${escaped}(?:=|\\s+)(["'])([\\s\\S]*?)\\1`));
		if (quoted?.[2]) return quoted[2];
		const unquoted = segment.match(new RegExp(`${escaped}=([^\\s;&|]+)|${escaped}\\s+([^\\s;&|]+)`));
		const value = unquoted?.[1] ?? unquoted?.[2];
		if (value) return value;
	}
	return undefined;
}

function parseBdCreateTitle(segment: string): string | undefined {
	const explicit = valueAfterFlag(segment, ["--title"]);
	if (explicit) return explicit;
	const tokens = shellTokens(segment);
	const createIndex = tokens.findIndex((token, index) => (token === "create" || token === "new") && tokens[index - 1] === "bd");
	if (createIndex < 0) return undefined;
	const valueFlags = new Set(["--priority", "-p", "--description", "-d", "--type", "-t", "--label", "--labels", "-l", "--deps", "--parent"]);
	for (let index = createIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (valueFlags.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("--") && token.includes("=")) continue;
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function getBeadLocaleError(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const isCreate = segmentHasBdCommand(segment, new Set(["create", "new"]));
		const isUpdate = segmentHasBdCommand(segment, new Set(["update"]));
		if (!isCreate && !isUpdate) continue;

		const title = isCreate ? parseBdCreateTitle(segment) : valueAfterFlag(segment, ["--title"]);
		if (title && isClearlyEnglishBeadText(title, "title")) {
			return "Blocked: bead title is clearly English. Write bead titles in Russian for Maxim; keep only technical identifiers in English.";
		}

		const description = valueAfterFlag(segment, ["--description", "-d"]);
		if (description && isClearlyEnglishBeadText(description, "description")) {
			return "Blocked: bead description is clearly English. Write bead descriptions in Russian for Maxim while preserving required section headings and technical identifiers.";
		}
	}
	return undefined;
}

function getBeadEnrichmentError(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		if (!segmentHasBdCommand(segment, new Set(["create", "new"]))) continue;
		if (hasCreateExemption(segment)) continue;

		const missing = REQUIRED_HANDOFF_SECTIONS.filter((section) => !segment.includes(section));
		if (missing.length > 0) {
			return `Blocked: agent-created beads require a self-contained handoff template. Missing: ${missing.join(", ")}. Ask the user or create a spike if context/acceptance is unclear.`;
		}

		if (!hasLabel(segment)) {
			return "Blocked: agent-created beads require at least one label via --label/--labels/-l so future sessions can route work.";
		}

		const acceptance = extractSection(segment, "### Acceptance criteria");
		const verification = extractSection(segment, "### Verification / acceptance checks");
		if (!hasBullet(acceptance) || !hasBullet(verification)) {
			return "Blocked: Acceptance criteria and Verification / acceptance checks must contain concrete bullet checks. If unclear, ask the user with 2-4 options before creating the bead.";
		}
		if (isVagueOnly(acceptance) || isVagueOnly(verification)) {
			return "Blocked: acceptance/verification is too vague. Ask a concrete question with 2-4 proposed acceptance options before creating the bead.";
		}
	}

	return undefined;
}

function segmentHasBdCommand(segment: string, commands: Set<string>): boolean {
	const tokens = shellTokens(segment);
	return tokens.some((token, index) => token === "bd" && commands.has(tokens[index + 1] ?? ""));
}

function shellTokens(input: string): string[] {
	return input.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(stripQuotes) ?? [];
}

function parseBdUpdateStatus(command: string): { id: string; status: string } | undefined {
	const valueFlags = new Set([
		"--priority",
		"-p",
		"--assignee",
		"-a",
		"--description",
		"-d",
		"--title",
		"--type",
		"-t",
		"--label",
		"--labels",
		"--add-label",
		"--remove-label",
		"--set-labels",
		"--deps",
		"--reason",
	]);
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		const updateIndex = tokens.findIndex((token, index) => token === "update" && tokens[index - 1] === "bd");
		if (updateIndex < 0) continue;
		let id: string | undefined;
		let status: string | undefined;
		for (let index = updateIndex + 1; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token === "--status" || token === "-s") {
				status = stripQuotes(tokens[index + 1] ?? "");
				index += 1;
				continue;
			}
			if (token.startsWith("--status=")) {
				status = stripQuotes(token.slice("--status=".length));
				continue;
			}
			if (token.startsWith("-s=")) {
				status = stripQuotes(token.slice("-s=".length));
				continue;
			}
			if (valueFlags.has(token)) {
				index += 1;
				continue;
			}
			if (token.startsWith("--") && token.includes("=")) continue;
			if (token.startsWith("-")) continue;
			id = id ?? token;
		}
		if (id && status) return { id, status };
	}
	return undefined;
}

function reviewCheckpointTransition(command: string): { id: string; status: string } | undefined {
	const parsed = parseBdUpdateStatus(command);
	return parsed && /^(simplified|reviewed|accepted)$/.test(parsed.status) ? parsed : undefined;
}

function normalizeStatusValue(value: string | undefined): string | undefined {
	return value ? stripQuotes(value).toLowerCase() : undefined;
}

function directClosedTransition(command: string): { id: string; status: string } | undefined {
	const parsed = parseBdUpdateStatus(command);
	if (!parsed || normalizeStatusValue(parsed.status) !== "closed") return undefined;
	return { ...parsed, status: "closed" };
}

function closeCommandId(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		const closeIndex = tokens.findIndex((token, index) => token === "close" && tokens[index - 1] === "bd");
		if (closeIndex >= 0) return tokens[closeIndex + 1];
	}
	return undefined;
}

function commandHasReviewCheckpointTransition(command: string): boolean {
	return Boolean(reviewCheckpointTransition(command));
}

function parseBdClaimId(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		const updateIndex = tokens.findIndex((token, index) => token === "update" && tokens[index - 1] === "bd");
		if (updateIndex < 0) continue;
		let id: string | undefined;
		let hasClaim = false;
		for (let index = updateIndex + 1; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token === "--claim") {
				hasClaim = true;
				continue;
			}
			if (token.startsWith("-")) continue;
			id = id ?? token;
		}
		if (id && hasClaim) return id;
	}
	return undefined;
}

function parseWorkflowCommandBead(command: string): string | undefined {
	return command.match(/\/(?:workflow-claim|workflow-set-bead)\s+(\S+)/)?.[1] ?? command.match(/\/workflow-update\b[^;&|]*\bbead=(\S+)/)?.[1];
}

function commandStartsDifferentBead(command: string): string | undefined {
	return parseBdClaimId(command) ?? parseWorkflowCommandBead(command);
}

function commandDispatchesBead(command: string): string | undefined {
	return command.match(/\bdispatch_supervisor\s*\(\s*beadId\s*=\s*([^\s,)]+)/)?.[1] ?? command.match(/\bdispatch_supervisor\b[^;&|]*\bbeadId=(\S+)/)?.[1];
}

function commandReviewsBead(command: string): string | undefined {
	return command.match(/\breview_bead\s*\(\s*beadId\s*=\s*([^\s,)]+)/)?.[1] ?? command.match(/\/review-bead\s+(\S+)/)?.[1];
}

export function activeBeadLifecycleReason(targetBead: string | undefined, action: string, workflowState: WorkflowStateSnapshot): string | undefined {
	const activeBead = workflowState.activeBead;
	const bdStatus = workflowState.bdStatus;
	const legacyState = workflowState.state ?? "idle";
	if (!activeBead) return undefined;
	if (targetBead && targetBead === activeBead) return undefined;

	if (bdStatus) {
		if (TERMINAL_BD_STATUSES.has(bdStatus)) return undefined;
		const label = NON_TERMINAL_BD_STATUSES.has(bdStatus) ? bdStatus : `unknown bd status ${bdStatus}`;
		if (bdStatus === "inreview") return `Blocked: active bead ${activeBead} is bd:${bdStatus}; after confirming current-session branch/worktree ownership, next valid action is review-bead / review_bead for ${activeBead}, not ${action}${targetBead ? ` on ${targetBead}` : ""}. If ownership is stale or foreign, agents can call workflow_reset; /workflow-reset is only an optional human UI shortcut.`;
		return `Blocked: active bead ${activeBead} is non-terminal (bd:${label}). Finish it to closed, block/defer it with an explicit reason, hand it off, or call workflow_reset if this is stale/foreign state before ${action}${targetBead ? ` on ${targetBead}` : ""}. /workflow-reset is an optional human UI shortcut.`;
	}

	if (TERMINAL_WORKFLOW_STATES.has(legacyState)) return undefined;
	if (!NON_TERMINAL_WORKFLOW_STATES.has(legacyState)) return undefined;
	if (legacyState === "inreview") return `Blocked: active bead ${activeBead} is inreview; after confirming current-session branch/worktree ownership, next valid action is review-bead / review_bead for ${activeBead}, not ${action}${targetBead ? ` on ${targetBead}` : ""}. If ownership is stale or foreign, agents can call workflow_reset; /workflow-reset is only an optional human UI shortcut.`;
	return `Blocked: active bead ${activeBead} is non-terminal (${legacyState}). Finish it to closed, block/defer it with an explicit reason, hand it off, or call workflow_reset if this is stale/foreign state before ${action}${targetBead ? ` on ${targetBead}` : ""}. /workflow-reset is an optional human UI shortcut.`;
}

function activeBeadLifecycleDecision(targetBead: string | undefined, action: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	const reason = activeBeadLifecycleReason(targetBead, action, workflowState);
	return reason ? { policy: "enforceActiveBeadLifecycle", block: true, reason } : undefined;
}

function commandDirectlySetsClosed(command: string): boolean {
	return Boolean(directClosedTransition(command));
}

function commandClosesBead(command: string): boolean {
	return Boolean(closeCommandId(command));
}

interface BdIssueSummary {
	id?: string;
	status?: string;
	issue_type?: string;
	title?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

interface BdMergeSlotIssue extends BdIssueSummary {
	metadata?: {
		holder?: unknown;
		waiters?: unknown;
		[key: string]: unknown;
	};
}

function parseBdJson(raw: string): any {
	const parsed = JSON.parse(raw);
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

function getBdIssue(cwd: string, id: string): BdIssueSummary | undefined {
	try {
		const raw = execFileSync("bd", ["show", id, "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return parseBdJson(raw);
	} catch {
		return undefined;
	}
}

function getCurrentActor(cwd: string, override?: string): string | undefined {
	const actor = override ?? process.env.BEADS_ACTOR ?? runGit(cwd, ["config", "user.name"]) ?? process.env.USER;
	return actor?.trim() || undefined;
}

function getBdMergeSlotIssue(cwd: string): BdMergeSlotIssue | undefined {
	return getBdIssue(cwd, "beads-task-issue-tracker-merge-slot") as BdMergeSlotIssue | undefined;
}

function currentActorHoldsBdMergeSlot(cwd: string, options: BashPolicyOptions): boolean {
	const actor = getCurrentActor(cwd, options.currentActor);
	if (!actor) return false;
	const issue = options.bdMergeSlotIssue === undefined ? getBdMergeSlotIssue(cwd) : options.bdMergeSlotIssue;
	if (!issue || issue.status !== "in_progress") return false;
	return typeof issue.metadata?.holder === "string" && issue.metadata.holder.trim() === actor;
}

function getEpicChildren(cwd: string, id: string): BdIssueSummary[] | undefined {
	try {
		const raw = execFileSync("bd", ["list", "--parent", id, "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return undefined;
	}
}

function getBdCommentsText(cwd: string, id: string): string {
	try {
		return execFileSync("bd", ["comments", id], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function validateReviewTransitionForCommand(command: string, cwd: string): string | undefined {
	const transition = reviewCheckpointTransition(command);
	if (!transition) return undefined;
	const issue = getBdIssue(cwd, transition.id);
	const from = issue?.status;
	const comments = getBdCommentsText(cwd, transition.id);
	if (transition.status === "simplified" && from !== "inreview") return `simplified requires source status inreview, got ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && from !== "simplified") return `reviewed requires source status simplified, got ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && !/CODE REVIEW:\s*APPROVED|VERDICT:\s*APPROVED/i.test(comments)) return "reviewed requires CODE REVIEW APPROVED evidence";
	if (transition.status === "accepted" && from !== "reviewed") return `accepted requires source status reviewed, got ${from ?? "unknown"}`;
	if (transition.status === "accepted" && !/ACCEPTANCE|Acceptance evidence|human acceptance/i.test(comments)) return "accepted requires acceptance evidence";
	return undefined;
}

function terminalCloseId(command: string): string | undefined {
	return directClosedTransition(command)?.id ?? closeCommandId(command);
}

function incompleteEpicChildren(cwd: string, id: string): BdIssueSummary[] | undefined {
	const issue = getBdIssue(cwd, id);
	if (issue?.issue_type !== "epic") return undefined;
	const children = getEpicChildren(cwd, id);
	if (!children) return [];
	const incomplete = children.filter((child) => child.id !== id && child.status !== "closed");
	return incomplete.length > 0 ? incomplete : undefined;
}

function formatIncompleteChildren(children: BdIssueSummary[]): string {
	if (children.length === 0) return "unable to read child list";
	return children
		.slice(0, 5)
		.map((child) => `${child.id ?? "unknown"}:${child.status ?? "unknown"}`)
		.join(", ");
}

function canCloseByReviewState(command: string, cwd: string, workflowState: WorkflowStateSnapshot): boolean {
	const id = terminalCloseId(command);
	if (!id) return false;
	const status = workflowState.activeBead === id && workflowState.bdStatus ? workflowState.bdStatus : getBdIssue(cwd, id)?.status;
	const comments = getBdCommentsText(cwd, id);
	return status === "accepted" || (status === "reviewed" && /NO_ACCEPTANCE_REQUIRED|no acceptance criteria/i.test(comments));
}

function descriptionAcceptanceChecks(description?: string): string[] {
	if (!description) return [];
	const sections = [extractSection(description, "### Acceptance criteria"), extractSection(description, "### Verification / acceptance checks")];
	return sections
		.flatMap((section) => section.split(/\r?\n/))
		.map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
		.filter((line) => line.length > 0 && !/^###\s+/.test(line));
}

function latestAcceptanceMatrix(commentsText: string): string | undefined {
	const index = commentsText.toUpperCase().lastIndexOf("ACCEPTANCE MATRIX:");
	if (index < 0) return undefined;
	return commentsText.slice(index).trim();
}

function hasValidHumanAcceptanceOverride(commentsText: string): boolean {
	const index = commentsText.toUpperCase().lastIndexOf("HUMAN ACCEPTANCE OVERRIDE");
	if (index < 0) return false;
	const override = commentsText.slice(index);
	return /(?:approver|approved[_ -]?by)\s*:\s*\S+/i.test(override) && /reason\s*:\s*\S+/i.test(override);
}

const ACCEPTANCE_MATRIX_COMMON_WORDS = new Set([
	"acceptance",
	"check",
	"checks",
	"criteria",
	"criterion",
	"evidence",
	"exit",
	"manual",
	"observed",
	"result",
	"should",
	"verification",
	"должен",
	"должна",
	"должно",
	"если",
	"критерий",
	"проверка",
	"результат",
]);

function acceptanceCoverageTokens(value: string): string[] {
	const normalized = value.toLowerCase().replace(/ё/g, "е");
	return Array.from(new Set(normalized.match(/[a-zа-я0-9]+/g) ?? [])).filter((token) => token.length >= 4 && !ACCEPTANCE_MATRIX_COMMON_WORDS.has(token));
}

function matrixCoversCheck(matrixText: string, check: string): boolean {
	const normalizedMatrix = matrixText.toLowerCase().replace(/ё/g, "е");
	const normalizedCheck = check.toLowerCase().replace(/ё/g, "е");
	const highSignalGroups = [
		/(?:runtime|smoke|reload|starts?\/reloads?|pi\s+starts?)/,
		/(?:settings\.json|stable\s+extensions|implemented\/stable)/,
		/(?:child\s+beads|children|дочерн)/,
	];
	for (const group of highSignalGroups) {
		if (group.test(normalizedCheck) && !group.test(normalizedMatrix)) return false;
	}
	const matrixTokens = new Set(acceptanceCoverageTokens(matrixText));
	const checkTokens = acceptanceCoverageTokens(check);
	if (checkTokens.length === 0) return true;
	const matches = checkTokens.filter((token) => matrixTokens.has(token)).length;
	return matches >= Math.min(2, checkTokens.length);
}

const ACCEPTANCE_BLOCKING_RESULTS = /^(?:FAIL|NOT\s+RUN|BLOCKED|SCOPE\s+GAP)\b/i;

function normalizeAcceptanceResultCell(value: string): string {
	return value
		.replace(/[`*_~]/g, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.trim();
}

function acceptanceMatrixStructuredResults(matrixText: string): string[] {
	const matrixWithoutOverride = matrixText.replace(/HUMAN ACCEPTANCE OVERRIDE[\s\S]*$/i, "");
	const results: string[] = [];
	for (const line of matrixWithoutOverride.split(/\r?\n/)) {
		const yamlLike = line.match(/^\s*(?:[-*]\s*)?(?:result|verdict|status)\s*:\s*(.+?)\s*$/i);
		if (yamlLike?.[1]) results.push(normalizeAcceptanceResultCell(yamlLike[1]));
	}
	const tableLines = matrixWithoutOverride.split(/\r?\n/).filter((line) => line.includes("|"));
	for (let index = 0; index < tableLines.length; index += 1) {
		const headerLine = tableLines[index];
		if (!headerLine) continue;
		const headerCells = headerLine.split("|").map((cell) => cell.trim().toLowerCase());
		const resultColumn = headerCells.findIndex((cell) => /^(?:result|verdict|status)$/.test(cell));
		if (resultColumn < 0) continue;
		let rowIndex = index + 1;
		const separatorLine = tableLines[rowIndex];
		if (separatorLine && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separatorLine)) rowIndex += 1;
		for (; rowIndex < tableLines.length; rowIndex += 1) {
			const rowLine = tableLines[rowIndex];
			if (!rowLine) break;
			const cells = rowLine.split("|").map((cell) => cell.trim());
			if (cells.length <= resultColumn) break;
			results.push(normalizeAcceptanceResultCell(cells[resultColumn] ?? ""));
		}
	}
	return results;
}

function acceptanceMatrixHasBlockingResult(matrixText: string): boolean {
	return acceptanceMatrixStructuredResults(matrixText).some((result) => ACCEPTANCE_BLOCKING_RESULTS.test(result));
}

function validateAcceptanceMatrixForClose(cwd: string, id: string): string | undefined {
	const issue = getBdIssue(cwd, id);
	const checks = descriptionAcceptanceChecks(issue?.description);
	if (checks.length === 0) return undefined;
	const comments = getBdCommentsText(cwd, id);
	if (hasValidHumanAcceptanceOverride(comments)) return undefined;
	const matrix = latestAcceptanceMatrix(comments);
	if (!matrix) return `Blocked: terminal close for ${id} requires ACCEPTANCE MATRIX in bd comments because the bead has acceptance criteria.`;
	if (acceptanceMatrixHasBlockingResult(matrix)) {
		return `Blocked: ACCEPTANCE MATRIX for ${id} contains FAIL/NOT RUN/BLOCKED/SCOPE GAP. Fix the criteria or add HUMAN ACCEPTANCE OVERRIDE with approver and reason.`;
	}
	if (!/result\s*:\s*PASS\b|\bPASS\b/i.test(matrix)) {
		return `Blocked: ACCEPTANCE MATRIX for ${id} must include PASS result evidence or a valid HUMAN ACCEPTANCE OVERRIDE.`;
	}
	const uncovered = checks.filter((check) => !matrixCoversCheck(matrix, check));
	const firstUncovered = uncovered[0];
	if (firstUncovered) {
		return `Blocked: ACCEPTANCE MATRIX for ${id} does not cover acceptance/verification item: ${firstUncovered.slice(0, 140)}.`;
	}
	return undefined;
}

function hasPrMergedException(command: string): boolean {
	return /PR_MERGED_EXCEPTION=\S+|NO_REMOTE_BRANCH_COMPLETION_REQUIRED|--pr-merged-exception\b|pr[-_ ]merged exception/i.test(command);
}

function getCurrentBranch(cwd: string): string | undefined {
	return runGit(cwd, ["branch", "--show-current"]);
}

function hasRemoteUpstream(cwd: string): boolean {
	const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	return Boolean(upstream && upstream !== "@{u}");
}

function branchHeadMergedIntoOriginMain(cwd: string): boolean | undefined {
	const originMain = runGit(cwd, ["rev-parse", "origin/main"]);
	if (!originMain) return undefined;
	return commandSucceeds(cwd, "git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
}

function githubPrMerged(cwd: string, branch: string): { merged: boolean; evidence?: string } | undefined {
	const raw = runCommand(cwd, "gh", ["pr", "view", branch, "--json", "state,mergedAt,url"]);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { state?: string; mergedAt?: string; url?: string };
		const merged = parsed.state === "MERGED" || Boolean(parsed.mergedAt);
		return { merged, evidence: parsed.url ?? `gh pr view ${branch}` };
	} catch {
		return undefined;
	}
}

function unmergedBranchCompletionReason(command: string, cwd: string): string | undefined {
	if (hasPrMergedException(command)) return undefined;
	if (!getRepoRoot(cwd)) return undefined;
	const branch = getCurrentBranch(cwd);
	if (!branch || PROTECTED_BRANCHES.has(branch)) return undefined;
	if (!hasRemoteUpstream(cwd)) return undefined;

	const ancestor = branchHeadMergedIntoOriginMain(cwd);
	if (ancestor === true) return undefined;
	const ghMerged = githubPrMerged(cwd, branch);
	if (ghMerged?.merged) return undefined;

	const originEvidence = ancestor === false ? "HEAD is not an ancestor of origin/main" : "origin/main unavailable";
	const prEvidence = ghMerged ? `PR ${ghMerged.evidence} is not merged` : `could not verify merged PR with gh pr view ${branch}`;
	return `Blocked: remote branch completion for ${branch} requires a merged PR or explicit documented exception (${originEvidence}; ${prEvidence}). Use merge-to-main first, or add PR_MERGED_EXCEPTION=<reason> / NO_REMOTE_BRANCH_COMPLETION_REQUIRED for local-only fast-path or spike work.`;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let quote: '"' | "'" | undefined;
	let start = 0;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (char !== ';' && two !== '&&' && two !== '||') continue;
		const segment = command.slice(start, index).trim();
		if (segment) segments.push(segment);
		index += two === '&&' || two === '||' ? 1 : 0;
		start = index + 1;
	}
	const finalSegment = command.slice(start).trim();
	if (finalSegment) segments.push(finalSegment);
	return segments;
}

function extractWorktreePathFromSegment(segment: string): string | undefined {
	const match = segment.match(/\b(?:bd\s+worktree\s+create|git\s+worktree\s+add)\s+(.+)$/);
	const args = match?.[1];
	if (!args) return undefined;
	const tokens = args.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (["--branch", "-b", "-B", "--orphan", "--reason"].includes(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function invalidWorktreePath(command: string, cwd?: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		if (!/\b(?:bd\s+worktree\s+create|git\s+worktree\s+add)\b/.test(segment)) continue;
		const rawPath = extractWorktreePathFromSegment(segment);
		if (!rawPath) continue;
		const unquoted = stripQuotes(rawPath);
		if (!unquoted.startsWith("/") && !unquoted.startsWith("~/") && !unquoted.startsWith("$HOME/")) return unquoted;
		if (unquoted.includes("..")) return unquoted;
		const resolved = realpathExistingOrParent(normalizeFsPath(unquoted, cwd));
		const allowedRoot = realpathExistingOrParent(WORKTREE_ROOT);
		if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) return unquoted;
	}
	return undefined;
}

function getStagedFiles(cwd: string): string[] {
	return (runGit(cwd, ["diff", "--cached", "--name-only"]) ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function isCodeFile(file: string): boolean {
	return CODE_FILE_PATTERN.test(file) && !META_ONLY_PATTERN.test(file);
}

function getChangedFiles(cwd: string): string[] {
	const tracked = (runGit(cwd, ["diff", "--name-only", "HEAD"]) ?? "").split("\n");
	const untracked = (runGit(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n");
	return [...new Set([...tracked, ...untracked].map((file) => file.trim()).filter(Boolean))];
}

function countFileLines(cwd: string, file: string): number {
	try {
		return fs.readFileSync(path.join(cwd, file), "utf8").split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

function getUntrackedFiles(cwd: string): Set<string> {
	return new Set((runGit(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").map((file) => file.trim()).filter(Boolean));
}

function getAddedLines(cwd: string, files: string[]): number {
	let total = 0;
	const untracked = getUntrackedFiles(cwd);
	for (const file of files) {
		if (untracked.has(file)) {
			total += countFileLines(cwd, file);
			continue;
		}
		const stat = runGit(cwd, ["diff", "--numstat", "HEAD", "--", file]);
		if (!stat) continue;
		const added = Number(stat.split(/\s+/)[0]);
		if (Number.isFinite(added)) total += added;
	}
	return total;
}

function hasActiveBead(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(workflowState.activeBead);
}

function isSupervisorPathActive(workflowState: WorkflowStateSnapshot, cwd?: string): boolean {
	if (!hasActiveBead(workflowState)) return false;
	if (workflowState.planApproved) return true;
	return Boolean(cwd && workflowState.activeBead && hasScopedApprovedPlanComment(cwd, workflowState.activeBead, currentRecoveryScope(cwd, workflowState.sessionKey)));
}

interface RecoveryScope {
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	sessionKey?: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactField(text: string, names: string[], value?: string): boolean {
	if (!value) return false;
	const escaped = escapeRegExp(value);
	return names.some((name) => new RegExp(`(^|\\n)\\s*${name}\\s*[:=]\\s*${escaped}(\\s|$)`, "im").test(text));
}

function readFieldValues(text: string, names: string[]): string[] {
	const namePattern = names.map(escapeRegExp).join("|");
	const values: string[] = [];
	const regex = new RegExp(`(^|\\n)\\s*(${namePattern})\\s*[:=]\\s*([^\\n]+)`, "gim");
	for (const match of text.matchAll(regex)) {
		const value = match[3]?.trim();
		if (value) values.push(value);
	}
	return values;
}

function latestFieldValue(text: string, names: string[]): string | undefined {
	return readFieldValues(text, names).at(-1);
}

function latestFieldMatches(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	return latestFieldValue(text, names) === current;
}

function latestFieldIsForeign(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	const latest = latestFieldValue(text, names);
	return Boolean(latest && latest !== current);
}

function hasForeignSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	const hasCurrentEvidence = latestFieldMatches(commentsText, branchNames, scope.branch) || latestFieldMatches(commentsText, worktreeNames, scope.worktreePath);
	if (hasCurrentEvidence) return false;
	return latestFieldIsForeign(commentsText, branchNames, scope.branch) || latestFieldIsForeign(commentsText, worktreeNames, scope.worktreePath);
}

export function hasSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	if (!scope.sessionKey) return false;
	return hasExactField(commentsText, ["PI_SESSION_KEY", "SESSION_KEY", "sessionKey", "session"], scope.sessionKey);
}

function currentRecoveryScope(cwd: string, sessionKey?: string): RecoveryScope {
	return {
		branch: getCurrentBranch(cwd),
		worktreePath: getRepoRoot(cwd),
		startCommit: runGit(cwd, ["rev-parse", "HEAD"]),
		sessionKey,
	};
}

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function currentSessionKey(ctx?: ExtensionContext): string | undefined {
	const manager = ctx?.sessionManager;
	const sessionId = manager?.getSessionId?.();
	if (sessionId) return `id:${sessionId}`;
	const sessionFile = manager?.getSessionFile?.();
	if (sessionFile) return `file:${sessionFile}`;
	const leafId = manager?.getLeafId?.();
	if (leafId) return `leaf:${leafId}`;
	return undefined;
}

function hasCurrentSessionOwnership(state: WorkflowStateSnapshot, ctx?: ExtensionContext): boolean {
	const key = currentSessionKey(ctx);
	return Boolean(key && state.sessionKey === key);
}

function commentEvidenceBlocks(text: string): string[] {
	return text
		.split(/\n\s*\n+/)
		.map((block) => block.trim())
		.filter(Boolean);
}

function hasScopedApprovedPlanComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	return commentEvidenceBlocks(comments).some((block) => /PLAN APPROVED/i.test(block) && hasSessionOwnershipEvidence(block, scope));
}

function hasScopeOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	if (hasForeignSessionOwnershipEvidence(commentsText, scope)) return false;
	const branchMatches = latestFieldMatches(commentsText, branchNames, scope.branch);
	const worktreeMatches = latestFieldMatches(commentsText, worktreeNames, scope.worktreePath);
	const startMatches = hasExactField(commentsText, ["START_COMMIT", "START-COMMIT", "Start-commit", "start"], scope.startCommit);
	return branchMatches && worktreeMatches && startMatches;
}

function hasScopedApprovedSupervisorWorkflowComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	const blocks = commentEvidenceBlocks(comments);
	const hasScopedApprovedPlan = blocks.some((block) => /PLAN APPROVED/i.test(block) && hasScopeOwnershipEvidence(block, scope));
	const hasAnyApprovedPlan = /PLAN APPROVED/i.test(comments);
	const hasSupervisorDispatch = blocks.some((block) => /DISPATCH(?: RESULT)?/i.test(block) && hasScopeOwnershipEvidence(block, scope));
	return hasSupervisorDispatch && (hasScopedApprovedPlan || hasAnyApprovedPlan);
}

function hasScopedApprovedWorkflowComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	return /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(comments) && hasSessionOwnershipEvidence(comments, scope);
}

function hasScopedPostCloseMergeFixComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	const blocks = commentEvidenceBlocks(comments);
	return blocks.some((block) => /POST[- ]CLOSE MERGE FIX/i.test(block) && hasScopeOwnershipEvidence(block, scope));
}

function recoverableApprovedPlanBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	if (!scope.sessionKey) return undefined;
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedApprovedPlanComment(cwd, issue.id, scope));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverableApprovedSupervisorWorkflowBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	for (const status of ["inreview", "reviewed", "accepted", "in_progress", "simplified"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedApprovedSupervisorWorkflowComment(cwd, issue.id, scope));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverablePostCloseMergeFixBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	for (const status of ["closed"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedPostCloseMergeFixComment(cwd, issue.id, scope));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverableApprovedWorkflowBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	if (!scope.sessionKey) return recoverableApprovedSupervisorWorkflowBead(cwd, scope);
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && (hasScopedApprovedWorkflowComment(cwd, issue.id, scope) || hasScopedApprovedSupervisorWorkflowComment(cwd, issue.id, scope)));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function hasFastPathRationale(command: string): boolean {
	return /FAST_PATH_RATIONALE=\S+|fast[-_ ]path rationale|--fast-path-rationale\b/i.test(command);
}

function hasMechanicalBatchMarker(command: string): boolean {
	return /MECHANICAL_BATCH=1|mechanical batch|--label(?:=|\s+)mechanical|--labels(?:=|\s+)mechanical/i.test(command);
}

function hasRiskyScope(files: string[]): boolean {
	return files.some((file) => RISKY_FILE_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function hasCrossDomainScope(files: string[]): boolean {
	const frontend = files.some((file) => file.startsWith("app/") || file.startsWith("i18n/"));
	const backend = files.some((file) => file.startsWith("src-tauri/"));
	return frontend && backend;
}

function evaluateFastPathDiscipline(command: string, cwd: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!getRepoRoot(cwd)) return undefined;
	const changedCodeFiles = getChangedFiles(cwd).filter(isCodeFile);
	if (changedCodeFiles.length === 0) return undefined;

	const addedLines = getAddedLines(cwd, changedCodeFiles);
	const thresholdExceeded = changedCodeFiles.length > FAST_PATH_FILE_THRESHOLD || addedLines > FAST_PATH_ADDED_LINE_THRESHOLD;
	const risky = hasRiskyScope(changedCodeFiles) || hasCrossDomainScope(changedCodeFiles);
	const supervisorPath = isSupervisorPathActive(workflowState, cwd);
	const activeBead = hasActiveBead(workflowState);
	const rationale = hasFastPathRationale(command) || hasMechanicalBatchMarker(command);

	if (risky && !supervisorPath) {
		if (!commandHasMutatingBd(command) && !commandHasMutatingGitOrFs(command)) return undefined;
		const scope = currentRecoveryScope(cwd, workflowState.sessionKey);
		const recoveredBead =
			recoverableApprovedPlanBead(cwd, scope) ??
			recoverableApprovedSupervisorWorkflowBead(cwd, scope) ??
			recoverablePostCloseMergeFixBead(cwd, scope);
		if (recoveredBead) return undefined;
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Blocked: risky scope requires an active bead with approved plan/supervisor path, a valid POST-CLOSE MERGE FIX marker (closed scope), or other scoped recoverable approval evidence. Changed code files: ${changedCodeFiles.slice(0, 5).join(", ")}.`,
		};
	}

	if (thresholdExceeded && !activeBead && commandHasCommitLikeOperation(command)) {
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Blocked: large code change without active bead (${changedCodeFiles.length} files, ${addedLines} added lines). Create/claim a self-contained bead with concrete acceptance or dispatch supervisor.`,
		};
	}

	if (thresholdExceeded && !supervisorPath && !rationale) {
		return {
			policy: "fastPathDiscipline",
			block: false,
			reason: `Fast Path threshold exceeded (${changedCodeFiles.length} code files, ${addedLines} added lines). Add explicit FAST_PATH_RATIONALE or use supervisor path; mechanical batches must stay narrow and be marked mechanical.`,
		};
	}

	return undefined;
}

function evaluateStaleGuard(command: string, cwd: string): PolicyDecision | undefined {
	if (!commandHasCommitLikeOperation(command)) return undefined;
	if (!getRepoRoot(cwd)) return undefined;
	if (isProtectedBranch(cwd)) return undefined;

	const staged = getStagedFiles(cwd);
	const stagedCode = staged.filter(isCodeFile);
	const originMain = runGit(cwd, ["rev-parse", "origin/main"]);
	if (!originMain) {
		if (stagedCode.length === 0) {
			return {
				policy: "staleWorktreeGuard",
				block: false,
				reason: "Warning: origin/main is unavailable; docs/beads-only commit-like operation is allowed, but run git fetch origin before code changes.",
			};
		}
		return {
			policy: "staleWorktreeGuard",
			block: true,
			reason: "Blocked: origin/main is unavailable for a code change; run git fetch origin before commit-like operations.",
		};
	}

	const mergeBase = runGit(cwd, ["merge-base", "HEAD", "origin/main"]);
	if (!mergeBase || mergeBase === originMain) return undefined;
	if (stagedCode.length === 0) return undefined;

	const mainDiff = new Set((runGit(cwd, ["diff", "--name-only", mergeBase, "origin/main"]) ?? "").split("\n").filter(Boolean));
	const intersect = stagedCode.filter((file) => mainDiff.has(file));
	if (intersect.length === 0) return undefined;
	return {
		policy: "staleWorktreeGuard",
		block: true,
		reason: `Blocked: branch is stale vs origin/main and staged code files intersect main changes: ${intersect.slice(0, 5).join(", ")}. Run git fetch origin && git rebase origin/main.`,
	};
}

function isSupervisorContext(): boolean {
	return /supervisor/i.test(process.env.PI_AGENT_ROLE ?? "") || /supervisor/i.test(process.env.PI_SUBAGENT_ROLE ?? "");
}

export function reconcileWorkflowStateWithBdStatus(state: WorkflowStateSnapshot, bdStatus?: string): WorkflowStateSnapshot {
	if (!bdStatus) return state;
	if (TERMINAL_BD_STATUSES.has(bdStatus)) {
		return {
			...state,
			activeBead: undefined,
			state: "idle",
			bdStatus,
			endCommit: undefined,
		};
	}
	const next = { ...state, bdStatus };
	if (bdStatus === "inreview" && state.state === "implementing") {
		next.state = "inreview";
		next.sessionMode = "inreview";
	}
	if (bdStatus === "inreview" && state.sessionMode === "implementing") next.sessionMode = "inreview";
	return next;
}

function workflowStateHasCurrentScopeEvidence(state: WorkflowStateSnapshot, scope: RecoveryScope): boolean {
	const hasForeignWorktree = Boolean(state.worktreePath && scope.worktreePath && state.worktreePath !== scope.worktreePath);
	const hasForeignBranch = Boolean(state.branch && scope.branch && state.branch !== scope.branch);
	if (hasForeignWorktree || hasForeignBranch) return false;

	return Boolean(
		(state.worktreePath && scope.worktreePath && state.worktreePath === scope.worktreePath) ||
			(state.branch && scope.branch && state.branch === scope.branch) ||
			(state.startCommit && scope.startCommit && state.startCommit === scope.startCommit),
	);
}

function workflowStateHasValidRecordedTaskScope(state: WorkflowStateSnapshot): boolean {
	if (!state.worktreePath || !state.branch || PROTECTED_BRANCHES.has(state.branch)) return false;
	if (!fs.existsSync(state.worktreePath)) return false;
	const repoRoot = getRepoRoot(state.worktreePath);
	return Boolean(repoRoot && isPathInsideOrEqual(repoRoot, state.worktreePath) && isPathInsideOrEqual(state.worktreePath, repoRoot) && getCurrentBranch(state.worktreePath) === state.branch);
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const runtimeOwnerKey = currentRuntimeOwnerKey();
	const workflowEntries = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state") as Array<{ data?: WorkflowStateSnapshot }>;
	const last = workflowEntries
		.filter((entry: { data?: unknown }) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === runtimeOwnerKey)
		.pop();
	const restoredLast = workflowEntries.at(-1);
	const state = last?.data ?? restoredLast?.data ?? {};
	const scope = currentRecoveryScope(ctx.cwd, currentSessionKey(ctx));
	if (state.activeBead && state.state && state.state !== "idle") {
		const stateScope = {
			branch: state.branch ?? scope.branch,
			worktreePath: state.worktreePath,
			startCommit: state.startCommit ?? scope.startCommit,
			sessionKey: state.sessionKey ?? scope.sessionKey,
		};
		const currentSessionState = hasCurrentSessionOwnership(state, ctx);
		const currentScopeState = workflowStateHasCurrentScopeEvidence(state, scope);
		const recordedTaskScopeState = workflowStateHasValidRecordedTaskScope(state);
		const missingWorktreeLock = currentSessionState && hasActiveWorktreeLockRequirement(state) && !state.worktreePath;
		const isCurrentSessionState = currentSessionState && (currentScopeState || recordedTaskScopeState || missingWorktreeLock);
		if (!isCurrentSessionState) {
			return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
		}
		const commentsText = getBdCommentsText(ctx.cwd, state.activeBead);
		const ownershipScope = recordedTaskScopeState && !currentScopeState ? scope : stateScope;
		if (hasForeignSessionOwnershipEvidence(commentsText, ownershipScope)) {
			return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
		}
		return reconcileWorkflowStateWithBdStatus(state, getBdIssue(ctx.cwd, state.activeBead)?.status);
	}
	const recoveredBead = recoverableApprovedWorkflowBead(ctx.cwd, scope);
	if (!recoveredBead) return { ...state, branch: scope.branch };
	const issue = getBdIssue(ctx.cwd, recoveredBead);
	return {
		...state,
		activeBead: recoveredBead,
		state: state.state ?? "idle",
		bdStatus: issue?.status,
		branch: scope.branch,
		worktreePath: scope.worktreePath,
		startCommit: scope.startCommit,
	};
}

export function evaluateBashPolicy(
	commandInput: string,
	workflowState: WorkflowStateSnapshot = {},
	options: BashPolicyOptions = {},
): PolicyDecision | undefined {
	const command = normalizeCommand(commandInput);
	const commandCwd = inferCommandCwd(command, options.cwd);

	const nextBead = commandStartsDifferentBead(command);
	const dispatchBead = commandDispatchesBead(command);
	const reviewBead = commandReviewsBead(command);
	const lifecycleDecision = nextBead
		? activeBeadLifecycleDecision(nextBead, "start/claim another bead", workflowState)
		: dispatchBead
			? activeBeadLifecycleDecision(dispatchBead, "dispatch supervisor", workflowState)
			: reviewBead
				? activeBeadLifecycleDecision(reviewBead, "review", workflowState)
				: undefined;
	if (lifecycleDecision) return lifecycleDecision;

	const rawClaimId = parseBdClaimId(command);
	if (rawClaimId && !parseWorkflowCommandBead(command)) {
		return {
			policy: "blockRawBdClaim",
			block: true,
			reason: `Blocked: use the workflow_claim typed tool (or optional human UI shortcut /workflow-claim ${rawClaimId}) instead of raw bd update --claim so Pi footer/workflow-state stays synchronized.`,
		};
	}

	if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(command)) {
		return {
			policy: "blockGitAddAll",
			block: true,
			reason: "Blocked: use explicit file paths instead of git add . / -A / --all.",
		};
	}

	const destructiveReason = destructiveCommandReason(command);
	if (destructiveReason) {
		return {
			policy: "blockDestructiveCommand",
			block: true,
			reason: destructiveReason,
		};
	}

	const isPlanning = workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (commandHasMutatingBd(command) || commandHasMutatingGitOrFs(command))) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; only read-only commands are allowed.",
		};
	}

	const worktreeCwdDecision = activeWorktreeCwdDecision(command, options.cwd ?? process.cwd(), workflowState);
	if (worktreeCwdDecision) return worktreeCwdDecision;

	if ((commandHasMainLocalMutation(command) || commandHasProtectedBranchFsMutation(command, commandCwd)) && isProtectedBranch(commandCwd)) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: "Blocked: file mutations and git add/stage/commit on main/master are not allowed. Use a feature branch or approved merge/release workflow.",
		};
	}

	const invalidWorktree = invalidWorktreePath(command, commandCwd);
	if (invalidWorktree) {
		return {
			policy: "blockWorktreeInsideRepo",
			block: true,
			reason: `Blocked: worktree path must be under ${WORKTREE_ROOT}; got ${invalidWorktree}.`,
		};
	}

	const staleDecision = evaluateStaleGuard(command, commandCwd);
	if (staleDecision) return staleDecision;

	if (
		commandHasGitPush(command) &&
		!workflowState.mergeSlotHeld &&
		!commandAcquiresMergeSlotBeforePush(command) &&
		!currentActorHoldsBdMergeSlot(commandCwd, options)
	) {
		return {
			policy: "requireMergeSlotForPush",
			block: true,
			reason: "Blocked: git push requires bd merge-slot acquire first (or workflow state mergeSlotHeld=true or current bd merge-slot holder evidence).",
		};
	}

	const fastPathDecision = evaluateFastPathDiscipline(command, commandCwd, workflowState);
	if (fastPathDecision) return fastPathDecision;

	const beadLocaleError = getBeadLocaleError(command);
	if (beadLocaleError) {
		return {
			policy: "enforceBeadRussianLocale",
			block: true,
			reason: beadLocaleError,
		};
	}

	const beadEnrichmentError = getBeadEnrichmentError(command);
	if (beadEnrichmentError) {
		return {
			policy: "enforceBeadEnrichment",
			block: true,
			reason: beadEnrichmentError,
		};
	}

	if (isSupervisorContext() && (commandClosesBead(command) || commandDirectlySetsClosed(command) || commandHasReviewCheckpointTransition(command) || commandHasGitPush(command))) {
		return {
			policy: "blockSupervisorClose",
			block: true,
			reason: "Blocked: supervisor contexts cannot close beads, set orchestrator statuses, or push.",
		};
	}

	const closeId = terminalCloseId(command);
	const incompleteChildren = closeId ? incompleteEpicChildren(commandCwd, closeId) : undefined;
	if (incompleteChildren) {
		return {
			policy: "blockEpicCloseWithIncompleteChildren",
			block: true,
			reason: `Blocked: epic ${closeId} cannot be completed while child beads are not closed (${formatIncompleteChildren(incompleteChildren)}). Close children first or use an explicit documented policy override.`,
		};
	}

	// Per-task bead closure is allowed before merge-to-main in multi-task sessions.
	// Session-final merge evidence is enforced by merge-to-main/final verdict workflows,
	// not by blocking every accepted bead close on a feature branch.
	if (commandClosesBead(command) || commandDirectlySetsClosed(command)) {
		const matrixError = closeId ? validateAcceptanceMatrixForClose(commandCwd, closeId) : undefined;
		if (matrixError) {
			return {
				policy: "blockBdCloseWithoutReview",
				block: true,
				reason: matrixError,
			};
		}
		if (!canCloseByReviewState(command, commandCwd, workflowState)) {
			return {
				policy: "blockBdCloseWithoutReview",
				block: true,
				reason: "Blocked: terminal close requires bd status accepted, or bd status reviewed with documented no-acceptance shortcut, or an explicit policy override.",
			};
		}
	}

	const invalidReviewTransition = validateReviewTransitionForCommand(command, commandCwd);
	if (commandHasReviewCheckpointTransition(command) && invalidReviewTransition) {
		return {
			policy: "validateReviewChain",
			block: true,
			reason: invalidReviewTransition,
		};
	}

	return undefined;
}

export function evaluateToolPolicy(toolName: string, input: Record<string, unknown>, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const worktreeDecision = requiredToolCwdDecision(toolName, input, workflowState);
	if (worktreeDecision) return worktreeDecision;
	if (toolName === "dispatch_supervisor") return activeBeadLifecycleDecision(String(input.beadId ?? ""), "dispatch supervisor", workflowState);
	if (toolName === "review_bead") return activeBeadLifecycleDecision(String(input.beadId ?? ""), "review", workflowState);
	if (toolName === "workflow_complete" && workflowState.activeBead && workflowState.bdStatus === "inreview") {
		const targetState = String(input.state ?? "");
		if (targetState !== "blocked" && targetState !== "deferred") {
			return {
				policy: "enforceActiveBeadLifecycle",
				block: true,
				reason: `Blocked: active bead ${workflowState.activeBead} is bd:inreview; workflow_complete ${targetState || "without blocker"} would stop before review. Run review-bead / review_bead for ${workflowState.activeBead}, or use workflow_complete state=blocked|deferred with an explicit blocker and next action if review cannot run.`,
			};
		}
	}
	return undefined;
}

export function evaluatePathPolicy(toolName: string, targetPath: string, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const pathReason = protectedPathReason(targetPath);
	if (pathReason) {
		return {
			policy: "protectPaths",
			block: true,
			reason: `Blocked: ${targetPath} is protected (${pathReason}).`,
		};
	}

	const worktreeDecision = activeWorktreePathDecision(toolName, targetPath, workflowState);
	if (worktreeDecision) return worktreeDecision;

	const isPlanning = workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (toolName === "edit" || toolName === "write")) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; edit/write are disabled.",
		};
	}

	if ((toolName === "edit" || toolName === "write") && PROTECTED_BRANCHES.has(getBranchForPath(targetPath) ?? "")) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: `Blocked: edit/write on main/master is not allowed for ${targetPath}. Use a feature branch or external worktree.`,
		};
	}

	return undefined;
}

function toToolBlock(decision: PolicyDecision): { block: true; reason: string } {
	return { block: true, reason: `[${decision.policy}] ${decision.reason}` };
}

export default function beadsPolicyExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		const workflowState = latestWorkflowState(ctx);

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const decision = applySkip(evaluateBashPolicy(command, workflowState, { cwd: ctx.cwd }));
			if (decision?.block) return toToolBlock(decision);
			if (decision) ctx.ui.notify(`[${decision.policy}] ${decision.reason}`, "warning");
			return undefined;
		}

		const toolDecision = applySkip(evaluateToolPolicy(event.toolName, event.input as Record<string, unknown>, workflowState));
		if (toolDecision?.block) return toToolBlock(toolDecision);

		if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
			const targetPath = String(event.input.path ?? "");
			const decision = applySkip(evaluatePathPolicy(event.toolName, targetPath, workflowState));
			if (decision?.block) return toToolBlock(decision);
		}

		return undefined;
	});

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		ctx.ui.setStatus("beads-policy", ctx.ui.theme.fg("dim", "policy:on"));
	});

	pi.registerCommand("policy-status", {
		description: "Show active Pi beads policy engine status and overrides",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skipped = [...getSkipPolicies()].join(", ") || "none";
			ctx.ui.notify(`Beads policy engine active. Overrides: ${skipped}`, "info");
		},
	});
}
