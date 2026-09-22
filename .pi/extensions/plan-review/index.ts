import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publishDashboardCard } from "../subagent/dashboard.js";
import {
	pushModelArg,
	pushThinkingArg,
	resolveAgentModelFromCwd,
} from "../agent-models/index";
import {
	extractFinalAssistantText,
	resolveVisibleCmuxAdapter,
	spawnSyncVisibleAgents,
	type SpawnSyncVisibleAgentsInput,
	type SyncVisibleAgentResult,
} from "../beads-dispatch/visible-agents";
import type { CmuxAdapter } from "../beads-dispatch/cmux-transport";

export default function planReviewExtension(_pi: unknown): void {
	// Helper module loaded from .pi/extensions; no runtime hooks are required here.
}

export const REQUIRED_PLAN_REVIEWERS = [
	"plan-edge-reviewer",
	"plan-consistency-reviewer",
	"plan-dead-zone-reviewer",
] as const;

export type PlanReviewerName = (typeof REQUIRED_PLAN_REVIEWERS)[number];
export type PlanReviewVerdict = "APPROVED" | "NEEDS_CHANGES" | "BLOCKED";
export type PlanReviewSeverity = "critical" | "important" | "minor";

export interface PlanReviewFinding {
	severity: PlanReviewSeverity;
	issue: string;
	evidence: string;
	suggestedFix: string;
}

export interface PlanReviewResult {
	reviewer: string;
	verdict: PlanReviewVerdict;
	findings: PlanReviewFinding[];
	unresolvedBlockers: string[];
	raw?: string;
	resultFile?: string;
	error?: string;
}

export interface PlanReviewGateResult {
	ok: boolean;
	results: PlanReviewResult[];
	missingReviewers: string[];
	blockedReviewers: PlanReviewResult[];
	unresolvedBlockers: string[];
	importantFindings: PlanReviewFinding[];
	reasons: string[];
}

/** Telemetry-only risk class; never an argument to planReviewStopAdvice. */
export type PlanReviewRisk = "low" | "high";

/** Exclusive stop advice for workflow_plan_review cycle cap (auto max 2; extra up to total ceiling). */
export type PlanReviewStopAdvice = "HARD_BLOCK" | "CONTINUE" | "STOP_SHOW_USER";

/** Auto CONTINUE cap for workflow_plan_review (eb4k nits loop). */
export const MAX_PLAN_REVIEW_CYCLES = 2;

/** Orchestrator extra ceiling (cycles 3–4 via extraCycle). Maxim bypass past 4 lives in plan-mode (extraCycle+requestedBy="maxim"). Reset only plan mode off→on. */
export const MAX_PLAN_REVIEW_TOTAL_SPAWNS = 4;

const FAST_PATH_STICKER = /FAST_PATH_RATIONALE\s*:/i;
const PLAN_REVIEW_RISK_DENYLIST = /\.pi\/(extensions|skills|agents|rules)|(?:^|[\s`"'(])scripts\//i;

/**
 * Classify draft-plan risk for telemetry only.
 * low iff FAST_PATH_RATIONALE is present AND the plan does not touch denylisted
 * workflow paths AND does not span both app/ and src-tauri; otherwise high.
 */
export function classifyPlanReviewRisk(draftPlan: string): PlanReviewRisk {
	const text = draftPlan ?? "";
	if (!FAST_PATH_STICKER.test(text)) return "high";
	if (PLAN_REVIEW_RISK_DENYLIST.test(text)) return "high";
	const touchesApp = /(?:^|[\s`"'(])app\//.test(text) || /\bapp\//.test(text);
	const touchesSrcTauri = /src-tauri/.test(text);
	if (touchesApp && touchesSrcTauri) return "high";
	return "low";
}

/**
 * Exclusive stop table for plan-review cycles.
 * Risk is intentionally not an input — telemetry only.
 *
 * - !gateOk → HARD_BLOCK
 * - gateOk && !hasImportantOrCritical → STOP_SHOW_USER (cycle >= 1 after spawn)
 * - gateOk && hasImportantOrCritical && cycle < MAX_PLAN_REVIEW_CYCLES → CONTINUE
 * - gateOk && cycle >= MAX_PLAN_REVIEW_CYCLES → STOP_SHOW_USER
 * Extra spawns (orch cycles 3–4 via extraCycle; Maxim cycle 5+ via plan-mode requestedBy) never CONTINUE: cycle >= 2 already yields STOP_SHOW_USER.
 */
export function planReviewStopAdvice(input: {
	cycle: number;
	gateOk: boolean;
	hasImportantOrCritical: boolean;
}): PlanReviewStopAdvice {
	const { cycle, gateOk, hasImportantOrCritical } = input;
	if (!gateOk) return "HARD_BLOCK";
	if (cycle >= MAX_PLAN_REVIEW_CYCLES) return "STOP_SHOW_USER";
	if (!hasImportantOrCritical) return "STOP_SHOW_USER";
	return "CONTINUE";
}

export function hasImportantOrCriticalFindings(
	results: PlanReviewResult[] | undefined,
	importantFindings?: PlanReviewFinding[],
): boolean {
	if (importantFindings && importantFindings.length > 0) return true;
	return (results ?? []).some((result) =>
		result.findings.some((finding) => finding.severity === "critical" || finding.severity === "important"),
	);
}

export interface PlanReviewExecAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}


const ACCEPTED_SEQUENTIAL_REASON = /dependency\s+chain|write\s+conflict|shared\s+verification\s+bottleneck|shared\s+external\s+resource|uncertain\s+scope|repo\/?policy\s+limit|repo\s+limit|policy\s+limit/i;
const VAGUE_SEQUENTIAL_REASON = /files?\s+(?:are\s+)?related|related\s+files?|related\s+changes?|changes?\s+(?:are\s+)?related|same\s+(?:area|domain|feature)/i;

function splitMarkdownRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function findInvalidSequentialReasons(planText: string): string[] {
	const findings: string[] = [];
	const lines = planText.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const headers = splitMarkdownRow(lines[index] ?? "").map((cell) => cell.toLowerCase().replace(/[*_`]/g, "").trim());
		const decisionIndex = headers.findIndex((cell) => cell === "decision" || cell === "решение");
		const reasonIndex = headers.findIndex((cell) => cell === "reason" || cell === "причина");
		if (decisionIndex === -1 || reasonIndex === -1) continue;
		for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
			const rowLine = lines[rowIndex] ?? "";
			if (!rowLine.includes("|") || /^\s*$/.test(rowLine)) break;
			const cells = splitMarkdownRow(rowLine);
			const decision = cells[decisionIndex] ?? "";
			const reason = cells[reasonIndex] ?? "";
			if (/sequential|последоват/i.test(decision) && (!reason || VAGUE_SEQUENTIAL_REASON.test(reason) || !ACCEPTED_SEQUENTIAL_REASON.test(reason))) {
				findings.push(`Sequential stream row ${rowIndex + 1} has unsupported reason: ${reason || "<empty>"}`);
			}
		}
	}
	return findings;
}

export const REQUIRED_REVISED_PLAN_SECTIONS = [
	{ label: "Reviewer findings summary", pattern: /(^|\n)\s*\*{0,2}Reviewer findings summary:\*{0,2}\s*\n/i },
	{ label: "Accepted findings", pattern: /(^|\n)\s*\*{0,2}Accepted findings:\*{0,2}\s*\n/i },
	{ label: "Rejected findings", pattern: /(^|\n)\s*\*{0,2}Rejected findings:\*{0,2}\s*\n/i },
	{ label: "Unresolved blockers: none", pattern: /(^|\n)\s*\*{0,2}Unresolved blockers:\*{0,2}\s*none\s*($|\n)/i },
	{ label: "Revised plan", pattern: /(^|\n)\s*\*{0,2}Revised plan:\*{0,2}\s*\n/i },
	{ label: "Files to change", pattern: /(^|\n)\s*\*{0,2}Files to change:\*{0,2}\s*\n/i },
	{ label: "Acceptance", pattern: /(^|\n)\s*\*{0,2}Acceptance:\*{0,2}\s*\n/i },
	{ label: "Risks / rollback", pattern: /(^|\n)\s*\*{0,2}Risks\s*\/\s*rollback:\*{0,2}\s*\n/i },
	{ label: "AUTO_EXECUTE_ALLOWED: true", pattern: /(^|\n)\s*AUTO_EXECUTE_ALLOWED:\s*true\s*($|\n)/i },
];

export function missingRevisedPlanSections(message: string): string[] {
	return [
		...REQUIRED_REVISED_PLAN_SECTIONS.filter((section) => !section.pattern.test(message)).map((section) => section.label),
		...findInvalidSequentialReasons(message),
	];
}

function normalizeListValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed || /^none$/i.test(trimmed)) return [];
	return trimmed
		.split(/\n|;|,/)
		.map((item) => item.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean);
}

const LEFTOVER_DECISION_RE = /PLAN REVIEW:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)|нельзя исполнять|не исполнять|must not execute|do not execute|cannot execute|should not execute|\bBLOCKED\b|unresolved blocker|\bcritical\b|\bimportant\b/i;

function parseFindingsBlock(block: string): PlanReviewFinding[] {
	const findings: PlanReviewFinding[] = [];
	let current: Partial<PlanReviewFinding> & { severity?: PlanReviewSeverity } | undefined;
	let currentField: "issue" | "evidence" | "suggestedFix" | undefined;

	const flush = () => {
		if (!current) return;
		const severity = current.severity;
		if (
			(severity === "critical" || severity === "important" || severity === "minor")
			&& current.issue
			&& current.evidence
			&& current.suggestedFix
		) {
			findings.push({
				severity,
				issue: current.issue.trim(),
				evidence: current.evidence.trim(),
				suggestedFix: current.suggestedFix.trim(),
			});
		}
		current = undefined;
		currentField = undefined;
	};

	for (const line of block.replace(/\r\n/g, "\n").split("\n")) {
		const severityLine = line.match(/^\s*-?\s*severity:\s*(critical|important|minor)\s*$/i);
		if (severityLine) {
			flush();
			current = { severity: severityLine[1]!.toLowerCase() as PlanReviewSeverity };
			continue;
		}
		const field = line.match(/^\s*(issue|evidence|suggested fix):\s*(.*)$/i);
		if (field && current) {
			const name = field[1]!.toLowerCase();
			currentField = name === "suggested fix" ? "suggestedFix" : name === "issue" ? "issue" : "evidence";
			current[currentField] = field[2] ?? "";
			continue;
		}
		if (current && currentField) {
			current[currentField] = `${current[currentField] ?? ""}\n${line.replace(/^\s{0,2}/, "")}`;
		}
	}
	flush();
	return findings;
}

function leftoverOutsideTemplate(raw: string): string {
	const text = raw.replace(/\r\n/g, "\n");
	const spans: Array<[number, number]> = [];
	const verdict = /PLAN REVIEW:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)\b/i.exec(text);
	if (verdict && verdict.index !== undefined) {
		spans.push([verdict.index, verdict.index + verdict[0].length]);
	}
	const findingsHeader = /^\s*Findings:\s*$/im.exec(text);
	const blockersHeader = /^\s*Unresolved blockers:/im.exec(text);
	if (
		findingsHeader && findingsHeader.index !== undefined
		&& blockersHeader && blockersHeader.index !== undefined
		&& blockersHeader.index > findingsHeader.index
	) {
		spans.push([findingsHeader.index, blockersHeader.index]);
	}
	if (blockersHeader && blockersHeader.index !== undefined) {
		const rest = text.slice(blockersHeader.index);
		const block = rest.match(/^\s*Unresolved blockers:\s*([^\n]*(?:\n\s*[-*]\s+[^\n]+)*)/i);
		if (block) spans.push([blockersHeader.index, blockersHeader.index + block[0].length]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (const [start, end] of spans) {
		if (start > pos) out += text.slice(pos, start);
		pos = Math.max(pos, end);
	}
	out += text.slice(pos);
	return out.trim();
}

function leftoverDecisionQuote(leftover: string): string | undefined {
	const match = leftover.match(LEFTOVER_DECISION_RE);
	if (!match || match.index === undefined) return undefined;
	const line = leftover.split("\n").find((row) => LEFTOVER_DECISION_RE.test(row)) ?? leftover;
	const quote = line.trim();
	return quote.length > 240 ? `${quote.slice(0, 240)}…` : quote;
}

export function parsePlanReviewOutput(reviewer: string, raw: string, resultFile?: string): PlanReviewResult {
	const text = raw ?? "";
	if (!text.trim()) {
		return {
			reviewer,
			verdict: "BLOCKED",
			findings: [],
			unresolvedBlockers: ["empty report file"],
			resultFile,
		};
	}
	const verdictMatch = text.match(/PLAN REVIEW:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)\b/i);
	let verdict = (verdictMatch?.[1]?.toUpperCase() ?? "BLOCKED") as PlanReviewVerdict;
	const unresolvedMatch = text.match(/Unresolved blockers:\s*([^\n]*(?:\n\s*[-*]\s+[^\n]+)*)/i);
	const unresolvedBlockers = normalizeListValue(unresolvedMatch?.[1] ?? "none");
	const findingsHeader = /^\s*Findings:\s*$/im.exec(text);
	const blockersHeader = /^\s*Unresolved blockers:/im.exec(text);
	const findingsBlock = findingsHeader && findingsHeader.index !== undefined
		? text.slice(findingsHeader.index, blockersHeader && blockersHeader.index !== undefined ? blockersHeader.index : undefined)
		: text;
	const findings = parseFindingsBlock(findingsBlock);
	const leftover = leftoverOutsideTemplate(text);
	const leftoverQuote = leftoverDecisionQuote(leftover);
	if (leftoverQuote) unresolvedBlockers.push(`leftover decision: ${leftoverQuote}`);
	if (!verdictMatch || findings.length === 0) {
		verdict = "BLOCKED";
		if (!verdictMatch) unresolvedBlockers.push("missing PLAN REVIEW verdict");
		if (findings.length === 0) unresolvedBlockers.push("no parsed findings");
	}
	return { reviewer, verdict, findings, unresolvedBlockers, resultFile };
}

export function parsePlanReviewFile(reviewer: string, filePath: string): PlanReviewResult {
	let source = "";
	try {
		if (!fs.existsSync(filePath)) {
			return {
				reviewer,
				verdict: "BLOCKED",
				findings: [],
				unresolvedBlockers: ["empty report file"],
				resultFile: filePath,
			};
		}
		source = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			reviewer,
			verdict: "BLOCKED",
			findings: [],
			unresolvedBlockers: [`cannot read report file: ${message}`],
			resultFile: filePath,
		};
	}
	if (!source.trim()) {
		return {
			reviewer,
			verdict: "BLOCKED",
			findings: [],
			unresolvedBlockers: ["empty report file"],
			resultFile: filePath,
		};
	}
	return parsePlanReviewOutput(reviewer, extractFinalAssistantText(source), filePath);
}

function persistHeadlessPlanReviewStdout(cwd: string, reviewer: string, stdout: string): string {
	const preferred = path.join(cwd, ".pi", "orchestrator", "results");
	try {
		fs.mkdirSync(preferred, { recursive: true });
		const file = path.join(preferred, `plan-review-${reviewer}-${Date.now()}.md`);
		fs.writeFileSync(file, stdout);
		return file;
	} catch {
		const fallback = path.join(os.tmpdir(), "pi-plan-review-reports");
		fs.mkdirSync(fallback, { recursive: true });
		const file = path.join(fallback, `plan-review-${reviewer}-${Date.now()}-${process.pid}.md`);
		fs.writeFileSync(file, stdout);
		return file;
	}
}

export function buildPlanReviewTask(draftPlan: string): string {
	return [
		"Review this draft plan. Return only the required structured verdict format.",
		"Do not modify repository files, bd state, workflow-state, or approval state.",
		"",
		"Draft plan:",
		"```text",
		draftPlan.trim(),
		"```",
	].join("\n");
}

/** Immediate hasUI caption while workflow_plan_review holds Using Tools (jipg). */
export const PLAN_REVIEW_WAITING_TRIO_NOTICE =
	"Жду трёх ревьюеров плана — панели справа. Оценка начнётся, только когда закончат всех троих: после одного или двух ничего не произойдёт. Пока они работают, оркестратор не читает чат. Когда будут все три отчёта — разберу план.";

export const PLAN_REVIEW_WAITING_TRIO_ENTRY = "plan-review-waiting";

export function announceVisiblePlanReviewWait(channels?: {
	notify?: (text: string, level?: string) => void;
	appendEntry?: (customType: string, data: unknown) => void;
}): void {
	try {
		channels?.notify?.(PLAN_REVIEW_WAITING_TRIO_NOTICE, "info");
	} catch {
		// notify failure must not cancel spawn
	}
	try {
		channels?.appendEntry?.(PLAN_REVIEW_WAITING_TRIO_ENTRY, { content: PLAN_REVIEW_WAITING_TRIO_NOTICE });
	} catch {
		// appendEntry failure must not cancel spawn
	}
}

export interface RunPlanReviewersOptions {
	hasUI?: boolean;
	beadId?: string;
	branch?: string;
	adapter?: CmuxAdapter;
	signal?: AbortSignal;
	timeoutMs?: number;
	pollMs?: number;
	sleep?: SpawnSyncVisibleAgentsInput["sleep"];
	spawnVisible?: (input: SpawnSyncVisibleAgentsInput) => Promise<SyncVisibleAgentResult[]>;
	notify?: (text: string, level?: string) => void;
	appendEntry?: (customType: string, data: unknown) => void;
}

const PLAN_REVIEW_VISIBLE_TOOLS = "read,grep,find,ls,write";

function planReviewResultFromVisible(reviewer: string, row: SyncVisibleAgentResult): PlanReviewResult {
	if (row.error && !row.output.trim()) {
		return {
			reviewer,
			verdict: "BLOCKED",
			findings: [],
			unresolvedBlockers: [row.error],
			resultFile: row.resultFile,
			error: row.error,
		};
	}
	if (row.resultFile) {
		const parsed = parsePlanReviewFile(reviewer, row.resultFile);
		if (row.error) parsed.error = row.error;
		return parsed;
	}
	const parsed = parsePlanReviewOutput(reviewer, row.output, row.resultFile);
	if (row.error) parsed.error = row.error;
	return parsed;
}

export async function runPlanReviewers(
	pi: PlanReviewExecAPI,
	cwd: string,
	draftPlan: string,
	reviewers: readonly string[] = REQUIRED_PLAN_REVIEWERS,
	options?: RunPlanReviewersOptions,
): Promise<PlanReviewResult[]> {
	const task = buildPlanReviewTask(draftPlan);
	if (options?.hasUI) {
		if (options.notify || options.appendEntry) {
			announceVisiblePlanReviewWait({
				notify: options.notify,
				appendEntry: options.appendEntry,
			});
		}
		const adapter = options.adapter ?? resolveVisibleCmuxAdapter(pi.exec.bind(pi));
		const spawnVisible = options.spawnVisible ?? spawnSyncVisibleAgents;
		try {
			const visible = await spawnVisible({
				adapter,
				worktreePath: cwd,
				branch: options.branch,
				beadId: options.beadId,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				pollMs: options.pollMs,
				sleep: options.sleep,
				agents: reviewers.map((reviewer) => {
					const resolved = resolveAgentModelFromCwd(cwd, reviewer);
					return {
						role: reviewer,
						task,
						systemPromptFile: path.join(cwd, ".pi", "agents", `${reviewer}.md`),
						tools: PLAN_REVIEW_VISIBLE_TOOLS,
						model: resolved.model,
						thinking: resolved.thinking,
					};
				}),
			});
			const byRole = new Map(visible.map((row) => [row.role, row]));
			return reviewers.map((reviewer) => {
				const row = byRole.get(reviewer);
				if (!row) {
					return {
						reviewer,
						verdict: "BLOCKED",
						findings: [],
						unresolvedBlockers: [`missing visible result for ${reviewer}`],
						raw: "",
						error: `missing visible result for ${reviewer}`,
					} satisfies PlanReviewResult;
				}
				return planReviewResultFromVisible(reviewer, row);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return reviewers.map((reviewer) => ({
				reviewer,
				verdict: "BLOCKED",
				findings: [],
				unresolvedBlockers: [message],
				raw: "",
				error: message,
			}));
		}
	}
	const headlessTask = `Task: ${task}`;
	return Promise.all(reviewers.map(async (reviewer) => {
		const agentPath = path.join(cwd, ".pi", "agents", `${reviewer}.md`);
		const startedAt = Date.now();
		publishDashboardCard({
			agent: reviewer,
			description: `plan review: ${reviewer}`,
			source: "project",
			status: "running",
			task: "Review draft plan",
			startedAt,
			toolCount: 0,
			lastPreview: "starting plan reviewer...",
		});
		let terminalStatus: "completed" | "failed" = "completed";
		let reviewResult: PlanReviewResult | undefined;
		try {
			const resolved = resolveAgentModelFromCwd(cwd, reviewer);
			const args = [
				"--mode", "json",
				"-p",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--tools", "read,grep,find,ls,write",
				"--append-system-prompt", agentPath,
			];
			pushModelArg(args, resolved.model);
			pushThinkingArg(args, resolved.thinking);
			args.push(headlessTask);
			const result = await pi.exec("pi", args);
			const reportFile = persistHeadlessPlanReviewStdout(cwd, reviewer, result.stdout);
			if (result.code !== 0) {
				terminalStatus = "failed";
				reviewResult = {
					reviewer,
					verdict: "BLOCKED",
					findings: [],
					unresolvedBlockers: [result.stderr || result.stdout || `reviewer ${reviewer} failed`],
					resultFile: reportFile,
					error: result.stderr || result.stdout,
				} satisfies PlanReviewResult;
			} else {
				reviewResult = parsePlanReviewFile(reviewer, reportFile);
				terminalStatus = reviewResult.verdict === "BLOCKED" || reviewResult.error ? "failed" : "completed";
			}
			return reviewResult;
		} catch (error) {
			terminalStatus = "failed";
			const message = error instanceof Error ? error.message : String(error);
			reviewResult = {
				reviewer,
				verdict: "BLOCKED",
				findings: [],
				unresolvedBlockers: [message],
				raw: "",
				error: message,
			} satisfies PlanReviewResult;
			return reviewResult;
		} finally {
			publishDashboardCard({
				agent: reviewer,
				description: `plan review: ${reviewer}`,
				source: "project",
				status: terminalStatus,
				task: "Review draft plan",
				startedAt,
				completedAt: Date.now(),
				toolCount: 0,
				lastPreview: reviewResult?.verdict
					? `PLAN REVIEW: ${reviewResult.verdict}`
					: terminalStatus === "failed"
						? "plan reviewer failed"
						: "plan reviewer finished",
				errorMessage: reviewResult?.error,
			});
		}
	}));
}

export function evaluatePlanReviewGate(results: PlanReviewResult[], reviewers: readonly string[] = REQUIRED_PLAN_REVIEWERS): PlanReviewGateResult {
	const missingReviewers = reviewers.filter((reviewer) => !results.some((result) => result.reviewer === reviewer));
	const blockedReviewers = results.filter((result) => result.verdict === "BLOCKED" || Boolean(result.error));
	const unresolvedBlockers = results.flatMap((result) => result.unresolvedBlockers.map((blocker) => `${result.reviewer}: ${blocker}`));
	const importantFindings = results.flatMap((result) => result.findings.filter((finding) => finding.severity === "critical" || finding.severity === "important"));
	const reasons = [
		...missingReviewers.map((reviewer) => `missing reviewer: ${reviewer}`),
		...blockedReviewers.map((result) => `blocked reviewer: ${result.reviewer}`),
		...unresolvedBlockers.map((blocker) => `unresolved blocker: ${blocker}`),
	];
	return {
		ok: reasons.length === 0,
		results,
		missingReviewers,
		blockedReviewers,
		unresolvedBlockers,
		importantFindings,
		reasons,
	};
}

export function renderPlanReviewResults(results: PlanReviewResult[]): string {
	return results.map((result) => {
		const findings = result.findings.length > 0
			? result.findings.map((finding) => `- ${finding.severity}: ${finding.issue}\n  Evidence: ${finding.evidence}\n  Suggested fix: ${finding.suggestedFix}`).join("\n")
			: "- none";
		const blockers = result.unresolvedBlockers.length > 0 ? result.unresolvedBlockers.map((blocker) => `- ${blocker}`).join("\n") : "none";
		const lines = [`## ${result.reviewer}`, `PLAN REVIEW: ${result.verdict}`, "Findings:", findings, `Unresolved blockers: ${blockers}`];
		if (result.resultFile) lines.push(`Report file: ${result.resultFile}`);
		return lines.join("\n");
	}).join("\n\n");
}
