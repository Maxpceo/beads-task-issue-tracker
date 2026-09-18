/**
 * Plan-ready UI: four action labels only (no plan text, no pager).
 * Execute-path uses this as a bottom overlay so the chat stays scrollable.
 *
 * Crash-safe: no SelectList (live HA 2026-09-18: SelectList.render inside
 * custom killed Pi / TUI.stop(); questionnaire-style hand-rolled 1–4 / ↑↓ / Enter lives).
 */

import { Key, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Stable ready-action ids used by plan-mode agent_end loop. */
export type ReadyAction = "execute" | "stay" | "refine" | "plan-review";

export interface ReadyActionItem {
	value: ReadyAction;
	label: string;
	description?: string;
}

/** RU labels; values stay English for code paths. */
export const READY_ACTIONS: readonly ReadyActionItem[] = [
	{ value: "execute", label: "Исполнить", description: "Записать PLAN APPROVED и выйти из plan mode" },
	{ value: "stay", label: "Остаться в plan mode", description: "Очистить pending ready, остаться в plan mode без approve" },
	{ value: "refine", label: "Уточнить", description: "Очистить pending и открыть редактор уточнения" },
	{ value: "plan-review", label: "Отправить на plan-review", description: "Критика без approve; findings → tool result; cycle не увеличивается; dirty очищает pending" },
] as const;

export interface ReadyUiTheme {
	fg: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

export interface ReadyUiTui {
	requestRender: () => void;
}

type ReadyDone = (value: { action: ReadyAction } | null) => void;

function clampRenderLines(lines: string[], width: number): string[] {
	const w = Math.max(1, width);
	return lines.map((line) => truncateToWidth(line, w, ""));
}

function addWrapped(lines: string[], text: string, width: number): void {
	lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
}

function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
	const renderWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= renderWidth) {
		addWrapped(lines, prefix + text, renderWidth);
		return;
	}
	const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
	const continuation = " ".repeat(prefixWidth);
	for (let i = 0; i < wrapped.length; i++) {
		lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
	}
}

/**
 * Wrap the full plan to width. Used by the transcript entry renderer so mouse-wheel
 * chat scroll shows the whole document. Do not slice a pager window here.
 */
export function wrapPlanToWidth(planText: string, width: number): string[] {
	const lines: string[] = [];
	const w = Math.max(1, width);
	const text = planText.trim();
	if (!text) return lines;
	for (const raw of text.split(/\r?\n/)) {
		addWrapped(lines, raw, w);
	}
	return lines;
}

/** Full plan lines for `registerEntryRenderer` — clamp to terminal width (m6ho). */
export function renderPlanTranscriptLines(planText: string, width: number): string[] {
	return clampRenderLines(wrapPlanToWidth(planText, width), width);
}

/** Markdown document with post-clamp so wide fences cannot abort the TUI (m6ho). */
export class ClampedMarkdown extends Markdown {
	constructor(text: string, paddingX = 0, paddingY = 0, mdTheme?: unknown) {
		super(text, paddingX, paddingY, mdTheme);
	}

	render(width: number): string[] {
		return clampRenderLines(super.render(width), Math.max(1, width));
	}
}

/** Live plan-ready transcript component: themed Markdown, not wrap-only source. */
export function createPlanDocumentComponent(content: string, mdTheme: unknown): Markdown | Text {
	const text = content.trim();
	if (!text) return new Text("", 0, 0);
	return new ClampedMarkdown(text, 0, 0, mdTheme);
}

/**
 * Sync factory for ctx.ui.custom — overlay buttons only, no plan, no SelectList.
 * Digits 1-4 select actions; ↑↓ + Enter; Esc cancels (stay-equivalent null).
 * Unhandled keys (including paging) are ignored so this is not a widget pager.
 */
export function createReadyUiFactory() {
	return (tui: ReadyUiTui, theme: ReadyUiTheme, _keybindings: unknown, done: ReadyDone) => {
		let selectedIndex = 0;
		let settled = false;
		let cachedLines: string[] | undefined;

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function finish(action: ReadyAction | undefined): void {
			if (settled) return;
			settled = true;
			done(action ? { action } : null);
		}

		function selectedItem(): ReadyActionItem {
			return READY_ACTIONS[Math.min(selectedIndex, READY_ACTIONS.length - 1)] ?? READY_ACTIONS[0];
		}

		function handleInput(data: string): void {
			if (settled) return;

			const digit = data.length === 1 ? data.charCodeAt(0) - 48 : -1;
			if (digit >= 1 && digit <= READY_ACTIONS.length) {
				selectedIndex = digit - 1;
				finish(READY_ACTIONS[selectedIndex]?.value);
				return;
			}

			if (matchesKey(data, Key.escape) || data === "\x1b") {
				finish(undefined);
				return;
			}

			if (matchesKey(data, Key.up) || data === "\x1b[A") {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "\x1b[B") {
				selectedIndex = Math.min(READY_ACTIONS.length - 1, selectedIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
				finish(selectedItem().value);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const w = Math.max(1, width);
			const bold = theme.bold ?? ((t: string) => t);
			const divider = truncateToWidth(theme.fg("accent", "─".repeat(w)), w, "");

			lines.push(divider);
			addWrappedWithPrefix(lines, " ", theme.fg("accent", bold("План готов — что дальше?")), w);
			lines.push("");

			for (let i = 0; i < READY_ACTIONS.length; i++) {
				const item = READY_ACTIONS[i];
				const selected = i === selectedIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = `${i + 1}. ${item.label}`;
				addWrappedWithPrefix(lines, prefix, theme.fg(selected ? "accent" : "text", label), w);
			}

			lines.push("");
			addWrappedWithPrefix(lines, " ", theme.fg("dim", "1-4 / ↑↓ • Enter • Esc отмена"), w);
			lines.push(divider);

			// Pi TUI aborts the process if any line exceeds terminal width.
			cachedLines = clampRenderLines(lines, w);
			return cachedLines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	};
}

export type ReadyUiComponent = ReturnType<ReturnType<typeof createReadyUiFactory>>;
