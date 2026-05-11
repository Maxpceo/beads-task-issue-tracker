import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NotifyKind = "complete" | "needs-input" | "error" | "test";

interface TurnState {
	startedAt: number;
	toolCalls: number;
	hasError: boolean;
	errorTool?: string;
	lastAction?: string;
	needsInputNotified: boolean;
}

const OSC_BEL = "\x07";
const OSC_777_PREFIX = "\x1b]777;notify;";
const DEFAULT_COMPLETE_SOUND = "/System/Library/Sounds/Pop.aiff";
const DEFAULT_INPUT_SOUND = "/System/Library/Sounds/Glass.aiff";
const MAX_SNIPPET_LENGTH = 180;
const MAX_ACTION_LENGTH = 48;

function sanitizeOscPart(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/;/g, ":")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function truncate(value: string, maxLength: number): string {
	const clean = sanitizeOscPart(value);
	if (clean.length <= maxLength) return clean;
	return `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function envFlag(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function notify(title: string, body: string): void {
	if (!envFlag("PI_WARP_NOTIFICATIONS", true)) return;

	const payload = `${OSC_777_PREFIX}${sanitizeOscPart(title)};${sanitizeOscPart(body)}${OSC_BEL}`;
	try {
		writeFileSync("/dev/tty", payload);
	} catch {
		try {
			process.stdout.write(payload);
		} catch {
			// Notifications must never break Pi execution.
		}
	}
}

function playSound(kind: NotifyKind): void {
	if (process.platform !== "darwin") return;
	if (!envFlag("PI_WARP_NOTIFICATIONS_SOUND", true)) return;
	if (kind === "complete" && !envFlag("PI_WARP_NOTIFICATIONS_COMPLETE_SOUND", true)) return;
	if ((kind === "needs-input" || kind === "error") && !envFlag("PI_WARP_NOTIFICATIONS_ATTENTION_SOUND", true)) return;

	const configuredPath =
		kind === "complete" || kind === "test"
			? process.env.PI_WARP_NOTIFICATIONS_COMPLETE_SOUND_PATH
			: process.env.PI_WARP_NOTIFICATIONS_ATTENTION_SOUND_PATH;
	const soundPath = configuredPath || (kind === "complete" || kind === "test" ? DEFAULT_COMPLETE_SOUND : DEFAULT_INPUT_SOUND);
	if (!existsSync(soundPath)) return;

	try {
		const child = spawn("afplay", [soundPath], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// Sound is best-effort only.
	}
}

function formatDuration(ms: number): string | undefined {
	const seconds = Math.round(ms / 1000);
	if (seconds < 10) return undefined;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function cleanModelName(name: string | undefined): string {
	if (!name) return "Pi";
	return name
		.replace(/\s*\(.*?\)/g, "")
		.replace(/\b(High|Medium|Low)\b/g, (match) => match[0] ?? match)
		.trim() || "Pi";
}

function commandPreview(command: string): string {
	const firstLine = command.split("\n").find((line) => line.trim().length > 0) ?? command;
	return `💻 ${truncate(firstLine, MAX_ACTION_LENGTH)}`;
}

function pathPreview(path: string): string {
	const name = path.split("/").filter(Boolean).pop() ?? path;
	return `📝 ${truncate(name, MAX_ACTION_LENGTH)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "text" && typeof part.text === "string") return part.text;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function lastAssistantSnippet(messages: unknown): { snippet: string; truncated: boolean } {
	if (!Array.isArray(messages)) return { snippet: "Pi is ready for input", truncated: false };
	const assistant = [...messages]
		.reverse()
		.find((message) => isRecord(message) && message.role === "assistant") as Record<string, unknown> | undefined;
	if (!assistant) return { snippet: "Pi is ready for input", truncated: false };

	const text = textFromContent(assistant.content);
	const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : undefined;
	return {
		snippet: text ? truncate(text, MAX_SNIPPET_LENGTH) : "Pi is ready for input",
		truncated: stopReason === "length",
	};
}

function resetTurn(): TurnState {
	return {
		startedAt: Date.now(),
		toolCalls: 0,
		hasError: false,
		needsInputNotified: false,
	};
}

function isAskUserTool(toolName: string): boolean {
	const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
	return normalized === "ask_user" || normalized.endsWith("_ask_user") || normalized.includes("ask_user");
}

function inputSummary(input: unknown): string {
	if (!isRecord(input)) return "Pi needs your answer";
	const question = typeof input.question === "string" ? input.question : undefined;
	const context = typeof input.context === "string" ? input.context : undefined;
	return truncate(question || context || "Pi needs your answer", MAX_SNIPPET_LENGTH);
}

export default function (pi: ExtensionAPI) {
	let state = resetTurn();

	pi.on("agent_start", async () => {
		state = resetTurn();
	});

	pi.on("tool_call", async (event) => {
		state.toolCalls += 1;

		if (isAskUserTool(event.toolName) && !state.needsInputNotified) {
			state.needsInputNotified = true;
			notify("🔔 Pi needs your answer", inputSummary(event.input));
			playSound("needs-input");
			return;
		}

		if (event.toolName === "bash" && isRecord(event.input) && typeof event.input.command === "string") {
			state.lastAction = commandPreview(event.input.command);
			return;
		}

		if ((event.toolName === "write" || event.toolName === "edit" || event.toolName === "read") && isRecord(event.input) && typeof event.input.path === "string") {
			state.lastAction = pathPreview(event.input.path);
		}
	});

	pi.on("tool_result", async (event) => {
		if (event.isError) {
			state.hasError = true;
			state.errorTool = event.toolName;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const duration = formatDuration(Date.now() - state.startedAt);
		const model = cleanModelName(ctx.model?.name);
		const sessionName = pi.getSessionName();
		const { snippet, truncated } = lastAssistantSnippet(event.messages);

		const kind: NotifyKind = state.hasError ? "error" : "complete";
		const icon = state.hasError ? "❌" : truncated ? "⚠️" : "✅";
		const titleParts = [icon, duration ? `(${duration})` : undefined, `Pi: ${model}`].filter(Boolean);
		const meta = [
			state.lastAction,
			state.toolCalls > 0 ? `${state.toolCalls} ops` : undefined,
			state.hasError && state.errorTool ? `${state.errorTool} error` : undefined,
			truncated ? "truncated" : undefined,
			sessionName ? truncate(sessionName, 40) : undefined,
		].filter(Boolean);
		const body = meta.length > 0 ? `[${meta.join(" · ")}] ${snippet}` : snippet;

		notify(titleParts.join(" "), body);
		playSound(kind);
	});

	pi.registerCommand("warp-notify-test", {
		description: "Send a test Warp/Pi OSC 777 notification and play the configured sound",
		handler: async (_args, ctx) => {
			notify("🔔 Pi Warp notification test", `cwd: ${ctx.cwd}`);
			playSound("test");
			ctx.ui.notify("Sent test Warp notification", "info");
		},
	});
}
