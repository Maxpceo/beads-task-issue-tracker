import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectPiRoot } from "../agent-models/index";

export const SUPERVISOR_ROUTING_FILENAME = "supervisor-routing.json";
export const KERNEL_FAILSAFE_AGENT = "implementer";

export type SupervisorRoutingRule = {
	agent: string;
	labels: string[];
	textPatterns: string[];
};

export type SupervisorRoutingLoadResult = {
	rules: SupervisorRoutingRule[];
	default: string;
	path: string | null;
	missing?: boolean;
	error?: string;
};

export type RoutingBead = {
	id?: string;
	status?: string;
	title?: string;
	description?: string;
	labels?: string[];
};

const OUT_OF_SCOPE_HEADING_RE = /^#{2,6}\s*out of scope\s*:?\s*$/;
const MARKDOWN_HEADING_RE = /^#{2,6}\s/;
const NEGATION_OPENER_RE = /^[ \t]*(?:[-*][ \t]+|\d+\.[ \t]+)?(?:не трогать|do not touch|don't touch)\s*:?/;

function isNegationContinuation(line: string): boolean {
	if (/^\s*$/.test(line) || MARKDOWN_HEADING_RE.test(line)) return false;
	return /^[ \t]+/.test(line) || /^(?:[-*][ \t]+|\d+\.[ \t]+)/.test(line);
}

/** Strip Out of scope headings and do-not-touch blocks from a bead description before supervisor routing. Title is not stripped. */
export function textForSupervisorRouting(description: string): string {
	const lines = description.toLowerCase().split(/\r?\n/);
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (OUT_OF_SCOPE_HEADING_RE.test(line)) {
			i++;
			while (i < lines.length && !MARKDOWN_HEADING_RE.test(lines[i]!)) i++;
			i--;
			continue;
		}
		if (NEGATION_OPENER_RE.test(line)) {
			i++;
			while (i < lines.length && isNegationContinuation(lines[i]!)) i++;
			i--;
			continue;
		}
		kept.push(line);
	}
	return kept.join("\n");
}

function failSafe(filePath: string | null, extra: { missing?: boolean; error?: string }): SupervisorRoutingLoadResult {
	return {
		rules: [],
		default: KERNEL_FAILSAFE_AGENT,
		path: filePath,
		...extra,
	};
}

function joinNotes(notes: string[]): string | undefined {
	return notes.length > 0 ? notes.join("; ") : undefined;
}

function normalizeDefault(value: unknown, notes: string[]): string {
	if (value === undefined) return KERNEL_FAILSAFE_AGENT;
	if (typeof value !== "string") {
		notes.push("default is not a string");
		return KERNEL_FAILSAFE_AGENT;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		notes.push("default is empty");
		return KERNEL_FAILSAFE_AGENT;
	}
	return trimmed;
}

function normalizeStringList(
	value: unknown,
	field: string,
	notes: string[],
	ruleAgent: string,
): { ok: true; items: string[] } | { ok: false } {
	if (value === undefined) return { ok: true, items: [] };
	if (!Array.isArray(value)) {
		notes.push(`rule "${ruleAgent}": ${field} is not an array`);
		return { ok: false };
	}
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			notes.push(`rule "${ruleAgent}": ${field} contains a non-string entry`);
			return { ok: false };
		}
		const trimmed = entry.trim();
		if (trimmed) items.push(field === "textPatterns" ? trimmed.toLowerCase() : trimmed);
	}
	return { ok: true, items };
}

function normalizeRules(rawRules: unknown, notes: string[]): SupervisorRoutingRule[] {
	if (rawRules === undefined) return [];
	if (!Array.isArray(rawRules)) {
		notes.push("rules is not an array");
		return [];
	}
	const rules: SupervisorRoutingRule[] = [];
	for (const raw of rawRules) {
		if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
			notes.push("skipped a non-object rule");
			continue;
		}
		const record = raw as Record<string, unknown>;
		const agent = typeof record.agent === "string" ? record.agent.trim() : "";
		if (!agent) {
			notes.push("skipped a rule without a string agent");
			continue;
		}
		const labelsResult = normalizeStringList(record.labels, "labels", notes, agent);
		if (!labelsResult.ok) continue;
		const patternsResult = normalizeStringList(record.textPatterns, "textPatterns", notes, agent);
		if (!patternsResult.ok) continue;
		if (labelsResult.items.length === 0 && patternsResult.items.length === 0) {
			notes.push(`rule "${agent}": skipped because it has no labels and no textPatterns`);
			continue;
		}
		rules.push({
			agent,
			labels: labelsResult.items,
			textPatterns: patternsResult.items,
		});
	}
	return rules;
}

export function supervisorRoutingFilePath(projectRoot: string): string {
	return path.join(projectRoot, ".pi", SUPERVISOR_ROUTING_FILENAME);
}

export function supervisorRoutingWarning(routing: SupervisorRoutingLoadResult): string | undefined {
	if (routing.error) return routing.error;
	if (routing.missing) {
		return routing.path
			? `supervisor-routing.json missing: ${routing.path}`
			: "supervisor-routing.json missing: no project .pi/ directory found from cwd";
	}
	return undefined;
}

/** Load project supervisor-routing.json. Missing/invalid never throws. */
export function loadSupervisorRouting(cwd: string): SupervisorRoutingLoadResult {
	const projectRoot = findProjectPiRoot(cwd);
	if (!projectRoot) {
		return failSafe(null, { missing: true, error: "no project .pi/ directory found from cwd" });
	}
	const filePath = supervisorRoutingFilePath(projectRoot);
	if (!fs.existsSync(filePath)) {
		return failSafe(filePath, { missing: true });
	}
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		return failSafe(filePath, {
			missing: true,
			error: `cannot read ${filePath}: ${(error as Error).message}`,
		});
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return failSafe(filePath, {
			error: `invalid JSON in ${filePath}: ${(error as Error).message}`,
		});
	}
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return failSafe(filePath, { error: `supervisor-routing.json root is not an object: ${filePath}` });
	}
	const record = raw as Record<string, unknown>;
	const notes: string[] = [];
	const defaultAgent = normalizeDefault(record.default, notes);
	const rules = normalizeRules(record.rules, notes);
	return {
		rules,
		default: defaultAgent,
		path: filePath,
		error: joinNotes(notes),
	};
}

function labelsMatch(beadLabels: string[] | undefined, ruleLabels: string[]): boolean {
	if (ruleLabels.length === 0 || !beadLabels || beadLabels.length === 0) return false;
	const have = new Set(beadLabels.map((label) => label.trim().toLowerCase()));
	return ruleLabels.some((label) => have.has(label.toLowerCase()));
}

function textMatches(text: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const needle = pattern.trim().toLowerCase();
		return needle.length > 0 && text.includes(needle);
	});
}

export function resolveSupervisorFromRouting(bead: RoutingBead, routing: SupervisorRoutingLoadResult): string {
	const text = `${bead.title ?? ""}\n${textForSupervisorRouting(bead.description ?? "")}`.toLowerCase();
	for (const rule of routing.rules) {
		if (labelsMatch(bead.labels, rule.labels) || textMatches(text, rule.textPatterns)) {
			return rule.agent;
		}
	}
	return routing.default || KERNEL_FAILSAFE_AGENT;
}

/** Pick supervisor role from project routing table. Read-per-call, no cache. */
export function chooseSupervisor(bead: RoutingBead, cwd = process.cwd()): string {
	return resolveSupervisorFromRouting(bead, loadSupervisorRouting(cwd));
}
