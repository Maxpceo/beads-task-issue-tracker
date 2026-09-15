/**
 * Searchable compact model picker for /agent-models (khec / 2aqh).
 * Product filter is NOT SelectList.setFilter (prefix-on-value).
 * Overlay + SelectList.onSelect/onCancel + pad contract: beads-task-issue-tracker-2aqh.
 */

import { Container, Input, Key, SelectList, Text } from "@earendil-works/pi-tui";

export const MODEL_PICKER_VIEWPORT = 12;
export const FALLBACK_SELECT_CAP = 30;
export const UNBOUNDED_SELECT_MAX = 40;
export const BACK_MODEL_ID = "__back__";
export const OTHER_MODEL_ID = "__other__";
export const OTHER_MODEL_LABEL = "Другая…";
export const MENU_BACK_LABEL = "← Назад";
export const FILTER_NOTIFY = "Уточните фильтр";

/** Near-fullscreen overlay options (session-replay canon). */
export const MODEL_PICKER_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: {
		width: "90%",
		minWidth: 50,
		maxHeight: "85%",
		anchor: "center",
		margin: 1,
	},
} as const;

/** Append empty lines after root.render so overlay chrome has height (never prepend). */
export const MODEL_PICKER_MIN_RENDER_LINES = 100;

export type PickerModel = {
	id: string;
	provider?: string;
	modelId?: string;
	name?: string;
};

export type SelectOption = { id: string; label: string };

type SelectItem = { value: string; label: string };

function fieldMatch(value: unknown, needle: string): boolean {
	return typeof value === "string" && value.toLowerCase().includes(needle);
}

export function filterAvailableModels<T extends PickerModel>(models: T[], query: string): T[] {
	const q = (query ?? "").trim().toLowerCase();
	if (!q) return [...models];
	return models.filter(
		(m) =>
			fieldMatch(m.id, q) ||
			fieldMatch(m.provider, q) ||
			fieldMatch(m.modelId, q) ||
			fieldMatch(m.name, q),
	);
}

export function modelLabelOptions(models: PickerModel[]): SelectOption[] {
	return models.map((m) => {
		const provider = m.provider ?? (m.id.includes("/") ? m.id.split("/")[0] : undefined);
		const label = provider ? `${m.id}` : m.id;
		const suffix = m.name && m.name !== m.modelId && m.name !== m.id ? ` — ${m.name}` : "";
		return { id: m.id, label: `${label}${suffix}` };
	});
}

export function pinThenCap<T extends PickerModel>(models: T[], initial: string | undefined, cap: number): T[] {
	if (models.length < UNBOUNDED_SELECT_MAX) return [...models];
	const pinned = initial ? models.find((m) => m.id === initial) : undefined;
	if (!pinned) return models.slice(0, cap);
	const rest = models.filter((m) => m.id !== initial).slice(0, Math.max(0, cap - 1));
	return [pinned, ...rest];
}

export function interpretPick(v: unknown): "back" | "other" | { modelId: string } {
	if (v == null || v === BACK_MODEL_ID || v === MENU_BACK_LABEL) return "back";
	if (v === OTHER_MODEL_ID || v === OTHER_MODEL_LABEL) return "other";
	const modelId = String(v).trim();
	if (!modelId) return "back";
	return { modelId };
}

/**
 * Call Keybindings.matches on the object (keep `this`).
 * Never extract unbound `matches` — live pi Keybindings reads this.keysById.
 */
function matchSelectKey(kb: unknown, data: string, id: string): boolean {
	const obj = kb as { matches?: (d: string, key: string) => boolean } | null | undefined;
	if (obj == null || typeof obj.matches !== "function") return false;
	try {
		return obj.matches(data, id) === true;
	} catch {
		return false;
	}
}

function isPageKey(kb: unknown, data: string): boolean {
	// Prefer raw bytes so printable keys never need matches.
	if (data === Key.pageUp || data === Key.pageDown) return true;
	return (
		matchSelectKey(kb, data, "tui.select.pageUp") || matchSelectKey(kb, data, "tui.select.pageDown")
	);
}

function shouldSkipInput(kb: unknown, data: string): boolean {
	// Prefer raw bytes before matches: printable keys do not need keybindings.
	if (
		data === "\r" ||
		data === "\n" ||
		data === Key.enter ||
		data === Key.escape ||
		data === Key.up ||
		data === Key.down ||
		data.startsWith("\x1b")
	) {
		return true;
	}
	return (
		matchSelectKey(kb, data, "tui.select.confirm") ||
		matchSelectKey(kb, data, "tui.select.cancel") ||
		matchSelectKey(kb, data, "tui.select.up") ||
		matchSelectKey(kb, data, "tui.select.down")
	);
}

function selectListTheme(theme: unknown): {
	selectedPrefix: (t: string) => string;
	selectedText: (t: string) => string;
	description: (t: string) => string;
	scrollInfo: (t: string) => string;
	noMatch: (t: string) => string;
} {
	const fg =
		typeof (theme as { fg?: (c: string, t: string) => string })?.fg === "function"
			? (theme as { fg: (c: string, t: string) => string }).fg.bind(theme)
			: (_c: string, t: string) => t;
	const muted = (t: string): string => {
		try {
			const out = fg("muted", t);
			return out || fg("dim", t);
		} catch {
			return fg("dim", t);
		}
	};
	return {
		selectedPrefix: (t) => fg("accent", t),
		selectedText: (t) => fg("accent", t),
		description: muted,
		scrollInfo: muted,
		noMatch: muted,
	};
}

export function customPickerAvailable(): boolean {
	return typeof SelectList === "function" && typeof Input === "function" && typeof Container === "function";
}

export type CustomComponent = {
	render: (width: number) => string[];
	invalidate?: () => void;
	handleInput?: (data: string) => void;
	focused?: boolean;
};

export type CustomFn = (
	factory: (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		done: (value: unknown) => void,
	) => CustomComponent,
	opts?: unknown,
) => Promise<unknown>;

export async function runSearchableModelPicker(input: {
	custom: CustomFn;
	title: string;
	models: PickerModel[];
	initial?: string;
}): Promise<unknown> {
	const { custom, title, models, initial } = input;
	return custom((tui, theme, keybindings, done) => {
		const requestRender = (): void => {
			(tui as { requestRender?: () => void })?.requestRender?.();
		};
		const searchInput = new Input();
		const listContainer = new Container();
		const root = new Container();
		root.addChild(new Text(title));
		root.addChild(new Text("Фильтр моделей: "));
		root.addChild(searchInput);
		root.addChild(listContainer);

		let prevQuery = "";
		let list: InstanceType<typeof SelectList> | undefined;
		let settled = false;
		let focusedFlag = false;

		const finish = (value: unknown): void => {
			if (settled) return;
			settled = true;
			done(value as never);
		};

		const buildItems = (query: string): SelectItem[] => {
			const filtered = filterAvailableModels(models, query);
			const labels = modelLabelOptions(filtered);
			return [
				...labels.map((o) => ({ value: o.id, label: o.label })),
				{ value: OTHER_MODEL_ID, label: OTHER_MODEL_LABEL },
				{ value: BACK_MODEL_ID, label: MENU_BACK_LABEL },
			];
		};

		const rebuild = (): void => {
			const query = typeof searchInput.getValue === "function" ? searchInput.getValue() : "";
			const items = buildItems(query);
			const want = list?.getSelectedItem()?.value;
			const next = new SelectList(items, MODEL_PICKER_VIEWPORT, selectListTheme(theme));
			next.onSelect = (item: SelectItem) => finish(item.value);
			next.onCancel = () => finish(null);
			if (typeof (listContainer as { clear?: () => void }).clear === "function") {
				(listContainer as { clear: () => void }).clear();
			} else {
				const children = (listContainer as { children?: unknown[] }).children;
				if (Array.isArray(children)) children.length = 0;
			}
			listContainer.addChild(next);
			let idx = want != null ? items.findIndex((i) => i.value === want) : -1;
			// Pin initial only on empty query when no prior selection.
			if (query.trim() === "" && want == null && initial) {
				idx = items.findIndex((i) => i.value === initial);
			}
			next.setSelectedIndex(idx >= 0 ? idx : 0);
			list = next;
		};

		rebuild();

		return {
			render: (width: number) => {
				const lines = root.render(width);
				while (lines.length < MODEL_PICKER_MIN_RENDER_LINES) {
					lines.push("");
				}
				return lines;
			},
			invalidate: () => {
				root.invalidate?.();
			},
			handleInput: (data: string) => {
				if (settled) return;
				try {
					if (isPageKey(keybindings, data)) {
						return;
					}
					list?.handleInput?.(data);
					if (settled) return;
					if (shouldSkipInput(keybindings, data)) {
						if (!settled) requestRender();
						return;
					}
					searchInput.handleInput?.(data);
					const q = typeof searchInput.getValue === "function" ? searchInput.getValue() : "";
					if (q !== prevQuery) {
						prevQuery = q;
						rebuild();
					}
					if (!settled) requestRender();
				} catch {
					// Path (b): runtime error inside returned handleInput → cancel without notify/rethrow.
					finish(null);
				}
			},
			get focused() {
				return focusedFlag;
			},
			set focused(value: boolean) {
				focusedFlag = value;
				searchInput.focused = value;
			},
		};
	}, MODEL_PICKER_OVERLAY_OPTIONS);
}
