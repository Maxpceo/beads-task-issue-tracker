interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	appendEntry(type: string, data: unknown): void;
	events: { on(name: string, handler: (event: WorkflowStateUpdateEvent) => void): void };
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
}

interface ExtensionContext {
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
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

interface WorkflowState {
	activeBead?: string;
	state: WorkflowStateName;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	planMode: PlanMode;
	mergeSlotHeld: boolean;
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
	planMode?: PlanMode;
	mergeSlotHeld?: boolean;
	ctx?: ExtensionContext;
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
		`mergeSlot=${state.mergeSlotHeld ? "held" : "free"}`,
	].join(" | ");
}

async function detectBranch(pi: ExtensionAPI): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function detectStartCommit(pi: ExtensionAPI): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", ["rev-parse", "HEAD"]);
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function detectWorktreePath(pi: ExtensionAPI): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

function isTerminalWorkflowState(state: WorkflowStateName): boolean {
	return state === "closed" || state === "blocked" || state === "deferred" || state === "merged";
}

function stateFromBdStatus(status?: string): WorkflowStateName | undefined {
	if (status === "in_progress") return "implementing";
	if (status === "inreview") return "inreview";
	if (status === "reviewed" || status === "accepted") return "accepted";
	if (status === "closed") return "closed";
	if (status === "blocked") return "blocked";
	if (status === "deferred") return "deferred";
	return undefined;
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

interface RecoveryScope {
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactField(text: string, names: string[], value?: string): boolean {
	if (!value) return false;
	const escaped = escapeRegExp(value);
	return names.some((name) => new RegExp(`(^|\\n)\\s*${name}\\s*[:=]\\s*${escaped}(\\s|$)`, "im").test(text));
}

export function hasSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchMatches = hasExactField(commentsText, ["BRANCH", "Branch", "branch"], scope.branch);
	const worktreeMatches = hasExactField(commentsText, ["WORKTREE", "Worktree", "worktree", "worktreePath"], scope.worktreePath);
	const startMatches = hasExactField(commentsText, ["START_COMMIT", "START-COMMIT", "Start-commit", "start"], scope.startCommit);

	// A branch/worktree match is explicit ownership.  A start commit match is
	// accepted only when the comment is a Pi workflow comment, avoiding broad
	// recovery of arbitrary global bd statuses.
	return branchMatches || worktreeMatches || (startMatches && /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(commentsText));
}

function workflowStateHasCurrentScopeEvidence(state: WorkflowState, scope: RecoveryScope): boolean {
	return Boolean(
		(state.worktreePath && scope.worktreePath && state.worktreePath === scope.worktreePath) ||
			(state.startCommit && scope.startCommit && state.startCommit === scope.startCommit) ||
			(state.branch && scope.branch && state.branch === scope.branch && state.startCommit),
	);
}

async function readBdComments(pi: ExtensionAPI, beadId: string): Promise<string> {
	const { stdout, code } = await pi.exec("bd", ["comments", beadId]);
	return code === 0 ? stdout : "";
}

async function findRecoverableActiveBead(pi: ExtensionAPI, scope: RecoveryScope): Promise<string | undefined> {
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const { stdout, code } = await pi.exec("bd", ["list", `--status=${status}`, "--json"]);
		if (code !== 0) continue;
		try {
			const issues = JSON.parse(stdout) as Array<{ id?: string }>;
			for (const issue of issues) {
				if (!issue.id) continue;
				if (hasSessionOwnershipEvidence(await readBdComments(pi, issue.id), scope)) return issue.id;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

async function reconcileActiveBeadState(pi: ExtensionAPI, state: WorkflowState): Promise<WorkflowState> {
	const currentScope = {
		branch: await detectBranch(pi),
		worktreePath: await detectWorktreePath(pi),
		startCommit: await detectStartCommit(pi),
	};
	const scope = {
		branch: currentScope.branch ?? state.branch,
		worktreePath: currentScope.worktreePath ?? state.worktreePath,
		startCommit: currentScope.startCommit ?? state.startCommit,
	};

	if (state.activeBead && state.state !== "idle" && !isTerminalWorkflowState(state.state)) {
		const hasOwnership = hasSessionOwnershipEvidence(await readBdComments(pi, state.activeBead), scope) || workflowStateHasCurrentScopeEvidence(state, scope);
		if (!hasOwnership) {
			return {
				...state,
				activeBead: undefined,
				state: "idle",
				branch: currentScope.branch ?? state.branch,
				worktreePath: currentScope.worktreePath,
				startCommit: currentScope.startCommit,
				endCommit: undefined,
			};
		}
		return state;
	}

	const activeBead = state.state === "idle" ? await findRecoverableActiveBead(pi, scope) : undefined;
	if (!activeBead) return { ...state, branch: currentScope.branch ?? state.branch };
	const inferred = stateFromBdStatus(await readBdStatus(pi, activeBead));
	if (!inferred || (activeBead === state.activeBead && inferred === state.state)) return state;
	return { ...state, activeBead, state: inferred, branch: currentScope.branch ?? state.branch, worktreePath: currentScope.worktreePath, startCommit: currentScope.startCommit };
}

function updateFooter(ctx: ExtensionContext, state: WorkflowState): void {
	const bead = state.activeBead ?? "-";
	const branch = state.branch ?? "-";
	const worktree = state.worktreePath ? "wt:yes" : "wt:no";
	const slot = state.mergeSlotHeld ? "slot:held" : "slot:free";
	ctx.ui.setStatus(
		"workflow-state",
		ctx.ui.theme.fg("dim", `wf:${state.state} bead:${bead} br:${branch} ${worktree} ${slot}`),
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

export default function workflowStateExtension(pi: ExtensionAPI): void {
	let workflowState: WorkflowState = cloneState(DEFAULT_STATE);

	function persist(ctx?: ExtensionContext): void {
		workflowState.updatedAt = new Date().toISOString();
		pi.appendEntry("workflow-state", cloneState(workflowState));
		if (ctx) updateFooter(ctx, workflowState);
	}

	function setState(partial: Partial<WorkflowState>, ctx?: ExtensionContext): WorkflowState {
		workflowState = { ...workflowState, ...partial };
		persist(ctx);
		return workflowState;
	}

	function applyEventUpdate(event: WorkflowStateUpdateEvent): WorkflowState {
		const next: Partial<WorkflowState> = {};
		if (event.state && (!event.stateIfCurrent || event.stateIfCurrent.includes(workflowState.state))) {
			next.state = event.state;
		}
		if (event.activeBead !== undefined) next.activeBead = event.activeBead || undefined;
		if (event.branch !== undefined) next.branch = event.branch || undefined;
		if (event.worktreePath !== undefined) next.worktreePath = event.worktreePath || undefined;
		if (event.startCommit !== undefined) next.startCommit = event.startCommit || undefined;
		if (event.endCommit !== undefined) next.endCommit = event.endCommit || undefined;
		if (event.planMode !== undefined) next.planMode = event.planMode;
		if (event.mergeSlotHeld !== undefined) next.mergeSlotHeld = event.mergeSlotHeld;
		return setState(next, event.ctx);
	}

	pi.events.on("workflow-state:update", (event: WorkflowStateUpdateEvent) => {
		applyEventUpdate(event);
	});

	pi.registerCommand("workflow-status", {
		description: "Show current Pi workflow state",
		handler: async (_args, ctx) => {
			updateFooter(ctx, workflowState);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.registerCommand("workflow-reset", {
		description: "Reset Pi workflow state to idle",
		handler: async (_args, ctx) => {
			workflowState = { ...cloneState(DEFAULT_STATE), branch: await detectBranch(pi), updatedAt: new Date().toISOString() };
			persist(ctx);
			ctx.ui.notify("Workflow state reset to idle", "info");
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
					branch: workflowState.branch ?? (await detectBranch(pi)),
					startCommit: workflowState.startCommit ?? (await detectStartCommit(pi)),
				},
				ctx,
			);
			ctx.ui.notify(formatState(workflowState), "info");
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

			const showResult = await pi.exec("bd", ["show", bead, "--json"]);
			if (showResult.code !== 0) {
				ctx.ui.notify(`Failed to read bead ${bead}: ${showResult.stderr || showResult.stdout}`.trim(), "error");
				return;
			}

			const claimResult = await pi.exec("bd", ["update", bead, "--claim", "--json"]);
			if (claimResult.code !== 0) {
				ctx.ui.notify(`Failed to claim bead ${bead}: ${claimResult.stderr || claimResult.stdout}`.trim(), "error");
				return;
			}

			setState(
				{
					activeBead: bead,
					state: "claimed",
					branch: await detectBranch(pi),
					startCommit: await detectStartCommit(pi),
				},
				ctx,
			);
			ctx.ui.notify(`Claimed ${bead}; ${formatState(workflowState)}`, "success");
		},
	});

	pi.registerCommand("workflow-set-state", {
		description: `Set workflow state. Values: ${WORKFLOW_STATES.join(", ")}`,
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
			"Update workflow fields. Usage: /workflow-update state=claimed bead=<id> branch=<name> worktree=<path> start=<sha> end=<sha> plan=off|strict|auto slot=held|free",
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
			if (kv.bead) next.activeBead = kv.bead;
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
			if (kv.slot) {
				if (kv.slot !== "held" && kv.slot !== "free") {
					ctx.ui.notify(`Invalid slot value: ${kv.slot}`, "error");
					return;
				}
				next.mergeSlotHeld = kv.slot === "held";
			}
			setState(next, ctx);
			ctx.ui.notify(formatState(workflowState), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const lastStateEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
			.pop() as { data?: WorkflowState } | undefined;

		workflowState = lastStateEntry?.data ? { ...cloneState(DEFAULT_STATE), ...lastStateEntry.data } : cloneState(DEFAULT_STATE);
		workflowState.branch = workflowState.branch ?? (await detectBranch(pi));
		const reconciled = await reconcileActiveBeadState(pi, workflowState);
		if (reconciled.state !== workflowState.state) {
			workflowState = reconciled;
			persist(ctx);
		} else {
			updateFooter(ctx, workflowState);
		}
	});

	pi.on("before_agent_start", async () => {
		return {
			message: {
				customType: "workflow-state-context",
				content: `[PI WORKFLOW STATE]\n${formatState(workflowState)}\n\nUse /workflow-status to inspect state. Use /workflow-update for explicit state transitions when a workflow phase changes.`,
				display: false,
			},
		};
	});
}
