/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, loadProjectAgentTeams } from "./agents.js";
import {
	AgentDashboardComponent,
	type AgentDashboardCard,
	type AgentDashboardMode,
	clearObservedDashboardCards,
	createDashboardState,
	getSharedDashboardState,
	publishDashboardCard,
	registerDashboardRenderer,
	selectDashboardAgents,
	setSharedDashboardState,
} from "./dashboard.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PLAN_SUBAGENT_NAMES = new Set(["detective", "architect"]);
const PLAN_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatDashboardUsage(usage: UsageStats): string | undefined {
	const parts: string[] = [];
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (usage.input > 0) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`cache:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`write:${formatTokens(usage.cacheWrite)}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	status: "queued" | "running" | "completed" | "failed" | "aborted";
	startedAt: number;
	completedAt?: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function formatElapsed(startedAt: number, completedAt?: number): string {
	const end = completedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function getLastPreview(messages: Message[]): string {
	const items = getDisplayItems(messages);
	const last = items[items.length - 1];
	if (!last) return "";
	const text = last.type === "text" ? last.text : `${last.name} ${JSON.stringify(last.args)}`;
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function getToolCallCount(messages: Message[]): number {
	return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}

function resultToDashboardCard(result: SingleResult): AgentDashboardCard {
	const errorMessage = Array.from(
		new Set([result.errorMessage, result.stderr.trim()].filter((part): part is string => Boolean(part))),
	).join("\n");
	return {
		agent: result.agent,
		source: result.agentSource,
		status: result.status === "completed" && result.exitCode !== 0 ? "failed" : result.status,
		task: result.task,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
		toolCount: getToolCallCount(result.messages),
		contextText: formatDashboardUsage(result.usage),
		lastPreview: getLastPreview(result.messages),
		errorMessage: errorMessage || undefined,
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

let spawnForSubagent = spawn;

export function setSpawnForSubagentTestOverride(override: typeof spawn | null): void {
	spawnForSubagent = override ?? spawn;
}

async function execText(pi: ExtensionAPI, command: string, args: string[]): Promise<string> {
	const exec = (pi as ExtensionAPI & { exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> }).exec;
	if (!exec) return `N/A: ${command} ${args.join(" ")} unavailable in this Pi runtime`;
	const result = await exec(command, args);
	return result.code === 0 ? result.stdout.trim() || "(empty)" : `ERROR exit ${result.code}: ${(result.stderr || result.stdout).trim()}`;
}

function latestWorkflowState(ctx: { sessionManager?: { getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> } }): { activeBead?: string; branch?: string; worktreePath?: string; startCommit?: string } | undefined {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of [...entries].reverse()) {
		const isWorkflowState = entry.type === "workflow-state" || (entry.type === "custom" && entry.customType === "workflow-state");
		if (!isWorkflowState || !entry.data || typeof entry.data !== "object") continue;
		return entry.data as { activeBead?: string; branch?: string; worktreePath?: string; startCommit?: string };
	}
	return undefined;
}

async function gitText(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	return execText(pi, "git", ["-C", cwd, ...args]);
}

async function buildPlanSubagentTask(pi: ExtensionAPI, ctx: { cwd: string; sessionManager?: { getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> } }, params: { agent: string; task: string; beadId?: string; branch?: string; startCommit?: string; planContext?: string; cwd?: string }): Promise<string> {
	const state = latestWorkflowState(ctx);
	const cwd = params.cwd ?? state?.worktreePath ?? ctx.cwd;
	const beadId = params.beadId ?? state?.activeBead;
	const branch = params.branch ?? state?.branch ?? await gitText(pi, cwd, ["branch", "--show-current"]);
	const startCommit = params.startCommit ?? state?.startCommit ?? await gitText(pi, cwd, ["rev-parse", "HEAD"]);
	const beadShow = beadId ? await execText(pi, "bd", ["show", beadId]) : "N/A: no BEAD_ID supplied or recorded in workflow-state";
	const beadComments = beadId ? await execText(pi, "bd", ["comments", beadId]) : "N/A: no BEAD_ID supplied or recorded in workflow-state";

	return `PLAN-SAFE SUBAGENT CONTEXT
Agent: ${params.agent}
Allowed child tools: ${PLAN_SUBAGENT_TOOLS.join(",")}
BEAD_ID: ${beadId ?? "-"}
BRANCH: ${branch || "-"}
START_COMMIT: ${startCommit || "-"}
CWD: ${cwd}

Read-only bead context from wrapper prefetch:

--- bd show ${beadId ?? "<none>"} ---
${beadShow}

--- bd comments ${beadId ?? "<none>"} ---
${beadComments}

--- relevant plan/context ---
${params.planContext?.trim() || "N/A"}

TASK:
${params.task}

Constraints:
- You are a read-only planning/investigation subagent.
- Use only read, grep, find, and ls.
- Do not ask for bash/edit/write or workflow dispatch/review tools.
- Return findings, evidence, risks, and recommendations only.`;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	toolOverride?: string[],
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const now = Date.now();
		const errorMessage = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			status: "failed",
			startedAt: now,
			completedAt: now,
			messages: [],
			stderr: errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			errorMessage,
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	const tools = toolOverride ?? agent.tools;
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		status: "running",
		startedAt: Date.now(),
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		emitUpdate();

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawnForSubagent(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				currentResult.stderr += `\nProcess error: ${error.message}`;
				currentResult.errorMessage = error.message;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.completedAt = Date.now();
		currentResult.status = exitCode === 0 ? "completed" : "failed";
		if (wasAborted) {
			currentResult.status = "aborted";
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project" (.pi/agents only). Use "both" to explicitly include user agents.',
	default: "project",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const PlanSubagentParams = Type.Object({
	agent: Type.String({ description: "Plan-safe project agent name. Only detective or architect are allowed." }),
	task: Type.String({ description: "Read-only planning or investigation task." }),
	beadId: Type.Optional(Type.String({ description: "Bead ID for wrapper-side bd show/comments prefetch." })),
	branch: Type.Optional(Type.String({ description: "Branch context to inject." })),
	startCommit: Type.Optional(Type.String({ description: "Start commit context to inject." })),
	planContext: Type.Optional(Type.String({ description: "Relevant plan text to inject into the child prompt." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child process. Defaults to workflow-state worktree or current cwd." })),
});

export default function (pi: ExtensionAPI) {
	const renderDashboardWidget = (ctx: { ui: any }) => {
		const dashboardState = getSharedDashboardState();
		if (!dashboardState?.visible) return;
		ctx.ui.setWidget("subagent-dashboard", (tui: { requestRender?: () => void } | undefined, theme: any) => {
			registerDashboardRenderer(tui);
			return new AgentDashboardComponent(() => getSharedDashboardState()!, theme);
		});
	};

	const updateDashboardFromResults = (results: SingleResult[], ctx: { ui: any }) => {
		if (!getSharedDashboardState()?.visible) return;
		for (const result of results) publishDashboardCard(resultToDashboardCard(result));
		renderDashboardWidget(ctx);
	};

	pi.registerCommand("agents-dashboard", {
		description:
			"Show a persistent project-local agent dashboard. Usage: /agents-dashboard [active|all] [team], refresh, hide, or clear.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens.find((token) => token === "clear" || token === "hide");
			if (action) {
				if (action === "clear") clearObservedDashboardCards();
				setSharedDashboardState(null);
				ctx.ui.setWidget("subagent-dashboard", undefined);
				ctx.ui.notify("Agent dashboard hidden.", "info");
				return;
			}

			const current = getSharedDashboardState();
			const explicitMode = tokens.find((token): token is AgentDashboardMode => token === "active" || token === "all");
			const mode = explicitMode ?? current?.mode ?? "all";
			const teamName = tokens.find((token) => token !== "refresh" && token !== "active" && token !== "all") ?? current?.teamName;
			const discovery = discoverAgents(ctx.cwd, "project");
			const teams = loadProjectAgentTeams(ctx.cwd, discovery.agents);
			const selection = selectDashboardAgents(discovery.agents, teams, teamName);
			const state = createDashboardState(selection, mode);
			setSharedDashboardState(state);
			renderDashboardWidget(ctx);
			ctx.ui.notify(
				`Agent dashboard shown in ${mode} mode for ${state.cards.size} displayed agent(s).`,
				selection.warnings.length > 0 || (state.cards.size === 0 && mode === "all") ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("agents-list", {
		description: "List project-local Pi agents from .pi/agents (no .claude/.gemini/.codex scanning). Use 'clear' to hide.",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				ctx.ui.setWidget("subagent-agents", undefined);
				ctx.ui.notify("Agents list cleared.", "info");
				return;
			}

			const discovery = discoverAgents(ctx.cwd, "project");
			const lines = ["Pi agents (.pi/agents only)"];
			if (discovery.projectAgentsDir) lines.push(`Source: ${discovery.projectAgentsDir}`);
			else lines.push("Source: no project .pi/agents directory found");
			lines.push("");
			if (discovery.agents.length === 0) {
				lines.push("No project-local agents found.");
			} else {
				for (const agent of discovery.agents.sort((a, b) => a.name.localeCompare(b.name))) {
					const model = agent.model ? ` · model: ${agent.model}` : "";
					const tools = agent.tools?.length ? ` · tools: ${agent.tools.join(", ")}` : "";
					lines.push(`• ${agent.name}: ${agent.description}${model}${tools}`);
				}
			}
			lines.push("");
			lines.push("Default subagent scope is project-only; use typed workflow commands for dispatch/review guards.");
			ctx.ui.setWidget("subagent-agents", lines);
			ctx.ui.notify(`Listed ${discovery.agents.length} project-local agent(s).`, "info");
		},
	});

	pi.registerCommand("agents-team", {
		description: "Show project-local teams from .pi/agents/teams.yaml. Missing or malformed config is reported without crashing.",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				ctx.ui.setWidget("subagent-teams", undefined);
				ctx.ui.notify("Agent teams cleared.", "info");
				return;
			}

			const discovery = discoverAgents(ctx.cwd, "project");
			const config = loadProjectAgentTeams(ctx.cwd, discovery.agents);
			const selected = args.trim();
			const teams = selected ? config.teams.filter((team) => team.name === selected) : config.teams;
			const lines = ["Pi agent teams (.pi/agents/teams.yaml)"];
			lines.push(`Source: ${config.filePath ?? "no project .pi/agents directory"}`);
			for (const warning of config.warnings) lines.push(`! ${warning}`);
			lines.push("");

			if (teams.length === 0) {
				lines.push(selected ? `No team named "${selected}" found.` : "No teams configured.");
				if (discovery.agents.length > 0) {
					lines.push("Available individual agents:");
					for (const agent of discovery.agents.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`• ${agent.name}`);
				}
			} else {
				for (const team of teams) {
					lines.push(`• ${team.name}${team.description ? ` — ${team.description}` : ""}`);
					lines.push(`  members: ${team.members.join(", ") || "none"}`);
					for (const warning of team.warnings) lines.push(`  ! ${warning}`);
				}
			}

			lines.push("");
			lines.push("Team view is read-only; workflow dispatch/review still goes through typed guarded tools.");
			ctx.ui.setWidget("subagent-teams", lines);
			ctx.ui.notify(`Displayed ${teams.length} team(s).`, teams.length > 0 ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "plan_subagent",
		label: "Plan Subagent",
		description: "Run a read-only planning subagent in plan mode. Only detective/architect are allowed; child tools are forced to read,grep,find,ls.",
		parameters: PlanSubagentParams,
		async execute(_toolCallId, params: { agent: string; task: string; beadId?: string; branch?: string; startCommit?: string; planContext?: string; cwd?: string }, signal, onUpdate, ctx) {
			if (!PLAN_SUBAGENT_NAMES.has(params.agent)) {
				return {
					content: [{ type: "text", text: `plan_subagent blocked: agent "${params.agent}" is not allowed. Allowed agents: ${Array.from(PLAN_SUBAGENT_NAMES).join(", ")}. Use typed dispatch tools outside plan mode for implementation supervisors.` }],
					details: { ok: false, allowedAgents: Array.from(PLAN_SUBAGENT_NAMES), rejectedAgent: params.agent, childTools: PLAN_SUBAGENT_TOOLS },
					isError: true,
				};
			}

			const discovery = discoverAgents(ctx.cwd, "project");
			const agent = discovery.agents.find((a) => a.name === params.agent);
			if (!agent) {
				return {
					content: [{ type: "text", text: `plan_subagent blocked: project agent "${params.agent}" not found in ${discovery.projectAgentsDir ?? ".pi/agents"}.` }],
					details: { ok: false, allowedAgents: Array.from(PLAN_SUBAGENT_NAMES), rejectedAgent: params.agent, childTools: PLAN_SUBAGENT_TOOLS },
					isError: true,
				};
			}

			const taskWithContext = await buildPlanSubagentTask(pi, ctx, params);
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope: "project",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});
			const result = await runSingleAgent(
				ctx.cwd,
				discovery.agents,
				params.agent,
				taskWithContext,
				params.cwd,
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) updateDashboardFromResults([partial.details.results[0]], ctx);
					onUpdate?.(partial);
				},
				makeDetails,
				PLAN_SUBAGENT_TOOLS,
			);
			updateDashboardFromResults([result], ctx);
			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			return {
				content: [{ type: "text", text: isError ? `Plan agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"}` : getFinalOutput(result.messages) || "(no output)" }],
				details: { ...makeDetails([result]), ok: !isError, childTools: PLAN_SUBAGENT_TOOLS, injectedContext: { beadId: params.beadId, branch: params.branch, startCommit: params.startCommit } },
				isError,
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "project" and discovers only project-local .pi/agents.',
			'Use agentScope: "both" or "user" only when user agents are explicitly needed.',
			"Workflow-critical dispatch/review actions must use typed workflow tools, not generic team UI shortcuts.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const emitDashboard = (results: SingleResult[]) => updateDashboardFromResults(results, ctx);

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = (partial) => {
						// Combine completed results with current streaming result
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							const allResults = [...results, currentResult];
							emitDashboard(allResults);
							onUpdate?.({
								content: partial.content,
								details: makeDetails("chain")(allResults),
							});
						}
					};

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);
					emitDashboard(results);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						status: "queued",
						startedAt: Date.now(),
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					emitDashboard([...allResults]);
					onUpdate?.({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
						],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					(partial) => {
						if (partial.details?.results[0]) emitDashboard([partial.details.results[0]]);
						onUpdate?.(partial);
					},
					makeDetails("single"),
				);
				emitDashboard([result]);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "project";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderRunStats = (r: SingleResult) => {
				const tools = getToolCallCount(r.messages);
				const preview = getLastPreview(r.messages);
				const parts = [
					`status:${r.status}`,
					`elapsed:${formatElapsed(r.startedAt, r.completedAt)}`,
					`tools:${tools}`,
				];
				if (preview) parts.push(`last:${preview}`);
				return theme.fg("dim", parts.join(" · "));
			};

			const renderErrorText = (r: SingleResult): string =>
				Array.from(new Set([r.errorMessage, r.stderr.trim()].filter((part): part is string => Boolean(part)))).join("\n");

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					container.addChild(new Text(renderRunStats(r), 0, 0));
					const errorText = renderErrorText(r);
					if (isError && errorText)
						container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				text += `\n${renderRunStats(r)}`;
				const errorText = renderErrorText(r);
				if (isError && errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = renderErrorText(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(renderRunStats(r), 0, 0));
						if (errorText) container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const errorText = renderErrorText(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					text += `\n${renderRunStats(r)}`;
					if (errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = renderErrorText(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(renderRunStats(r), 0, 0));
						if (errorText) container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const errorText = renderErrorText(r);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					text += `\n${renderRunStats(r)}`;
					if (errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
