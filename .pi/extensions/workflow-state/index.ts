import { parseWorkflowIntent, shouldAutoClaim } from "../workflow-intent/index";
import { validateTaskScopePath } from "../worktree-scope/index";

interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	appendEntry(type: string, data: unknown): void;
	events: { on(name: string, handler: (event: WorkflowStateUpdateEvent) => void | Promise<void>): void };
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
	registerTool?(tool: any): void;
}

interface ExtensionContext {
	cwd?: string;
	sessionManager: {
		getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | undefined;
		getLeafId?: () => string | undefined;
	};
	ui: {
		notify(message: string, level?: string): void;
		setStatus(key: string, value: string | undefined): void;
		theme: { fg(style: string, value: string): string };
	};
}

const WORKFLOW_STATES = [
	"idle",
	"claimed",
	"planning",
	"plan_approved",
	"implementing",
	"inreview",
	"reviewing",
	"accepted",
	"closed",
	"landing",
	"merged",
	"blocked",
	"deferred",
] as const;

type WorkflowStateName = (typeof WORKFLOW_STATES)[number];
type PlanMode = "off" | "strict" | "auto";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

interface WorkflowState {
	activeBead?: string;
	state: WorkflowStateName;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	sessionKey?: string;
	runtimeOwnerKey?: string;
	planMode: PlanMode;
	mergeSlotHeld: boolean;
	planApproved?: boolean | string;
	sessionMode?: string;
	bdStatus?: string;
	updatedAt: string;
}

interface WorkflowStateUpdateEvent {
	state?: WorkflowStateName;
	stateIfCurrent?: WorkflowStateName[];
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	sessionKey?: string;
	planMode?: PlanMode;
	mergeSlotHeld?: boolean;
	planApproved?: boolean | string;
	sessionMode?: string;
	ctx?: ExtensionContext;
}

export interface WorkflowClaimResult {
	ok: boolean;
	state?: unknown;
	error?: string;
}

interface WorkflowClaimApi<Ctx = unknown> {
	claimWorkflowBead(beadId: string, ctx: Ctx): Promise<WorkflowClaimResult>;
}

const WORKFLOW_CLAIM_API_KEY = "__piWorkflowClaimApi";

interface WorkflowClaimApiRegistryState {
	byPi: WeakMap<object, WorkflowClaimApi>;
	latest?: WorkflowClaimApi;
}

type WorkflowClaimApiRegistry = WorkflowClaimApiRegistryState;

function workflowClaimApiRegistry(): WorkflowClaimApiRegistry {
	const root = globalThis as typeof globalThis & { [WORKFLOW_CLAIM_API_KEY]?: WorkflowClaimApiRegistry };
	root[WORKFLOW_CLAIM_API_KEY] ??= { byPi: new WeakMap<object, WorkflowClaimApi>() };
	return root[WORKFLOW_CLAIM_API_KEY];
}

export function registerWorkflowClaimApi<Ctx = unknown>(pi: object, api: WorkflowClaimApi<Ctx>): void {
	const registry = workflowClaimApiRegistry();
	const typedApi = api as WorkflowClaimApi;
	registry.byPi.set(pi, typedApi);
	registry.latest = typedApi;
}

export async function requestWorkflowClaim<Ctx = unknown>(pi: object, beadId: string, ctx: Ctx): Promise<WorkflowClaimResult> {
	const registry = workflowClaimApiRegistry();
	const api = registry.byPi.get(pi) ?? registry.latest;
	if (!api) {
		return { ok: false, error: "workflow-state claim API is unavailable; cannot claim without lifecycle guard" };
	}
	return api.claimWorkflowBead(beadId, ctx);
}

const DEFAULT_STATE: WorkflowState = {
	state: "idle",
	planMode: "off",
	mergeSlotHeld: false,
	updatedAt: new Date(0).toISOString(),
};

function cloneState(state: WorkflowState): WorkflowState {
	return { ...state };
}

function isWorkflowStateName(value: string): value is WorkflowStateName {
	return WORKFLOW_STATES.includes(value as WorkflowStateName);
}

function isPlanMode(value: string): value is PlanMode {
	return value === "off" || value === "strict" || value === "auto";
}

function formatState(state: WorkflowState): string {
	return [
		`state=${state.state}`,
		`bead=${state.activeBead ?? "-"}`,
		`branch=${state.branch ?? "-"}`,
		`worktree=${state.worktreePath ?? "-"}`,
		`start=${state.startCommit ?? "-"}`,
		`end=${state.endCommit ?? "-"}`,
		`plan=${state.planMode}`,
		`planApproved=${state.planApproved ? "true" : "false"}`,
		`sessionMode=${state.sessionMode ?? "-"}`,
		`mergeSlot=${state.mergeSlotHeld ? "held" : "free"}`,
		`bdStatus=${state.bdStatus ?? "-"}`,
	].join(" | ");
}

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

export function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function isCurrentRuntimeWorkflowState(data: unknown): data is WorkflowState {
	const state = data as WorkflowState | undefined;
	return Boolean(state?.runtimeOwnerKey && state.runtimeOwnerKey === currentRuntimeOwnerKey());
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

function hasCurrentSessionOwnership(state: WorkflowState, ctx?: ExtensionContext): boolean {
	const key = currentSessionKey(ctx);
	return Boolean(key && state.sessionKey === key);
}

function gitArgs(cwd: string | undefined, args: string[]): string[] {
	return cwd ? ["-C", cwd, ...args] : args;
}

async function detectBranch(pi: ExtensionAPI, cwd?: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", gitArgs(cwd, ["branch", "--show-current"]));
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function detectStartCommit(pi: ExtensionAPI, cwd?: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", gitArgs(cwd, ["rev-parse", "HEAD"]));
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function detectWorktreePath(pi: ExtensionAPI, cwd?: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", gitArgs(cwd, ["rev-parse", "--show-toplevel"]));
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

function isTerminalWorkflowState(state: WorkflowStateName): boolean {
	return state === "closed" || state === "blocked" || state === "deferred" || state === "merged";
}

function isTerminalBdStatus(status?: string): boolean {
	return status === "closed" || status === "blocked" || status === "deferred";
}

async function readBdStatus(pi: ExtensionAPI, beadId: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("bd", ["show", beadId, "--json"]);
	if (code !== 0) return undefined;
	try {
		const parsed = JSON.parse(stdout);
		const bead = Array.isArray(parsed) ? parsed[0] : parsed;
		return bead?.status;
	} catch {
		return undefined;
	}
}

async function ensureClaimedBdStatus(pi: ExtensionAPI, beadId: string): Promise<{ status?: string; error?: string }> {
	const claimedBdStatus = await readBdStatus(pi, beadId);
	if (claimedBdStatus === "in_progress") return { status: claimedBdStatus };
	if (claimedBdStatus !== "open") return { status: claimedBdStatus };

	const statusResult = await pi.exec("bd", ["update", beadId, "--status", "in_progress", "--json"]);
	if (statusResult.code !== 0) {
		return {
			status: claimedBdStatus,
			error: `fallback command \`bd update ${beadId} --status in_progress --json\` exited ${statusResult.code}: ${(statusResult.stderr || statusResult.stdout || "<no output>").trim()}`,
		};
	}
	return { status: await readBdStatus(pi, beadId) };
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
	return latestFieldIsForeign(commentsText, branchNames, scope.branch) || latestFieldIsForeign(commentsText, worktreeNames, scope.worktreePath);
}

function hasCurrentCommentScopeEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	const startNames = ["START_COMMIT", "Start-Commit", "startCommit", "start"];
	return latestFieldMatches(commentsText, branchNames, scope.branch)
		|| latestFieldMatches(commentsText, worktreeNames, scope.worktreePath)
		|| latestFieldMatches(commentsText, startNames, scope.startCommit);
}

function hasAnyCurrentCommentScopeEvidence(commentsText: string, scope: RecoveryScope): boolean {
	return hasExactField(commentsText, ["BRANCH", "Branch", "branch"], scope.branch)
		|| hasExactField(commentsText, ["WORKTREE", "Worktree", "worktree", "worktreePath"], scope.worktreePath)
		|| hasExactField(commentsText, ["START_COMMIT", "Start-Commit", "startCommit", "start"], scope.startCommit);
}

export function hasSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	if (!scope.sessionKey) return false;
	return hasExactField(commentsText, ["PI_SESSION_KEY", "SESSION_KEY", "sessionKey", "session"], scope.sessionKey);
}

function hasForeignSessionKeyEvidence(commentsText: string, scope: RecoveryScope): boolean {
	if (!scope.sessionKey) return false;
	const latest = latestFieldValue(commentsText, ["PI_SESSION_KEY", "SESSION_KEY", "sessionKey", "session"]);
	return Boolean(latest && latest !== scope.sessionKey);
}

function workflowStateHasCurrentScopeEvidence(state: WorkflowState, scope: RecoveryScope): boolean {
	const hasForeignWorktree = Boolean(state.worktreePath && scope.worktreePath && state.worktreePath !== scope.worktreePath);
	const hasForeignBranch = Boolean(state.branch && scope.branch && state.branch !== scope.branch);
	if (hasForeignWorktree || hasForeignBranch) return false;

	const hasMatchingWorktree = Boolean(state.worktreePath && scope.worktreePath && state.worktreePath === scope.worktreePath);
	const hasMatchingBranch = Boolean(state.branch && scope.branch && state.branch === scope.branch);
	const hasMatchingStartCommit = Boolean(state.startCommit && scope.startCommit && state.startCommit === scope.startCommit);

	return hasMatchingWorktree || hasMatchingBranch || hasMatchingStartCommit;
}

async function workflowStateHasValidRecordedTaskScope(pi: ExtensionAPI, state: WorkflowState): Promise<boolean> {
	if (!state.worktreePath || !state.branch || PROTECTED_BRANCHES.has(state.branch)) return false;
	const validation = validateTaskScopePath(state.worktreePath, {
		expectedBranch: state.branch,
		getRepoRoot: (cwd) => cwd,
		getBranch: () => undefined,
		exists: () => true,
	});
	if (!validation.ok) return false;
	const [actualWorktree, actualBranch] = await Promise.all([
		detectWorktreePath(pi, state.worktreePath),
		detectBranch(pi, state.worktreePath),
	]);
	return actualWorktree === state.worktreePath && actualBranch === state.branch;
}

async function readBdComments(pi: ExtensionAPI, beadId: string): Promise<string> {
	const { stdout, code } = await pi.exec("bd", ["comments", beadId]);
	return code === 0 ? stdout : "";
}

async function findRecoverableActiveBead(pi: ExtensionAPI, scope: RecoveryScope, excludedBeads = new Set<string>()): Promise<{ beadId?: string; diagnostic?: string }> {
	const candidates: Array<{ id: string; via: "session" | "scope" }> = [];
	const foreignSessionScopeMatches: string[] = [];
	for (const status of ["in_progress", "inreview", "simplified", "reviewed", "accepted"]) {
		const { stdout, code } = await pi.exec("bd", ["list", `--status=${status}`, "--json"]);
		if (code !== 0) continue;
		try {
			const issues = JSON.parse(stdout) as Array<{ id?: string }>;
			for (const issue of issues) {
				if (!issue.id || excludedBeads.has(issue.id)) continue;
				const commentsText = await readBdComments(pi, issue.id);
				const hasSessionEvidence = hasSessionOwnershipEvidence(commentsText, scope);
				const hasLatestScopeEvidence = hasCurrentCommentScopeEvidence(commentsText, scope);
				const hasAnyScopeEvidence = hasAnyCurrentCommentScopeEvidence(commentsText, scope);
				if (hasForeignSessionKeyEvidence(commentsText, scope) && hasAnyScopeEvidence) {
					foreignSessionScopeMatches.push(issue.id);
					continue;
				}
				if (hasForeignSessionOwnershipEvidence(commentsText, scope)) continue;
				if (hasSessionEvidence && hasLatestScopeEvidence) candidates.push({ id: issue.id, via: "session" });
				else if (hasAnyScopeEvidence) candidates.push({ id: issue.id, via: "scope" });
			}
		} catch {
			continue;
		}
	}
	const sessionCandidates = candidates.filter((candidate) => candidate.via === "session");
	if (sessionCandidates.length === 1) return { beadId: sessionCandidates[0]?.id };
	if (sessionCandidates.length > 1) return { diagnostic: `UNBOUND_WORKFLOW_STATE: несколько non-terminal beads текущей сессии подходят для этой сессии (${sessionCandidates.map((candidate) => candidate.id).join(", ")}); выберите active bead и вызовите workflow_update.` };

	const scopeCandidates = candidates.filter((candidate) => candidate.via === "scope");
	if (scopeCandidates.length === 1 && scope.branch && !PROTECTED_BRANCHES.has(scope.branch)) return { beadId: scopeCandidates[0]?.id };
	if (scopeCandidates.length > 0) return { diagnostic: `UNBOUND_WORKFLOW_STATE: найдена evidence non-terminal bead/worktree (${scopeCandidates.map((candidate) => candidate.id).join(", ")}), но auto-bind неоднозначен или текущая branch защищена; восстановитесь явно через workflow_status/workflow_update/workflow_reset.` };
	if (foreignSessionScopeMatches.length > 0) return { diagnostic: `UNBOUND_WORKFLOW_STATE: найдена evidence non-terminal bead/worktree с foreign session marker (${foreignSessionScopeMatches.join(", ")}); после проверки ownership восстановитесь через workflow_status/workflow_update/workflow_reset.` };
	return {};
}

function staleForeignRecoveryMessage(beadId: string, reason: string): string {
	return `Workflow-state для ${beadId} не может быть продолжен автоматически: ${reason}. Автопродолжение и review остановлены. Агент может вызвать workflow_reset, чтобы очистить stale local state, или явно подтвердить takeover и вызвать workflow_update с bead=${beadId} после проверки branch/worktree ownership. /workflow-reset и /workflow-update остаются опциональными human UI shortcuts.`;
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && /extension ctx is stale after session replacement or reload/i.test(error.message);
}

function hasUnsafeApprovedImplementingState(state: WorkflowState): boolean {
	return Boolean(state.planApproved && state.sessionMode === "implementing" && !state.activeBead);
}

function clearUnsafeApprovedImplementingState(state: WorkflowState): { state: WorkflowState; warning?: string } {
	if (!hasUnsafeApprovedImplementingState(state)) return { state };
	return {
		state: {
			...state,
			state: state.state === "implementing" || state.state === "plan_approved" ? "idle" : state.state,
			planApproved: false,
			sessionMode: "idle",
		},
		warning: "Небезопасное workflow-state: planApproved=true + sessionMode=implementing без active bead; флаги approved/implementing сброшены, потому что не хватило evidence владения текущей сессии.",
	};
}

async function reconcileActiveBeadState(pi: ExtensionAPI, state: WorkflowState, ctx?: ExtensionContext, staleRecoveryBlockedBeads = new Set<string>()): Promise<{ state: WorkflowState; warning?: string }> {
	const gitCwd = ctx?.cwd;
	const currentScope = {
		branch: await detectBranch(pi, gitCwd),
		worktreePath: await detectWorktreePath(pi, gitCwd),
		startCommit: await detectStartCommit(pi, gitCwd),
	};
	const scope = {
		branch: currentScope.branch ?? state.branch,
		worktreePath: currentScope.worktreePath ?? state.worktreePath,
		startCommit: currentScope.startCommit ?? state.startCommit,
		sessionKey: currentSessionKey(ctx),
	};

	if (state.activeBead && state.state !== "idle") {
		const bdStatus = await readBdStatus(pi, state.activeBead);
		if (isTerminalBdStatus(bdStatus)) {
			const cleared = clearUnsafeApprovedImplementingState({
				...state,
				activeBead: undefined,
				state: "idle",
				branch: currentScope.branch ?? state.branch,
				worktreePath: currentScope.worktreePath,
				startCommit: currentScope.startCommit,
				endCommit: undefined,
				sessionKey: undefined,
				bdStatus: undefined,
			});
			return { state: cleared.state, warning: staleForeignRecoveryMessage(state.activeBead, `terminal bd status ${bdStatus}`) };
		}
		if (isTerminalWorkflowState(state.state)) return { state: { ...state, bdStatus } };

		const commentsText = await readBdComments(pi, state.activeBead);
		const hasCurrentScope = workflowStateHasCurrentScopeEvidence(state, scope);
		const hasRecordedTaskScope = await workflowStateHasValidRecordedTaskScope(pi, state);
		const ownershipScope = hasRecordedTaskScope && !hasCurrentScope ? {
			branch: state.branch,
			worktreePath: state.worktreePath,
			startCommit: state.startCommit,
			sessionKey: scope.sessionKey,
		} : scope;
		const hasOwnership = !hasForeignSessionOwnershipEvidence(commentsText, ownershipScope)
			&& hasCurrentSessionOwnership(state, ctx)
			&& (hasCurrentScope || hasRecordedTaskScope);
		if (!hasOwnership) {
			staleRecoveryBlockedBeads.add(state.activeBead);
			const cleared = clearUnsafeApprovedImplementingState({
				...state,
				activeBead: undefined,
				state: "idle",
				branch: currentScope.branch ?? state.branch,
				worktreePath: currentScope.worktreePath,
				startCommit: currentScope.startCommit,
				endCommit: undefined,
				sessionKey: undefined,
				bdStatus: undefined,
			});
			return { state: cleared.state, warning: staleForeignRecoveryMessage(state.activeBead, "stale or foreign for this branch/worktree/session") };
		}
		if (!bdStatus) {
			const cleared = clearUnsafeApprovedImplementingState({
				...state,
				activeBead: undefined,
				state: "idle",
				branch: currentScope.branch ?? state.branch,
				worktreePath: currentScope.worktreePath,
				startCommit: currentScope.startCommit,
				endCommit: undefined,
				sessionKey: undefined,
				bdStatus: undefined,
			});
			return { state: cleared.state, warning: staleForeignRecoveryMessage(state.activeBead, "not backed by a readable bd status") };
		}
		const syncedState: WorkflowState = {
			...state,
			bdStatus,
			branch: hasCurrentScope ? (currentScope.branch ?? state.branch) : state.branch,
			worktreePath: hasCurrentScope ? currentScope.worktreePath : state.worktreePath,
			startCommit: hasCurrentScope ? currentScope.startCommit : state.startCommit,
		};
		if (bdStatus === "inreview" && state.state === "implementing") {
			syncedState.state = "inreview";
			syncedState.sessionMode = "inreview";
		}
		if (bdStatus === "inreview" && state.sessionMode === "implementing") {
			syncedState.sessionMode = "inreview";
		}
		return { state: syncedState };
	}

	const baseState = { ...state, branch: currentScope.branch ?? state.branch, worktreePath: currentScope.worktreePath, startCommit: currentScope.startCommit };
	const canRecoverActiveBead = state.state === "idle" || hasUnsafeApprovedImplementingState(baseState);
	const recovery = canRecoverActiveBead ? await findRecoverableActiveBead(pi, scope, staleRecoveryBlockedBeads) : {};
	if (!recovery.beadId) {
		const cleared = clearUnsafeApprovedImplementingState(baseState);
		if (recovery.diagnostic && !cleared.warning) {
			return {
				state: { ...cleared.state, sessionMode: "UNBOUND_WORKFLOW_STATE" },
				warning: recovery.diagnostic,
			};
		}
		return cleared;
	}
	const activeBead = recovery.beadId;
	const bdStatus = await readBdStatus(pi, activeBead);
	if (!bdStatus || isTerminalBdStatus(bdStatus)) return clearUnsafeApprovedImplementingState(baseState);
	return {
		state: {
			...baseState,
			activeBead,
			state: hasUnsafeApprovedImplementingState(baseState) ? "implementing" : baseState.state,
			sessionKey: scope.sessionKey ?? baseState.sessionKey,
			bdStatus,
		},
	};
}

function updateFooter(ctx: ExtensionContext, state: WorkflowState): void {
	const bead = state.activeBead ?? "-";
	const branch = state.branch ?? "-";
	const worktree = state.worktreePath ? "wt:yes" : "wt:no";
	const plan = `plan:${state.planMode}`;
	const slot = state.mergeSlotHeld ? "slot:held" : "slot:free";
	const bd = `bd:${state.bdStatus ?? "-"}`;
	ctx.ui.setStatus(
		"workflow-state",
		ctx.ui.theme.fg("dim", `session:${state.state} bead:${bead} br:${branch} ${worktree} ${plan} ${slot} ${bd}`),
	);
}

function parseKeyValueArgs(args: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const part of args.split(/\s+/).filter(Boolean)) {
		const [key, ...valueParts] = part.split("=");
		if (!key || valueParts.length === 0) continue;
		result[key] = valueParts.join("=");
	}
	return result;
}


const WorkflowStatusParams = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const WorkflowClaimParams = {
	type: "object",
	properties: { beadId: { type: "string", description: "Bead ID to claim and bind to this Pi session" } },
	required: ["beadId"],
	additionalProperties: false,
} as const;

const WorkflowResetParams = {
	type: "object",
	properties: { reason: { type: "string", description: "Why the local workflow state is being reset" } },
	additionalProperties: false,
} as const;

const WorkflowUpdateParams = {
	type: "object",
	properties: {
		bead: { type: "string" },
		state: { type: "string", enum: WORKFLOW_STATES },
		session: { type: "string" },
		branch: { type: "string" },
		worktree: { type: "string" },
		start: { type: "string" },
		end: { type: "string" },
		plan: { type: "string", enum: ["off", "strict", "auto"] },
		approved: { type: "boolean" },
		slot: { type: "string", enum: ["held", "free"] },
	},
	additionalProperties: false,
} as const;

const WorkflowSubmitForReviewParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Active bead ID to move to bd status inreview" },
		reason: { type: "string", description: "Evidence summary for why implementation is ready for review" },
		endCommit: { type: "string", description: "Implementation commit SHA, defaults to current HEAD in the resolved review worktree" },
	},
	required: ["beadId", "reason"],
	additionalProperties: false,
} as const;

const WorkflowCompleteParams = {
	type: "object",
	properties: {
		state: { type: "string", enum: ["closed", "blocked", "deferred", "merged"] },
		reason: { type: "string" },
		endCommit: { type: "string" },
	},
	required: ["state", "reason"],
	additionalProperties: false,
} as const;

function toolText(text: string, details: unknown = {}) {
	return { content: [{ type: "text", text }], details };
}

async function resolvedTaskScope(pi: ExtensionAPI, state: WorkflowState, ctx: ExtensionContext): Promise<{ branch?: string; worktreePath?: string; startCommit?: string }> {
	if (await workflowStateHasValidRecordedTaskScope(pi, state)) {
		return {
			branch: state.branch,
			worktreePath: state.worktreePath,
			startCommit: state.startCommit ?? (await detectStartCommit(pi, state.worktreePath)),
		};
	}
	return {
		branch: await detectBranch(pi, ctx.cwd),
		worktreePath: await detectWorktreePath(pi, ctx.cwd),
		startCommit: state.startCommit ?? (await detectStartCommit(pi, ctx.cwd)),
	};
}

const WORKFLOW_UPDATE_KEYS = ["bead", "state", "session", "branch", "worktree", "start", "end", "plan", "approved", "slot"] as const;

type WorkflowUpdateToolParams = {
	bead?: string;
	state?: WorkflowStateName;
	session?: string;
	branch?: string;
	worktree?: string;
	start?: string;
	end?: string;
	plan?: PlanMode;
	approved?: boolean;
	slot?: "held" | "free";
};

function validateWorkflowUpdateParams(params: Record<string, unknown>): string | undefined {
	const allowed = new Set<string>(WORKFLOW_UPDATE_KEYS);
	for (const key of Object.keys(params)) {
		if (!allowed.has(key)) return `Unsupported workflow_update parameter: ${key}`;
	}
	for (const key of ["bead", "session", "branch", "worktree", "start", "end"] as const) {
		if (params[key] !== undefined && (typeof params[key] !== "string" || params[key].trim() === "")) return `Invalid ${key} value: expected non-empty string`;
	}
	if (params.state !== undefined && (typeof params.state !== "string" || !isWorkflowStateName(params.state))) return `Invalid state: ${String(params.state)}`;
	if (params.plan !== undefined && (typeof params.plan !== "string" || !isPlanMode(params.plan))) return `Invalid plan mode: ${String(params.plan)}`;
	if (params.approved !== undefined && typeof params.approved !== "boolean") return `Invalid approved value: expected boolean`;
	if (params.slot !== undefined && params.slot !== "held" && params.slot !== "free") return `Invalid slot value: ${String(params.slot)}`;
	return undefined;
}

export default function workflowStateExtension(pi: ExtensionAPI): void {
	let workflowState: WorkflowState = cloneState(DEFAULT_STATE);
	let lastClaimError: string | undefined;
	const staleRecoveryBlockedBeads = new Set<string>();

	function persist(ctx?: ExtensionContext): void {
		workflowState.runtimeOwnerKey = currentRuntimeOwnerKey();
		workflowState.updatedAt = new Date().toISOString();
		pi.appendEntry("workflow-state", cloneState(workflowState));
		if (ctx) updateFooter(ctx, workflowState);
	}

	function assignState(partial: Partial<WorkflowState>): WorkflowState {
		workflowState = { ...workflowState, ...partial };
		return workflowState;
	}

	function setState(partial: Partial<WorkflowState>, ctx?: ExtensionContext): WorkflowState {
		assignState(partial);
		persist(ctx);
		return workflowState;
	}

	async function resetWorkflowState(ctx: ExtensionContext): Promise<WorkflowState> {
		workflowState = {
			...cloneState(DEFAULT_STATE),
			branch: await detectBranch(pi, ctx.cwd),
			worktreePath: await detectWorktreePath(pi, ctx.cwd),
			startCommit: await detectStartCommit(pi, ctx.cwd),
			runtimeOwnerKey: currentRuntimeOwnerKey(),
			updatedAt: new Date().toISOString(),
		};
		persist(ctx);
		return workflowState;
	}

	async function ensureReconciled(ctx?: ExtensionContext): Promise<boolean> {
		const reconciled = await reconcileActiveBeadState(pi, workflowState, ctx, staleRecoveryBlockedBeads);
		const changed =
			reconciled.state.state !== workflowState.state ||
			reconciled.state.activeBead !== workflowState.activeBead ||
			reconciled.state.branch !== workflowState.branch ||
			reconciled.state.worktreePath !== workflowState.worktreePath ||
			reconciled.state.startCommit !== workflowState.startCommit ||
			reconciled.state.endCommit !== workflowState.endCommit ||
			reconciled.state.bdStatus !== workflowState.bdStatus ||
			reconciled.state.planApproved !== workflowState.planApproved ||
			reconciled.state.sessionMode !== workflowState.sessionMode;
		workflowState = reconciled.state;
		if (changed) {
			persist(ctx);
		} else if (ctx) {
			updateFooter(ctx, workflowState);
		}
		if (ctx && reconciled.warning) ctx.ui.notify(reconciled.warning, "warning");
		return changed;
	}

	function applyEventUpdate(event: WorkflowStateUpdateEvent): WorkflowState {
		const next: Partial<WorkflowState> = {};
		if (event.state && (!event.stateIfCurrent || event.stateIfCurrent.includes(workflowState.state))) {
			next.state = event.state;
		}
		if (event.activeBead !== undefined) {
			next.activeBead = event.activeBead || undefined;
			if (event.activeBead && event.ctx) next.sessionKey = currentSessionKey(event.ctx);
		}
		if (event.branch !== undefined) next.branch = event.branch || undefined;
		if (event.worktreePath !== undefined) next.worktreePath = event.worktreePath || undefined;
		if (event.startCommit !== undefined) next.startCommit = event.startCommit || undefined;
		if (event.endCommit !== undefined) next.endCommit = event.endCommit || undefined;
		if (event.planMode !== undefined) next.planMode = event.planMode;
		if (event.planApproved !== undefined) next.planApproved = event.planApproved;
		if (event.sessionMode !== undefined) {
			next.sessionMode = event.sessionMode || undefined;
			if (!event.state && event.sessionMode && isWorkflowStateName(event.sessionMode)) next.state = event.sessionMode;
		}
		if (event.mergeSlotHeld !== undefined) next.mergeSlotHeld = event.mergeSlotHeld;
		return setState(next, event.ctx);
	}

	pi.events.on("workflow-state:update", async (event: WorkflowStateUpdateEvent) => {
		applyEventUpdate(event);
		try {
			await ensureReconciled(event.ctx);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	pi.registerCommand("workflow-status", {
		description: "Show current Pi session context and live bd status",
		handler: async (_args, ctx) => {
			await ensureReconciled(ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-reset", {
		description: "Reset Pi session context to idle (optional human UI shortcut; agents can call workflow_reset)",
		handler: async (_args, ctx) => {
			await resetWorkflowState(ctx);
			ctx.ui.notify("Workflow session context сброшен в idle", "info");
		},
	});

	pi.registerCommand("workflow-set-bead", {
		description: "Set active bead and optionally state. Usage: /workflow-set-bead <bead-id> [state]",
		handler: async (args, ctx) => {
			const [bead, maybeState] = args.trim().split(/\s+/).filter(Boolean);
			if (!bead) {
				ctx.ui.notify("Usage: /workflow-set-bead <bead-id> [state]", "error");
				return;
			}
			const nextState = maybeState && isWorkflowStateName(maybeState) ? maybeState : workflowState.state;
			setState(
				{
					activeBead: bead,
					state: nextState,
					branch: workflowState.branch ?? (await detectBranch(pi, ctx.cwd)),
					worktreePath: workflowState.worktreePath ?? (await detectWorktreePath(pi, ctx.cwd)),
					startCommit: workflowState.startCommit ?? (await detectStartCommit(pi, ctx.cwd)),
					sessionKey: currentSessionKey(ctx),
				},
				ctx,
			);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	function recordClaimError(ctx: ExtensionContext, message: string): false {
		lastClaimError = message.trim();
		ctx.ui.notify(lastClaimError, "error");
		return false;
	}

	async function claimWorkflowBead(bead: string, ctx: ExtensionContext): Promise<boolean> {
		lastClaimError = undefined;
		await ensureReconciled(ctx);
		if (workflowState.activeBead && workflowState.activeBead !== bead) {
			const activeStatus = workflowState.bdStatus ?? (await readBdStatus(pi, workflowState.activeBead));
			if (activeStatus === "inreview") {
				return recordClaimError(ctx, `Нельзя claim ${bead}: active bead ${workflowState.activeBead} уже в inreview. Сначала запустите review-bead / review_bead для active bead, затем можно брать unrelated work.`);
			}
			if (activeStatus && !isTerminalBdStatus(activeStatus)) {
				return recordClaimError(ctx, `Нельзя claim ${bead}: active bead ${workflowState.activeBead} имеет non-terminal bd status ${activeStatus}. Завершите, отправьте на review или сбросьте active workflow перед claim unrelated work.`);
			}
		}

		const showResult = await pi.exec("bd", ["show", bead, "--json"]);
		if (showResult.code !== 0) {
			return recordClaimError(ctx, `Failed to read bead ${bead}: command \`bd show ${bead} --json\` exited ${showResult.code}: ${(showResult.stderr || showResult.stdout || "<no output>").trim()}`);
		}

		const claimResult = await pi.exec("bd", ["update", bead, "--claim", "--json"]);
		if (claimResult.code !== 0) {
			return recordClaimError(ctx, `Failed to claim bead ${bead}: command \`bd update ${bead} --claim --json\` exited ${claimResult.code}: ${(claimResult.stderr || claimResult.stdout || "<no output>").trim()}`);
		}

		const { status: claimedBdStatus, error: statusFallbackError } = await ensureClaimedBdStatus(pi, bead);
		if (claimedBdStatus !== "in_progress") {
			const fallbackDetails = statusFallbackError ? ` ${statusFallbackError}.` : "";
			return recordClaimError(ctx, `Failed to claim bead ${bead}: bd status is ${claimedBdStatus ?? "unreadable"} after command \`bd update ${bead} --claim --json\`; expected in_progress.${fallbackDetails} Local workflow-state не изменён.`);
		}

		const branch = await detectBranch(pi, ctx.cwd);
		const worktreePath = await detectWorktreePath(pi, ctx.cwd);
		const startCommit = await detectStartCommit(pi, ctx.cwd);
		const sessionKey = currentSessionKey(ctx);
		const ownershipCommentResult = await pi.exec("bd", [
			"comments",
			"add",
			bead,
			[
				"WORKFLOW CLAIM",
				branch ? `BRANCH: ${branch}` : undefined,
				worktreePath ? `WORKTREE: ${worktreePath}` : undefined,
				startCommit ? `START_COMMIT: ${startCommit}` : undefined,
				sessionKey ? `PI_SESSION_KEY: ${sessionKey}` : undefined,
			]
				.filter((line) => line !== undefined)
				.join("\n"),
		]);
		if (ownershipCommentResult.code !== 0) {
			return recordClaimError(ctx, `Failed to claim bead ${bead}: command \`bd comments add ${bead} WORKFLOW CLAIM\` exited ${ownershipCommentResult.code}: ${(ownershipCommentResult.stderr || ownershipCommentResult.stdout || "<no output>").trim()}. Local workflow-state не изменён.`);
		}

		setState(
			{
				activeBead: bead,
				state: "claimed",
				branch,
				worktreePath,
				startCommit,
				sessionKey,
				bdStatus: claimedBdStatus,
			},
			ctx,
		);
		ctx.ui.notify(`Claim выполнен для ${bead}; ${formatState(workflowState)}`, "success");
		return true;
	}

	registerWorkflowClaimApi<ExtensionContext>(pi, {
		claimWorkflowBead: async (beadId, ctx) => {
			const ok = await claimWorkflowBead(beadId, ctx);
			return { ok, state: cloneState(workflowState), error: ok ? undefined : lastClaimError };
		},
	});

	pi.registerCommand("workflow-claim", {
		description: "Claim a bead and set this Pi session's active workflow bead. Usage: /workflow-claim <bead-id>",
		handler: async (args, ctx) => {
			const bead = args.trim().split(/\s+/).filter(Boolean)[0];
			if (!bead) {
				ctx.ui.notify("Usage: /workflow-claim <bead-id>", "error");
				return;
			}
			await claimWorkflowBead(bead, ctx);
		},
	});

	pi.on("input", async (event: any, ctx) => {
		if (event.source === "extension") return;
		const intent = parseWorkflowIntent(String(event.text ?? ""));
		if (!shouldAutoClaim(intent) || intent.wantsPlan) return;
		await claimWorkflowBead(intent.beadId, ctx);
		// Do not consume claim-only natural-language input. The agent must still get a turn
		// to decide whether the task needs strict plan mode, fast path, or a visible blocker.
		return undefined;
	});

	pi.registerCommand("workflow-set-state", {
		description: `Set legacy session state. Prefer session=<mode>; values: ${WORKFLOW_STATES.join(", ")}`,
		handler: async (args, ctx) => {
			const nextState = args.trim();
			if (!isWorkflowStateName(nextState)) {
				ctx.ui.notify(`Invalid state. Expected one of: ${WORKFLOW_STATES.join(", ")}`, "error");
				return;
			}
			setState({ state: nextState }, ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-set-worktree", {
		description: "Set active worktree path. Usage: /workflow-set-worktree <path>",
		handler: async (args, ctx) => {
			const worktreePath = args.trim();
			if (!worktreePath) {
				ctx.ui.notify("Usage: /workflow-set-worktree <path>", "error");
				return;
			}
			setState({ worktreePath }, ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-plan-mode", {
		description: "Set workflow plan mode. Usage: /workflow-plan-mode off|strict|auto",
		handler: async (args, ctx) => {
			const planMode = args.trim();
			if (!isPlanMode(planMode)) {
				ctx.ui.notify("Usage: /workflow-plan-mode off|strict|auto", "error");
				return;
			}
			setState({ planMode }, ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-merge-slot", {
		description: "Set merge-slot state. Usage: /workflow-merge-slot held|free",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value !== "held" && value !== "free") {
				ctx.ui.notify("Usage: /workflow-merge-slot held|free", "error");
				return;
			}
			setState({ mergeSlotHeld: value === "held" }, ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-update", {
		description:
			"Update session context fields. Usage: /workflow-update bead=<id> session=<mode> branch=<name> worktree=<path> start=<sha> end=<sha> plan=off|strict|auto approved=true|false slot=held|free (legacy state=<value> is still accepted)",
		handler: async (args, ctx) => {
			const kv = parseKeyValueArgs(args);
			const next: Partial<WorkflowState> = {};
			if (kv.state) {
				if (!isWorkflowStateName(kv.state)) {
					ctx.ui.notify(`Invalid state: ${kv.state}`, "error");
					return;
				}
				next.state = kv.state;
			}
			if (kv.bead) {
				next.activeBead = kv.bead;
				next.sessionKey = currentSessionKey(ctx);
				next.branch = workflowState.branch ?? (await detectBranch(pi));
				next.worktreePath = workflowState.worktreePath ?? (await detectWorktreePath(pi));
				next.startCommit = workflowState.startCommit ?? (await detectStartCommit(pi));
			}
			if (kv.branch) next.branch = kv.branch;
			if (kv.worktree) next.worktreePath = kv.worktree;
			if (kv.start) next.startCommit = kv.start;
			if (kv.end) next.endCommit = kv.end;
			if (kv.plan) {
				if (!isPlanMode(kv.plan)) {
					ctx.ui.notify(`Invalid plan mode: ${kv.plan}`, "error");
					return;
				}
				next.planMode = kv.plan;
			}
			if (kv.approved) {
				if (kv.approved !== "true" && kv.approved !== "false") {
					ctx.ui.notify(`Invalid approved value: ${kv.approved}`, "error");
					return;
				}
				next.planApproved = kv.approved === "true";
			}
			if (kv.session) next.sessionMode = kv.session;
			if (kv.slot) {
				if (kv.slot !== "held" && kv.slot !== "free") {
					ctx.ui.notify(`Invalid slot value: ${kv.slot}`, "error");
					return;
				}
				next.mergeSlotHeld = kv.slot === "held";
			}
			const changed = Object.keys(next).length > 0;
			assignState(next);
			const persistedByReconcile = await ensureReconciled(ctx);
			if (changed && !persistedByReconcile) persist(ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});


	if (pi.registerTool) {
		pi.registerTool({
			name: "workflow_status",
			label: "Workflow Status",
			description: "Inspect current Pi workflow-state with live bd reconciliation. Agent-operable equivalent of optional /workflow-status.",
			parameters: WorkflowStatusParams,
			async execute(_id: string, _params: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				await ensureReconciled(ctx);
				return toolText(formatState(workflowState), cloneState(workflowState));
			},
		});

		pi.registerTool({
			name: "workflow_claim",
			label: "Workflow Claim",
			description: "Claim a bead via bd and bind it to this Pi session without requiring slash commands.",
			parameters: WorkflowClaimParams,
			async execute(_id: string, params: { beadId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				const ok = await claimWorkflowBead(params.beadId, ctx);
				const error = ok ? undefined : lastClaimError;
				await ensureReconciled(ctx);
				const failureDetails = error ? `; reason: ${error}` : "";
				return toolText(ok ? `workflow_claim выполнен: ${formatState(workflowState)}` : `workflow_claim не выполнен для ${params.beadId}: ${formatState(workflowState)}${failureDetails}`, { ok, error, ...cloneState(workflowState) });
			},
		});

		pi.registerTool({
			name: "workflow_reset",
			label: "Workflow Reset",
			description: "Clear stale/recoverable local Pi workflow-state to idle without requiring /workflow-reset.",
			parameters: WorkflowResetParams,
			async execute(_id: string, params: { reason?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				await resetWorkflowState(ctx);
				return toolText(`workflow_reset выполнен${params.reason ? `: ${params.reason}` : ""}. ${formatState(workflowState)}`, cloneState(workflowState));
			},
		});

		pi.registerTool({
			name: "workflow_update",
			label: "Workflow Update",
			description: "Update typed Pi session workflow fields; agent-operable equivalent of optional /workflow-update.",
			parameters: WorkflowUpdateParams,
			async execute(_id: string, params: WorkflowUpdateToolParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				const rawParams = params as Record<string, unknown>;
				const validationError = validateWorkflowUpdateParams(rawParams);
				if (validationError) return toolText(`workflow_update отклонён: ${validationError}`, { ok: false, error: validationError, ...cloneState(workflowState) });

				const next: Partial<WorkflowState> = {};
				if (params.state !== undefined) next.state = params.state;
				if (params.bead !== undefined) {
					next.activeBead = params.bead;
					next.sessionKey = currentSessionKey(ctx);
				}
				if (params.branch !== undefined) next.branch = params.branch;
				if (params.worktree !== undefined) next.worktreePath = params.worktree;
				if (params.start !== undefined) next.startCommit = params.start;
				if (params.end !== undefined) next.endCommit = params.end;
				if (params.plan !== undefined) next.planMode = params.plan;
				if (params.approved !== undefined) next.planApproved = params.approved;
				if (params.session !== undefined) next.sessionMode = params.session;
				if (params.slot !== undefined) next.mergeSlotHeld = params.slot === "held";

				const changed = Object.keys(next).length > 0;
				if (!changed) return toolText(`workflow_update no-op: supported parameters не переданы. ${formatState(workflowState)}`, { ok: true, reason: "no supported parameters provided", ...cloneState(workflowState) });

				assignState(next);
				const unsafeCleared = clearUnsafeApprovedImplementingState(workflowState);
				if (unsafeCleared.warning) {
					assignState(unsafeCleared.state);
					ctx.ui.notify(`${unsafeCleared.warning} ${formatState(workflowState)}`, "warn");
				}
				const hasExplicitScope = params.branch !== undefined || params.worktree !== undefined || params.start !== undefined;
				if (hasExplicitScope) {
					if (workflowState.activeBead) {
						const bdStatus = await readBdStatus(pi, workflowState.activeBead);
						if (isTerminalBdStatus(bdStatus)) {
							assignState({ activeBead: undefined, state: "idle", endCommit: undefined, sessionKey: undefined, bdStatus: undefined });
						} else if (bdStatus) {
							assignState({ bdStatus });
							const ownershipComment = [
								"PI WORKFLOW UPDATE",
								"",
								workflowState.branch ? `BRANCH: ${workflowState.branch}` : undefined,
								workflowState.worktreePath ? `WORKTREE: ${workflowState.worktreePath}` : undefined,
								workflowState.startCommit ? `START_COMMIT: ${workflowState.startCommit}` : undefined,
								workflowState.endCommit ? `END_COMMIT: ${workflowState.endCommit}` : undefined,
								workflowState.sessionKey ? `PI_SESSION_KEY: ${workflowState.sessionKey}` : undefined,
								workflowState.sessionMode ? `SESSION_MODE: ${workflowState.sessionMode}` : undefined,
							].filter((line) => line !== undefined).join("\n");
							const ownershipCommentResult = await pi.exec("bd", ["comments", "add", workflowState.activeBead, ownershipComment]);
							if (ownershipCommentResult.code !== 0) {
								return toolText(`workflow_update не выполнен для ${workflowState.activeBead}: не удалось записать branch/worktree ownership evidence: ${ownershipCommentResult.stderr || ownershipCommentResult.stdout}`.trim(), { ok: false, ...cloneState(workflowState) });
							}
						}
					}
					persist(ctx);
				} else {
					const reconciled = await ensureReconciled(ctx);
					if (!reconciled) persist(ctx);
				}
				return toolText(`workflow_update выполнен: ${formatState(workflowState)}`, { ok: true, ...cloneState(workflowState) });
			},
		});

		pi.registerTool({
			name: "workflow_submit_for_review",
			label: "Workflow Submit For Review",
			description: "Atomically move the active bead to bd status inreview and sync Pi workflow-state so the next action is review_bead/review-bead.",
			parameters: WorkflowSubmitForReviewParams,
			async execute(_id: string, params: { beadId: string; reason: string; endCommit?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				await ensureReconciled(ctx);
				if (workflowState.activeBead && workflowState.activeBead !== params.beadId) {
					return toolText(`workflow_submit_for_review заблокирован: active bead = ${workflowState.activeBead}, а не ${params.beadId}. Используйте workflow_reset только после проверки stale/foreign ownership.`, { ok: false, ...cloneState(workflowState) });
				}
				const reviewScope = await resolvedTaskScope(pi, workflowState, ctx);
				const endCommit = params.endCommit ?? (await detectStartCommit(pi, reviewScope.worktreePath ?? ctx.cwd));
				const submitComment = [
					"WORKFLOW SUBMIT FOR REVIEW",
					"",
					reviewScope.branch ? `BRANCH: ${reviewScope.branch}` : undefined,
					reviewScope.worktreePath ? `WORKTREE: ${reviewScope.worktreePath}` : undefined,
					reviewScope.startCommit ? `START_COMMIT: ${reviewScope.startCommit}` : undefined,
					endCommit ? `END_COMMIT: ${endCommit}` : undefined,
					currentSessionKey(ctx) ? `PI_SESSION_KEY: ${currentSessionKey(ctx)}` : undefined,
					"",
					params.reason,
				].filter((line) => line !== undefined).join("\n");
				const commentResult = await pi.exec("bd", ["comments", "add", params.beadId, submitComment]);
				if (commentResult.code !== 0) {
					return toolText(`workflow_submit_for_review не выполнен для ${params.beadId}: не удалось записать durable review scope evidence: ${commentResult.stderr || commentResult.stdout}`.trim(), { ok: false, ...cloneState(workflowState) });
				}
				const updateResult = await pi.exec("bd", ["update", params.beadId, "--status", "inreview", "--json"]);
				if (updateResult.code !== 0) {
					return toolText(`workflow_submit_for_review не выполнен для ${params.beadId}: ${updateResult.stderr || updateResult.stdout}`.trim(), { ok: false, ...cloneState(workflowState) });
				}
				setState(
					{
						activeBead: params.beadId,
						state: "inreview",
						sessionMode: "inreview",
						branch: reviewScope.branch,
						worktreePath: reviewScope.worktreePath,
						startCommit: reviewScope.startCommit,
						endCommit,
						sessionKey: currentSessionKey(ctx),
						bdStatus: "inreview",
					},
					ctx,
				);
				return toolText(`workflow_submit_for_review выполнен для ${params.beadId}: ${params.reason}. Следующее действие: review_bead/review-bead, либо workflow_complete state=blocked|deferred с явным blocker, если review нельзя запустить. ${formatState(workflowState)}`, { ok: true, ...cloneState(workflowState) });
			},
		});

		pi.registerTool({
			name: "workflow_complete",
			label: "Workflow Complete",
			description: "Mark local Pi workflow-state terminal after external bd/review workflow completion; does not close bd or push.",
			parameters: WorkflowCompleteParams,
			async execute(_id: string, params: { state: "closed" | "blocked" | "deferred" | "merged"; reason: string; endCommit?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				await ensureReconciled(ctx);
				if (workflowState.activeBead && workflowState.bdStatus === "inreview" && params.state !== "blocked" && params.state !== "deferred") {
					return toolText(
						`workflow_complete заблокирован: active bead ${workflowState.activeBead} имеет bd:inreview. Следующее допустимое действие: review_bead/review-bead, либо workflow_complete state=blocked|deferred с явным blocker, если review нельзя запустить.`,
						{ ok: false, ...cloneState(workflowState) },
					);
				}
				setState({ state: params.state, sessionMode: params.state, endCommit: params.endCommit ?? (await detectStartCommit(pi, ctx.cwd)), activeBead: undefined, bdStatus: undefined, planMode: "off", planApproved: false }, ctx);
				return toolText(`workflow_complete записал ${params.state}: ${params.reason}. ${formatState(workflowState)}`, { ok: true, ...cloneState(workflowState) });
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const lastStateEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
			.filter((entry: { data?: unknown }) => isCurrentRuntimeWorkflowState(entry.data))
			.pop() as { data?: WorkflowState } | undefined;

		workflowState = lastStateEntry?.data ? { ...cloneState(DEFAULT_STATE), ...lastStateEntry.data } : { ...cloneState(DEFAULT_STATE), runtimeOwnerKey: currentRuntimeOwnerKey() };
		workflowState.branch = workflowState.branch ?? (await detectBranch(pi, ctx.cwd));
		workflowState.worktreePath = workflowState.worktreePath ?? (await detectWorktreePath(pi, ctx.cwd));
		workflowState.startCommit = workflowState.startCommit ?? (await detectStartCommit(pi, ctx.cwd));
		persist(ctx);
		await ensureReconciled(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx) await ensureReconciled(ctx);
		const inreviewGuard = workflowState.activeBead && workflowState.bdStatus === "inreview"
			? `\n\n[PI INREVIEW GUARD]\nActive bead ${workflowState.activeBead} имеет bdStatus=inreview. Не останавливайся с обычным final report. Если ты не в plan mode и ownership не stale/foreign, следующее действие: review-bead / review_bead для ${workflowState.activeBead}. Не заявляй, что review_bead или dispatch_reviewer недоступны, по памяти, compacted context или отсутствию предыдущего tool call: такой blocker допустим только если tool реально отсутствует в текущем tool surface или typed call вернул ошибку до запуска review. Если review нельзя запустить из-за доказанной недоступности tool, failed typed call или stale/foreign ownership, верни BLOCKED на русском с точным evidence, next action и затем workflow_complete state=blocked|deferred; workflow_complete допустим только для этого явного blocker.`
			: "";
		return {
			message: {
				customType: "workflow-state-context",
				content: `[PI SESSION CONTEXT]\n${formatState(workflowState)}\n\nAgents используют workflow_status/workflow_update typed tools для session context; /workflow-status и /workflow-update — опциональные human UI shortcuts. bdStatus — live read-only issue status.${inreviewGuard}`,
				display: false,
			},
		};
	});
}
