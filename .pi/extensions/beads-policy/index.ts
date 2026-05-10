import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PolicyName =
	| "blockGitAddAll"
	| "requireMergeSlotForPush"
	| "protectPaths"
	| "blockBdCloseWithoutReview"
	| "validateReviewChain"
	| "enforceBeadEnrichment"
	| "blockMutationsInPlanning"
	| "blockSupervisorClose"
	| "blockWorktreeInsideRepo"
	| "staleWorktreeGuard";

interface PolicyDecision {
	policy: PolicyName;
	block: boolean;
	reason: string;
}

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	mergeSlotHeld?: boolean;
	planMode?: string;
}

const PROTECTED_PATHS = [".env", ".git/", "node_modules/"];

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
	return /\b(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(
		command,
	);
}

function commandCreatesWorktreeInsideRepo(command: string): boolean {
	return /\b(git\s+worktree\s+add|bd\s+worktree\s+create)\s+(?!\/|~|\.\.\/)/.test(command);
}

function commandCreatesUnenrichedBead(command: string): boolean {
	if (!/\bbd\s+(create|new)\b/.test(command)) return false;
	if (/--type[=\s]epic\b/.test(command)) return false;
	if (/--ephemeral\b|--from-markdown\b|--from-graph\b|--file\b/.test(command)) return false;
	if (/SKIP_ENRICH_CHECK=1/.test(command)) return false;
	return !(
		command.includes("### Files") &&
		command.includes("### Current state") &&
		command.includes("### Target state")
	);
}

function commandHasInvalidReviewTransition(command: string): boolean {
	return /\bbd\s+update\s+\S+\s+--status\s+(simplified|reviewed|accepted)\b/.test(command);
}

function commandClosesBead(command: string): boolean {
	return /\bbd\s+close\b/.test(command);
}

function isSupervisorContext(): boolean {
	return /supervisor/i.test(process.env.PI_AGENT_ROLE ?? "") || /supervisor/i.test(process.env.PI_SUBAGENT_ROLE ?? "");
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data ?? {};
}

export function evaluateBashPolicy(commandInput: string, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const command = normalizeCommand(commandInput);

	if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(command)) {
		return {
			policy: "blockGitAddAll",
			block: true,
			reason: "Blocked: use explicit file paths instead of git add . / -A / --all.",
		};
	}

	const isPlanning = workflowState.state === "planning" || workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (commandHasMutatingBd(command) || commandHasMutatingGitOrFs(command))) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; only read-only commands are allowed.",
		};
	}

	if (commandHasGitPush(command) && !workflowState.mergeSlotHeld && !commandAcquiresMergeSlotBeforePush(command)) {
		return {
			policy: "requireMergeSlotForPush",
			block: true,
			reason: "Blocked: git push requires bd merge-slot acquire first (or workflow state mergeSlotHeld=true).",
		};
	}

	if (commandCreatesUnenrichedBead(command)) {
		return {
			policy: "enforceBeadEnrichment",
			block: true,
			reason: "Blocked: bd create requires ### Files, ### Current state, and ### Target state markers unless explicitly exempt.",
		};
	}

	if (isSupervisorContext() && (commandClosesBead(command) || commandHasInvalidReviewTransition(command) || commandHasGitPush(command))) {
		return {
			policy: "blockSupervisorClose",
			block: true,
			reason: "Blocked: supervisor contexts cannot close beads, set orchestrator statuses, or push.",
		};
	}

	if (commandClosesBead(command) && !["accepted", "reviewing"].includes(workflowState.state ?? "")) {
		return {
			policy: "blockBdCloseWithoutReview",
			block: true,
			reason: "Blocked: bd close requires reviewed/accepted workflow state or an explicit policy override.",
		};
	}

	if (commandHasInvalidReviewTransition(command) && workflowState.state !== "reviewing") {
		return {
			policy: "validateReviewChain",
			block: true,
			reason: "Blocked: orchestrator review statuses require workflow state reviewing.",
		};
	}

	if (commandCreatesWorktreeInsideRepo(command)) {
		return {
			policy: "blockWorktreeInsideRepo",
			block: true,
			reason: "Blocked: create worktrees with an absolute external path, not inside the repository.",
		};
	}

	return undefined;
}

function evaluatePathPolicy(toolName: string, path: string, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const normalizedPath = path.replace(/\\/g, "/");
	if (PROTECTED_PATHS.some((protectedPath) => normalizedPath.includes(protectedPath))) {
		return {
			policy: "protectPaths",
			block: true,
			reason: `Blocked: ${path} is protected.`,
		};
	}

	const isPlanning = workflowState.state === "planning" || workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (toolName === "edit" || toolName === "write")) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; edit/write are disabled.",
		};
	}

	return undefined;
}

function toToolBlock(decision: PolicyDecision): { block: true; reason: string } {
	return { block: true, reason: `[${decision.policy}] ${decision.reason}` };
}

export default function beadsPolicyExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const workflowState = latestWorkflowState(ctx);

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const decision = applySkip(evaluateBashPolicy(command, workflowState));
			if (decision?.block) return toToolBlock(decision);
			return undefined;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const path = String(event.input.path ?? "");
			const decision = applySkip(evaluatePathPolicy(event.toolName, path, workflowState));
			if (decision?.block) return toToolBlock(decision);
		}

		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("beads-policy", ctx.ui.theme.fg("dim", "policy:on"));
	});

	pi.registerCommand("policy-status", {
		description: "Show active Pi beads policy engine status and overrides",
		handler: async (_args, ctx) => {
			const skipped = [...getSkipPolicies()].join(", ") || "none";
			ctx.ui.notify(`Beads policy engine active. Overrides: ${skipped}`, "info");
		},
	});
}
