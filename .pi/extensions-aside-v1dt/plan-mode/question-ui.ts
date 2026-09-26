/**
 * Questionnaire UI in editor/document flow (no floating overlay).
 * Example-compatible schema: questions[] with id, prompt, options[{value,label,description}], allowOther.
 * Digits 1-9 select options; multi-question tabs; selected option preview.
 */

import { Input, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionInput {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
}

export interface NormalizedQuestion {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

export interface QuestionAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface QuestionnaireUiResult {
	questions: NormalizedQuestion[];
	answers: QuestionAnswer[];
	cancelled: boolean;
}

export interface QuestionUiTheme {
	fg: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

export interface QuestionUiTui {
	requestRender: () => void;
}

type RenderOption = QuestionOption & { isOther?: boolean };

/** Soft-normalize example-compatible question payloads. */
export function normalizeQuestions(raw: unknown): NormalizedQuestion[] {
	if (!Array.isArray(raw)) return [];
	const out: NormalizedQuestion[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object") continue;
		const q = item as Record<string, unknown>;
		const id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${i + 1}`;
		const prompt = typeof q.prompt === "string" ? q.prompt : typeof q.question === "string" ? q.question : "";
		if (!prompt.trim()) continue;
		const optionsRaw = Array.isArray(q.options) ? q.options : [];
		const options: QuestionOption[] = [];
		for (let j = 0; j < optionsRaw.length; j++) {
			const opt = optionsRaw[j];
			if (!opt || typeof opt !== "object") continue;
			const o = opt as Record<string, unknown>;
			const label = typeof o.label === "string" ? o.label : typeof o.value === "string" ? o.value : "";
			if (!label) continue;
			const value = typeof o.value === "string" && o.value ? o.value : label;
			const description = typeof o.description === "string" ? o.description : undefined;
			options.push({ value, label, description });
		}
		out.push({
			id,
			label: typeof q.label === "string" && q.label.trim() ? q.label.trim() : `Q${i + 1}`,
			prompt: prompt.trim(),
			options,
			allowOther: q.allowOther !== false,
		});
	}
	return out;
}

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
 * Sync factory for ctx.ui.custom — no overlay options.
 */
export function createQuestionUiFactory(questions: NormalizedQuestion[]) {
	return (tui: QuestionUiTui, theme: QuestionUiTheme, _keybindings: unknown, done: (value: QuestionnaireUiResult) => void) => {
		const isMulti = questions.length > 1;
		const totalTabs = questions.length + (isMulti ? 1 : 0); // + Submit tab when multi
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let settled = false;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, QuestionAnswer>();
		const otherInput = new Input();

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean): void {
			if (settled) return;
			settled = true;
			done({ questions, answers: Array.from(answers.values()), cancelled });
		}

		function currentQuestion(): NormalizedQuestion | undefined {
			return questions[currentTab];
		}

		function currentOptions(): RenderOption[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: RenderOption[] = [...q.options];
			if (q.allowOther) opts.push({ value: "__other__", label: "Другая…", isOther: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function advanceAfterAnswer(): void {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab += 1;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number): void {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		function selectOption(index: number): void {
			const q = currentQuestion();
			const opts = currentOptions();
			if (!q || index < 0 || index >= opts.length) return;
			const opt = opts[index];
			if (opt.isOther) {
				inputMode = true;
				otherInput.setValue("");
				otherInput.focused = true;
				refresh();
				return;
			}
			saveAnswer(q.id, opt.value, opt.label, false, index + 1);
			advanceAfterAnswer();
		}

		function handleInput(data: string): void {
			if (settled) return;

			if (inputMode) {
				if (matchesKey(data, Key.escape) || data === "\x1b") {
					inputMode = false;
					otherInput.setValue("");
					otherInput.focused = false;
					refresh();
					return;
				}
				if (data === "\r" || data === "\n" || matchesKey(data, Key.enter)) {
					const q = currentQuestion();
					if (!q) return;
					const trimmed = otherInput.getValue().trim() || "(no response)";
					saveAnswer(q.id, trimmed, trimmed, true);
					inputMode = false;
					otherInput.setValue("");
					otherInput.focused = false;
					advanceAfterAnswer();
					return;
				}
				otherInput.handleInput?.(data);
				refresh();
				return;
			}

			// Multi-tab navigation
			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "\t") {
					currentTab = (currentTab + 1) % Math.max(totalTabs, 1);
					optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.left) || data === "\x1b[D") {
					currentTab = (currentTab - 1 + Math.max(totalTabs, 1)) % Math.max(totalTabs, 1);
					optionIndex = 0;
					refresh();
					return;
				}
			}

			// Submit tab
			if (isMulti && currentTab === questions.length) {
				if ((matchesKey(data, Key.enter) || data === "\r" || data === "\n") && allAnswered()) {
					submit(false);
					return;
				}
				if (matchesKey(data, Key.escape) || data === "\x1b") {
					submit(true);
					return;
				}
				return;
			}

			const opts = currentOptions();
			const digit = data.length === 1 ? data.charCodeAt(0) - 48 : -1;
			if (digit >= 1 && digit <= 9 && digit <= opts.length) {
				optionIndex = digit - 1;
				selectOption(optionIndex);
				return;
			}

			if (matchesKey(data, Key.up) || data === "\x1b[A") {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "\x1b[B") {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
				selectOption(optionIndex);
				return;
			}
			if (matchesKey(data, Key.escape) || data === "\x1b") {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const w = Math.max(1, width);
			const bold = theme.bold ?? ((t: string) => t);
			const divider = truncateToWidth(theme.fg("accent", "─".repeat(w)), w, "");
			const q = currentQuestion();
			const opts = currentOptions();

			lines.push(divider);

			if (isMulti) {
				const tabs: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const active = i === currentTab;
					const answered = answers.has(questions[i].id);
					const box = answered ? "■" : "□";
					const color = answered ? "success" : "muted";
					const text = ` ${box} ${questions[i].label} `;
					const styled = active
						? (theme.bg ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("accent", text))
						: theme.fg(color, text);
					tabs.push(styled);
				}
				const submitActive = currentTab === questions.length;
				const submitText = " ✓ Submit ";
				const submitStyled = submitActive
					? (theme.bg ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg("accent", submitText))
					: theme.fg(allAnswered() ? "success" : "dim", submitText);
				tabs.push(submitStyled);
				addWrappedWithPrefix(lines, " ", tabs.join(" "), w);
				lines.push("");
			}

			if (inputMode && q) {
				addWrappedWithPrefix(lines, " ", theme.fg("text", q.prompt), w);
				lines.push("");
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${opt.label}${opt.isOther ? " ✎" : ""}`;
					addWrappedWithPrefix(lines, prefix, theme.fg(selected || opt.isOther ? "accent" : "text", label), w);
				}
				lines.push("");
				addWrappedWithPrefix(lines, " ", theme.fg("muted", "Свой ответ:"), w);
				for (const line of otherInput.render(Math.max(1, w - 2))) {
					lines.push(` ${line}`);
				}
				lines.push("");
				addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter отправить • Esc назад"), w);
			} else if (isMulti && currentTab === questions.length) {
				addWrappedWithPrefix(lines, " ", theme.fg("accent", bold("Готово к отправке")), w);
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (!answer) continue;
					const prefix = answer.wasCustom ? "(wrote) " : "";
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("muted", `${question.label}: `) + theme.fg("text", prefix + answer.label),
						w,
					);
				}
				lines.push("");
				if (allAnswered()) {
					addWrappedWithPrefix(lines, " ", theme.fg("success", "Enter — отправить"), w);
				} else {
					const missing = questions.filter((item) => !answers.has(item.id)).map((item) => item.label).join(", ");
					addWrappedWithPrefix(lines, " ", theme.fg("warning", `Не отвечено: ${missing}`), w);
				}
			} else if (q) {
				addWrappedWithPrefix(lines, " ", theme.fg("text", q.prompt), w);
				lines.push("");
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${opt.label}`;
					addWrappedWithPrefix(lines, prefix, theme.fg(selected ? "accent" : "text", label), w);
					if (opt.description) {
						addWrappedWithPrefix(lines, "     ", theme.fg("muted", opt.description), w);
					}
				}

				const current = opts[optionIndex];
				if (current) {
					lines.push("");
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("success", "Превью: ") + theme.fg("text", current.label),
						w,
					);
					if (current.description) {
						addWrappedWithPrefix(lines, " ", theme.fg("muted", current.description), w);
					}
				}
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? "Tab/←→ вопросы • 1-9 / ↑↓ • Enter • Esc отмена"
					: "1-9 / ↑↓ • Enter выбрать • Esc отмена";
				addWrappedWithPrefix(lines, " ", theme.fg("dim", help), w);
			}
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

/** Exported for tool render helpers. */
export function formatQuestionnaireAnswerLines(
	questions: NormalizedQuestion[],
	answers: QuestionAnswer[],
): string[] {
	return answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
		return `${qLabel}: user selected: ${a.index ?? ""}. ${a.label}`.replace(" .", ".");
	});
}

// Keep Text import used for type-parity with pi-tui consumers in tests.
void Text;
