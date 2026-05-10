import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKFLOW_STATES = [
	"idle",
	"claimed",
	"planning",
	"plan_approved",
	"implementing",
	"inreview",
	"reviewing",
	"accepted",
	"landing",
	"merged",
	"blocked",
] as const;

type WorkflowStateName = (typeof WORKFLOW_STATES)[number];
type PlanMode = "off" | "strict" | "auto";

interface WorkflowState {
	activeBead?: string;
	state: WorkflowStateName;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	planMode: PlanMode;
	mergeSlotHeld: boolean;
	updatedAt: string;
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
			"Update workflow fields. Usage: /workflow-update state=claimed bead=<id> branch=<name> worktree=<path> start=<sha> plan=off|strict|auto slot=held|free",
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
		updateFooter(ctx, workflowState);
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
