/**
 * Plan-ready UI (document flow, no floating overlay).
 * Stable action values: execute | stay | refine | plan-review
 */

import { Key, matchesKey, SelectList, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	{ value: "plan-review", label: "Отправить на plan-review", description: "Критика без approve; cycle не увеличивается" },
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
 * Sync factory for ctx.ui.custom — no overlay options.
 * Digits 1-4 select actions; ↑↓ + Enter; Esc cancels (stay-equivalent null).
 */
export function createReadyUiFactory(planPreview?: string) {
	return (tui: ReadyUiTui, theme: ReadyUiTheme, _keybindings: unknown, done: ReadyDone) => {
		let selectedIndex = 0;
		let settled = false;
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

			list.handleInput?.(data);
			selectedIndex = list.selectedIndex;
			if (!settled) refresh();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const w = Math.max(1, width);
			const bold = theme.bold ?? ((t: string) => t);
			const divider = theme.fg("accent", "─".repeat(w));

			lines.push(divider);
			addWrappedWithPrefix(lines, " ", theme.fg("accent", bold("План готов — что дальше?")), w);
			lines.push("");

			if (planPreview?.trim()) {
				const preview = planPreview.trim().split(/\r?\n/).slice(0, 6).join("\n");
				for (const line of preview.split("\n")) {
					addWrappedWithPrefix(lines, " ", theme.fg("muted", line), w);
				}
				lines.push("");
			}

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
			addWrappedWithPrefix(lines, " ", theme.fg("dim", "1-4 / ↑↓ • Enter • Esc отмена"), w);
			lines.push(divider);

			// Keep SelectList in sync for tests that call list.handleInput via component
			void list.render(w);
			cachedLines = lines;
			return lines;
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
