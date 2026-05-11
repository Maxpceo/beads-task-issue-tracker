import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type HistoryKind = "user" | "assistant" | "tool" | "workflow" | "system" | "unknown";

interface HistoryItem {
	id: string;
	kind: HistoryKind;
	title: string;
	content: string;
	timestamp?: Date;
	elapsed?: string;
}

const MAX_PREVIEW_WIDTH = 240;
const MAX_EXPANDED_LINES = 10;
const MAX_BODY_LINES = 24;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringifySafe(value: unknown, maxLength = 1200): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	try {
		const json = JSON.stringify(value, (_key, nested) => {
			if (typeof nested === "bigint") return String(nested);
			return nested;
		}, 2);
		return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
	} catch {
		return String(value);
	}
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function previewText(text: string): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length <= MAX_PREVIEW_WIDTH) return normalized;
	return `${normalized.slice(0, MAX_PREVIEW_WIDTH)}…`;
}

function parseTimestamp(entry: Record<string, unknown>, message?: Record<string, unknown>): Date | undefined {
	const rawMessageTs = message?.timestamp;
	if (typeof rawMessageTs === "number" && Number.isFinite(rawMessageTs)) return new Date(rawMessageTs);
	if (typeof rawMessageTs === "string") {
		const date = new Date(rawMessageTs);
		if (!Number.isNaN(date.getTime())) return date;
	}
	const rawEntryTs = entry.timestamp;
	if (typeof rawEntryTs === "string") {
		const date = new Date(rawEntryTs);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return undefined;
}

function formatTime(date?: Date): string {
	if (!date) return "--:--:--";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsedBetween(previous?: Date, current?: Date): string | undefined {
	if (!previous || !current) return undefined;
	const diffMs = current.getTime() - previous.getTime();
	if (!Number.isFinite(diffMs) || diffMs < 0) return undefined;
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return stringifySafe(content);

	return content
		.map((block) => {
			const record = asRecord(block);
			if (!record) return stringifySafe(block);
			switch (record.type) {
				case "text":
					return stringifySafe(record.text);
				case "thinking":
					return `[thinking] ${stringifySafe(record.thinking)}`;
				case "toolCall":
					return `[tool call] ${stringifySafe(record.name)} ${stringifySafe(record.arguments, 500)}`;
				case "image":
					return `[image ${stringifySafe(record.mimeType ?? record.mediaType)}]`;
				default:
					return stringifySafe(record, 500);
			}
		})
		.filter(Boolean)
		.join("\n");
}

function messageToItem(entry: Record<string, unknown>, index: number): HistoryItem | undefined {
	const message = asRecord(entry.message);
	if (!message) return undefined;
	const role = typeof message.role === "string" ? message.role : "unknown";
	const id = typeof entry.id === "string" ? entry.id : `message-${index}`;
	const timestamp = parseTimestamp(entry, message);

	switch (role) {
		case "user":
			return { id, kind: "user", title: "User", content: contentToText(message.content), timestamp };
		case "assistant":
			return { id, kind: "assistant", title: "Assistant", content: contentToText(message.content), timestamp };
		case "toolResult": {
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const status = message.isError === true ? "error" : "result";
			const details = message.details ? `\n\nDetails:\n${stringifySafe(message.details, 800)}` : "";
			return {
				id,
				kind: "tool",
				title: `Tool ${status}: ${toolName}`,
				content: `${contentToText(message.content)}${details}`.trim(),
				timestamp,
			};
		}
		case "bashExecution": {
			const command = stringifySafe(message.command);
			const exitCode = message.exitCode === undefined ? "unknown" : stringifySafe(message.exitCode);
			const output = stringifySafe(message.output);
			const truncated = message.truncated === true ? "\n[output truncated by Pi]" : "";
			return {
				id,
				kind: "tool",
				title: `User bash: exit ${exitCode}`,
				content: `$ ${command}\n${output}${truncated}`.trim(),
				timestamp,
			};
		}
		case "custom": {
			const customType = typeof message.customType === "string" ? message.customType : "custom";
			return {
				id,
				kind: "workflow",
				title: `Custom message: ${customType}`,
				content: contentToText(message.content) || stringifySafe(message.details),
				timestamp,
			};
		}
		case "branchSummary":
			return { id, kind: "system", title: "Branch summary", content: stringifySafe(message.summary), timestamp };
		case "compactionSummary":
			return { id, kind: "system", title: "Compaction summary", content: stringifySafe(message.summary), timestamp };
		default:
			return { id, kind: "unknown", title: `Message: ${role}`, content: stringifySafe(message), timestamp };
	}
}

function entryToItem(entry: unknown, index: number): HistoryItem {
	const record = asRecord(entry);
	if (!record) {
		return { id: `entry-${index}`, kind: "unknown", title: "Unknown entry", content: stringifySafe(entry) };
	}

	const type = typeof record.type === "string" ? record.type : "unknown";
	const id = typeof record.id === "string" ? record.id : `entry-${index}`;
	const timestamp = parseTimestamp(record);

	if (type === "message") {
		return messageToItem(record, index) ?? { id, kind: "unknown", title: "Malformed message", content: stringifySafe(record), timestamp };
	}

	switch (type) {
		case "custom": {
			const customType = typeof record.customType === "string" ? record.customType : "custom";
			return { id, kind: "workflow", title: `Custom entry: ${customType}`, content: stringifySafe(record.data), timestamp };
		}
		case "custom_message": {
			const customType = typeof record.customType === "string" ? record.customType : "custom";
			return { id, kind: "workflow", title: `Custom context: ${customType}`, content: contentToText(record.content), timestamp };
		}
		case "compaction":
			return { id, kind: "system", title: "Compaction", content: stringifySafe(record.summary ?? record.details), timestamp };
		case "branch_summary":
			return { id, kind: "system", title: "Branch summary", content: stringifySafe(record.summary ?? record.details), timestamp };
		case "model_change":
			return { id, kind: "system", title: "Model change", content: `${stringifySafe(record.provider)}/${stringifySafe(record.modelId)}`, timestamp };
		case "thinking_level_change":
			return { id, kind: "system", title: "Thinking level change", content: stringifySafe(record.thinkingLevel), timestamp };
		case "label":
			return { id, kind: "system", title: "Label", content: `${stringifySafe(record.label)} → ${stringifySafe(record.targetId)}`, timestamp };
		case "session_info":
			return { id, kind: "system", title: "Session info", content: stringifySafe(record.name ?? record), timestamp };
		default:
			return { id, kind: "unknown", title: `Entry: ${type}`, content: stringifySafe(record), timestamp };
	}
}

function buildTimeline(entries: unknown[]): HistoryItem[] {
	let previous: Date | undefined;
	return entries.map((entry, index) => {
		const item = entryToItem(entry, index);
		item.elapsed = elapsedBetween(previous, item.timestamp);
		if (item.timestamp) previous = item.timestamp;
		if (!item.content.trim()) item.content = "(no displayable content)";
		return item;
	});
}

function kindIcon(kind: HistoryKind): string {
	switch (kind) {
		case "user":
			return "👤";
		case "assistant":
			return "🤖";
		case "tool":
			return "🛠";
		case "workflow":
			return "◆";
		case "system":
			return "◇";
		default:
			return "?";
	}
}

function kindColor(kind: HistoryKind): "success" | "accent" | "warning" | "muted" | "dim" {
	switch (kind) {
		case "user":
			return "success";
		case "assistant":
			return "accent";
		case "tool":
			return "warning";
		case "workflow":
			return "muted";
		default:
			return "dim";
	}
}

class ReplayOverlay {
	private selectedIndex: number;
	private expanded = new Set<string>();
	private scrollOffset = 0;

	constructor(
		private readonly theme: Theme,
		private readonly items: HistoryItem[],
		private readonly done: () => void,
	) {
		this.selectedIndex = Math.max(0, items.length - 1);
		this.ensureVisible();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		if (this.items.length === 0) return;

		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = this.items.length - 1;
		} else if (matchesKey(data, Key.pageUp)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 8);
		} else if (matchesKey(data, Key.pageDown)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 8);
		} else if (matchesKey(data, Key.enter)) {
			const item = this.items[this.selectedIndex];
			if (item) {
				if (this.expanded.has(item.id)) this.expanded.delete(item.id);
				else this.expanded.add(item.id);
			}
		}
		this.ensureVisible();
	}

	private ensureVisible(): void {
		const pageSize = 10;
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + pageSize) {
			this.scrollOffset = this.selectedIndex - pageSize + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.items.length - 1)));
	}

	private pad(content: string, innerWidth: number): string {
		const visible = visibleWidth(content);
		return content + " ".repeat(Math.max(0, innerWidth - visible));
	}

	private row(content: string, width: number): string {
		const innerWidth = Math.max(1, width - 2);
		const safeContent = truncateToWidth(content, innerWidth, "…");
		return `${this.theme.fg("border", "│")}${this.pad(safeContent, innerWidth)}${this.theme.fg("border", "│")}`;
	}

	private wrappedRows(content: string, width: number): string[] {
		const innerContentWidth = Math.max(10, width - 6);
		const normalized = content.replace(/\t/g, "  ");
		const wrapped = normalized
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line || " ", innerContentWidth));
		const clipped = wrapped.slice(0, MAX_EXPANDED_LINES);
		if (wrapped.length > MAX_EXPANDED_LINES) clipped.push(this.theme.fg("dim", `… ${wrapped.length - MAX_EXPANDED_LINES} more lines`));
		return clipped.map((line) => this.row(`    ${line}`, width));
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const lines: string[] = [];
		const border = "─".repeat(innerWidth);
		lines.push(this.theme.fg("border", `╭${border}╮`));
		lines.push(
			this.row(
				` ${this.theme.fg("accent", this.theme.bold("Session Replay"))} ${this.theme.fg("dim", "|")} ${this.items.length} entries ${this.theme.fg("dim", "| current branch | read-only")}`,
				safeWidth,
			),
		);
		lines.push(this.row("", safeWidth));

		if (this.items.length === 0) {
			lines.push(this.row(` ${this.theme.fg("warning", "No session entries on the current branch yet.")}`, safeWidth));
			lines.push(this.row(` ${this.theme.fg("dim", "Esc/Ctrl-C close")}`, safeWidth));
		} else {
			let bodyLines = 0;
			for (let index = this.scrollOffset; index < this.items.length && bodyLines < MAX_BODY_LINES; index++) {
				const item = this.items[index];
				if (!item) continue;
				const selected = index === this.selectedIndex;
				const expanded = this.expanded.has(item.id);
				const marker = selected ? this.theme.fg("accent", "▶") : " ";
				const icon = this.theme.fg(kindColor(item.kind), kindIcon(item.kind));
				const time = this.theme.fg("success", `[${formatTime(item.timestamp)}]`);
				const elapsed = item.elapsed ? this.theme.fg("dim", ` +${item.elapsed}`) : "";
				const expandMarker = expanded ? "−" : "+";
				lines.push(this.row(` ${marker} ${icon} ${expandMarker} ${this.theme.bold(item.title)} ${time}${elapsed}`, safeWidth));
				const contentRows = expanded
					? this.wrappedRows(item.content, safeWidth)
					: [this.row(`    ${this.theme.fg("dim", previewText(item.content))}`, safeWidth)];
				for (const contentRow of contentRows) lines.push(contentRow);
				bodyLines += 1 + contentRows.length;
			}
			if (this.scrollOffset > 0) lines.splice(3, 0, this.row(` ${this.theme.fg("dim", `↑ ${this.scrollOffset} earlier entries`)}`, safeWidth));
			const hiddenAfter = this.items.length - (this.scrollOffset + 1) - Math.max(0, this.selectedIndex - this.scrollOffset);
			if (hiddenAfter > 0 && lines.length < MAX_BODY_LINES + 5) {
				lines.push(this.row(` ${this.theme.fg("dim", `↓ more entries available`)}`, safeWidth));
			}
		}

		lines.push(this.row("", safeWidth));
		lines.push(this.row(` ${this.theme.fg("dim", "↑/↓ or j/k navigate • Enter expand/collapse • Home/End/PageUp/PageDown • Esc/Ctrl-C close")}`, safeWidth));
		lines.push(this.theme.fg("border", `╰${border}╯`));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {}
}

export default function sessionReplayExtension(pi: ExtensionAPI): void {
	pi.registerCommand("replay", {
		description: "Open read-only current session replay timeline",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				console.log("/replay requires an interactive Pi UI.");
				return;
			}

			const branch = [...ctx.sessionManager.getBranch()].reverse();
			const items = buildTimeline(branch);

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const overlay = new ReplayOverlay(theme, items, () => done(undefined));
					return {
						render: (width: number) => overlay.render(width),
						handleInput: (data: string) => {
							overlay.handleInput(data);
							tui.requestRender();
						},
						invalidate: () => overlay.invalidate(),
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						minWidth: 50,
						maxHeight: "85%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		},
	});
}
