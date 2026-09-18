/**
 * Plan-ready UI (document flow, no floating overlay).
 * Stable action values: execute | stay | refine | plan-review
 *
 * Execute-path layout: 4 action labels first (narrow cmux clips from the top),
 * then a wrap-then-window plan pane. PgUp/PgDn scroll the pane before SelectList.
 */

import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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

/** Visible wrapped-line count for the plan window (not a full dump). */
export const PLAN_WINDOW_LINES = 6;

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
 * Wrap the full plan to width first. Do not slice raw source lines and then wrap:
 * a long unspaced line would still dump after wrap.
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

/** Clamp offset and return a 4–6 line window into already-wrapped plan lines. */
export function visiblePlanWindow(
	wrappedLines: string[],
	offset: number,
	windowSize = PLAN_WINDOW_LINES,
): { lines: string[]; offset: number; total: number } {
	const size = Math.max(1, windowSize);
	const maxOffset = Math.max(0, wrappedLines.length - size);
	const clamped = Math.min(Math.max(0, offset), maxOffset);
	return {
		lines: wrappedLines.slice(clamped, clamped + size),
		offset: clamped,
		total: wrappedLines.length,
	};
}

/**
 * Sync factory for ctx.ui.custom — no overlay options.
 * Digits 1-4 select actions; ↑↓ + Enter; Esc cancels (stay-equivalent null).
 * PgUp/PgDn scroll the plan window only (not SelectList / not j-k dual-focus).
 */
export function createReadyUiFactory(planPreview?: string) {
	return (tui: ReadyUiTui, theme: ReadyUiTheme, _keybindings: unknown, done: ReadyDone) => {
		let selectedIndex = 0;
		let settled = false;
		let planOffset = 0;
		let cachedLines: string[] | undefined;
		const items = READY_ACTIONS.map((item) => ({ value: item.value, label: item.label }));

		const listTheme = (text: string) => theme.fg("accent", text);
		let list = new SelectList(items, items.length, listTheme);
		list.setSelectedIndex(0);
		list.onSelect = (item) => finish(item?.value as ReadyAction | undefined);
		list.onCancel = () => finish(undefined);
		list.onSelectionChange = () => {
			selectedIndex = list.selectedIndex;
			refresh();
		};

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
				list.setSelectedIndex(selectedIndex);
				finish(READY_ACTIONS[selectedIndex]?.value);
				return;
			}

			if (matchesKey(data, Key.escape) || data === "\x1b") {
				finish(undefined);
				return;
			}

			if (matchesKey(data, Key.pageUp) || data === "\x1b[5~") {
				planOffset = Math.max(0, planOffset - PLAN_WINDOW_LINES);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown) || data === "\x1b[6~") {
				planOffset += PLAN_WINDOW_LINES;
				refresh();
				return;
			}

			list.handleInput?.(data);
			selectedIndex = list.selectedIndex;
			if (!settled) refresh();
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
				if (item.description) {
					addWrappedWithPrefix(lines, "     ", theme.fg("muted", item.description), w);
				}
			}

			const current = selectedItem();
			lines.push("");
			addWrappedWithPrefix(
				lines,
				" ",
				theme.fg("success", "Превью: ") + theme.fg("text", `${current.label} (${current.value})`),
				w,
			);
			if (current.description) {
				addWrappedWithPrefix(lines, " ", theme.fg("muted", current.description), w);
			}

			lines.push("");
			addWrappedWithPrefix(lines, " ", theme.fg("dim", "1-4 / ↑↓ • Enter • Esc отмена • PgUp/PgDn план"), w);

			if (planPreview?.trim()) {
				lines.push("");
				const wrapWidth = Math.max(1, w - 1);
				const wrapped = wrapPlanToWidth(planPreview, wrapWidth);
				const window = visiblePlanWindow(wrapped, planOffset, PLAN_WINDOW_LINES);
				planOffset = window.offset;
				for (const line of window.lines) {
					lines.push(truncateToWidth(` ${theme.fg("muted", line)}`, w, ""));
				}
			}

			lines.push(divider);

			// Keep SelectList in sync for tests that call list.handleInput via component
			void list.render(w);
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
