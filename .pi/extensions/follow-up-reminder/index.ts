import { createHash } from "node:crypto";

interface ExtensionAPI {
	appendEntry(type: string, data: unknown): void;
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
	sendMessage?(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }): void;
}

interface ExtensionContext {
	hasUI?: boolean;
	sessionManager: {
		getEntries(): SessionEntry[];
		getLeafId?(): string | undefined;
	};
	ui: {
		notify(message: string, level?: string): void;
	};
}

interface SessionEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown; customType?: string };
	timestamp?: string;
}

export interface FollowUpCandidate {
	id: string;
	markerType: string;
	snippet: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	sourceEntryId?: string;
	sourceTime: string;
	status: "open" | "resolved" | "cleared";
	resolution?: string;
}

interface WorkflowStateSnapshot {
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	state?: string;
}

type FollowUpReminderEvent =
	| { version: 1; action: "candidate"; candidate: FollowUpCandidate }
	| { version: 1; action: "resolve" | "clear"; id: string; reason: string; at: string }
	| { version: 1; action: "clear-all"; reason: string; at: string; scope?: FollowUpScope };

interface FollowUpScope {
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
}

const CUSTOM_TYPE = "follow-up-reminder";
const SNIPPET_LIMIT = 360;

const MARKERS: Array<{ type: string; pattern: RegExp }> = [
	{ type: "follow-up bead", pattern: /\bfollow[- ]?up\s+(?:bead|issue|task|work)\b/i },
	{ type: "outside scope", pattern: /\b(?:outside|out of)\s+scope\b/i },
	{ type: "pre-existing", pattern: /\bpre[- ]?existing\b/i },
	{ type: "not introduced", pattern: /\bnot\s+introduced\s+by\s+this\s+change\b/i },
	{ type: "separate bead", pattern: /\b(?:separate|new)\s+(?:bead|issue|task)\b/i },
	{ type: "отдельный bead", pattern: /(?:^|[^\p{L}\p{N}_])отдельн(?:ым|ый|ую|ая|ое)\s+(?:bead|задач[ауи]|issue)(?=$|[^\p{L}\p{N}_])/iu },
	{ type: "можно отложить", pattern: /(?:^|[^\p{L}\p{N}_])можно\s+отложить(?=$|[^\p{L}\p{N}_])/iu },
];

const LOW_CONFIDENCE_ONLY = /\b(?:later|todo|eventually|maybe|nice to have|потом|когда-нибудь)\b/iu;

function sha(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clipAround(text: string, index: number, limit = SNIPPET_LIMIT): string {
	const normalized = normalizeText(text);
	if (normalized.length <= limit) return normalized;
	const start = Math.max(0, Math.min(index - Math.floor(limit / 3), normalized.length - limit));
	const clipped = normalized.slice(start, start + limit);
	return `${start > 0 ? "…" : ""}${clipped}${start + limit < normalized.length ? "…" : ""}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
				const text = (block as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function extractFollowUpCandidates(text: string, scope: FollowUpScope = {}, source: { entryId?: string; time?: string } = {}): FollowUpCandidate[] {
	const matches: FollowUpCandidate[] = [];
	const seen = new Set<string>();
	for (const marker of MARKERS) {
		const match = marker.pattern.exec(text);
		if (!match || match.index === undefined) continue;
		const snippet = clipAround(text, match.index);
		if (!snippet || (LOW_CONFIDENCE_ONLY.test(snippet) && !marker.pattern.test(snippet))) continue;
		const key = `${marker.type}\n${normalizeText(snippet).toLocaleLowerCase("ru-RU")}\n${scope.activeBead ?? ""}\n${scope.branch ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		matches.push({
			id: `fu-${sha(key)}`,
			markerType: marker.type,
			snippet,
			activeBead: scope.activeBead,
			branch: scope.branch,
			worktreePath: scope.worktreePath,
			sourceEntryId: source.entryId,
			sourceTime: source.time ?? new Date().toISOString(),
			status: "open",
		});
	}
	return matches;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFollowUpCandidate(value: unknown): value is FollowUpCandidate {
	if (!isPlainObject(value)) return false;
	if (!isString(value.id) || !isString(value.markerType) || !isString(value.snippet) || !isString(value.sourceTime)) return false;
	if (value.status !== "open" && value.status !== "resolved" && value.status !== "cleared") return false;
	for (const field of ["activeBead", "branch", "worktreePath", "sourceEntryId", "resolution"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") return false;
	}
	return true;
}

function isFollowUpScope(value: unknown): value is FollowUpScope {
	if (value === undefined) return true;
	if (!isPlainObject(value)) return false;
	return ["activeBead", "branch", "worktreePath"].every((field) => value[field] === undefined || typeof value[field] === "string");
}

function isFollowUpEvent(value: unknown): value is FollowUpReminderEvent {
	if (!isPlainObject(value) || value.version !== 1 || typeof value.action !== "string") return false;
	if (value.action === "candidate") return isFollowUpCandidate(value.candidate);
	if (value.action === "resolve" || value.action === "clear") return isString(value.id) && isString(value.reason) && isString(value.at);
	if (value.action === "clear-all") return isString(value.reason) && isString(value.at) && isFollowUpScope(value.scope);
	return false;
}

function latestWorkflowState(entries: SessionEntry[]): WorkflowStateSnapshot {
	const last = entries.filter((entry) => entry.type === "custom" && entry.customType === "workflow-state").pop();
	return last?.data && typeof last.data === "object" ? (last.data as WorkflowStateSnapshot) : {};
}

function sameScope(candidate: FollowUpCandidate, scope?: FollowUpScope): boolean {
	if (!scope) return true;
	if (scope.activeBead && candidate.activeBead !== scope.activeBead) return false;
	if (scope.branch && candidate.branch !== scope.branch) return false;
	if (scope.worktreePath && candidate.worktreePath !== scope.worktreePath) return false;
	return true;
}

export function reduceFollowUpState(entries: SessionEntry[], scope?: FollowUpScope): FollowUpCandidate[] {
	const candidates = new Map<string, FollowUpCandidate>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isFollowUpEvent(entry.data)) continue;
		const event = entry.data;
		if (event.action === "candidate") {
			const existing = candidates.get(event.candidate.id);
			if (!existing) candidates.set(event.candidate.id, event.candidate);
			continue;
		}
		if (event.action === "resolve" || event.action === "clear") {
			const existing = candidates.get(event.id);
			if (existing) candidates.set(event.id, { ...existing, status: event.action === "resolve" ? "resolved" : "cleared", resolution: event.reason });
			continue;
		}
		if (event.action === "clear-all") {
			for (const [id, candidate] of candidates) {
				if (candidate.status === "open" && sameScope(candidate, event.scope)) candidates.set(id, { ...candidate, status: "cleared", resolution: event.reason });
			}
		}
	}
	return [...candidates.values()].filter((candidate) => sameScope(candidate, scope));
}

function unresolved(entries: SessionEntry[], scope?: FollowUpScope): FollowUpCandidate[] {
	return reduceFollowUpState(entries, scope).filter((candidate) => candidate.status === "open");
}

function formatCandidate(candidate: FollowUpCandidate, index: number): string {
	const bead = candidate.activeBead ? ` bead=${candidate.activeBead}` : "";
	const branch = candidate.branch ? ` branch=${candidate.branch}` : "";
	const status = candidate.status === "open" ? "" : ` status=${candidate.status}`;
	return `${index + 1}. ${candidate.id} [${candidate.markerType}]${status}${bead}${branch}\n   ${candidate.snippet}`;
}

export function formatFollowUps(candidates: FollowUpCandidate[]): string {
	if (candidates.length === 0) return "No unresolved follow-up candidates.";
	return `Unresolved follow-up candidates (${candidates.length}):\n${candidates.map(formatCandidate).join("\n")}`;
}

function appendEvent(pi: ExtensionAPI, event: FollowUpReminderEvent): void {
	pi.appendEntry(CUSTOM_TYPE, event);
}

function sourceFromEvent(event: any, ctx: ExtensionContext): { entryId?: string; time?: string } {
	return {
		entryId: typeof event.entryId === "string" ? event.entryId : ctx.sessionManager.getLeafId?.(),
		time: event.message?.timestamp ? new Date(event.message.timestamp).toISOString() : new Date().toISOString(),
	};
}

function commandHasLandingIntent(text: string): boolean {
	return /^\s*\/(?:land|landing|merge-to-main)\b/i.test(text) || /\b(?:landing the plane|пора заканчивать|сохрани работу|push всё|push все)\b/iu.test(text);
}

function commandHasDiscoveredFrom(command: string, bead?: string): boolean {
	if (!bead) return false;
	if (!/\bbd\s+(?:create|new)\b/.test(command)) return false;
	return new RegExp(`(?:--deps?|--dependencies)(?:=|\\s+)['\"]?discovered-from:${bead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(command);
}

function commandResolvesId(command: string): string | undefined {
	return command.match(/FOLLOWUP_RESOLVED:([a-z0-9-]+)/i)?.[1];
}

export default function followUpReminderExtension(pi: ExtensionAPI): void {
	function currentScope(ctx: ExtensionContext): FollowUpScope {
		const workflow = latestWorkflowState(ctx.sessionManager.getEntries());
		return { activeBead: workflow.activeBead, branch: workflow.branch, worktreePath: workflow.worktreePath };
	}

	function persistNewCandidates(ctx: ExtensionContext, text: string, source: { entryId?: string; time?: string }): number {
		const scope = currentScope(ctx);
		const existing = new Set(reduceFollowUpState(ctx.sessionManager.getEntries()).map((candidate) => candidate.id));
		let added = 0;
		for (const candidate of extractFollowUpCandidates(text, scope, source)) {
			if (existing.has(candidate.id)) continue;
			appendEvent(pi, { version: 1, action: "candidate", candidate });
			existing.add(candidate.id);
			added += 1;
		}
		return added;
	}

	pi.on("message_end", async (event, ctx) => {
		const role = event.message?.role;
		if (role !== "assistant" && role !== "custom") return;
		const text = textFromContent(event.message?.content);
		if (!text) return;
		persistNewCandidates(ctx, text, sourceFromEvent(event, ctx));
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!commandHasLandingIntent(String(event.text ?? ""))) return { action: "continue" };
		const open = unresolved(ctx.sessionManager.getEntries(), currentScope(ctx));
		if (open.length > 0 && ctx.hasUI) ctx.ui.notify(`Follow-up reminder before landing:\n${formatFollowUps(open)}`, "warning");
		return { action: "continue" };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || event.isError) return;
		const command = String(event.input?.command ?? "");
		const scope = currentScope(ctx);
		const explicitId = commandResolvesId(command);
		if (explicitId) {
			appendEvent(pi, { version: 1, action: "resolve", id: explicitId, reason: "FOLLOWUP_RESOLVED marker", at: new Date().toISOString() });
			return;
		}
		if (!commandHasDiscoveredFrom(command, scope.activeBead)) return;
		for (const candidate of unresolved(ctx.sessionManager.getEntries(), scope)) {
			appendEvent(pi, { version: 1, action: "resolve", id: candidate.id, reason: `bd create discovered-from:${scope.activeBead}`, at: new Date().toISOString() });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const open = unresolved(ctx.sessionManager.getEntries(), currentScope(ctx));
		if (open.length === 0) return;
		const message = `Follow-up reminder: ${open.length} unresolved candidate(s). Run /followups before ending if they need beads.`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		pi.sendMessage?.({ customType: CUSTOM_TYPE, content: `${message}\n\n${formatFollowUps(open)}`, display: true }, { triggerTurn: false });
	});

	pi.registerCommand("followups", {
		description: "List, resolve, or clear follow-up reminder candidates. Usage: /followups [list|all|resolve <id>|clear [id]|help]",
		handler: async (args, ctx) => {
			const [command = "list", id] = args.trim().split(/\s+/).filter(Boolean);
			const scope = currentScope(ctx);
			const entries = ctx.sessionManager.getEntries();
			if (command === "help") {
				ctx.ui.notify("Usage: /followups [list|all|resolve <id>|clear [id]|help]", "info");
				return;
			}
			if (command === "list") {
				ctx.ui.notify(formatFollowUps(unresolved(entries, scope)), "info");
				return;
			}
			if (command === "all") {
				ctx.ui.notify(formatFollowUps(reduceFollowUpState(entries, scope)), "info");
				return;
			}
			if (command === "resolve") {
				if (!id) {
					ctx.ui.notify("Usage: /followups resolve <id>", "error");
					return;
				}
				if (!reduceFollowUpState(entries, scope).some((candidate) => candidate.id === id)) {
					ctx.ui.notify(`Unknown follow-up candidate: ${id}`, "error");
					return;
				}
				appendEvent(pi, { version: 1, action: "resolve", id, reason: "manual /followups resolve", at: new Date().toISOString() });
				ctx.ui.notify(`Resolved follow-up candidate ${id}`, "info");
				return;
			}
			if (command === "clear") {
				if (id) {
					if (!reduceFollowUpState(entries, scope).some((candidate) => candidate.id === id)) {
						ctx.ui.notify(`Unknown follow-up candidate: ${id}`, "error");
						return;
					}
					appendEvent(pi, { version: 1, action: "clear", id, reason: "manual /followups clear", at: new Date().toISOString() });
					ctx.ui.notify(`Cleared follow-up candidate ${id}`, "info");
					return;
				}
				appendEvent(pi, { version: 1, action: "clear-all", reason: "manual /followups clear", at: new Date().toISOString(), scope });
				ctx.ui.notify("Cleared unresolved follow-up candidates for current scope", "info");
				return;
			}
			ctx.ui.notify(`Unknown /followups command: ${command}. Use /followups help.`, "error");
		},
	});
}
