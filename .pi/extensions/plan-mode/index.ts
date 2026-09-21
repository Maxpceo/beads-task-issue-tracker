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
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import {
	AUTOPILOT_CLOSE_HOP_SUMMARY,
	describeAutopilotGitState,
	extractAcceptanceCheckLines,
	extractPlanApprovedFiles,
	extractPlanApprovedSummary,
	extractTodoItems,
	formatAutopilotCloseReport,
	isSafeCommand,
	markCompletedSteps,
	type AutopilotCloseReportFacts,
	type TodoItem,
} from "./utils.js";
import {
	createQuestionUiFactory,
	formatQuestionnaireAnswerLines,
	normalizeQuestions,
	type QuestionnaireUiResult,
} from "./question-ui.js";
import {
	READY_ACTIONS,
	createPlanDocumentComponent,
	createReadyUiFactory,
	type ReadyAction,
} from "./ready-ui.js";
import { currentRuntimeOwnerKey, requestWorkflowClaim } from "../workflow-state/index";
import { parseWorkflowIntent, shouldAutoClaimAndPlan } from "../workflow-intent/index";
import {
	MAX_PLAN_REVIEW_CYCLES,
	MAX_PLAN_REVIEW_TOTAL_SPAWNS,
	PLAN_REVIEW_WAITING_TRIO_ENTRY,
	PLAN_REVIEW_WAITING_TRIO_NOTICE,
	REQUIRED_PLAN_REVIEWERS,
	announceVisiblePlanReviewWait,
	classifyPlanReviewRisk,
	evaluatePlanReviewGate,
	hasImportantOrCriticalFindings,
	missingRevisedPlanSections,
	planReviewStopAdvice,
	renderPlanReviewResults,
	runPlanReviewers,
	type PlanReviewGateResult,
	type PlanReviewResult,
	type PlanReviewStopAdvice,
} from "../plan-review/index";
import {
	closeVisibleDispatch,
	completeVisibleDispatch,
	findLiveRegistryEntriesForBead,
	findRegistryByTaskId,
	parseVisiblePing,
	requestReviewerDispatch,
	requestSupervisorDispatch,
	type ParsedVisiblePing,
} from "../beads-dispatch/index";
import { finalizeVisibleReviewClose } from "../review-workflow/index";
import { PROTECTED_BRANCHES, validateTaskScopePath } from "../worktree-scope/index";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "plan_mode_complete", "workflow_status", "workflow_plan_mode", "workflow_plan_approved", "workflow_plan_review", "plan_subagent"];
const PLAN_MODE_TOOL_SET = new Set(PLAN_MODE_TOOLS);
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
	"complete_visible_dispatch",
	"followup_visible_dispatch",
	"close_visible_dispatch",
	"spawn_task_workspace",
];

type ExecResult = { stdout?: string; stderr?: string; code?: number };
type ExecApi = { exec: (command: string, args: string[]) => Promise<ExecResult> };

async function readExecJson(pi: ExecApi, command: string, args: string[]): Promise<unknown | undefined> {
	try {
		const result = await pi.exec(command, args);
		if (result.code !== 0) return undefined;
		const stdout = String(result.stdout ?? "").trim();
		if (!stdout) return undefined;
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
}

function commentTextsFromJson(json: unknown): string[] {
	if (!Array.isArray(json)) return [];
	return json
		.map((item) => {
			if (typeof item === "string") return item;
			if (item && typeof item === "object" && "text" in item) return String((item as { text?: unknown }).text ?? "");
			return "";
		})
		.filter((text) => text.trim().length > 0);
}

async function probeAutopilotGitNote(pi: ExecApi, worktree: string): Promise<string | undefined> {
	let upstream: string | null | undefined;
	try {
		const result = await pi.exec("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "@{u}"]);
		const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (result.code === 0) {
			const value = String(result.stdout ?? "").trim();
			upstream = value || undefined;
		} else if (/no upstream/i.test(combined)) {
			upstream = null;
		}
	} catch {
		/* unknown */
	}

	let ancestorOfMain: boolean | undefined;
	for (const ref of ["origin/main", "main", "origin/master", "master"]) {
		try {
			const result = await pi.exec("git", ["-C", worktree, "merge-base", "--is-ancestor", "HEAD", ref]);
			if (result.code === 0) {
				ancestorOfMain = true;
				break;
			}
			if (result.code === 1) {
				ancestorOfMain = false;
				break;
			}
		} catch {
			/* try next ref */
		}
	}
	return describeAutopilotGitState({ upstream, ancestorOfMain });
}

async function collectAutopilotCloseReportFacts(
	pi: ExecApi,
	input: { beadId: string; worktree?: string },
): Promise<AutopilotCloseReportFacts> {
	const facts: AutopilotCloseReportFacts = { beadId: input.beadId, summary: AUTOPILOT_CLOSE_HOP_SUMMARY };
	try {
		const shown = await readExecJson(pi, "bd", ["show", input.beadId, "--json"]);
		const bead = Array.isArray(shown) ? shown[0] : shown;
		const title = bead && typeof bead === "object" && "title" in bead ? String((bead as { title?: unknown }).title ?? "").trim() : "";
		if (title) facts.title = title;
	} catch {
		/* omit title */
	}

	try {
		const commentsJson = await readExecJson(pi, "bd", ["comments", input.beadId, "--json"]);
		const blob = commentTextsFromJson(commentsJson).join("\n\n").slice(0, 80_000);
		const planSummary = extractPlanApprovedSummary(blob);
		if (planSummary) facts.summary = `${planSummary}\n\n${AUTOPILOT_CLOSE_HOP_SUMMARY}`;
		const files = extractPlanApprovedFiles(blob);
		if (files.length > 0) facts.files = files;
		const checks = extractAcceptanceCheckLines(blob);
		if (checks.length > 0) facts.checks = checks;
	} catch {
		/* omit optional sections */
	}

	if (input.worktree) {
		try {
			const gitNote = await probeAutopilotGitNote(pi, input.worktree);
			if (gitNote) facts.gitNote = gitNote;
		} catch {
			/* omit git note */
		}
	}
	return facts;
}

const WorkflowPlanModeParams = {
	type: "object",
	properties: {
		mode: { type: "string", enum: ["off", "strict", "auto", "autopilot"], description: "Target plan mode. autopilot = auto-execute gate + Approved-by оркестратор + durable autopilot flag after plan=off" },
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

const PlanModeCompleteParams = {
	type: "object",
	properties: {
		plan: { type: "string", description: "Final plan text ready for human ready-UI (execute/stay/refine/plan-review). Call only when the plan is complete; do not call after a clarifying question." },
	},
	required: ["plan"],
	additionalProperties: false,
} as const;

const QuestionnaireParams = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			description: "One or more clarifying questions (example-compatible schema)",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Unique question id" },
					label: { type: "string", description: "Short tab label" },
					prompt: { type: "string", description: "Full question text" },
					options: {
						type: "array",
						items: {
							type: "object",
							properties: {
								value: { type: "string" },
								label: { type: "string" },
								description: { type: "string" },
							},
							required: ["value", "label"],
							additionalProperties: false,
						},
					},
					allowOther: { type: "boolean", description: "Allow custom text answer (default true)" },
				},
				required: ["id", "prompt", "options"],
				additionalProperties: false,
			},
		},
	},
	required: ["questions"],
	additionalProperties: false,
} as const;

function toolText(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

function normalizedToolCallName(toolName: string | undefined): string {
	return (toolName ?? "").split(".").at(-1)?.trim() ?? "";
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

/** NL activation for /plan-autopilot. Questions, negations, multi-id claims stay unhandled. */
function isNaturalLanguageAutopilotActivation(text: string): boolean {
	if (/[?？]/u.test(text)) return false;

	const normalized = normalizePlanModeActivationText(text);
	if (!normalized) return false;
	if (/(?:^|\s)(?:не|нет|без|dont|don't|do not|never|stop)\b/u.test(normalized)) return false;
	// Multiple bead ids → ambiguous claim+autopilot; leave to agent.
	const beadIds = normalized.match(/\bbeads?[\w.-]*-\w+/gi) ?? [];
	if (beadIds.length > 1) return false;

	const russianPatterns = [
		/^(?:пожалуйста\s+)?(?:я\s+)?работаю\s+автономно$/u,
		/^(?:пожалуйста\s+)?работать\s+автономно$/u,
		/^(?:пожалуйста\s+)?(?:работай|работайте)\s+автономно$/u,
		/^(?:пожалуйста\s+)?включи\s+(?:режим\s+)?autopilot$/u,
		/^(?:пожалуйста\s+)?включи\s+plan-autopilot$/u,
	];
	const englishPatterns = [
		/^(?:please\s+)?(?:i\s+)?(?:am\s+)?work(?:ing)?\s+autonomously$/u,
		/^(?:please\s+)?work\s+autonomously$/u,
		/^(?:please\s+)?enable\s+(?:plan[-\s]?)?autopilot$/u,
		/^(?:please\s+)?run\s+plan-autopilot$/u,
	];

	return [...russianPatterns, ...englishPatterns].some((pattern) => pattern.test(normalized));
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

type AutoPlanReviewState = "idle" | "awaiting_revision" | "blocked" | "stopped";

function restoreAutoPlanReviewState(value: unknown): AutoPlanReviewState | undefined {
	if (value === "idle" || value === "awaiting_revision" || value === "blocked" || value === "stopped") return value;
	return undefined;
}

function samePlanReviewDraft(a: string | undefined, b: string | undefined): boolean {
	return Boolean(a && b && a.trim() === b.trim());
}

function collectDeadPaneWithoutResultMarks(results: PlanReviewResult[]): string[] {
	const marks: string[] = [];
	const seen = new Set<string>();
	const consider = (text: string | undefined) => {
		if (!text) return;
		const match = text.match(/dead pane without result(?::\s*(\S+))?/i);
		if (!match) return;
		const pane = (match[1] ?? "").replace(/[.,;]+$/u, "");
		const mark = pane ? `dead pane without result: ${pane}` : "dead pane without result";
		if (seen.has(mark)) return;
		seen.add(mark);
		marks.push(mark);
	};
	for (const result of results) {
		consider(result.error);
		for (const blocker of result.unresolvedBlockers) consider(blocker);
		for (const finding of result.findings) {
			consider(finding.issue);
			consider(finding.evidence);
		}
	}
	return marks;
}

function isDeadPaneHardBlock(results: PlanReviewResult[]): boolean {
	return collectDeadPaneWithoutResultMarks(results).length > 0;
}

function formatDeadPaneHardBlockCopy(results: PlanReviewResult[]): string {
	const marks = collectDeadPaneWithoutResultMarks(results);
	const paneLine = marks.length > 0 ? marks.join("; ") : "dead pane without result";
	return [
		`HARD_BLOCK. ${paneLine}. findings=[].`,
		"This is a pane/runtime failure, not a plan-quality finding.",
		"Do not approve.",
		"Retry only with an explicit extraCycle, /plan-review, or Maxim «Отправить на plan-review» using the cached draftPlan.",
	].join(" ");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	const workflowPi = pi as ExtensionAPI & {
		registerTool?: (tool: any) => void;
		getActiveTools?: () => Array<{ name: string } | string>;
		getAllTools?: () => Array<{ name: string } | string>;
	};
	let planModeEnabled = false;
	let autoExecuteEnabled = false;
	/** Survives plan=off after approve so hop/close runtime can honor autopilot close contract. Cleared on cancel/exit. */
	let autopilotEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let autoPlanReviewState: AutoPlanReviewState = "idle";
	let autoPlanReviewResults: PlanReviewResult[] = [];
	/** workflow_plan_review spawn counter only (not /plan-auto runReviewGateForPlan). Reset on plan-mode off→on. */
	let planReviewCycleCount = 0;
	let lastPlanReviewStopAdvice: PlanReviewStopAdvice | undefined;
	let lastPlanReviewResults: PlanReviewResult[] = [];
	/** Last draft actually sent to reviewers; used for anti-respawn and /plan-review while blocked. */
	let lastPlanReviewDraftPlan: string | undefined;
	let prePlanActiveToolNames: string[] | undefined;
	/** Set only by plan_mode_complete; gates ready-UI in strict agent_end. */
	let pendingReadyPlan: string | undefined;

	pi.registerEntryRenderer("plan-ready-document", (entry) => {
		const data = entry.data as { content?: unknown } | undefined;
		const content = typeof data?.content === "string" ? data.content : "";
		return createPlanDocumentComponent(content, getMarkdownTheme());
	});

	pi.registerEntryRenderer("plan-ready-choice", (entry) => {
		const data = entry.data as { content?: unknown } | undefined;
		const content = typeof data?.content === "string" ? data.content : "";
		return createPlanDocumentComponent(content, getMarkdownTheme());
	});

	pi.registerEntryRenderer(PLAN_REVIEW_WAITING_TRIO_ENTRY, (entry) => {
		const data = entry.data as { content?: unknown } | undefined;
		const content = typeof data?.content === "string" ? data.content : PLAN_REVIEW_WAITING_TRIO_NOTICE;
		return new Text(content, 0, 0);
	});

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
			const label = autopilotEnabled ? "⏸ plan-autopilot" : autoExecuteEnabled ? "⏸ plan-auto" : "⏸ plan";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", label));
		} else if (autopilotEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "autopilot"));
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

	function shouldPreserveImplementingOnPlanIdle(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of [...entries].reverse()) {
			const isWorkflowState = entry.type === "workflow-state" || (entry.type === "custom" && entry.customType === "workflow-state");
			if (!isWorkflowState) continue;
			const data = entry.data as { activeBead?: string; state?: string; sessionMode?: string; bdStatus?: string } | undefined;
			if (!data?.activeBead) return false;
			const implementing = data.state === "implementing" || data.sessionMode === "implementing";
			const terminal = data.bdStatus === "closed" || data.bdStatus === "blocked" || data.bdStatus === "deferred" || data.state === "closed" || data.state === "blocked" || data.state === "deferred";
			return implementing && !terminal;
		}
		return false;
	}

	function syncWorkflowPlanMode(ctx: ExtensionContext, planMode: "off" | "strict" | "auto", sessionMode?: string, extra: Record<string, unknown> = {}): void {
		const event: Record<string, unknown> = { ctx, planMode, ...extra };
		if (sessionMode !== undefined) {
			const preserveImplementing = sessionMode === "idle" && extra.state !== "idle" && shouldPreserveImplementingOnPlanIdle(ctx);
			if (!preserveImplementing) event.sessionMode = sessionMode;
		}
		pi.events.emit("workflow-state:update", event);
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

	/** Worktree-only sanitize for planEvidence paths with trailing notes/inline wrappers. */
	function normalizeWorktreePathEvidence(value: string): string {
		let normalized = value.trim();
		if (!normalized) return normalized;

		// 1) strip trailing parenthetical/bracket notes: `/path` (created) / [already created]
		while (true) {
			const stripped = normalized.replace(/\s*[(\[].*?[)\]]\s*$/u, "").trim();
			if (stripped === normalized) break;
			normalized = stripped;
		}

		// 2) iterative unwrap whole-string quotes/backticks
		while (true) {
			const unwrapped = normalized
				.replace(/^`([^`]+)`$/u, "$1")
				.replace(/^["'“”‘’]([^"'“”‘’]+)["'“”‘’]$/u, "$1")
				.trim();
			if (unwrapped === normalized) break;
			normalized = unwrapped;
		}

		normalized = normalized.replace(/[.,;:]$/u, "").trim();

		// 3) if still dirty, extract first absolute POSIX path token (unanchored)
		const cleanAbsolutePath = /^\/[^\s`'"()[\]]+$/u.test(normalized);
		if (!cleanAbsolutePath) {
			const token = normalized.match(/\/[^\s`'"()[\]]+/u)?.[0];
			if (token) return token.replace(/[.,;:]+$/u, "");
			// never invent a path when none is present
		}

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

	function isCanonicalTaskBranch(branch?: string): branch is string {
		if (!branch || PROTECTED_BRANCHES.has(branch)) return false;
		return /^(?:feat|fix|docs|test|ci|refactor|task|chore)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(branch);
	}

	function isAbsoluteTaskWorktreePath(worktreePath?: string): worktreePath is string {
		return Boolean(worktreePath && worktreePath.startsWith("/") && !/\s/.test(worktreePath));
	}

	function worktreeRecovery(
		worktreePath: string | undefined,
		branch?: string,
		phase: "approval" | "continuation" = "approval",
		evidence?: { worktreePath?: string; branch?: string },
	): string {
		const protectedBranch = Boolean(branch && PROTECTED_BRANCHES.has(branch));
		const recoveryBranch =
			(!protectedBranch && isCanonicalTaskBranch(branch) ? branch : undefined)
			?? (isCanonicalTaskBranch(evidence?.branch) ? evidence?.branch : undefined);
		const recoveryPath =
			(!protectedBranch && isAbsoluteTaskWorktreePath(worktreePath) ? worktreePath : undefined)
			?? (isAbsoluteTaskWorktreePath(evidence?.worktreePath) ? evidence?.worktreePath : undefined);
		const nextStep = phase === "continuation"
			? "then retry `dispatch_supervisor` from that task worktree"
			: "then retry `workflow_plan_approved` with WORKTREE and BRANCH (no second human approval)";
		if (recoveryPath && recoveryBranch) {
			return `Recovery: create the task worktree with \`bd worktree create ${recoveryPath} --branch ${recoveryBranch}\` from the project checkout (allowed in plan=strict), ${nextStep}.`;
		}
		if (recoveryBranch) {
			return `Recovery: create the canonical task worktree with \`bd worktree create\` under the project worktrees root using \`--branch ${recoveryBranch}\` from the project checkout (allowed in plan=strict), ${nextStep}.`;
		}
		return `Recovery: create a canonical task worktree with \`bd worktree create <absolute-path> --branch <type>/<bead-suffix>-<domain-or-component>-<purpose>\` from the project checkout (allowed in plan=strict; not main/master), ${nextStep}.`;
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

	async function validatedWorktreeScope(
		source: "approved plan evidence" | "recorded workflow-state" | "continuation",
		worktreePath: string,
		expectedBranch?: string,
		startCommit?: string,
		phase: "approval" | "continuation" = "approval",
		evidence?: { worktreePath?: string; branch?: string },
	): Promise<{ branch?: string; worktreePath?: string; startCommit?: string; error?: string; code?: string }> {
		const detectedWorktreePath = await detectGitValueAt(worktreePath, ["rev-parse", "--show-toplevel"]);
		const detectedBranch = detectedWorktreePath ? await detectGitValueAt(detectedWorktreePath, ["branch", "--show-current"]) : undefined;
		const validated = validateTaskScopePath(worktreePath, {
			expectedBranch,
			exists: () => detectedWorktreePath != null,
			getRepoRoot: () => detectedWorktreePath,
			getBranch: () => detectedBranch,
		});
		if (!validated.ok) {
			const recovery = worktreeRecovery(worktreePath, expectedBranch ?? detectedBranch, phase, evidence);
			if (validated.error.code === "BRANCH_MISMATCH") {
				return { error: `${source} branch ${expectedBranch} does not match worktree branch ${detectedBranch ?? "<unknown>"}. ${recovery}`, code: validated.error.code };
			}
			if (validated.error.code === "WORKTREE_NOT_FOUND" || validated.error.code === "INVALID_WORKTREE" || validated.error.code === "MISSING_WORKTREE" || detectedWorktreePath !== worktreePath) {
				return { error: `${source} worktree is not a readable git worktree: ${worktreePath}. ${recovery}`, code: validated.error.code };
			}
			return { error: `${source} ${validated.error.message}. ${recovery}`, code: validated.error.code };
		}

		return {
			branch: validated.scope.branch,
			worktreePath: validated.scope.worktreePath,
			startCommit: startCommit ?? await detectGitValueAt(validated.scope.worktreePath, ["rev-parse", "HEAD"]),
		};
	}

	async function approvalScope(ctx: ExtensionContext, beadId: string, planEvidence: string): Promise<{ branch?: string; worktreePath?: string; startCommit?: string; error?: string }> {
		const evidenceWorktreePathRaw = latestPlanField(planEvidence, ["WORKTREE", "Worktree", "worktree", "worktreePath", "Worktree / cwd"]);
		const evidenceWorktreePath = evidenceWorktreePathRaw ? normalizeWorktreePathEvidence(evidenceWorktreePathRaw) : undefined;
		const evidenceBranch = latestPlanField(planEvidence, ["BRANCH", "Branch", "branch"]);
		const evidenceStartCommit = latestPlanField(planEvidence, ["START_COMMIT", "Start-commit", "Start commit", "startCommit", "start"]);
		const evidenceCanon = {
			worktreePath: isAbsoluteTaskWorktreePath(evidenceWorktreePath) ? evidenceWorktreePath : undefined,
			branch: isCanonicalTaskBranch(evidenceBranch) ? evidenceBranch : undefined,
		};

		if (evidenceWorktreePath) {
			const scoped = await validatedWorktreeScope("approved plan evidence", evidenceWorktreePath, evidenceBranch, evidenceStartCommit, "approval", evidenceCanon);
			if (!scoped.error) return scoped;
			const evidenceProtected = scoped.code === "PROTECTED_BRANCH" || Boolean(evidenceBranch && PROTECTED_BRANCHES.has(evidenceBranch));
			if (!evidenceProtected) return scoped;
		} else if (evidenceBranch && !PROTECTED_BRANCHES.has(evidenceBranch)) {
			return { error: `approved plan evidence names branch ${evidenceBranch}, but no worktree path was found. ${worktreeRecovery(undefined, evidenceBranch, "approval", evidenceCanon)}` };
		}

		const recordedScope = latestRecordedWorkflowScope(ctx, beadId);
		const recordedProtected = Boolean(recordedScope?.branch && PROTECTED_BRANCHES.has(recordedScope.branch));
		const recoveryCanon = {
			worktreePath: evidenceCanon.worktreePath ?? (isAbsoluteTaskWorktreePath(recordedScope?.worktreePath) && !recordedProtected ? recordedScope?.worktreePath : undefined),
			branch: evidenceCanon.branch ?? (isCanonicalTaskBranch(recordedScope?.branch) ? recordedScope?.branch : undefined),
		};
		const noReadableWithCanon = () =>
			`no readable task worktree is recorded or named in approved plan evidence. ${worktreeRecovery(undefined, undefined, "approval", recoveryCanon)}`;
		if (recordedScope?.worktreePath && !recordedProtected) {
			const scoped = await validatedWorktreeScope("recorded workflow-state", recordedScope.worktreePath, recordedScope.branch, recordedScope.startCommit, "approval", recoveryCanon);
			if (scoped.error) {
				if (scoped.code === "PROTECTED_BRANCH") return { error: noReadableWithCanon() };
				return scoped;
			}
			return scoped;
		}
		if (recordedProtected) {
			return { error: noReadableWithCanon() };
		}
		if (recordedScope?.branch || recordedScope?.startCommit) {
			// Incomplete recorded scope without a worktree: recoverable, not a dead-end incomplete-scope message.
			return { error: noReadableWithCanon() };
		}

		return { error: noReadableWithCanon() };
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

	function isRuntimeHookUnavailable(error: string): boolean {
		return /runtime hook missing|API unavailable|not available|registry/i.test(error);
	}

	// Close to isSupervisorRole (cmux-transport.ts:367); implementer clause is from KERNEL_FAILSAFE_AGENT (supervisor-routing.ts:6); the extra clause is intentional.
	function isSupervisorRegistryRole(role: string): boolean {
		return role.includes("supervisor") || role === "implementer";
	}

	function isLivePaneAlreadyRegistered(error: string): boolean {
		return /live pane already registered|повторный spawn/i.test(error);
	}

	function isDispatchReadinessFailure(error: string): boolean {
		return error.includes("readiness не пройдена");
	}

	function sendAlreadySpawnedSkip(beadId: string, live: Array<{ entry: { taskId?: string; role?: string } }>): void {
		const liveSummary = live.length > 0
			? live.map((item) => `${item.entry.taskId ?? "unknown"} (${item.entry.role ?? "unknown"})`).join(", ")
			: "(none listed)";
		const content = [
			"PLAN APPROVED continuation skipped: supervisor already spawned; waiting ping",
			`Bead: ${beadId}`,
			`Live: ${liveSummary}`,
			"Next: complete_visible_dispatch after supervisor ping. Do not dispatch_supervisor again.",
			"If no ping arrives (dead pane), inspect pane/registry and use close_visible_dispatch before re-dispatch.",
		].join("\n");
		pi.sendMessage(
			{ customType: "post-approval-continuation-idempotent-skip", content, display: true },
			{ triggerTurn: false },
		);
	}

	type ContinuationSkipReason = "fastPath" | "alreadySpawned";
	type ContinuationNext = "fastPath" | "alreadySpawned" | "dispatched" | "continuation-blocked";
	type ContinuationResult = {
		skipped: boolean;
		reason?: ContinuationSkipReason;
		next: ContinuationNext;
	};

	function skipAlreadySpawnedContinuation(beadId: string): { skipped: true; reason: "alreadySpawned"; next: "alreadySpawned" } {
		let live: ReturnType<typeof findLiveRegistryEntriesForBead> = [];
		try {
			live = findLiveRegistryEntriesForBead(beadId).filter((item) => isSupervisorRegistryRole(item.entry.role));
		} catch {
			live = [];
		}
		sendAlreadySpawnedSkip(beadId, live);
		return { skipped: true, reason: "alreadySpawned", next: "alreadySpawned" };
	}

	async function recordRuntimeHookMissing(ctx: ExtensionContext, beadId: string, action: string, error: string): Promise<void> {
		const content = [
			"BLOCKED: runtime hook missing",
			`Bead: ${beadId}`,
			`Action: ${action}`,
			`Reason: ${error}`,
			"Немедленный системный blocker: approval comment уже записан, но Pi runtime не смог запустить следующий typed workflow step автономно. Это не silent stall; требуется исправить runtime hook, а не отправлять новое сообщение в чат.",
		].join("\n");
		await pi.exec("bd", ["comments", "add", beadId, content]);
		syncWorkflowPlanMode(ctx, "off", "blocked", { state: "blocked", activeBead: beadId, planApproved: true });
		pi.sendMessage(
			{ customType: "post-approval-continuation-blocked", content, display: true },
			{ triggerTurn: false },
		);
	}

	async function recordContinuationScopeBlocked(ctx: ExtensionContext, beadId: string, error: string): Promise<void> {
		const content = [
			"BLOCKED: task worktree scope",
			`Bead: ${beadId}`,
			`Reason: ${error}`,
			"Continuation cannot start dispatch_supervisor without a readable task worktree. Create or update the task worktree, then retry dispatch_supervisor. Do not write another approval comment.",
		].join("\n");
		await pi.exec("bd", ["comments", "add", beadId, content]);
		syncWorkflowPlanMode(ctx, "off", "blocked", { state: "blocked", activeBead: beadId, planApproved: true });
		pi.sendMessage(
			{ customType: "post-approval-continuation-blocked", content, display: true },
			{ triggerTurn: false },
		);
	}

	async function recordContinuationReadinessBlocked(ctx: ExtensionContext, beadId: string, error: string): Promise<void> {
		const missingFields = error.includes("отсутствуют fields");
		const recovery = missingFields
			? "Fix canonical PLAN APPROVED fields. The heading must be exactly `Acceptance:` (not `Acceptance (…):`). Repeat the approve path only after that heading is already corrected. Do not re-approve with the same non-canonical heading."
			: "Fix the named cause in Reason, then retry dispatch_supervisor. Do not write another approval comment.";
		const content = [
			"BLOCKED: dispatch readiness",
			`Bead: ${beadId}`,
			`Reason: ${error}`,
			recovery,
			"Do not create or update a task worktree for this error.",
		].join("\n");
		await pi.exec("bd", ["comments", "add", beadId, content]);
		syncWorkflowPlanMode(ctx, "off", "blocked", { state: "blocked", activeBead: beadId, planApproved: true });
		pi.sendMessage(
			{ customType: "post-approval-continuation-blocked", content, display: true },
			{ triggerTurn: false },
		);
	}

	function sendPreDispatchProgress(ctx: ExtensionContext, beadId: string, action: string): void {
		const content = [
			"PLAN APPROVED: продолжение запущено.",
			`Bead: ${beadId}`,
			"State: started/running",
			`Next typed action: ${action}`,
		].join("\n");
		try {
			pi.sendMessage(
				{ customType: "post-approval-continuation-started", content, display: false },
				{ triggerTurn: false },
			);
		} catch {
			// Best-effort in-flight progress only: dispatch continuation must still run.
		}
		try {
			if (ctx.hasUI) ctx.ui.notify("Запускаю супервизор…", "info");
		} catch {
			// Best-effort toast only: dispatch continuation must still run.
		}
	}

	async function resolveContinuationCwd(ctx: ExtensionContext, beadId: string, approvedWorktreePath?: string): Promise<{ cwd?: string; error?: string }> {
		const recorded = latestRecordedWorkflowScope(ctx, beadId);
		const attempts: Array<{ path?: string; expectedBranch?: string; source: "recorded workflow-state" | "approved plan evidence" }> = [
			{ path: recorded?.worktreePath, expectedBranch: recorded?.branch, source: "recorded workflow-state" },
			{ path: approvedWorktreePath, source: "approved plan evidence" },
		];
		for (const attempt of attempts) {
			if (!attempt.path) continue;
			const scoped = await validatedWorktreeScope(attempt.source, attempt.path, attempt.expectedBranch, undefined, "continuation");
			if (!scoped.error && scoped.worktreePath) return { cwd: scoped.worktreePath };
		}
		const recoveryPath = recorded?.worktreePath && !PROTECTED_BRANCHES.has(recorded.branch ?? "") ? recorded.worktreePath : approvedWorktreePath;
		const recoveryBranch = recorded?.branch && !PROTECTED_BRANCHES.has(recorded.branch) ? recorded.branch : undefined;
		return { error: `no readable task worktree for continuation. ${worktreeRecovery(recoveryPath, recoveryBranch, "continuation")}` };
	}

	function hasNonemptyFastPathRationale(planEvidence: string): boolean {
		const value = latestPlanField(planEvidence, ["FAST_PATH_RATIONALE"]);
		return Boolean(value?.trim());
	}

	async function triggerApprovedPlanContinuation(
		ctx: ExtensionContext,
		beadId: string,
		options: { approvedWorktreePath?: string; planEvidence?: string; triggerTurn?: boolean } = {},
	): Promise<ContinuationResult> {
		// Fast Path: orchestrator implements; skip supervisor spawn before any pre-dispatch work.
		if (hasNonemptyFastPathRationale(options.planEvidence ?? "") && !autopilotEnabled) {
			const triggerTurn = options.triggerTurn === true;
			const content = [
				"Fast Path: skip supervisor after PLAN APPROVED.",
				`Bead: ${beadId}`,
				triggerTurn
					? "Next: implement now; do not dispatch_supervisor; do not wait for ping."
					: "Next: orchestrator continues; do not dispatch_supervisor; do not wait for ping.",
			].join("\n");
			pi.sendMessage(
				{ customType: "post-approval-fast-path-skip", content, display: true },
				{ triggerTurn },
			);
			return { skipped: true, reason: "fastPath", next: "fastPath" };
		}

		try {
			const live = findLiveRegistryEntriesForBead(beadId).filter((item) => isSupervisorRegistryRole(item.entry.role));
			if (live.length > 0) {
				sendAlreadySpawnedSkip(beadId, live);
				return { skipped: true, reason: "alreadySpawned", next: "alreadySpawned" };
			}
		} catch {
			// Fail-open: unreadable/corrupt registry must not skip; follow the existing dispatch path.
		}

		const resolved = await resolveContinuationCwd(ctx, beadId, options.approvedWorktreePath);
		if (resolved.error || !resolved.cwd) {
			await recordContinuationScopeBlocked(ctx, beadId, resolved.error ?? "no readable task worktree for continuation");
			return { skipped: false, next: "continuation-blocked" };
		}
		const action = renderPlanExecutionAction(beadId, resolved.cwd);
		sendPreDispatchProgress(ctx, beadId, action);
		const result = await requestSupervisorDispatch(pi, { beadId, cwd: resolved.cwd, transport: "cmux" }, ctx);
		if (!result.ok) {
			const error = result.error ?? "typed continuation returned without success";
			if (isLivePaneAlreadyRegistered(error)) {
				return skipAlreadySpawnedContinuation(beadId);
			}
			if (isRuntimeHookUnavailable(error)) {
				await recordRuntimeHookMissing(ctx, beadId, action, error);
				return { skipped: false, next: "continuation-blocked" };
			}
			if (isDispatchReadinessFailure(error)) {
				await recordContinuationReadinessBlocked(ctx, beadId, error);
				return { skipped: false, next: "continuation-blocked" };
			}
			await recordContinuationScopeBlocked(ctx, beadId, error);
			return { skipped: false, next: "continuation-blocked" };
		}
		pi.sendMessage(
			{
				customType: "post-approval-continuation",
				content: "Супервизор запущен, панель справа. Ждать не нужно.",
				display: true,
			},
			{ triggerTurn: false },
		);
		return { skipped: false, next: "dispatched" };
	}

	async function approvePlanForExecution(ctx: ExtensionContext, planEvidence: string): Promise<{ approved: boolean; beadId?: string; worktreePath?: string; next?: ContinuationNext }> {
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

		const approvedBy = autopilotEnabled ? "оркестратор" : "Максим";
		// UI Execute and /plan-auto need triggerTurn true on Fast Path skip so the orchestrator continues in-session.
		const result = await approvePlanTool({ beadId, planEvidence: normalizedApprovalEvidence(planEvidence), approvedBy, triggerTurn: true }, ctx);
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
		const next: ContinuationNext =
			result.details?.continuationNext === "fastPath"
			|| result.details?.continuationNext === "alreadySpawned"
			|| result.details?.continuationNext === "dispatched"
			|| result.details?.continuationNext === "continuation-blocked"
				? result.details.continuationNext
				: "dispatched";
		return { approved: true, beadId, worktreePath: result.details?.worktreePath as string | undefined, next };
	}

	function planReviewAutoCapReached(): boolean {
		return planReviewCycleCount >= MAX_PLAN_REVIEW_CYCLES;
	}

	function planReviewTotalCapReached(): boolean {
		return planReviewCycleCount >= MAX_PLAN_REVIEW_TOTAL_SPAWNS;
	}

	/** True when default auto path has stopped (cap or STOP_SHOW_USER); prompt documents extraCycle instead of absolute MUST NOT. */
	function shouldInjectPlanReviewStopPrompt(): boolean {
		return planReviewAutoCapReached() || lastPlanReviewStopAdvice === "STOP_SHOW_USER";
	}

	function resetPlanReviewCycleState(): void {
		planReviewCycleCount = 0;
		lastPlanReviewStopAdvice = undefined;
		lastPlanReviewResults = [];
		lastPlanReviewDraftPlan = undefined;
		autoPlanReviewState = "idle";
		autoPlanReviewResults = [];
	}

	function applyPlanReviewAdvice(advice: PlanReviewStopAdvice): void {
		if (advice === "HARD_BLOCK") autoPlanReviewState = "blocked";
		else if (advice === "CONTINUE") autoPlanReviewState = "awaiting_revision";
		else autoPlanReviewState = "stopped";
	}

	function buildPlanReviewToolText(input: {
		advice: PlanReviewStopAdvice;
		cycle: number;
		risk: string;
		gateOk: boolean;
		renderedResults: string;
		reasons?: string[];
		results?: PlanReviewResult[];
		skippedSpawn?: boolean;
		skipReason?: "auto-cap" | "total-ceiling";
		extraCycle?: boolean;
		requestedBy?: "maxim" | "orchestrator";
	}): string {
		const { advice, cycle, risk, gateOk, renderedResults, reasons, results, skippedSpawn, skipReason, extraCycle, requestedBy } = input;
		const cycleLabel = (extraCycle || cycle > MAX_PLAN_REVIEW_CYCLES)
			? (requestedBy === "maxim" && cycle > MAX_PLAN_REVIEW_TOTAL_SPAWNS
				? `${cycle} (extra, maxim)`
				: `${cycle}/${MAX_PLAN_REVIEW_TOTAL_SPAWNS}${cycle > MAX_PLAN_REVIEW_CYCLES ? " (extra)" : ""}`)
			: `${cycle}/${MAX_PLAN_REVIEW_CYCLES}`;
		const riskLine = `risk=${risk} (telemetry only; does not change stop advice)`;
		const reasonBlock = reasons && reasons.length > 0 ? `\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}` : "";
		let skipNote = "";
		if (skippedSpawn) {
			skipNote = skipReason === "total-ceiling"
				? ` No additional reviewer spawn (orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}). Orchestrator extra is forbidden; if Maxim explicitly asked this turn, pass extraCycle: true and requestedBy: "maxim".`
				: ` No additional reviewer spawn (auto cycle cap ${MAX_PLAN_REVIEW_CYCLES}). Pass extraCycle: true for another spawn when Maxim asks or residual important/critical remain on a high-risk plan (orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}; default requestedBy=orchestrator).`;
		}
		if (advice === "HARD_BLOCK") {
			if (results && isDeadPaneHardBlock(results)) {
				return `workflow_plan_review ${cycleLabel}: ${formatDeadPaneHardBlockCopy(results)}${skipNote}\n${riskLine}.${reasonBlock}`;
			}
			return `workflow_plan_review ${cycleLabel}: HARD_BLOCK. Do not execute or approve the plan until blockers are resolved.${skipNote}\n${riskLine}.${reasonBlock}\n\nReviewer output:\n\n${renderedResults}`;
		}
		if (advice === "CONTINUE") {
			return `workflow_plan_review ${cycleLabel}: CONTINUE. Important/critical findings remain. Revise the plan and call workflow_plan_review again (auto max ${MAX_PLAN_REVIEW_CYCLES} cycles). Implementation remains blocked until the revised plan adjudicates findings and receives normal approval.\n${riskLine}.\n\nReviewer output:\n\n${renderedResults}`;
		}
		// After cycle>=4: only Maxim this-turn path; never residual-OR for cycle 5+.
		const extraHint = planReviewTotalCapReached()
			? ` Orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS} reached — orchestrator extra is forbidden. If Maxim explicitly asked this turn, call workflow_plan_review({ draftPlan, extraCycle: true, requestedBy: "maxim" }). Residual important/critical alone do not justify cycle 5+. Call plan_mode_complete so ready-UI remains available.`
			: ` Default auto path stops at ${MAX_PLAN_REVIEW_CYCLES}. Another spawn: workflow_plan_review({ draftPlan, extraCycle: true }) (default requestedBy=orchestrator) only if Maxim explicitly asks or residual important/critical remain on a high-risk plan (not Fast Path nits); orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}. Still call plan_mode_complete so ready-UI exists.`;
		const stopLead = gateOk
			? `workflow_plan_review ${cycleLabel}: STOP_SHOW_USER. Present the plan to Maxim now.${extraHint}`
			: `workflow_plan_review ${cycleLabel}: STOP_SHOW_USER.`;
		return `${stopLead}${skipNote} Implementation remains blocked until the revised plan explicitly adjudicates accepted/rejected findings and receives normal approval.\n${riskLine}.${reasonBlock}\n\nReviewer output:\n\n${renderedResults}`;
	}

	async function planReviewTool(params: { draftPlan: string; extraCycle?: boolean; requestedBy?: "maxim" | "orchestrator" }, ctx: ExtensionContext) {
		const draftPlan = params.draftPlan.trim();
		const extraCycle = params.extraCycle === true;
		// Fail-closed: missing/invalid requestedBy defaults to orchestrator (only explicit "maxim" bypasses total ceiling).
		const requestedBy: "maxim" | "orchestrator" = params.requestedBy === "maxim" ? "maxim" : "orchestrator";
		if (!draftPlan) {
			return toolText("workflow_plan_review blocked: draftPlan is required", { ok: false, error: "draftPlan is required" });
		}

		const risk = classifyPlanReviewRisk(draftPlan);

		// Skip matrix: empty already returned; auto cap unless extraCycle; total cap unless maxim extra this turn.
		const skipForTotal = planReviewTotalCapReached() && !(extraCycle && requestedBy === "maxim");
		const skipForAuto = planReviewAutoCapReached() && !extraCycle;
		if (skipForTotal || skipForAuto) {
			const results = lastPlanReviewResults;
			const gate = evaluatePlanReviewGate(results);
			const advice: PlanReviewStopAdvice = "STOP_SHOW_USER";
			lastPlanReviewStopAdvice = advice;
			applyPlanReviewAdvice(advice);
			persistState();
			const renderedResults = results.length > 0
				? renderPlanReviewResults(results)
				: "(no cached reviewer output)";
			const skipReason = skipForTotal ? "total-ceiling" as const : "auto-cap" as const;
			return toolText(
				buildPlanReviewToolText({
					advice,
					cycle: planReviewCycleCount,
					risk,
					gateOk: gate.ok,
					renderedResults,
					reasons: gate.reasons,
					results,
					skippedSpawn: true,
					skipReason,
					extraCycle,
					requestedBy,
				}),
				{
					ok: gate.ok,
					gate,
					results,
					cycle: planReviewCycleCount,
					risk,
					stopAdvice: advice,
					skippedSpawn: true,
					extraCycle,
					requestedBy,
				},
			);
		}

		// Reserve cycle slot BEFORE await spawn so failed spawn consumes the slot (including maxim extra).
		planReviewCycleCount += 1;
		const cycle = planReviewCycleCount;
		const usedExtra = extraCycle && cycle > MAX_PLAN_REVIEW_CYCLES;
		persistState();

		let results: PlanReviewResult[];
		try {
			results = await runReviewGateForPlan(ctx, draftPlan);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results = [{
				reviewer: "plan-review-runtime",
				verdict: "BLOCKED",
				findings: [],
				unresolvedBlockers: [message || "plan review spawn failed"],
				raw: "",
				error: message || "plan review spawn failed",
			}];
		}

		const gate = evaluatePlanReviewGate(results);
		const hasImportantOrCritical = hasImportantOrCriticalFindings(results, gate.importantFindings);
		let advice = planReviewStopAdvice({
			cycle,
			gateOk: gate.ok,
			hasImportantOrCritical,
		});
		// Extra path never CONTINUE (always STOP_SHOW_USER or HARD_BLOCK) — including maxim cycle 5+.
		if (usedExtra && advice === "CONTINUE") {
			advice = "STOP_SHOW_USER";
		}
		lastPlanReviewStopAdvice = advice;
		lastPlanReviewResults = results;
		lastPlanReviewDraftPlan = draftPlan;
		applyPlanReviewAdvice(advice);
		persistState();

		const renderedResults = renderPlanReviewResults(results);
		return toolText(
			buildPlanReviewToolText({
				advice,
				cycle,
				risk,
				gateOk: gate.ok,
				renderedResults,
				reasons: gate.ok ? undefined : gate.reasons,
				results,
				extraCycle: usedExtra,
				requestedBy,
			}),
			{
				ok: gate.ok,
				gate,
				results,
				cycle,
				risk,
				stopAdvice: advice,
				extraCycle: usedExtra,
				requestedBy,
			},
		);
	}

	async function approvePlanTool(params: { beadId: string; planEvidence: string; approvedBy?: string; triggerTurn?: boolean }, ctx: ExtensionContext) {
		const evidenceError = validatePlanEvidence(params.planEvidence);
		if (evidenceError) return toolText(`workflow_plan_approved blocked: ${evidenceError}`, { ok: false, error: evidenceError });

		const { branch, worktreePath, startCommit, error: approvalScopeError } = await approvalScope(ctx, params.beadId, params.planEvidence);
		if (approvalScopeError) return toolText(`workflow_plan_approved blocked: ${approvalScopeError}`, { ok: false, error: approvalScopeError });
		const sessionKey = currentSessionKey(ctx);
		const approvedAt = new Date().toISOString();
		const defaultApprover = autopilotEnabled ? "оркестратор" : "Максим";
		const comment = [
			"PLAN APPROVED",
			`Approved-by: ${params.approvedBy || defaultApprover}`,
			`Approved-at: ${approvedAt}`,
			branch ? `BRANCH: ${branch}` : undefined,
			worktreePath ? `WORKTREE: ${worktreePath}` : undefined,
			startCommit ? `START_COMMIT: ${startCommit}` : undefined,
			sessionKey ? `PI_SESSION_KEY: ${sessionKey}` : undefined,
			autopilotEnabled ? "AUTOPILOT: true" : undefined,
			"",
			params.planEvidence.trim(),
		].filter((line) => line !== undefined).join("\n");

		const result = await pi.exec("bd", ["comments", "add", params.beadId, comment]);
		if (result.code !== 0) {
			return toolText(`workflow_plan_approved failed before session update: ${(result.stderr || result.stdout).trim()}`, { ok: false, code: result.code });
		}

		planModeEnabled = false;
		autoExecuteEnabled = false;
		// autopilotEnabled intentionally survives plan=off so post-approve hop can close without Maxim re-prompt.
		executionMode = false;
		clearPendingReadyPlan();
		restoreNormalToolSurface();
		syncWorkflowPlanMode(ctx, "off", "implementing", { state: "implementing", activeBead: params.beadId, branch, worktreePath, startCommit, planApproved: true });
		updateStatus(ctx);
		persistState();
		const continuation = await triggerApprovedPlanContinuation(ctx, params.beadId, {
			approvedWorktreePath: worktreePath,
			planEvidence: params.planEvidence,
			triggerTurn: params.triggerTurn === true,
		});
		const continuationLabel = continuation.reason === "alreadySpawned"
			? "continuation skipped: supervisor already spawned; waiting ping"
			: continuation.reason === "fastPath"
				? "fastPathSkip"
				: `continuation attempted${autopilotEnabled ? "; autopilot remains on" : ""}`;
		return toolText(
			`workflow_plan_approved recorded for ${params.beadId}; plan mode off; sessionMode=implementing; ${continuationLabel}`,
			{
				ok: true,
				beadId: params.beadId,
				branch,
				worktreePath,
				startCommit,
				autopilot: autopilotEnabled,
				fastPathSkip: continuation.reason === "fastPath",
				continuationSkipReason: continuation.reason,
				continuationNext: continuation.next,
			},
		);
	}

	async function claimWorkflowBead(bead: string, ctx: ExtensionContext): Promise<boolean> {
		const result = await requestWorkflowClaim(pi, bead, ctx);
		if (!result.ok && result.error && ctx.hasUI) ctx.ui.notify(result.error, "error");
		return result.ok;
	}

	function clearPendingReadyPlan(): void {
		pendingReadyPlan = undefined;
	}

	function enterPlanMode(ctx: ExtensionContext, autoExecute: boolean, autopilot = false): void {
		const wasEnabled = planModeEnabled;
		if (!planModeEnabled) snapshotNormalToolSurface();
		planModeEnabled = true;
		autoExecuteEnabled = autoExecute || autopilot;
		autopilotEnabled = autopilot;
		executionMode = false;
		autoPlanReviewState = "idle";
		autoPlanReviewResults = [];
		lastPlanReviewDraftPlan = undefined;
		todoItems = [];
		// Auto/autopilot never uses ready-UI; clear any leftover strict pending.
		if (autoExecute || autopilot) clearPendingReadyPlan();
		// Reset cycle only on plan-mode off→on (new /plan or first enable). Repeated workflow_plan_mode while already on does not reset.
		if (!wasEnabled) resetPlanReviewCycleState();
		pi.setActiveTools(PLAN_MODE_TOOLS);
		const modeLabel = autopilot ? "Autopilot " : autoExecute ? "Auto " : "";
		if (ctx.hasUI) ctx.ui.notify(`${modeLabel}Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		// Gate path matches plan=auto; durable autopilot flag is session-local in plan-mode state.
		syncWorkflowPlanMode(ctx, autoExecute || autopilot ? "auto" : "strict", "planning");
		updateStatus(ctx);
		persistState();
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		autoExecuteEnabled = false;
		autopilotEnabled = false;
		executionMode = false;
		autoPlanReviewState = "idle";
		autoPlanReviewResults = [];
		lastPlanReviewDraftPlan = undefined;
		todoItems = [];
		clearPendingReadyPlan();
		resetPlanReviewCycleState();
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
			autopilot: autopilotEnabled,
			todos: todoItems,
			executing: executionMode,
			autoPlanReviewState,
			autoPlanReviewResults,
			planReviewCycleCount,
			lastPlanReviewStopAdvice,
			lastPlanReviewResults,
			lastPlanReviewDraftPlan,
			pendingReadyPlan,
		});
	}

	function canUseCustomUi(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
	}

	/** Put a document in the human transcript without waking a model turn (51l5). */
	function showVisibleTranscript(customType: string, content: string): void {
		try {
			pi.sendMessage(
				{
					customType,
					content,
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch {
			// sendMessage failure must not block select / questionnaire
		}
	}

	/** Immediate chat document: appendEntry renders now; sendMessage is steered until the tool returns. */
	function showImmediatePlanDocument(planText: string): void {
		try {
			pi.appendEntry("plan-ready-document", { content: planText });
		} catch {
			// appendEntry failure must not block ready-UI
		}
	}

	function formatReadyChoiceLegend(): string {
		const lines = READY_ACTIONS.map((item) => {
			const description = item.description?.trim() ?? "";
			return description ? `- **${item.label}**: ${description}` : `- **${item.label}**`;
		});
		return ["Выбор в ready-UI:", ...lines].join("\n");
	}

	/** Legend before overlay/select. Throw must not block the widget. */
	function showImmediateReadyChoice(): void {
		try {
			pi.appendEntry("plan-ready-choice", { content: formatReadyChoiceLegend() });
		} catch {
			// appendEntry failure must not block ready-UI
		}
	}

	function formatQuestionnaireTranscript(
		questions: Array<{ label: string; prompt: string; options: Array<{ label: string }>; allowOther: boolean }>,
	): string {
		return questions
			.map((question, index) => {
				const header = `### ${question.label || `Q${index + 1}`}`;
				const options = question.options
					.map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`)
					.join("\n");
				const other = question.allowOther
					? `\n  ${question.options.length + 1}. Другая…`
					: "";
				return `${header}\n${question.prompt}\n${options}${other}`;
			})
			.join("\n\n");
	}

	type ReadyUiSource = "execute" | "leftover";

	async function promptReadyAction(
		ctx: ExtensionContext,
		planText: string,
		source: ReadyUiSource,
		options: { skipReadyChoice?: boolean } = {},
	): Promise<ReadyAction | null> {
		if (!ctx.hasUI) return null;

		// Legend before overlay/select (jxna). RPC execute uses select without legend;
		// leftover select still appends. Clean-reshow skip is caller-controlled.
		const skipLegend = options.skipReadyChoice === true || (source === "execute" && !canUseCustomUi(ctx));
		if (!skipLegend) {
			showImmediateReadyChoice();
		}

		// Full plan goes into the chat immediately via appendEntry + entry renderer.
		// sendMessage(plan-ready-document) is steered until the blocking widget returns,
		// so it is not the visibility path. Re-append on clean re-show / leftover.
		if (planText.trim()) {
			showImmediatePlanDocument(planText);
		}

		const labels = READY_ACTIONS.map((item) => item.label);

		// Execute (and clean re-show in that loop): short custom overlay, no plan, no
		// SelectList (live HA: SelectList.render inside custom killed Pi). overlay:true
		// leaves the transcript scrollable (mouse wheel). Leftover agent_settled keeps
		// built-in select (gauq/m6ho TUI abort). RPC / missing custom → select.
		// Custom throw must NOT fall back to select; runStrictReadyUiLoopSafe degrades.
		if (source === "execute" && canUseCustomUi(ctx)) {
			const result = await ctx.ui.custom<{ action: ReadyAction } | null>(createReadyUiFactory(), {
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
				},
			});
			return result?.action ?? null;
		}

		const choice = await ctx.ui.select("План готов — что дальше?", labels);
		if (!choice) return null;
		const matched = READY_ACTIONS.find((item) => item.label === choice);
		return matched?.value ?? null;
	}

	type StrictReadyUiOutcome =
		| { kind: "executed"; next: ContinuationNext }
		| { kind: "execute-blocked" }
		| { kind: "stay" }
		| { kind: "refine" }
		| { kind: "cancelled" }
		| { kind: "findings"; results: PlanReviewResult[]; gate: PlanReviewGateResult }
		| { kind: "clean-reshow" }
		| { kind: "error"; message: string };

	function formatPlanModeCompleteToolText(outcome: StrictReadyUiOutcome): string {
		switch (outcome.kind) {
			case "executed":
				if (outcome.next === "fastPath") {
					return "Максим нажал Исполнить. PLAN APPROVED записан. Next: implement now. Не ping. Не dispatch_supervisor.";
				}
				if (outcome.next === "alreadySpawned") {
					return "Максим нажал Исполнить. PLAN APPROVED записан. Супервизор already spawned. Next: ждать ping. Не dispatch_supervisor. Не ## Дальше про выбор плана. Не implement.";
				}
				if (outcome.next === "continuation-blocked") {
					return "Максим нажал Исполнить. PLAN APPROVED мог записаться. Continuation blocked. Next: plan-approval-recovery / continuation-blocked. Чат-стоп на recovery разрешён. Не ping. Не Fast Path implement.";
				}
				return "Максим нажал Исполнить. PLAN APPROVED записан. Супервизор live/attempted. Next: ждать ping. Не dispatch_supervisor. Не ## Дальше про выбор плана. Не implement.";
			case "execute-blocked":
				return "Исполнить нажат. Durable PLAN APPROVED не записан. Pending kept. Plan mode ON. Next: plan-approval-recovery. Не ping. Не Fast Path.";
			case "stay":
			case "cancelled":
				return "Pending снят. Plan mode ON. Продолжать планирование. Не утверждать что кнопка ready-UI ещё впереди.";
			case "refine":
				return "Pending снят. Next: ждать текст уточнения.";
			case "error":
				return `Ready-UI упал: ${outcome.message}. Pending cleared. Plan mode ON. Не утверждать что overlay ждёт. Снова plan_mode_complete или продолжить план.`;
			case "clean-reshow":
				return "plan_mode_complete: ready-UI clean-reshow; pending kept";
			case "findings":
				return formatReadyCritiqueFindingsText(outcome.results);
		}
	}

	function countImportantOrCritical(results: PlanReviewResult[], gate: PlanReviewGateResult): number {
		if (gate.importantFindings.length > 0) return gate.importantFindings.length;
		return results.reduce(
			(total, result) =>
				total + result.findings.filter((finding) => finding.severity === "critical" || finding.severity === "important").length,
			0,
		);
	}

	function formatReadyCritiqueFindingsText(results: PlanReviewResult[]): string {
		if (isDeadPaneHardBlock(results)) {
			return [
				formatDeadPaneHardBlockCopy(results),
				"",
				renderPlanReviewResults(results),
			].join("\n");
		}
		return [
			"**Strict plan critique complete.** Implementation remains blocked until explicit approval.",
			"",
			renderPlanReviewResults(results),
			"",
			"Revise the plan. Adjudicate each finding (Accepted findings / Rejected findings), keep Unresolved blockers: none when clear, then call plan_mode_complete({ plan }) again with the revised plan.",
		].join("\n");
	}

	async function runReadyPlanCritique(
		ctx: ExtensionContext,
		draftPlan: string,
	): Promise<{ results: PlanReviewResult[]; gate: PlanReviewGateResult }> {
		// Uncapped critique path (same as /plan-review): does NOT increment planReviewCycleCount.
		// Does not sendMessage — caller delivers findings via tool result (execute) or leftover sendMessage.
		let results: PlanReviewResult[];
		try {
			results = await runReviewGateForPlan(ctx, draftPlan);
		} catch (error) {
			// Spawn/runtime failure is a findings outcome (BLOCKED), not a Safe rethrow.
			const message = error instanceof Error ? error.message : String(error);
			results = [{
				reviewer: "plan-review-runtime",
				verdict: "BLOCKED",
				findings: [],
				unresolvedBlockers: [message || "plan review spawn failed"],
				raw: "",
				error: message || "plan review spawn failed",
			}];
		}
		const gate = evaluatePlanReviewGate(results);
		lastPlanReviewDraftPlan = draftPlan;
		lastPlanReviewResults = results;
		autoPlanReviewResults = results;
		const advice = planReviewStopAdvice({
			cycle: Math.max(planReviewCycleCount, 1),
			gateOk: gate.ok,
			hasImportantOrCritical: hasImportantOrCriticalFindings(results, gate.importantFindings),
		});
		lastPlanReviewStopAdvice = advice;
		applyPlanReviewAdvice(advice);
		persistState();
		return { results, gate };
	}

	async function runStrictReadyUiLoopSafe(ctx: ExtensionContext, source: ReadyUiSource): Promise<StrictReadyUiOutcome> {
		try {
			return await runStrictReadyUiLoop(ctx, source);
		} catch (error) {
			// Graceful degradation: a TUI/render failure in the ready-UI must never
			// kill the session. Clear pending, notify, and stay in strict plan mode.
			const message = error instanceof Error ? error.message : String(error);
			clearPendingReadyPlan();
			persistState();
			try {
				if (ctx.hasUI) {
					ctx.ui.notify(`plan-mode ready-UI failed: ${message}; pending ready plan cleared, plan mode stays ON`, "error");
				}
			} catch {
				// notify itself failing must not propagate either
			}
			return { kind: "error", message };
		}
	}

	async function runStrictReadyUiLoop(ctx: ExtensionContext, source: ReadyUiSource): Promise<StrictReadyUiOutcome> {
		let lastOutcome: StrictReadyUiOutcome = { kind: "cancelled" };
		while (planModeEnabled && !autoExecuteEnabled && pendingReadyPlan) {
			const planText = pendingReadyPlan;
			const action = await promptReadyAction(ctx, planText, source, {
				skipReadyChoice: lastOutcome.kind === "clean-reshow",
			});

			if (action === "execute") {
				const approval = await approvePlanForExecution(ctx, planText);
				if (!approval.approved) {
					persistState();
					return { kind: "execute-blocked" };
				}
				clearPendingReadyPlan();
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();
				return { kind: "executed", next: approval.next ?? "dispatched" };
			}

			if (action === "refine") {
				clearPendingReadyPlan();
				persistState();
				const refinement = await ctx.ui.editor("Уточните план:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
				return { kind: "refine" };
			}

			if (action === "plan-review") {
				const { results, gate } = await runReadyPlanCritique(ctx, planText);
				const clean = gate.ok && !hasImportantOrCriticalFindings(results, gate.importantFindings);

				if (clean) {
					const cleanText = "plan-review: чисто (нет important/critical) — можно исполнять";
					try {
						if (ctx.hasUI) ctx.ui.notify(cleanText, "info");
					} catch {
						// swallow
					}
					persistState();
					lastOutcome = { kind: "clean-reshow" };
					// pending kept; re-show ready buttons so Maxim can execute immediately
					continue;
				}

				// Dirty: deliver findings to the agent turn; no second select (prevents double run).
				clearPendingReadyPlan();
				persistState();
				const importantCount = countImportantOrCritical(results, gate);
				const dirtyText = gate.ok
					? `plan-review: findings — important/critical: ${importantCount}; plan mode ON, pending cleared`
					: `plan-review: gate blocked (${gate.reasons[0] ?? "see findings"}); important/critical: ${importantCount}; pending cleared`;
				try {
					if (ctx.hasUI) ctx.ui.notify(dirtyText, gate.ok ? "warning" : "error");
				} catch {
					// swallow
				}
				return { kind: "findings", results, gate };
			}

			// stay / Esc / null → clear pending, remain in plan mode
			clearPendingReadyPlan();
			persistState();
			return { kind: action === "stay" ? "stay" : "cancelled" };
		}
		return lastOutcome;
	}

	async function runQuestionnaireUi(
		ctx: ExtensionContext,
		rawQuestions: unknown,
	): Promise<{ content: { type: "text"; text: string }[]; details: QuestionnaireUiResult }> {
		const questions = normalizeQuestions(rawQuestions);
		if (questions.length === 0) {
			return {
				content: [{ type: "text", text: "Error: No valid questions provided" }],
				details: { questions: [], answers: [], cancelled: true },
			};
		}

		if (!ctx.hasUI) {
			return {
				content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
				details: { questions, answers: [], cancelled: true },
			};
		}

		// Prompt + options in the human transcript before the blocking widget (f3zr).
		showVisibleTranscript("plan-questionnaire", formatQuestionnaireTranscript(questions));

		if (canUseCustomUi(ctx)) {
			const result = await ctx.ui.custom<QuestionnaireUiResult>(createQuestionUiFactory(questions));
			const resolved = result ?? { questions, answers: [], cancelled: true };
			if (resolved.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: resolved,
				};
			}
			return {
				content: [{ type: "text", text: formatQuestionnaireAnswerLines(questions, resolved.answers).join("\n") }],
				details: resolved,
			};
		}

		// RPC / no-custom fallback: sequential capped select + optional input for Other.
		const answers: QuestionnaireUiResult["answers"] = [];
		for (const question of questions) {
			const labels = [
				...question.options.map((opt) => opt.label),
				...(question.allowOther ? ["Другая…"] : []),
			];
			const choice = await ctx.ui.select(question.prompt, labels);
			if (!choice) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: { questions, answers, cancelled: true },
				};
			}
			if (choice === "Другая…") {
				const typed = (await ctx.ui.input("Свой ответ:"))?.trim() || "(no response)";
				answers.push({ id: question.id, value: typed, label: typed, wasCustom: true });
				continue;
			}
			const optIndex = question.options.findIndex((opt) => opt.label === choice);
			const opt = question.options[optIndex];
			if (!opt) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: { questions, answers, cancelled: true },
				};
			}
			answers.push({ id: question.id, value: opt.value, label: opt.label, wasCustom: false, index: optIndex + 1 });
		}
		return {
			content: [{ type: "text", text: formatQuestionnaireAnswerLines(questions, answers).join("\n") }],
			details: { questions, answers, cancelled: false },
		};
	}

	if (workflowPi.registerTool) {
		workflowPi.registerTool({
			name: "workflow_plan_mode",
			label: "Workflow Plan Mode",
			description: "Enter/exit strict, auto, or autopilot plan mode and update active tool restrictions plus workflow-state metadata. Slash commands are optional human shortcuts. autopilot keeps a durable session flag after plan=off and records Approved-by: оркестратор.",
			parameters: WorkflowPlanModeParams,
			async execute(_id: string, params: { mode: "off" | "strict" | "auto" | "autopilot"; reason?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				let activeTools: string[];
				if (params.mode === "off") {
					exitPlanMode(ctx);
					activeTools = normalModeTools();
				} else {
					enterPlanMode(ctx, params.mode === "auto" || params.mode === "autopilot", params.mode === "autopilot");
					activeTools = PLAN_MODE_TOOLS;
				}
				return toolText(`workflow_plan_mode=${params.mode}${params.reason ? `: ${params.reason}` : ""}`, { mode: params.mode, activeTools, autopilot: autopilotEnabled });
			},
		});

		workflowPi.registerTool({
			name: "workflow_plan_review",
			label: "Workflow Plan Review",
			description: `Run required plan-review reviewers against a draft plan and return structured gate findings without mutating files, bd, git, workflow approval, merge-slot, or plan mode state. Auto cap ${MAX_PLAN_REVIEW_CYCLES} spawns; after auto cap pass extraCycle=true (default requestedBy=orchestrator) when Maxim asks or residual important/critical remain on a high-risk plan (orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}). Past ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS} only extraCycle=true + requestedBy="maxim" when Maxim explicitly asked this turn (no residual-OR). Extra path never returns CONTINUE.`,
			parameters: {
				type: "object",
				properties: {
					draftPlan: { type: "string" },
					extraCycle: {
						type: "boolean",
						description: `Optional. After auto cap ${MAX_PLAN_REVIEW_CYCLES}, set true to spawn another review on the current draftPlan. Cycles 3–${MAX_PLAN_REVIEW_TOTAL_SPAWNS}: Maxim ask or residual important/critical on high-risk (default requestedBy=orchestrator). Cycle ${MAX_PLAN_REVIEW_TOTAL_SPAWNS + 1}+ requires requestedBy="maxim" when Maxim explicitly asked this turn. Ignored below auto cap. Extra never returns CONTINUE.`,
					},
					requestedBy: {
						type: "string",
						enum: ["maxim", "orchestrator"],
						description: `Optional. Who requested the extra cycle. Default orchestrator when omitted (fail-closed). Use "maxim" only when Maxim explicitly asked this turn; required with extraCycle to bypass orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}. Without extraCycle, behaves as a normal call (still subject to auto cap).`,
					},
				},
				required: ["draftPlan"],
				additionalProperties: false,
			},
			async execute(_id: string, params: { draftPlan: string; extraCycle?: boolean; requestedBy?: "maxim" | "orchestrator" }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				return planReviewTool(params, ctx);
			},
		});

		workflowPi.registerTool({
			name: "workflow_plan_approved",
			label: "Workflow Plan Approved",
			description: "Write PLAN APPROVED evidence to bd and atomically exit plan mode/update workflow-state only after the comment succeeds.",
			parameters: WorkflowPlanApprovedParams,
			async execute(_id: string, params: { beadId: string; planEvidence: string; approvedBy?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				// In-turn tool call: Fast Path skip uses triggerTurn false (display only).
				return approvePlanTool({ ...params, triggerTurn: false }, ctx);
			},
		});

		workflowPi.registerTool({
			name: "plan_mode_complete",
			label: "Plan Mode Complete",
			description: "Mark the draft plan as ready for the human ready-UI (Исполнить / Остаться / Уточнить / Отправить на plan-review). Call only when the plan is complete — never after a clarifying question. Empty/whitespace plan is rejected.",
			parameters: PlanModeCompleteParams,
			renderCall(_args: { plan?: string }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, _context: unknown) {
				return new Text(
					theme.fg("toolTitle", theme.bold("plan_mode_complete")) +
						theme.fg("muted", " ready"),
					0,
					0,
				);
			},
			async execute(_id: string, params: { plan: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				const plan = typeof params.plan === "string" ? params.plan.trim() : "";
				if (!plan) {
					return toolText("plan_mode_complete blocked: plan must be non-empty", { ok: false, error: "plan must be non-empty" });
				}
				if (!planModeEnabled) {
					return toolText("plan_mode_complete blocked: plan mode is off", { ok: false, error: "plan mode is off" });
				}
				if (
					!autoExecuteEnabled
					&& autoPlanReviewState === "blocked"
					&& samePlanReviewDraft(plan, lastPlanReviewDraftPlan)
					&& isDeadPaneHardBlock(lastPlanReviewResults)
				) {
					const copy = formatDeadPaneHardBlockCopy(lastPlanReviewResults);
					persistState();
					return toolText(copy, {
						ok: false,
						pending: false,
						cachedHardBlock: true,
						stopAdvice: "HARD_BLOCK",
						results: lastPlanReviewResults,
					});
				}
				if (autoExecuteEnabled) {
					// Auto/autopilot ignores ready-UI; still accept the text as the latest draft without pending.
					clearPendingReadyPlan();
					persistState();
					return toolText("plan_mode_complete noted (auto/autopilot: ready-UI skipped)", { ok: true, pending: false, auto: true });
				}
				pendingReadyPlan = plan;
				persistState();
				if (ctx.hasUI) {
					const outcome = await runStrictReadyUiLoopSafe(ctx, "execute");
					if (outcome.kind === "findings") {
						const findingsText = formatReadyCritiqueFindingsText(outcome.results);
						// Human transcript + model tool result. triggerTurn false during execute (51l5).
						showVisibleTranscript("plan-review-findings", findingsText);
						return toolText(findingsText, {
							ok: false,
							pending: false,
							findings: true,
							gate: outcome.gate,
							results: outcome.results,
							outcome: outcome.kind,
						});
					}
					const pending = outcome.kind === "execute-blocked" || outcome.kind === "clean-reshow" || Boolean(pendingReadyPlan);
					const ok = outcome.kind !== "execute-blocked" && outcome.kind !== "error";
					return toolText(formatPlanModeCompleteToolText(outcome), {
						ok,
						pending,
						outcome: outcome.kind,
						next: outcome.kind === "executed" ? outcome.next : undefined,
					});
				}
				return toolText("plan_mode_complete: pending ready plan stored; ready select will open on agent_settled", { ok: true, pending: true });
			},
		});

		workflowPi.registerTool({
			name: "questionnaire",
			label: "Questionnaire",
			description: "Ask the user one or more clarifying questions with options. Single question tool for plan mode (document-flow UI in TUI; select/input fallback otherwise). Does not mark the plan ready.",
			parameters: QuestionnaireParams,
			async execute(_id: string, params: { questions: unknown }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
				return runQuestionnaireUi(ctx, params.questions);
			},
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle strict plan mode (read-only exploration; user approval required)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-auto", {
		description: "Enter plan mode and auto-execute only if the plan passes the required quality gate",
		handler: async (_args, ctx) => enterPlanMode(ctx, true, false),
	});

	pi.registerCommand("plan-autopilot", {
		description: "Enter plan-auto gate with Approved-by: оркестратор; durable autopilot flag survives plan=off (close hop is separate runtime)",
		handler: async (_args, ctx) => enterPlanMode(ctx, true, true),
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

	function planReviewWorktreeHardBlock(detail: string): PlanReviewResult[] {
		const reason = `HARD_BLOCK: plan-review needs a recorded task worktree, not a dead pane. ${detail}`;
		return REQUIRED_PLAN_REVIEWERS.map((reviewer) => ({
			reviewer,
			verdict: "BLOCKED" as const,
			findings: [],
			unresolvedBlockers: [reason],
			raw: "",
			error: reason,
		}));
	}

	async function runReviewGateForPlan(ctx: ExtensionContext, draftPlan: string): Promise<PlanReviewResult[]> {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		let beadId: string | undefined;
		for (const entry of [...entries].reverse()) {
			const isWorkflow = entry.type === "workflow-state" || (entry.type === "custom" && entry.customType === "workflow-state");
			if (!isWorkflow || !entry.data || typeof entry.data !== "object") continue;
			const active = (entry.data as { activeBead?: string }).activeBead?.trim();
			if (active) {
				beadId = active;
				break;
			}
		}
		if (!beadId) {
			return planReviewWorktreeHardBlock("No active bead is recorded in workflow-state.");
		}

		const recorded = latestRecordedWorkflowScope(ctx, beadId);
		if (!recorded?.worktreePath) {
			return planReviewWorktreeHardBlock("No recorded task worktree path for the active bead (sessionKey mismatch, first /plan without bind, or missing worktree). Do not spawn on ctx.cwd.");
		}
		if (recorded.branch && PROTECTED_BRANCHES.has(recorded.branch)) {
			return planReviewWorktreeHardBlock(`Recorded branch ${recorded.branch} is protected; need a canonical task worktree.`);
		}

		const scoped = await validatedWorktreeScope("recorded workflow-state", recorded.worktreePath, recorded.branch, recorded.startCommit, "approval");
		if (scoped.error || !scoped.worktreePath) {
			return planReviewWorktreeHardBlock(scoped.error ?? `Recorded worktree is not usable: ${recorded.worktreePath}`);
		}
		if (scoped.branch && PROTECTED_BRANCHES.has(scoped.branch)) {
			return planReviewWorktreeHardBlock(`Worktree branch ${scoped.branch} is protected; need a canonical task worktree.`);
		}

		// One caption at visible spawn start (всех троих / после одного); sendMessage would be steered until the tool returns.
		if (ctx.hasUI) {
			announceVisiblePlanReviewWait({
				notify: (text, level) => ctx.ui.notify(text, level),
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
			});
		}
		return runPlanReviewers(pi, scoped.worktreePath, draftPlan, undefined, {
			hasUI: Boolean(ctx.hasUI),
			beadId,
			branch: scoped.branch,
		});
	}

	async function requestRevisionAfterPlanReview(ctx: ExtensionContext, draftPlan: string): Promise<void> {
		const results = await runReviewGateForPlan(ctx, draftPlan);
		const gate = evaluatePlanReviewGate(results);
		autoPlanReviewResults = results;
		lastPlanReviewResults = results;
		lastPlanReviewDraftPlan = draftPlan;
		if (!gate.ok) {
			autoPlanReviewState = "blocked";
			lastPlanReviewStopAdvice = "HARD_BLOCK";
			const reasons = gate.reasons.map((reason) => `- ${reason}`).join("\n");
			const content = isDeadPaneHardBlock(results)
				? `**Auto-execute blocked.** ${formatDeadPaneHardBlockCopy(results)}\n\n${reasons}`
				: `**Auto-execute blocked by plan-review gate.**\n\n${reasons}\n\nReviewer output:\n\n${renderPlanReviewResults(results)}\n\nRemain in plan mode/read-only and resolve blockers before execution.`;
			pi.sendMessage(
				{
					customType: "plan-review-gate-blocked",
					content,
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
		const cached = lastPlanReviewDraftPlan?.trim() ?? "";
		const draftPlan = autoPlanReviewState === "blocked" && cached
			? cached
			: latestAssistantTextFromEntries(ctx.sessionManager.getEntries() as Array<{ type?: string; message?: AgentMessage }>);
		if (!draftPlan.trim()) {
			pi.sendMessage({ customType: "plan-review-blocked", content: "**Plan review blocked.** No draft plan found in the current session.", display: true }, { triggerTurn: false });
			return;
		}
		const results = await runReviewGateForPlan(ctx, draftPlan);
		const gate = evaluatePlanReviewGate(results);
		lastPlanReviewDraftPlan = draftPlan;
		lastPlanReviewResults = results;
		autoPlanReviewResults = results;
		const advice = planReviewStopAdvice({
			cycle: Math.max(planReviewCycleCount, 1),
			gateOk: gate.ok,
			hasImportantOrCritical: hasImportantOrCriticalFindings(results, gate.importantFindings),
		});
		lastPlanReviewStopAdvice = advice;
		applyPlanReviewAdvice(advice);
		const content = isDeadPaneHardBlock(results)
			? `${formatDeadPaneHardBlockCopy(results)}\n\n${renderPlanReviewResults(results)}`
			: `**Strict plan critique complete.** Implementation remains blocked until explicit approval.\n\n${renderPlanReviewResults(results)}`;
		pi.sendMessage(
			{
				customType: "plan-review-findings",
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
		persistState();
	}

	function sendAutopilotHopMessage(
		content: string,
		customType = "autopilot-hop",
		options?: { triggerTurn?: boolean },
	): void {
		try {
			pi.sendMessage(
				{ customType, content, display: true },
				{ triggerTurn: options?.triggerTurn === true },
			);
		} catch {
			// Best-effort visible hop progress only.
		}
	}

	/** Technical ids only — footer never replaces the human body. Best-effort beadId. */
	function formatAutopilotHopFooter(taskId?: string, beadId?: string): string {
		const lines: string[] = [];
		if (beadId) lines.push(`Bead: ${beadId}`);
		if (taskId) lines.push(`taskId: ${taskId}`);
		return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
	}

	function artifactReportsStop(text: string): boolean {
		return /\bStatus:\s*(?:BLOCKED|NEEDS_CONTEXT)\b/i.test(text)
			|| /\bBEAD\s+\S+\s+STATUS:\s*(?:BLOCKED|NEEDS_CONTEXT)\b/i.test(text)
			|| /\bSTATUS:\s*(?:BLOCKED|NEEDS_CONTEXT)\b/i.test(text);
	}

	async function handleAutopilotRuntimeHop(ctx: ExtensionContext, ping: ParsedVisiblePing): Promise<void> {
		if (ping.missingId || !ping.taskId) {
			sendAutopilotHopMessage(
				"STOP: пришёл [PING] без taskId. Hop не забирал пинг и complete не вызывался. Укажите taskId в ping.sh или повторите с корректным id.\nДействие Максима: поправьте child/ping.",
				"autopilot-hop-stop",
			);
			return;
		}

		const taskId = ping.taskId;
		const bestEffortBeadId = (): string | undefined => {
			try {
				return findRegistryByTaskId(taskId)?.entry?.beadId;
			} catch {
				return undefined;
			}
		};

		if (ping.kind === "error") {
			sendAutopilotHopMessage(
				`STOP: child прислал [PING-ERROR]. Hop остановлен, панели не закрывались.\nПинг уже обработан; ждать [PING] не нужно.\nДействие Максима: разберите ошибку child или followup_visible_dispatch({ beadId, role: "<agentName>", task }).${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
				"autopilot-hop-stop",
			);
			return;
		}

		let completeResult: { status: string; text: string };
		try {
			completeResult = await completeVisibleDispatch(pi as any, { taskId }, ctx as any);
		} catch (error) {
			sendAutopilotHopMessage(
				`STOP: не удалось забрать результат child (complete failed): ${(error as Error).message}\nДействие Максима: проверьте hop/registry или повторите после фикса.${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
				"autopilot-hop-stop",
			);
			return;
		}

		if (completeResult.status === "noop") {
			// submitted/verdict already recorded — no second reviewer/complete.
			sendAutopilotHopMessage(
				`Повторный пинг: шаг уже был зафиксирован раньше. Новых действий hop не делает; панели без изменений.\nЖдать [PING] не нужно.${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
			);
			return;
		}

		if (completeResult.status === "incomplete" || completeResult.status === "result-only") {
			if (artifactReportsStop(completeResult.text)) {
				sendAutopilotHopMessage(
					`STOP: child сообщил BLOCKED или NEEDS_CONTEXT. Autopilot hop на паузе; панели живы.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: fix/followup или снять autopilot.${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
					"autopilot-hop-stop",
				);
				return;
			}
			if (completeResult.status === "incomplete") {
				sendAutopilotHopMessage(
					`Пинг hop уже забрал. Результат child ещё не готов — это не финал.\nЖдать [PING] Максиму не нужно; следующий [PING] придёт от child, когда артефакт будет готов. Панели живы.${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
				);
			} else {
				// result-only: artifact present but not review-ready; reviewer not started.
				sendAutopilotHopMessage(
					`Пинг hop уже забрал. Артефакт есть, но к ревью он ещё не готов: reviewer не запускался, панели живы.\nЭто не «шаг закрыт» и не «работа закончена». Ждать [PING] Максиму не нужно; следующий [PING] — от child после доработки артефакта.${formatAutopilotHopFooter(taskId, bestEffortBeadId())}`,
				);
			}
			return;
		}

		const found = findRegistryByTaskId(taskId);
		if (!found?.entry) {
			sendAutopilotHopMessage(
				`STOP: после complete нет записи registry. Дальше hop не идёт.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: проверьте dispatch-registry.${formatAutopilotHopFooter(taskId)}`,
				"autopilot-hop-stop",
			);
			return;
		}
		const entry = found.entry;

		if (completeResult.status === "submitted") {
			if (artifactReportsStop(completeResult.text)) {
				sendAutopilotHopMessage(
					`STOP: submitted-артефакт всё ещё BLOCKED/NEEDS_CONTEXT. Reviewer не запускался; панели живы.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: fix/followup.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			const live = findLiveRegistryEntriesForBead(entry.beadId);
			const liveReviewer = live.some((item) => item.entry.role === "code-reviewer" && item.entry.status !== "tombstone");
			if (liveReviewer) {
				sendAutopilotHopMessage(
					`Пинг hop уже забрал (submitted). Live reviewer на bead уже есть — второй requestReviewerDispatch не запускался.\nЖдать [PING] Максиму не нужно; дождитесь вердикта reviewer.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
				);
				return;
			}
			if (!entry.worktree) {
				sendAutopilotHopMessage(
					`STOP: у registry entry нет worktree — dispatch_reviewer невозможен.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: восстановите worktree scope.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			let reviewer: { ok: boolean; text: string; error?: string };
			try {
				reviewer = await requestReviewerDispatch(
					pi as any,
					{ beadId: entry.beadId, cwd: entry.worktree, transport: "cmux" },
					ctx as any,
				);
			} catch (error) {
				sendAutopilotHopMessage(
					`STOP: не удалось запустить code-reviewer: ${(error as Error).message}\nПинг супервизора уже забран; панели живы.\nЖдать [PING] не нужно.\nДействие Максима: повторите dispatch_reviewer или followup.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			if (!reviewer.ok) {
				sendAutopilotHopMessage(
					`STOP: не удалось запустить code-reviewer: ${reviewer.error ?? "ошибка dispatch"}.\nПинг супервизора уже забран; панели живы.\nЖдать [PING] не нужно.\nДействие Максима: повторите dispatch_reviewer или followup.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			sendAutopilotHopMessage(
				`Супервизор сдал работу (submitted). Пинг hop уже забрал; ждать [PING] Максиму не нужно.\nЗапущен code-reviewer. Дальше — вердикт reviewer; панели живы.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
			);
			return;
		}

		if (completeResult.status === "verdict") {
			if (/NOT APPROVED/i.test(completeResult.text)) {
				sendAutopilotHopMessage(
					`STOP: code review вернул NOT APPROVED. Bead остаётся inreview; панели живы для followup.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: правки по fix-list / followup_visible_dispatch({ beadId, role: "<agentName>", task }).${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			if (!entry.worktree || !entry.beadId) {
				sendAutopilotHopMessage(
					`STOP: после APPROVED нет bead/worktree — close path не запущен.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: проверьте registry.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			const finalize = await finalizeVisibleReviewClose(pi as any, {
				beadId: entry.beadId,
				worktreePath: entry.worktree,
				startCommit: entry.startCommit,
			});
			if (!finalize.ok) {
				// Grey-matrix blocked (reviewed, not terminal): STOP close panes; keep bead open.
				// NOT APPROVED / missing-evidence: panes stay live; do not call close.
				if (finalize.status === "blocked") {
					let stopCloseError: string | undefined;
					try {
						await closeVisibleDispatch(pi as any, { beadId: entry.beadId, stopClose: true }, ctx as any);
					} catch (error) {
						stopCloseError = (error as Error).message;
					}
					autopilotEnabled = false;
					persistState();
					updateStatus(ctx);
					if (stopCloseError) {
						// Separate STOP: bead not closed, panes may remain; no a/b/c; no «bead уже closed».
						sendAutopilotHopMessage(
							`STOP: серая матрица (acceptance FAIL/NOT RUN). Bead не closed; close_visible_dispatch(stopClose) упал: ${stopCloseError}\nПанели могли остаться. Autopilot сброшен.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: закройте панели вручную при необходимости, затем разберите matrix.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
							"autopilot-hop-stop",
						);
						return;
					}
					const blockingRows = Array.isArray(finalize.blockingRows) ? finalize.blockingRows : [];
					const blockingLines = blockingRows
						.filter((row: { result?: string }) => row.result === "FAIL" || row.result === "NOT RUN")
						.map((row: { item?: string; result?: string }) => `- ${row.result}: ${String(row.item ?? "").slice(0, 120)}`);
					const stopCloseComment = [
						"STOP CLOSE:",
						"reason: grey-matrix blocked after CODE REVIEW APPROVED",
						"panes: closed+tombstone (stopClose); isolation files retained until terminal close",
						"bead: not closed; autopilot cleared",
						...(blockingLines.length > 0 ? ["blocking:", ...blockingLines] : ["blocking: (none listed)"]),
					].join("\n");
					try {
						await pi.exec("bd", ["comments", "add", entry.beadId, stopCloseComment]);
					} catch {
						/* durable comment best-effort; hop message still goes out */
					}
					// Do not dump finalize.text / ACCEPTANCE MATRIX body into the hop message.
					sendAutopilotHopMessage(
						`STOP close: серая матрица (FAIL/NOT RUN) после CODE REVIEW APPROVED. Bead не closed; панели этого bead закрыты/не live (stopClose+tombstone). Autopilot сброшен. followup_visible_dispatch не вызывался.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: (a) HUMAN ACCEPTANCE OVERRIDE comment → reviewed→accepted → bd close; (b) bd update --status in_progress + новый dispatch_supervisor; (c) ничего, autopilot сброшен.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
						"autopilot-hop-stop",
					);
					return;
				}
				// missing-evidence: wake orchestrator LLM (triggerTurn) so it can write matrix/close.
				// not-approved / unknown !ok: fail-closed STOP to Maxim; panes live, close not called.
				if (finalize.status === "missing-evidence") {
					const reason = String(finalize.text ?? "missing-evidence").slice(0, 300);
					sendAutopilotHopMessage(
						[
							"Ревью APPROVED. Hop не закрыл bead: missing-evidence.",
							`Причина: ${reason}`,
							"пинг уже забран, ждать [PING] не нужно; панели живы; autopilot не сброшен.",
							"Сделай в этом ходе: возьми START/END из workflow_status/registry, запиши START_COMMIT/END_COMMIT comments, ladder inreview → simplified → reviewed → честная ACCEPTANCE MATRIX → accepted → bd close → workflow_complete → close_visible_dispatch.",
							"Запреты: НЕ фабриковать матрицу; НЕ bd close из inreview; НЕ review_bead; НЕ complete_visible_dispatch; НЕ dispatch_reviewer; НЕ hop-retry; НЕ fake ping.",
							"Если gap не закрыть в этом ходе — без retry: сбросить autopilot (/plan-cancel) и короткий STOP Максиму. После успешного close — сбросить autopilot.",
							formatAutopilotHopFooter(taskId, entry.beadId).trimStart(),
						].filter(Boolean).join("\n"),
						"autopilot-hop-wake-orch",
						{ triggerTurn: true },
					);
					return;
				}
				if (finalize.status === "not-approved") {
					sendAutopilotHopMessage(
						`STOP: close path заблокирован (not-approved после finalize). Bead не закрыт; панели живы.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: разберите блокировку close / matrix, затем fix или снимите autopilot.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
						"autopilot-hop-stop",
					);
					return;
				}
				// Unknown non-blocked !ok — fail-closed STOP to Maxim.
				sendAutopilotHopMessage(
					`STOP: close path заблокирован (acceptance/matrix или preflight). Bead не закрыт; панели живы.\nПинг уже забран; ждать [PING] не нужно.\nДействие Максима: разберите блокировку close / matrix, затем fix или снимите autopilot.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			// workflow_complete(state=closed) equivalent via workflow-state update (local terminal).
			syncWorkflowPlanMode(ctx, "off", "closed", {
				state: "closed",
				sessionMode: "closed",
				activeBead: undefined,
				planApproved: false,
				bdStatus: "closed",
			});
			let closeFailedMessage: string | undefined;
			try {
				await closeVisibleDispatch(pi as any, { beadId: entry.beadId }, ctx as any);
				// status closed and noop are both success (panes closed or already not live).
			} catch (error) {
				closeFailedMessage = (error as Error).message;
			}
			autopilotEnabled = false;
			persistState();
			updateStatus(ctx);
			if (closeFailedMessage) {
				sendAutopilotHopMessage(
					`STOP: bead уже closed в bd, но закрытие панелей упало: ${closeFailedMessage}\nAutopilot сброшен. Панели могли остаться.\nЖдать [PING] не нужно.\nДействие Максима: закройте панели вручную при необходимости.${formatAutopilotHopFooter(taskId, entry.beadId)}`,
					"autopilot-hop-stop",
				);
				return;
			}
			let closeReport: string;
			try {
				const facts = await collectAutopilotCloseReportFacts(pi, {
					beadId: entry.beadId,
					worktree: entry.worktree,
				});
				closeReport = formatAutopilotCloseReport(facts);
			} catch {
				closeReport = formatAutopilotCloseReport({
					beadId: entry.beadId,
					summary: AUTOPILOT_CLOSE_HOP_SUMMARY,
				});
			}
			sendAutopilotHopMessage(
				`${closeReport}${formatAutopilotHopFooter(taskId, entry.beadId)}`,
			);
		}
	}

	// Natural-language activation for claim+plan, autopilot, and clear enter-plan-mode requests.
	// Autopilot runtime hop consumes [PING]/[PING-ERROR] only when autopilotEnabled && plan=off (exclusive consumer).
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;

		// Runtime hop before NL plan activation: /plan-auto does not set durable autopilot and does not consume ping.
		if (autopilotEnabled && !planModeEnabled) {
			const ping = parseVisiblePing(event.text ?? "");
			if (ping) {
				await handleAutopilotRuntimeHop(ctx, ping);
				return { action: "handled" };
			}
		}

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
		if (isNaturalLanguageAutopilotActivation(event.text)) {
			enterPlanMode(ctx, true, true);
			return { action: "handled" };
		}
		if (!isNaturalLanguagePlanModeActivation(event.text)) return;

		enterPlanMode(ctx, false);
		return { action: "handled" };
	});

	// Enforce plan mode active tool restrictions before runtime spawns any tool-backed work.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		const toolName = normalizedToolCallName(event.toolName);
		if (!PLAN_MODE_TOOL_SET.has(toolName)) {
			return {
				block: true,
				reason: `Plan mode: tool blocked (not available in strict plan mode). Use plan_subagent for read-only planning agents; generic subagent and implementation tools are unavailable until plan mode is approved or disabled with workflow_plan_mode(mode=off).\nTool: ${event.toolName ?? "<unknown>"}`,
			};
		}

		if (toolName !== "bash") return;

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
- You can only use: read, bash, grep, find, ls, questionnaire, plan_mode_complete, workflow_status, workflow_plan_mode, workflow_plan_approved, workflow_plan_review, plan_subagent
- You MAY use plan_subagent only for read-only planning agents (detective/architect); generic subagent and implementation supervisors remain unavailable in plan mode.
- You CANNOT use: edit, write, subagent, dispatch_supervisor, dispatch_reviewer, dispatch_docs_agent, review_bead, workflow_submit_for_review, workflow_complete, spawn_task_workspace (file/workflow mutations are disabled until approval)
- After approved/cancelled plan mode, Pi restores the pre-plan active tool surface plus registered mandatory workflow tools.
- Bash is restricted to an allowlist of read-only commands
- bd read-only commands are allowed: bd show, bd comments, bd list, bd ready, selected bd dep/dolt status commands
- One recovery exception in plan=strict: a single bd worktree create <absolute-path> --branch <type>/<basename> (canonical task branch; not main/master; not remove/prune/git worktree add). After create, retry workflow_plan_approved with WORKTREE+BRANCH — no second human approval and no workflow_plan_mode off.
- Other bd mutating commands remain blocked: bd create/update/close, bd comments add/delete, bd merge-slot acquire/release, bd dolt commit/push/pull. workflow_update and setup-worktree stay outside PLAN_MODE_TOOLS.

Ask clarifying questions using the questionnaire tool (one question tool only — do not invent a second question tool).
When the plan is fully ready for human decision, call plan_mode_complete({ plan }) as the last tool in the turn. Do NOT call plan_mode_complete after a clarifying question. Ready-UI (Исполнить / Остаться / Уточнить / Отправить на plan-review) appears only after plan_mode_complete; the plan-review button runs critique without approving or starting a supervisor. If the button returns findings, they arrive in the plan_mode_complete tool result — adjudicate Accepted/Rejected findings and call plan_mode_complete again with the revised plan.
Use brave-search skill via bash for web research.

Create a detailed numbered draft plan under a "Plan:" header. Do not write English ## section headings; keep canonical English field-lines (Acceptance:, Files to change:) for gates — ready-UI display rewrites known labels to Russian ##, and dual-write of Russian+English keys is forbidden.

${shouldInjectPlanReviewStopPrompt()
	? planReviewTotalCapReached()
		? `Plan-review cycle state: cycle=${planReviewCycleCount} (orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}), lastAdvice=${lastPlanReviewStopAdvice ?? "none"}. Orchestrator extra is forbidden past ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}. If Maxim explicitly asked this turn, call workflow_plan_review({ draftPlan, extraCycle: true, requestedBy: "maxim" }). Residual important/critical alone do not justify cycle 5+. Present the current plan (with Reviewer findings summary / Accepted findings / Rejected findings / Unresolved blockers when applicable) to Maxim now. Call plan_mode_complete so ready-UI remains available.`
		: `Plan-review cycle state: cycle=${planReviewCycleCount} (auto max ${MAX_PLAN_REVIEW_CYCLES}, orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS}), lastAdvice=${lastPlanReviewStopAdvice ?? "none"}. Default auto path stopped. Present the current plan (with Reviewer findings summary / Accepted findings / Rejected findings / Unresolved blockers when applicable) to Maxim now. Additional spawn is allowed only via workflow_plan_review({ draftPlan, extraCycle: true }) (default requestedBy=orchestrator) when Maxim explicitly asks for another review, or residual important/critical findings remain on a high-risk plan (not Fast Path nits). Past ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS} only requestedBy="maxim" when Maxim asked this turn. Extra path never returns CONTINUE. Still call plan_mode_complete so ready-UI exists.`
	: `For autonomous planning (for example, when the user says to work autonomously in plan mode), you MUST call workflow_plan_review with the complete draftPlan before presenting the final plan (auto max ${MAX_PLAN_REVIEW_CYCLES} review cycles; orchestrator extra ceiling ${MAX_PLAN_REVIEW_TOTAL_SPAWNS} with extraCycle; cycle ${MAX_PLAN_REVIEW_TOTAL_SPAWNS + 1}+ only extraCycle+requestedBy="maxim" when Maxim asked this turn). After CONTINUE, revise and call again; after STOP_SHOW_USER, show Maxim (extraCycle if Maxim asks or residual important/critical on high-risk under ceiling; requestedBy="maxim" past ceiling); after HARD_BLOCK, resolve blockers then retry only if cycle < ${MAX_PLAN_REVIEW_CYCLES} (or with extraCycle under orchestrator ceiling / maxim path past it). Then revise the plan with Reviewer findings summary, Accepted findings, Rejected findings, and Unresolved blockers sections.`}
Do not call workflow_plan_approved yourself unless Maxim explicitly approves — except in /plan-autopilot, where runtime approval records Approved-by: оркестратор after the plan-review gate.

If /plan-autopilot (or NL «работаю автономно» / «работать автономно») is active: same multi-agent plan-review gate as /plan-auto; durable PLAN APPROVED uses Approved-by: оркестратор; the autopilot session flag survives plan=off. After CODE REVIEW: APPROVED and a green ACCEPTANCE MATRIX the orchestrator closes the bead without asking Maxim «закрывай?». Stop and ask Maxim on plan-review BLOCKED, missing revised sections, missing active bead/worktree, supervisor BLOCKED/NEEDS_CONTEXT, code-review NOT APPROVED, or matrix FAIL/NOT RUN/BLOCKED/SCOPE GAP. Do not call land or merge-to-main from autopilot.

If auto-plan execution was explicitly requested (/plan-auto or /plan-autopilot), create a draft plan first. Pi will run required multi-agent plan-review agents before implementation. After reviewer findings are returned, your revised plan MUST include all sections below or execution will remain blocked:

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
			// Auto/autopilot never shows ready-UI; drop any stale pending.
			clearPendingReadyPlan();
			if (autoPlanReviewState === "blocked" || autoPlanReviewState === "stopped") {
				persistState();
				return;
			}
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

		// Strict complete-when-ready: primary path is plan_mode_complete execute (select).
		// Do not open ready-UI from agent_end (gauq crash).
	});

	// Restore leftover pendingReadyPlan (restart) with select — not custom (gauq/m6ho).
	// Findings cannot ride a tool result here (no active execute), so wake the model via sendMessage.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!planModeEnabled || autoExecuteEnabled || executionMode) return;
		if (!pendingReadyPlan) return;
		if (!ctx.hasUI) return;
		const outcome = await runStrictReadyUiLoopSafe(ctx, "leftover");
		if (outcome.kind === "findings") {
			pi.sendMessage(
				{
					customType: "plan-review-findings",
					content: formatReadyCritiqueFindingsText(outcome.results),
					display: true,
				},
				{ triggerTurn: true },
			);
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
			| { data?: {
				enabled: boolean;
				autoExecute?: boolean;
				autopilot?: boolean;
				todos?: TodoItem[];
				executing?: boolean;
				autoPlanReviewState?: AutoPlanReviewState;
				autoPlanReviewResults?: PlanReviewResult[];
				planReviewCycleCount?: number;
				lastPlanReviewStopAdvice?: PlanReviewStopAdvice;
				lastPlanReviewResults?: PlanReviewResult[];
				lastPlanReviewDraftPlan?: string;
				pendingReadyPlan?: string;
			} }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			autoExecuteEnabled = planModeEntry.data.autoExecute ?? autoExecuteEnabled;
			autopilotEnabled = planModeEntry.data.autopilot ?? autopilotEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			autoPlanReviewState = restoreAutoPlanReviewState(planModeEntry.data.autoPlanReviewState) ?? autoPlanReviewState;
			autoPlanReviewResults = planModeEntry.data.autoPlanReviewResults ?? autoPlanReviewResults;
			planReviewCycleCount = planModeEntry.data.planReviewCycleCount ?? planReviewCycleCount;
			lastPlanReviewStopAdvice = planModeEntry.data.lastPlanReviewStopAdvice ?? lastPlanReviewStopAdvice;
			lastPlanReviewResults = planModeEntry.data.lastPlanReviewResults ?? lastPlanReviewResults;
			lastPlanReviewDraftPlan = planModeEntry.data.lastPlanReviewDraftPlan ?? lastPlanReviewDraftPlan;
			pendingReadyPlan = planModeEntry.data.pendingReadyPlan ?? pendingReadyPlan;
			// Auto/autopilot never keeps ready pending across restore.
			if (autoExecuteEnabled) clearPendingReadyPlan();
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
