import * as path from "node:path";

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
	raw: string;
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

export interface PlanReviewExecAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
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
	return REQUIRED_REVISED_PLAN_SECTIONS.filter((section) => !section.pattern.test(message)).map((section) => section.label);
}

function normalizeListValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed || /^none$/i.test(trimmed)) return [];
	return trimmed
		.split(/\n|;|,/)
		.map((item) => item.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean);
}

export function parsePlanReviewOutput(reviewer: string, raw: string): PlanReviewResult {
	const verdictMatch = raw.match(/PLAN REVIEW:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)/i);
	const verdict = (verdictMatch?.[1]?.toUpperCase() ?? "BLOCKED") as PlanReviewVerdict;
	const unresolvedMatch = raw.match(/Unresolved blockers:\s*([^\n]*(?:\n\s*[-*]\s+[^\n]+)*)/i);
	const unresolvedBlockers = normalizeListValue(unresolvedMatch?.[1] ?? "none");
	const findings: PlanReviewFinding[] = [];
	const findingPattern = /severity:\s*(critical|important|minor)[\s\S]*?issue:\s*([^\n]+)[\s\S]*?evidence:\s*([^\n]+)[\s\S]*?suggested fix:\s*([^\n]+)/gi;
	for (const match of raw.matchAll(findingPattern)) {
		const [, severity, issue, evidence, suggestedFix] = match;
		if (!severity || !issue || !evidence || !suggestedFix) continue;
		findings.push({
			severity: severity.toLowerCase() as PlanReviewSeverity,
			issue: issue.trim(),
			evidence: evidence.trim(),
			suggestedFix: suggestedFix.trim(),
		});
	}
	return { reviewer, verdict, findings, unresolvedBlockers, raw };
}

function extractFinalAssistantText(stdout: string): string {
	let finalText = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
			if (event.type === "message_end" && event.message?.role === "assistant") {
				finalText = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? finalText;
			}
		} catch {
			// Non-json output is ignored until fallback below.
		}
	}
	return finalText || stdout;
}

export function buildPlanReviewTask(draftPlan: string): string {
	return [
		"Review this draft plan. Return only the required structured verdict format.",
		"Do not modify files, bd state, workflow-state, or approval state.",
		"",
		"Draft plan:",
		"```text",
		draftPlan.trim(),
		"```",
	].join("\n");
}

export async function runPlanReviewers(
	pi: PlanReviewExecAPI,
	cwd: string,
	draftPlan: string,
	reviewers: readonly string[] = REQUIRED_PLAN_REVIEWERS,
): Promise<PlanReviewResult[]> {
	const task = `Task: ${buildPlanReviewTask(draftPlan)}`;
	return Promise.all(reviewers.map(async (reviewer) => {
		const agentPath = path.join(cwd, ".pi", "agents", `${reviewer}.md`);
		const result = await pi.exec("pi", ["--mode", "json", "-p", "--no-session", "--append-system-prompt", agentPath, task]);
		if (result.code !== 0) {
			return { reviewer, verdict: "BLOCKED", findings: [], unresolvedBlockers: [result.stderr || result.stdout || `reviewer ${reviewer} failed`], raw: result.stdout, error: result.stderr || result.stdout } satisfies PlanReviewResult;
		}
		return parsePlanReviewOutput(reviewer, extractFinalAssistantText(result.stdout));
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
		return [`## ${result.reviewer}`, `PLAN REVIEW: ${result.verdict}`, "Findings:", findings, `Unresolved blockers: ${blockers}`].join("\n");
	}).join("\n\n");
}
