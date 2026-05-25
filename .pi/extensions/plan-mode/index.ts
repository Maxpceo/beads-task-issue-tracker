/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";
import { currentRuntimeOwnerKey, requestWorkflowClaim } from "../workflow-state/index";
import { parseWorkflowIntent, shouldAutoClaimAndPlan } from "../workflow-intent/index";
import {
	evaluatePlanReviewGate,
	missingRevisedPlanSections,
	renderPlanReviewResults,
	runPlanReviewers,
	type PlanReviewResult,
} from "../plan-review/index";
import { requestSupervisorDispatch } from "../beads-dispatch/index";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "workflow_status", "workflow_plan_mode", "workflow_plan_approved", "workflow_plan_review", "plan_subagent"];
const NORMAL_MODE_FALLBACK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "plan_subagent"];
const MANDATORY_WORKFLOW_TOOLS = [
	"workflow_status",
	"workflow_claim",
	"workflow_reset",
	"workflow_update",
	"workflow_submit_for_review",
	"workflow_complete",
	"dispatch_supervisor",
	"dispatch_reviewer",
	"dispatch_docs_agent",
	"review_bead",
];

const WorkflowPlanModeParams = {
	type: "object",
	properties: {
		mode: { type: "string", enum: ["off", "strict", "auto"], description: "Target plan mode" },
		reason: { type: "string", description: "Visible checkpoint reason for the mode change" },
	},
	required: ["mode"],
	additionalProperties: false,
} as const;

const WorkflowPlanApprovedParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Bead receiving the PLAN APPROVED evidence comment" },
		planEvidence: { type: "string", description: "Approved plan text or concise evidence. Must include enough details to audit approval." },
		approvedBy: { type: "string", description: "Approver name", default: "Максим" },
	},
	required: ["beadId", "planEvidence"],
	additionalProperties: false,
} as const;

function toolText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

interface WorkflowStateSnapshot {
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	sessionKey?: string;
	runtimeOwnerKey?: string;
}

function isWorkflowStateSnapshot(value: unknown): value is WorkflowStateSnapshot {
	if (!value || typeof value !== "object") return false;
	const state = value as WorkflowStateSnapshot;
	return typeof state.activeBead === "string";
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function normalizePlanModeActivationText(text: string): string {
	return text
		.toLocaleLowerCase("ru-RU")
		.replace(/ё/g, "е")
		.replace(/[.!…]+$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function isNaturalLanguagePlanModeActivation(text: string): boolean {
	if (/[?？]/u.test(text)) return false;

	const normalized = normalizePlanModeActivationText(text);
	if (!normalized) return false;

	const russianActivationPatterns = [
		/^(?:пожалуйста\s+)?(?:перейди|переведи|введи|запусти)(?:\s+(?:меня|нас|сессию))?\s+в\s+(?:строгий\s+)?режим\s+планирования$/u,
		/^(?:пожалуйста\s+)?(?:включи|активируй|запусти)\s+(?:строгий\s+)?режим\s+планирования$/u,
		/^(?:пожалуйста\s+)?(?:сделай|работай)(?:\s+(?:это|задачу))?\s+в\s+режиме\s+планирования$/u,
	];
	const englishActivationPatterns = [
		/^(?:please\s+)?(?:enter|switch(?:\s+me|\s+us|\s+the\s+session)?\s+to|go\s+to|start|enable|activate)\s+(?:strict\s+)?plan\s+mode$/u,
		/^(?:please\s+)?put(?:\s+(?:me|us|the\s+session))?\s+(?:into|in)\s+(?:strict\s+)?plan\s+mode$/u,
	];

	return [...russianActivationPatterns, ...englishActivationPatterns].some((pattern) => pattern.test(normalized));
}

function isExplicitPlanReviewRequest(text: string): boolean {
	if (/[?？]/u.test(text)) return false;
	const normalized = normalizePlanModeActivationText(text);
	return /(?:запусти|проведи|сделай)\s+(?:агентов\s+)?(?:проверить|ревью|review|critique|критику)\s+план/u.test(normalized)
		|| /(?:review|critique)\s+(?:the\s+)?plan\s+(?:with\s+)?(?:agents|reviewers)/u.test(normalized);
}

function latestAssistantTextFromEntries(entries: Array<{ type?: string; message?: AgentMessage }>): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i].message;
		if (message && isAssistantMessage(message)) return getTextContent(message);
	}
	return "";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	const workflowPi = pi as ExtensionAPI & {
		registerTool?: (tool: any) => void;
		getActiveTools?: () => Array<{ name: string } | string>;
		getAllTools?: () => Array<{ name: string } | string>;
	};
	let planModeEnabled = false;
	let autoExecuteEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let autoPlanReviewState: "idle" | "awaiting_revision" = "idle";
	let autoPlanReviewResults: PlanReviewResult[] = [];
	let prePlanActiveToolNames: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function toolName(tool: { name: string } | string): string | undefined {
		return typeof tool === "string" ? tool : tool?.name;
	}

	function uniqueToolNames(names: Array<string | undefined>): string[] {
		return [...new Set(names.filter((name): name is string => Boolean(name)))];
	}

	function readActiveToolNames(): string[] | undefined {
		const activeTools = workflowPi.getActiveTools?.();
		if (!activeTools) return undefined;
		return uniqueToolNames(activeTools.map(toolName));
	}

	function readRegisteredToolNames(): Set<string> | undefined {
		const allTools = workflowPi.getAllTools?.();
		if (!allTools) return undefined;
		return new Set(uniqueToolNames(allTools.map(toolName)));
	}

	function normalModeTools(): string[] {
		const registeredTools = readRegisteredToolNames();
		const mandatoryRegisteredWorkflowTools = registeredTools
			? MANDATORY_WORKFLOW_TOOLS.filter((name) => registeredTools.has(name))
			: MANDATORY_WORKFLOW_TOOLS;
		return uniqueToolNames([...(prePlanActiveToolNames?.length ? prePlanActiveToolNames : NORMAL_MODE_FALLBACK_TOOLS), ...mandatoryRegisteredWorkflowTools]);
	}

	function snapshotNormalToolSurface(): void {
		prePlanActiveToolNames = readActiveToolNames() ?? prePlanActiveToolNames ?? normalModeTools();
	}

	function restoreNormalToolSurface(): string[] {
		const tools = normalModeTools();
		pi.setActiveTools(tools);
		return tools;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			const label = autoExecuteEnabled ? "⏸ plan-auto" : "⏸ plan";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function syncWorkflowPlanMode(ctx: ExtensionContext, planMode: "off" | "strict" | "auto", sessionMode?: string, extra: Record<string, unknown> = {}): void {
		pi.events.emit("workflow-state:update", {
			ctx,
			planMode,
			sessionMode,
			...extra,
		});
	}

	async function detectGitValue(ctx: ExtensionContext, args: string[]): Promise<string | undefined> {
		const fullArgs = ctx.cwd ? ["-C", ctx.cwd, ...args] : args;
		const result = await pi.exec("git", fullArgs);
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	}

	async function detectGitValueAt(cwd: string | undefined, args: string[]): Promise<string | undefined> {
		const fullArgs = cwd ? ["-C", cwd, ...args] : args;
		const result = await pi.exec("git", fullArgs);
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	}

	function normalizePlanFieldValue(value: string): string {
		let normalized = value.trim();
		normalized = normalized.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim();
		normalized = normalized.replace(/^`([^`]+)`$/u, "$1").trim();
		normalized = normalized.replace(/^["'“”‘’]([^"'“”‘’]+)["'“”‘’]$/u, "$1").trim();
		normalized = normalized.replace(/[.,;:]$/u, "").trim();
		return normalized;
	}

	function latestPlanField(text: string, names: string[]): string | undefined {
		const namePattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
		const fieldRegex = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${namePattern})\\s*[:=]\\s*(.*)$`, "iu");
		const lines = text.split(/\r?\n/u);
		let value: string | undefined;
		for (let index = 0; index < lines.length; index++) {
			const match = lines[index]?.match(fieldRegex);
			if (!match) continue;

			let rawValue = match[1]?.trim();
			if (!rawValue && index + 1 < lines.length) {
				const nextLine = lines[index + 1]?.trim();
				if (nextLine && /^[-*]\s+/u.test(nextLine)) rawValue = nextLine.replace(/^[-*]\s+/u, "").trim();
			}
			if (rawValue) value = normalizePlanFieldValue(rawValue);
		}
		return value;
	}

	function worktreeRecovery(worktreePath: string, branch?: string): string {
		const branchFlag = branch ? ` --branch ${branch}` : " --branch <branch>";
		return `Recovery: create the task worktree with \`bd worktree create ${worktreePath}${branchFlag}\` from the project checkout, or update workflow-state to a readable task worktree before calling \`workflow_plan_approved\`.`;
	}

	function latestRecordedWorkflowScope(ctx: ExtensionContext, beadId: string): WorkflowStateSnapshot | undefined {
		const sessionKey = currentSessionKey(ctx);
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		const candidates = entries
			.map((entry) => {
				const typedEntry = entry as { type?: string; customType?: string; data?: unknown };
				if (typedEntry.type !== "workflow-state" && typedEntry.customType !== "workflow-state") return undefined;
				return isWorkflowStateSnapshot(typedEntry.data) ? typedEntry.data : undefined;
			})
			.filter((state): state is WorkflowStateSnapshot => {
				if (!state || state.activeBead !== beadId) return false;
				if (state.sessionKey && sessionKey && state.sessionKey !== sessionKey) return false;
				return true;
			});
		if (candidates.length === 0) return undefined;

		const runtimeOwnerKey = currentRuntimeOwnerKey();
		const currentRuntimeCandidates = candidates.filter((state) => state.runtimeOwnerKey === runtimeOwnerKey);
		return (currentRuntimeCandidates.length > 0 ? currentRuntimeCandidates : candidates).at(-1);
	}

	async function validatedWorktreeScope(source: "approved plan evidence" | "recorded workflow-state", worktreePath: string, expectedBranch?: string, startCommit?: string): Promise<{ branch?: string; worktreePath?: string; startCommit?: string; error?: string }> {
		const detectedWorktreePath = await detectGitValueAt(worktreePath, ["rev-parse", "--show-toplevel"]);
		if (detectedWorktreePath !== worktreePath) return { error: `${source} worktree is not a readable git worktree: ${worktreePath}. ${worktreeRecovery(worktreePath, expectedBranch)}` };

		const branch = await detectGitValueAt(detectedWorktreePath, ["branch", "--show-current"]);
		if (expectedBranch && branch !== expectedBranch) return { error: `${source} branch ${expectedBranch} does not match worktree branch ${branch ?? "<unknown>"}. ${worktreeRecovery(worktreePath, expectedBranch)}` };

		return {
			branch: branch ?? expectedBranch,
			worktreePath: detectedWorktreePath,
			startCommit: startCommit ?? await detectGitValueAt(detectedWorktreePath, ["rev-parse", "HEAD"]),
		};
	}

	async function approvalScope(ctx: ExtensionContext, beadId: string, planEvidence: string): Promise<{ branch?: string; worktreePath?: string; startCommit?: string; error?: string }> {
		const evidenceWorktreePath = latestPlanField(planEvidence, ["WORKTREE", "Worktree", "worktree", "worktreePath", "Worktree / cwd"]);
		const evidenceBranch = latestPlanField(planEvidence, ["BRANCH", "Branch", "branch"]);
		const evidenceStartCommit = latestPlanField(planEvidence, ["START_COMMIT", "Start-commit", "Start commit", "startCommit", "start"]);

		if (evidenceWorktreePath) {
			const scoped = await validatedWorktreeScope("approved plan evidence", evidenceWorktreePath, evidenceBranch, evidenceStartCommit);
			if (scoped.error) return scoped;
			if (!scoped.startCommit) scoped.startCommit = await detectGitValue(ctx, ["rev-parse", "HEAD"]);
			return scoped;
		}

		if (evidenceBranch) return { error: `approved plan evidence names branch ${evidenceBranch}, but no worktree path was found` };

		const recordedScope = latestRecordedWorkflowScope(ctx, beadId);
		if (recordedScope?.worktreePath) {
			const scoped = await validatedWorktreeScope("recorded workflow-state", recordedScope.worktreePath, recordedScope.branch, recordedScope.startCommit);
			if (scoped.error) return scoped;
			if (!scoped.startCommit) scoped.startCommit = await detectGitValue(ctx, ["rev-parse", "HEAD"]);
			return scoped;
		}
		if (recordedScope?.branch || recordedScope?.startCommit) {
			return { error: "recorded workflow-state has branch/start scope but no worktreePath; refusing to approve against ambiguous main-start cwd" };
		}

		const ctxBranch = await detectGitValue(ctx, ["branch", "--show-current"]);
		const ctxWorktreePath = await detectGitValue(ctx, ["rev-parse", "--show-toplevel"]);
		const ctxStartCommit = await detectGitValue(ctx, ["rev-parse", "HEAD"]);
		return { branch: ctxBranch, worktreePath: ctxWorktreePath, startCommit: ctxStartCommit };
	}

	function currentSessionKey(ctx: ExtensionContext): string | undefined {
		const manager = ctx.sessionManager;
		const sessionId = manager?.getSessionId?.();
		if (sessionId) return `id:${sessionId}`;
		const sessionFile = manager?.getSessionFile?.();
		if (sessionFile) return `file:${sessionFile}`;
		const leafId = manager?.getLeafId?.();
		if (leafId) return `leaf:${leafId}`;
		return undefined;
	}

	function validatePlanEvidence(planEvidence: string): string | undefined {
		const trimmed = planEvidence.trim();
		if (trimmed.length < 40) return "planEvidence must contain at least 40 characters of auditable plan/approval evidence";
		if (!/(plan|план|acceptance|verification|files|риски|провер)/i.test(trimmed)) return "planEvidence must mention plan content, files, acceptance, verification, or risks";
		return undefined;
	}

	type WorkflowStateEntry = {
		activeBead?: string;
		branch?: string;
		worktreePath?: string;
		startCommit?: string;
	};

	function latestWorkflowStateEntry(ctx: ExtensionContext): WorkflowStateEntry | undefined {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of [...entries].reverse()) {
			const isWorkflowState = entry.type === "workflow-state" || (entry.type === "custom" && entry.customType === "workflow-state");
			if (!isWorkflowState) continue;
			const data = entry.data as WorkflowStateEntry | undefined;
			if (data?.activeBead) return data;
		}
		return undefined;
	}

	function planEvidenceHasLinePrefix(planEvidence: string, alias: string): boolean {
		const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|\\n)\\s*${escaped}`).test(planEvidence);
	}

	function hasEvidenceAlias(planEvidence: string, aliases: string[]): boolean {
		return aliases.some((alias) => planEvidenceHasLinePrefix(planEvidence, alias));
	}

	function normalizedApprovalEvidence(planEvidence: string): string {
		const trimmed = planEvidence.trim();
		const sections = [trimmed];
		if (!hasEvidenceAlias(trimmed, ["Plan:", "Problem:"])) {
			sections.unshift("Plan:");
		}
		if (!hasEvidenceAlias(trimmed, ["Files to change:"])) {
			sections.push("Files to change:\n- See approved plan above and bead files/context.");
		}
		if (!hasEvidenceAlias(trimmed, ["Acceptance:"])) {
			sections.push("Acceptance:\n- Execute the approved plan and satisfy bead acceptance criteria.");
		}
		if (!hasEvidenceAlias(trimmed, ["Verification / acceptance checks:"])) {
			sections.push("Verification / acceptance checks:\n- Run checks listed in the approved plan and bead verification section.");
		}
		return sections.join("\n\n");
	}

	function renderPlanExecutionAction(beadId: string, worktreePath?: string): string {
		return worktreePath ? `dispatch_supervisor(beadId=${beadId}, cwd=${worktreePath})` : `dispatch_supervisor(beadId=${beadId})`;
	}

	async function recordRuntimeHookMissing(ctx: ExtensionContext, beadId: string, action: string, error: string): Promise<void> {
		const content = [
			"BLOCKED: runtime hook missing",
			`Bead: ${beadId}`,
			`Action: ${action}`,
			`Reason: ${error}`,
			"Немедленный системный blocker: PLAN APPROVED записан, но Pi runtime не смог запустить следующий typed workflow step автономно. Это не silent stall; требуется исправить runtime hook, а не отправлять новое сообщение в чат.",
		].join("\n");
		await pi.exec("bd", ["comments", "add", beadId, content]);
		syncWorkflowPlanMode(ctx, "off", "blocked", { state: "blocked", activeBead: beadId, planApproved: true });
		pi.sendMessage(
			{ customType: "post-approval-continuation-blocked", content, display: true },
			{ triggerTurn: false },
		);
	}

	function sendPreDispatchProgress(beadId: string, action: string): void {
		const content = [
			"PLAN APPROVED: продолжение запущено.",
			`Bead: ${beadId}`,
			"State: started/running",
			`Next typed action: ${action}`,
		].join("\n");
		try {
			pi.sendMessage(
				{ customType: "post-approval-continuation-started", content, display: true },
				{ triggerTurn: false },
			);
		} catch {
			// Best-effort visible progress only: dispatch continuation must still run.
		}
	}

	async function triggerApprovedPlanContinuation(ctx: ExtensionContext, beadId: string, worktreePath?: string): Promise<void> {
		const action = renderPlanExecutionAction(beadId, worktreePath);
		sendPreDispatchProgress(beadId, action);
		const result = await requestSupervisorDispatch(pi, { beadId, cwd: worktreePath }, ctx);
		if (!result.ok) {
			await recordRuntimeHookMissing(ctx, beadId, action, result.error ?? "typed continuation returned without success");
			return;
		}
		pi.sendMessage(
			{ customType: "post-approval-continuation", content: `PLAN APPROVED continuation completed: ${action}\n\n${result.text}`, display: true },
			{ triggerTurn: false },
		);
	}

	async function approvePlanForExecution(ctx: ExtensionContext, planEvidence: string): Promise<{ approved: boolean; beadId?: string; worktreePath?: string }> {
		const workflowState = latestWorkflowStateEntry(ctx);
		const beadId = workflowState?.activeBead;
		if (!beadId) {
			syncWorkflowPlanMode(ctx, planModeEnabled ? (autoExecuteEnabled ? "auto" : "strict") : "off", "blocked", { planApproved: false });
			pi.sendMessage(
				{
					customType: "plan-approval-recovery",
					content: "План не запущен: не найден active bead в workflow-state, поэтому нельзя записать durable `PLAN APPROVED` comment. Recovery: вызовите `workflow_update(bead=<id>, state=planning)` и затем `workflow_plan_approved(beadId=<id>, planEvidence=<approved plan>)`.",
					display: true,
				},
				{ triggerTurn: false },
			);
			return { approved: false };
		}

		const result = await approvePlanTool({ beadId, planEvidence: normalizedApprovalEvidence(planEvidence), approvedBy: "Максим" }, ctx);
		if (!result.details?.ok) {
			syncWorkflowPlanMode(ctx, planModeEnabled ? (autoExecuteEnabled ? "auto" : "strict") : "off", "blocked", { activeBead: beadId, planApproved: false });
			pi.sendMessage(
				{
					customType: "plan-approval-recovery",
					content: `План не запущен: durable \`PLAN APPROVED\` comment не записан. ${result.content[0].text} Recovery: выполните \`workflow_plan_approved(beadId=${beadId}, planEvidence=<approved plan>)\` после устранения причины.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			return { approved: false };
		}
		return { approved: true, beadId, worktreePath: result.details?.worktreePath as string | undefined };
	}

	async function planReviewTool(params: { draftPlan: string }, ctx: ExtensionContext) {
		const draftPlan = params.draftPlan.trim();
		if (!draftPlan) {
			return toolText("workflow_plan_review blocked: draftPlan is required", { ok: false, error: "draftPlan is required" });
		}

		const results = await runReviewGateForPlan(ctx, draftPlan);
		const gate = evaluatePlanReviewGate(results);
		const renderedResults = renderPlanReviewResults(results);
		if (!gate.ok) {
			const reasons = gate.reasons.map((reason) => `- ${reason}`).join("\n");
			return toolText(
				`workflow_plan_review blocked. Do not execute or approve the plan until blockers are resolved.\n\n${reasons}\n\nReviewer output:\n\n${renderedResults}`,
				{ ok: false, gate, results },
			);
		}

		return toolText(
			`workflow_plan_review complete. Implementation remains blocked until the revised plan explicitly adjudicates accepted/rejected findings and receives normal approval.\n\n${renderedResults}`,
			{ ok: true, gate, results },
		);
	}

	async function approvePlanTool(params: { beadId: string; planEvidence: string; approvedBy?: string }, ctx: ExtensionContext) {
		const evidenceError = validatePlanEvidence(params.planEvidence);
		if (evidenceError) return toolText(`workflow_plan_approved blocked: ${evidenceError}`, { ok: false, error: evidenceError });

		const { branch, worktreePath, startCommit, error: approvalScopeError } = await approvalScope(ctx, params.beadId, params.planEvidence);
		if (approvalScopeError) return toolText(`workflow_plan_approved blocked: ${approvalScopeError}`, { ok: false, error: approvalScopeError });
		const sessionKey = currentSessionKey(ctx);
		const approvedAt = new Date().toISOString();
		const comment = [
			"PLAN APPROVED",
			`Approved-by: ${params.approvedBy || "Максим"}`,
			`Approved-at: ${approvedAt}`,
			branch ? `BRANCH: ${branch}` : undefined,
			worktreePath ? `WORKTREE: ${worktreePath}` : undefined,
			startCommit ? `START_COMMIT: ${startCommit}` : undefined,
			sessionKey ? `PI_SESSION_KEY: ${sessionKey}` : undefined,
			"",
			params.planEvidence.trim(),
		].filter((line) => line !== undefined).join("\n");

		const result = await pi.exec("bd", ["comments", "add", params.beadId, comment]);
		if (result.code !== 0) {
			return toolText(`workflow_plan_approved failed before session update: ${(result.stderr || result.stdout).trim()}`, { ok: false, code: result.code });
		}

		planModeEnabled = false;
		autoExecuteEnabled = false;
		executionMode = false;
		restoreNormalToolSurface();
		syncWorkflowPlanMode(ctx, "off", "implementing", { state: "implementing", activeBead: params.beadId, branch, worktreePath, startCommit, planApproved: true });
		updateStatus(ctx);
		persistState();
		await triggerApprovedPlanContinuation(ctx, params.beadId, worktreePath);
		return toolText(`workflow_plan_approved recorded for ${params.beadId}; plan mode off; sessionMode=implementing; continuation attempted`, { ok: true, beadId: params.beadId, branch, worktreePath, startCommit });
	}

	async function claimWorkflowBead(bead: string, ctx: ExtensionContext): Promise<boolean> {
		const result = await requestWorkflowClaim(pi, bead, ctx);
		if (!result.ok && result.error && ctx.hasUI) ctx.ui.notify(result.error, "error");
		return result.ok;
	}

	function enterPlanMode(ctx: ExtensionContext, autoExecute: boolean): void {
		if (!planModeEnabled) snapshotNormalToolSurface();
		planModeEnabled = true;
		autoExecuteEnabled = autoExecute;
		executionMode = false;
		autoPlanReviewState = "idle";
		autoPlanReviewResults = [];
		todoItems = [];
		pi.setActiveTools(PLAN_MODE_TOOLS);
		if (ctx.hasUI) ctx.ui.notify(`${autoExecute ? "Auto " : ""}Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		syncWorkflowPlanMode(ctx, autoExecute ? "auto" : "strict", "planning");
		updateStatus(ctx);
		persistState();
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		autoExecuteEnabled = false;
		executionMode = false;
		autoPlanReviewState = "idle";
		autoPlanReviewResults = [];
		todoItems = [];
		const restoredTools = restoreNormalToolSurface();
		if (ctx.hasUI) ctx.ui.notify(`Plan mode disabled. Full access restored: ${restoredTools.join(", ")}`);
		syncWorkflowPlanMode(ctx, "off", "idle");
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			exitPlanMode(ctx);
		} else {
			enterPlanMode(ctx, false);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			autoExecute: autoExecuteEnabled,
			todos: todoItems,
			executing: executionMode,
			autoPlanReviewState,
			autoPlanReviewResults,
		});
	}

	if (workflowPi.registerTool) {
		workflowPi.registerTool({
			name: "workflow_plan_mode",
			label: "Workflow Plan Mode",
			description: "Enter/exit strict or auto plan mode and update active tool restrictions plus workflow-state metadata. Slash commands are optional human shortcuts.",
			parameters: WorkflowPlanModeParams,
			async execute(_id: string, params: { mode: "off" | "strict" | "auto"; reason?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				let activeTools: string[];
				if (params.mode === "off") {
					exitPlanMode(ctx);
					activeTools = normalModeTools();
				} else {
					enterPlanMode(ctx, params.mode === "auto");
					activeTools = PLAN_MODE_TOOLS;
				}
				return toolText(`workflow_plan_mode=${params.mode}${params.reason ? `: ${params.reason}` : ""}`, { mode: params.mode, activeTools });
			},
		});

		workflowPi.registerTool({
			name: "workflow_plan_review",
			label: "Workflow Plan Review",
			description: "Run required plan-review reviewers against a draft plan and return structured gate findings without mutating files, bd, git, workflow approval, merge-slot, or plan mode state.",
			parameters: { type: "object", properties: { draftPlan: { type: "string" } }, required: ["draftPlan"], additionalProperties: false },
			async execute(_id: string, params: { draftPlan: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				return planReviewTool(params, ctx);
			},
		});

		workflowPi.registerTool({
			name: "workflow_plan_approved",
			label: "Workflow Plan Approved",
			description: "Write PLAN APPROVED evidence to bd and atomically exit plan mode/update workflow-state only after the comment succeeds.",
			parameters: WorkflowPlanApprovedParams,
			async execute(_id: string, params: { beadId: string; planEvidence: string; approvedBy?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				return approvePlanTool(params, ctx);
			},
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle strict plan mode (read-only exploration; user approval required)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-auto", {
		description: "Enter plan mode and auto-execute only if the plan passes the required quality gate",
		handler: async (_args, ctx) => enterPlanMode(ctx, true),
	});

	pi.registerCommand("plan-cancel", {
		description: "Cancel plan mode and restore full tool access",
		handler: async (_args, ctx) => exitPlanMode(ctx),
	});

	pi.registerCommand("plan-review", {
		description: "Run required plan-review agents against the latest draft plan without approving or executing it",
		handler: async (_args, ctx) => runStrictPlanCritique(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	async function runReviewGateForPlan(ctx: ExtensionContext, draftPlan: string): Promise<PlanReviewResult[]> {
		const cwd = ctx.cwd || process.cwd();
		return runPlanReviewers(pi, cwd, draftPlan);
	}

	async function requestRevisionAfterPlanReview(ctx: ExtensionContext, draftPlan: string): Promise<void> {
		const results = await runReviewGateForPlan(ctx, draftPlan);
		const gate = evaluatePlanReviewGate(results);
		autoPlanReviewResults = results;
		if (!gate.ok) {
			const reasons = gate.reasons.map((reason) => `- ${reason}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-review-gate-blocked",
					content: `**Auto-execute blocked by plan-review gate.**\n\n${reasons}\n\nReviewer output:\n\n${renderPlanReviewResults(results)}\n\nRemain in plan mode/read-only and resolve blockers before execution.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			persistState();
			return;
		}

		autoPlanReviewState = "awaiting_revision";
		pi.sendMessage(
			{
				customType: "plan-review-findings",
				content: `[PLAN REVIEW GATE COMPLETE]\n\nReviewer findings:\n\n${renderPlanReviewResults(results)}\n\nRevise the plan. You must analyze findings instead of accepting them blindly. Return a revised plan with these exact sections:\n\nReviewer findings summary:\nAccepted findings:\nRejected findings:\nUnresolved blockers: none\nRevised plan:\nFiles to change:\nAcceptance:\nRisks / rollback:\nAUTO_EXECUTE_ALLOWED: true`,
				display: true,
			},
			{ triggerTurn: true },
		);
		persistState();
	}

	async function runStrictPlanCritique(ctx: ExtensionContext): Promise<void> {
		const draftPlan = latestAssistantTextFromEntries(ctx.sessionManager.getEntries() as Array<{ type?: string; message?: AgentMessage }>);
		if (!draftPlan.trim()) {
			pi.sendMessage({ customType: "plan-review-blocked", content: "**Plan review blocked.** No draft plan found in the current session.", display: true }, { triggerTurn: false });
			return;
		}
		const results = await runReviewGateForPlan(ctx, draftPlan);
		pi.sendMessage(
			{
				customType: "plan-review-findings",
				content: `**Strict plan critique complete.** Implementation remains blocked until explicit approval.\n\n${renderPlanReviewResults(results)}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		persistState();
	}

	// Natural-language activation for explicit claim+plan requests and clear enter-plan-mode requests.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		const workflowIntent = parseWorkflowIntent(event.text);
		if (shouldAutoClaimAndPlan(workflowIntent)) {
			const claimed = await claimWorkflowBead(workflowIntent.beadId, ctx);
			if (claimed) enterPlanMode(ctx, false);
			return { action: "handled" };
		}
		if (planModeEnabled && isExplicitPlanReviewRequest(event.text)) {
			await runStrictPlanCritique(ctx);
			return { action: "handled" };
		}
		if (!isNaturalLanguagePlanModeActivation(event.text)) return;

		enterPlanMode(ctx, false);
		return { action: "handled" };
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Agents should call workflow_plan_mode with mode=off when an approved workflow requires leaving plan mode; /plan remains an optional human UI shortcut.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire, workflow_status, workflow_plan_mode, workflow_plan_approved, workflow_plan_review, plan_subagent
- You MAY use plan_subagent only for read-only planning agents (detective/architect); generic subagent and implementation supervisors remain unavailable in plan mode.
- You CANNOT use: edit, write, subagent, dispatch_supervisor, dispatch_reviewer, dispatch_docs_agent, review_bead, workflow_submit_for_review, workflow_complete (file/workflow mutations are disabled until approval)
- After approved/cancelled plan mode, Pi restores the pre-plan active tool surface plus registered mandatory workflow tools.
- Bash is restricted to an allowlist of read-only commands
- bd read-only commands are allowed: bd show, bd comments, bd list, bd ready, selected bd dep/dolt status commands
- bd mutating commands are blocked: bd create, bd update, bd close, bd comments add/delete, bd merge-slot acquire/release, bd dolt commit/push/pull

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered draft plan under a "Plan:" header.

For autonomous planning (for example, when the user says to work autonomously in plan mode), you MUST call workflow_plan_review with the complete draftPlan before presenting the final plan. Then revise the plan with Reviewer findings summary, Accepted findings, Rejected findings, and Unresolved blockers sections. Do not call workflow_plan_approved yourself unless Maxim explicitly approves.

If auto-plan execution was explicitly requested, create a draft plan first. Pi will run required multi-agent plan-review agents before implementation. After reviewer findings are returned, your revised plan MUST include all sections below or execution will remain blocked:

Reviewer findings summary:
- Summary of reviewer verdicts and important findings

Accepted findings:
- Finding accepted and concrete plan change

Rejected findings:
- Finding rejected and reason, or none

Unresolved blockers: none

Revised plan:
1. First step description
2. Second step description
...

Files to change:
- path/to/file: intended change

Acceptance:
- Command/check and expected result

Risks / rollback:
- Risk and rollback strategy

AUTO_EXECUTE_ALLOWED: true

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				restoreNormalToolSurface();
				syncWorkflowPlanMode(ctx, "off", "idle");
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const lastAssistantText = lastAssistant ? getTextContent(lastAssistant) : "";
		if (lastAssistant) {
			const extracted = extractTodoItems(lastAssistantText);
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (autoExecuteEnabled) {
			if (autoPlanReviewState === "idle") {
				await requestRevisionAfterPlanReview(ctx, lastAssistantText);
				return;
			}

			const missing = missingRevisedPlanSections(lastAssistantText);
			if (missing.length === 0) {
				const approval = await approvePlanForExecution(ctx, lastAssistantText);
				if (!approval.approved) {
					persistState();
					return;
				}
				autoPlanReviewState = "idle";
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();

				return;
			}

			const missingText = missing.map((item) => `- ${item}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-quality-gate-failed",
					content: `**Auto-execute blocked.** Missing required revised-plan sections after plan review:\n\n${missingText}\n\nReviewer output:\n\n${renderPlanReviewResults(autoPlanReviewResults)}\n\nRemain in plan mode and refine the revised plan.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			persistState();
			return;
		}

		if (!ctx.hasUI) return;

		// Bead workflow progress is tracked via bd/workflow-state/typed tools, not plan todo-list UI.
		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const approval = await approvePlanForExecution(ctx, lastAssistantText);
			if (!approval.approved) {
				persistState();
				return;
			}
			executionMode = false;
			todoItems = [];
			updateStatus(ctx);

		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| { data?: { enabled: boolean; autoExecute?: boolean; todos?: TodoItem[]; executing?: boolean; autoPlanReviewState?: "idle" | "awaiting_revision"; autoPlanReviewResults?: PlanReviewResult[] } }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			autoExecuteEnabled = planModeEntry.data.autoExecute ?? autoExecuteEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			autoPlanReviewState = planModeEntry.data.autoPlanReviewState ?? autoPlanReviewState;
			autoPlanReviewResults = planModeEntry.data.autoPlanReviewResults ?? autoPlanReviewResults;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			syncWorkflowPlanMode(ctx, autoExecuteEnabled ? "auto" : "strict", "planning");
		} else if (!executionMode) {
			syncWorkflowPlanMode(ctx, "off", "idle");
		}
		updateStatus(ctx);
	});
}
