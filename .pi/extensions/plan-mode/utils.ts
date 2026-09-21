/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bbd\s+(create|new|update|close|reopen|delete|dep\s+(add|remove|rm)|comments\s+(add|delete|rm)|merge-slot\s+(acquire|release)|dolt\s+(commit|push|pull))/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*bd\s+(show|comments|list|ready|dep\s+(tree|list|show)|dolt\s+(status|show|test|remote\s+list))\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isSafeCommandSegment(command: string): boolean {
	return SAFE_PATTERNS.some((p) => p.test(command));
}

const CANONICAL_TASK_BRANCH_RE =
	/^(?:feat|fix|docs|test|ci|refactor|task|chore)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * Plan-mode recovery exception: one `bd worktree create <abs> --branch <type>/<basename>`.
 * Does not replace SAFE_PATTERNS; checked after shell-control forbids.
 */
export function isAllowedBdWorktreeCreateCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	// Fail closed on shell composition / substitution before any create exception.
	if (/(?:&&|\|\||;|`|\$\()/.test(trimmed)) return false;
	if (trimmed.includes("|")) return false;
	if (/\bgit\s+worktree\b/i.test(trimmed)) return false;
	if (/\bbd\s+worktree\s+(?:remove|prune|list|info)\b/i.test(trimmed)) return false;

	const match = trimmed.match(
		/^bd\s+worktree\s+create\s+(\/[^\s'"]+|\/'[^']+'|\/"[^"]+"|'\/[^']+'|"\/[^"]+")\s+--branch\s+([^\s'"]+|'[^']+'|"[^"]+")\s*$/i,
	);
	if (!match) return false;

	const rawPath = match[1] ?? "";
	const rawBranch = match[2] ?? "";
	const worktreePath = rawPath.replace(/^['"]|['"]$/g, "");
	const branch = rawBranch.replace(/^['"]|['"]$/g, "");
	if (!worktreePath.startsWith("/") || /[\n\r]/.test(worktreePath)) return false;
	if (!branch || /^(main|master)$/i.test(branch) || /^(main|master)\//i.test(branch)) return false;
	if (!CANONICAL_TASK_BRANCH_RE.test(branch)) return false;
	// Reject extra flags such as --orphan by requiring the exact two-token shape above.
	return true;
}

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	if (isDestructive) return false;

	const hasShellControlOperator = /(?:&&|\|\||;)/.test(command);
	if (hasShellControlOperator) return false;

	// Single recovery exception after control-operator forbid: canonical bd worktree create.
	if (isAllowedBdWorktreeCreateCommand(command)) return true;

	return command
		.split("|")
		.map((segment) => segment.trim())
		.every((segment) => segment.length > 0 && isSafeCommandSegment(segment));
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}(?:Revised plan|Plan):\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const rawText = match[2];
		if (!rawText) continue;
		const text = rawText
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

export interface PlanQualityResult {
	ok: boolean;
	missing: string[];
}

const REQUIRED_AUTO_EXECUTE_SECTIONS = [
	{ label: "Plan", pattern: /(^|\n)\s*\*{0,2}Plan:\*{0,2}\s*\n/i },
	{ label: "Edge-case review", pattern: /(^|\n)\s*\*{0,2}Edge-case review:\*{0,2}\s*\n/i },
	{ label: "Files to change", pattern: /(^|\n)\s*\*{0,2}Files to change:\*{0,2}\s*\n/i },
	{ label: "Acceptance", pattern: /(^|\n)\s*\*{0,2}Acceptance:\*{0,2}\s*\n/i },
	{ label: "Risks / rollback", pattern: /(^|\n)\s*\*{0,2}Risks\s*\/\s*rollback:\*{0,2}\s*\n/i },
	{ label: "AUTO_EXECUTE_ALLOWED: true", pattern: /(^|\n)\s*AUTO_EXECUTE_ALLOWED:\s*true\s*($|\n)/i },
];

export function validateAutoExecutePlan(message: string): PlanQualityResult {
	const missing = REQUIRED_AUTO_EXECUTE_SECTIONS.filter((section) => !section.pattern.test(message)).map(
		(section) => section.label,
	);
	return { ok: missing.length === 0, missing };
}

/** Hop-known close sentence. Never invents tests, files, or git facts. */
export const AUTOPILOT_CLOSE_HOP_SUMMARY =
	"После code review APPROVED hop закрыл bead без вопроса «закрывай?». Панели закрыты или уже не live.";

export interface AutopilotCloseReportFacts {
	beadId: string;
	title?: string;
	summary?: string;
	checks?: string[];
	files?: string[];
	gitNote?: string;
}

function truncateText(value: string, max: number): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isSectionHeading(line: string): boolean {
	return (
		/^\s*#{1,3}\s/.test(line)
		|| /^\s*[A-Za-z][\w /-]{0,40}:\s*$/.test(line)
	);
}

function extractLabeledParagraph(text: string, label: string): string | undefined {
	const header = new RegExp(`^\\s*${label}:\\s*(.*)$`, "i");
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index]?.match(header);
		if (!match) continue;
		const body: string[] = [];
		const sameLine = match[1]?.trim();
		if (sameLine) body.push(sameLine);
		for (let next = index + 1; next < lines.length; next += 1) {
			const line = lines[next] ?? "";
			if (/^\s*$/.test(line)) {
				if (body.length > 0) break;
				continue;
			}
			if (isSectionHeading(line)) break;
			body.push(line.trim());
		}
		const joined = body.join(" ").trim();
		return joined ? truncateText(joined, 280) : undefined;
	}
	return undefined;
}

export function extractPlanApprovedSummary(text: string): string | undefined {
	const problem = extractLabeledParagraph(text, "Problem");
	const approach = extractLabeledParagraph(text, "Approach");
	if (problem && approach) return `${problem} → ${approach}`;
	return problem ?? approach;
}

export function extractPlanApprovedFiles(text: string): string[] {
	const header = /(?:^|\n)\s*Files to change:\s*\n/i;
	const start = text.search(header);
	if (start < 0) return [];
	const after = text.slice(start).replace(header, "");
	const files: string[] = [];
	for (const line of after.split("\n")) {
		if (/^\s*$/.test(line)) {
			if (files.length > 0) break;
			continue;
		}
		if (/^\s*#{1,3}\s/.test(line) || /^\s*[A-Za-zА-Яа-я][^\n]{0,60}:\s*$/.test(line)) break;
		const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
		if (!bullet?.[1]) {
			if (files.length > 0) break;
			continue;
		}
		const file = bullet[1].replace(/^[`']+|[`']+$/g, "").trim();
		if (!file || /^(n\/a|none|-)$/i.test(file)) continue;
		files.push(truncateText(file, 160));
		if (files.length >= 12) break;
	}
	return files;
}

export function extractAcceptanceCheckLines(text: string): string[] {
	const checks: string[] = [];
	for (const raw of text.split("\n")) {
		if (!/\bPASS\b/.test(raw)) continue;
		if (/\b(FAIL|NOT RUN|BLOCKED|SCOPE GAP)\b/.test(raw)) continue;
		const cleaned = raw.replace(/^\s*[-*]\s*/, "").trim();
		if (!cleaned) continue;
		if (!/\b(exit\s+\d+|vitest|pnpm|cargo|pytest|passed)\b/i.test(cleaned)) continue;
		checks.push(truncateText(cleaned, 200));
		if (checks.length >= 8) break;
	}
	return checks;
}

export function describeAutopilotGitState(state: {
	upstream?: string | null;
	ancestorOfMain?: boolean | null;
}): string | undefined {
	const noUpstream = state.upstream === null;
	const notInMain = state.ancestorOfMain === false;
	if (!noUpstream && !notInMain) return undefined;
	if (noUpstream && notInMain) {
		return "Ветка без upstream и не в main. Сессию можно закрывать; land отдельно — hop его не вызывал.";
	}
	if (noUpstream) {
		return "Ветка без upstream. Сессию можно закрывать; land отдельно — hop его не вызывал.";
	}
	return "Ветка не в main. Сессию можно закрывать; land отдельно — hop его не вызывал.";
}

export function formatAutopilotCloseReport(facts: AutopilotCloseReportFacts): string {
	const beadId = facts.beadId.trim();
	const title = facts.title?.trim();
	const heading = title
		? `## Задача выполнена ${title} (${beadId}) на автопилоте`
		: `## Задача выполнена (${beadId}) на автопилоте`;
	const sections: string[] = [heading];

	const summary = facts.summary?.trim();
	if (summary) sections.push(summary);

	const checks = (facts.checks ?? []).map((line) => line.trim()).filter(Boolean);
	if (checks.length > 0) {
		sections.push(`## Проверка\n${checks.map((line) => `- ${line}`).join("\n")}`);
	}

	const files = (facts.files ?? []).map((line) => line.trim()).filter(Boolean);
	if (files.length > 0) {
		sections.push(`## Файлы\n${files.map((line) => `- ${line}`).join("\n")}`);
	}

	const gitNote = facts.gitNote?.trim();
	if (gitNote) sections.push(gitNote);

	return sections.join("\n\n");
}
