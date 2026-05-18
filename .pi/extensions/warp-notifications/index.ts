import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type NotifyKind = "complete" | "needs-input" | "error" | "test";
type NotificationBackend = "warp" | "macos" | "both";
type SoundKind = "complete" | "attention";

interface TurnState {
	startedAt: number;
	toolCalls: number;
	hasError: boolean;
	errorTool?: string;
	lastAction?: string;
	needsInputNotified: boolean;
}

interface WarpNotifyConfig {
	notificationsEnabled: boolean;
	notificationBackend: NotificationBackend;
	soundEnabled: boolean;
	completeSoundEnabled: boolean;
	attentionSoundEnabled: boolean;
	completeSoundPath: string;
	attentionSoundPath: string;
}

const OSC_BEL = "\x07";
const OSC_777_PREFIX = "\x1b]777;notify;";
const DEFAULT_COMPLETE_SOUND = "/System/Library/Sounds/Pop.aiff";
const DEFAULT_INPUT_SOUND = "/System/Library/Sounds/Glass.aiff";
const SYSTEM_SOUNDS_DIR = "/System/Library/Sounds";
const WARP_BUNDLE_ID = "dev.warp.Warp-Stable";
const TERMINAL_NOTIFIER_PATHS = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];
const MAX_SNIPPET_LENGTH = 180;
const MAX_ACTION_LENGTH = 48;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");

const DEFAULT_CONFIG: WarpNotifyConfig = {
	notificationsEnabled: true,
	notificationBackend: "both",
	soundEnabled: true,
	completeSoundEnabled: true,
	attentionSoundEnabled: true,
	completeSoundPath: DEFAULT_COMPLETE_SOUND,
	attentionSoundPath: DEFAULT_INPUT_SOUND,
};

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

function envFlagValue(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function envFlag(name: string, fallback: boolean): boolean {
	return envFlagValue(name) ?? fallback;
}

function envBackend(name: string, fallback: NotificationBackend): NotificationBackend {
	const value = process.env[name];
	if (value === "warp" || value === "macos" || value === "both") return value;
	return fallback;
}

function isConfig(value: unknown): value is Partial<WarpNotifyConfig> {
	return Boolean(value) && typeof value === "object";
}

function readConfig(): WarpNotifyConfig {
	if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
		if (!isConfig(parsed)) return { ...DEFAULT_CONFIG };
		const config = { ...DEFAULT_CONFIG };
		if (typeof parsed.notificationsEnabled === "boolean") config.notificationsEnabled = parsed.notificationsEnabled;
		if (parsed.notificationBackend === "warp" || parsed.notificationBackend === "macos" || parsed.notificationBackend === "both") {
			config.notificationBackend = parsed.notificationBackend;
		}
		if (typeof parsed.soundEnabled === "boolean") config.soundEnabled = parsed.soundEnabled;
		if (typeof parsed.completeSoundEnabled === "boolean") config.completeSoundEnabled = parsed.completeSoundEnabled;
		if (typeof parsed.attentionSoundEnabled === "boolean") config.attentionSoundEnabled = parsed.attentionSoundEnabled;
		if (typeof parsed.completeSoundPath === "string") config.completeSoundPath = parsed.completeSoundPath;
		if (typeof parsed.attentionSoundPath === "string") config.attentionSoundPath = parsed.attentionSoundPath;
		return config;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function writeConfig(config: WarpNotifyConfig): void {
	mkdirSync(EXTENSION_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function resetConfig(): WarpNotifyConfig {
	const config = { ...DEFAULT_CONFIG };
	writeConfig(config);
	return config;
}

function effectiveConfig(): WarpNotifyConfig {
	const config = readConfig();
	return {
		notificationsEnabled: envFlag("PI_WARP_NOTIFICATIONS", config.notificationsEnabled),
		notificationBackend: envBackend("PI_WARP_NOTIFICATIONS_BACKEND", config.notificationBackend),
		soundEnabled: envFlag("PI_WARP_NOTIFICATIONS_SOUND", config.soundEnabled),
		completeSoundEnabled: envFlag("PI_WARP_NOTIFICATIONS_COMPLETE_SOUND", config.completeSoundEnabled),
		attentionSoundEnabled: envFlag("PI_WARP_NOTIFICATIONS_ATTENTION_SOUND", config.attentionSoundEnabled),
		completeSoundPath: process.env.PI_WARP_NOTIFICATIONS_COMPLETE_SOUND_PATH || config.completeSoundPath,
		attentionSoundPath: process.env.PI_WARP_NOTIFICATIONS_ATTENTION_SOUND_PATH || config.attentionSoundPath,
	};
}

function status(value: boolean): string {
	return value ? "on" : "off";
}

function backendLabel(backend: NotificationBackend): string {
	if (backend === "warp") return "Warp only";
	if (backend === "macos") return "macOS only";
	return "Both";
}

function soundName(soundPath: string): string {
	return path.basename(soundPath).replace(/\.aiff$/i, "") || soundPath;
}

function terminalNotifierPath(): string | undefined {
	return TERMINAL_NOTIFIER_PATHS.find((candidate) => existsSync(candidate));
}

export function buildWarpOscPayload(title: string, body: string): string {
	return `${OSC_777_PREFIX}${sanitizeOscPart(title)};${sanitizeOscPart(body)}${OSC_BEL}`;
}

function notifyWarp(title: string, body: string): void {
	const payload = buildWarpOscPayload(title, body);
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

function osascriptLiteral(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function notifyMacos(title: string, body: string): void {
	if (process.platform !== "darwin") return;

	try {
		const notifier = terminalNotifierPath();
		if (notifier) {
			const child = spawn(notifier, [
				"-title",
				sanitizeOscPart(title),
				"-message",
				sanitizeOscPart(body),
				"-activate",
				WARP_BUNDLE_ID,
				"-group",
				"pi-warp-notifications",
			], { detached: true, stdio: "ignore" });
			child.unref();
			return;
		}

		const script = `display notification "${osascriptLiteral(sanitizeOscPart(body))}" with title "${osascriptLiteral(sanitizeOscPart(title))}"`;
		const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// macOS notifications are best-effort only.
	}
}

function notify(title: string, body: string): void {
	const config = effectiveConfig();
	if (!config.notificationsEnabled) return;
	if (config.notificationBackend === "warp" || config.notificationBackend === "both") notifyWarp(title, body);
	if (config.notificationBackend === "macos" || config.notificationBackend === "both") notifyMacos(title, body);
}

function soundPathFor(kind: NotifyKind, config = effectiveConfig()): string {
	return kind === "complete" || kind === "test" ? config.completeSoundPath : config.attentionSoundPath;
}

function playSound(kind: NotifyKind): void {
	const config = effectiveConfig();
	if (process.platform !== "darwin") return;
	if (!config.soundEnabled) return;
	if ((kind === "complete" || kind === "test") && !config.completeSoundEnabled) return;
	if ((kind === "needs-input" || kind === "error") && !config.attentionSoundEnabled) return;

	const soundPath = soundPathFor(kind, config);
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

function pathPreview(pathValue: string): string {
	const name = pathValue.split("/").filter(Boolean).pop() ?? pathValue;
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

function availableSystemSounds(): string[] {
	try {
		if (!existsSync(SYSTEM_SOUNDS_DIR)) return [];
		return readdirSync(SYSTEM_SOUNDS_DIR)
			.filter((entry) => entry.toLowerCase().endsWith(".aiff"))
			.sort((a, b) => a.localeCompare(b))
			.map((entry) => path.join(SYSTEM_SOUNDS_DIR, entry));
	} catch {
		return [];
	}
}

function menuSummary(config: WarpNotifyConfig): string {
	return [
		`Notifications: ${status(config.notificationsEnabled)}`,
		`Backend: ${backendLabel(config.notificationBackend)}`,
		`Sounds: ${status(config.soundEnabled)}`,
		`Complete sound: ${status(config.completeSoundEnabled)} (${soundName(config.completeSoundPath)})`,
		`Attention sound: ${status(config.attentionSoundEnabled)} (${soundName(config.attentionSoundPath)})`,
		`Config: ${CONFIG_PATH}`,
	].join("\n");
}

async function chooseBackend(ctx: ExtensionCommandContext): Promise<void> {
	const current = effectiveConfig().notificationBackend;
	const options = ["Both", "Warp only", "macOS only", "Back"];
	const choice = await ctx.ui.select(`Notification backend\nCurrent: ${backendLabel(current)}`, options);
	if (!choice || choice === "Back") return;
	const next = readConfig();
	if (choice === "Both") next.notificationBackend = "both";
	if (choice === "Warp only") next.notificationBackend = "warp";
	if (choice === "macOS only") next.notificationBackend = "macos";
	writeConfig(next);
	ctx.ui.notify(`Notification backend set to ${choice}`, "success");
}

async function chooseSound(ctx: ExtensionCommandContext, kind: SoundKind): Promise<void> {
	let config = readConfig();
	const sounds = availableSystemSounds();
	const currentPath = kind === "complete" ? config.completeSoundPath : config.attentionSoundPath;
	const title = kind === "complete" ? "Choose completion sound" : "Choose attention sound";
	const options = [
		...sounds.map((soundPath) => `${soundName(soundPath)} ${soundPath === currentPath ? "✓" : ""}`.trim()),
		"Custom path…",
		"Back",
	];
	const choice = await ctx.ui.select(`${title}\nCurrent: ${currentPath}`, options);
	if (!choice || choice === "Back") return;

	let selectedPath: string | undefined;
	if (choice === "Custom path…") {
		const input = await ctx.ui.input("Custom sound path", currentPath);
		if (!input) return;
		selectedPath = input.trim();
	} else {
		const selectedName = choice.replace(/\s+✓$/, "");
		selectedPath = sounds.find((soundPath) => soundName(soundPath) === selectedName);
	}

	if (!selectedPath) {
		ctx.ui.notify("Sound was not changed", "warning");
		return;
	}
	if (!existsSync(selectedPath)) {
		const ok = await ctx.ui.confirm("Sound file not found", `Save this path anyway?\n${selectedPath}`);
		if (!ok) return;
	}

	config = readConfig();
	if (kind === "complete") config.completeSoundPath = selectedPath;
	else config.attentionSoundPath = selectedPath;
	writeConfig(config);
	ctx.ui.notify(`${kind === "complete" ? "Completion" : "Attention"} sound set to ${soundName(selectedPath)}`, "success");
}

async function openSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(menuSummary(effectiveConfig()), "info");
		return;
	}

	while (true) {
		const config = readConfig();
		const effective = effectiveConfig();
		const choice = await ctx.ui.select(`Warp notification settings\n\n${menuSummary(effective)}`, [
			`${config.notificationsEnabled ? "Disable" : "Enable"} notifications`,
			"Choose notification backend…",
			`${config.soundEnabled ? "Disable" : "Enable"} all sounds`,
			`${config.completeSoundEnabled ? "Disable" : "Enable"} completion sound`,
			`${config.attentionSoundEnabled ? "Disable" : "Enable"} attention sound`,
			"Choose completion sound…",
			"Choose attention sound…",
			"Play completion sound",
			"Play attention sound",
			"Send test notification",
			"Reset to defaults…",
			"Close",
		]);

		if (!choice || choice === "Close") return;

		if (choice === "Choose notification backend…") {
			await chooseBackend(ctx);
			continue;
		}
		if (choice === "Choose completion sound…") {
			await chooseSound(ctx, "complete");
			continue;
		}
		if (choice === "Choose attention sound…") {
			await chooseSound(ctx, "attention");
			continue;
		}
		if (choice === "Play completion sound") {
			playSound("test");
			ctx.ui.notify(`Played ${soundName(effectiveConfig().completeSoundPath)}`, "info");
			continue;
		}
		if (choice === "Play attention sound") {
			playSound("needs-input");
			ctx.ui.notify(`Played ${soundName(effectiveConfig().attentionSoundPath)}`, "info");
			continue;
		}
		if (choice === "Send test notification") {
			notify("🔔 Pi Warp notification test", `Settings menu test · ${new Date().toLocaleTimeString()}`);
			ctx.ui.notify("Sent test Warp notification", "info");
			continue;
		}
		if (choice === "Reset to defaults…") {
			const ok = await ctx.ui.confirm("Reset Warp notification settings?", `This will overwrite ${CONFIG_PATH}`);
			if (ok) {
				resetConfig();
				ctx.ui.notify("Warp notification settings reset", "success");
			}
			continue;
		}
		if (choice.endsWith("notifications")) {
			const next = readConfig();
			next.notificationsEnabled = !next.notificationsEnabled;
			writeConfig(next);
			continue;
		}
		if (choice.endsWith("all sounds")) {
			const next = readConfig();
			next.soundEnabled = !next.soundEnabled;
			writeConfig(next);
			continue;
		}
		if (choice.endsWith("completion sound")) {
			const next = readConfig();
			next.completeSoundEnabled = !next.completeSoundEnabled;
			writeConfig(next);
			continue;
		}
		if (choice.endsWith("attention sound")) {
			const next = readConfig();
			next.attentionSoundEnabled = !next.attentionSoundEnabled;
			writeConfig(next);
		}
	}
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

	pi.registerCommand("warp-notify-settings", {
		description: "Open Warp notification settings menu",
		handler: async (_args, ctx) => {
			await openSettingsMenu(ctx);
		},
	});
}
