import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendPanesEnv,
	buildVisibleChildArgv,
	buildVisibleChildSpawnPayload,
	classifyVisiblePane,
	createLiveCmuxAdapter,
	getCmuxAdapterForTests,
	loadRegistry,
	nsDir,
	ORCHESTRATOR_TAB_TITLE,
	persistIsolationFiles,
	resolveVisibleSplitPlacement,
	saveRegistry,
	validateVisibleChildArgv,
	visibleChildTabTitle,
	visibleCmuxSpawnFailReason,
	type CmuxAdapter,
	type CmuxExec,
	type DispatchRegistry,
	type DispatchRegistryEntry,
	type VisiblePaneHealth,
} from "./cmux-transport";

export const DEFAULT_SYNC_VISIBLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_SYNC_VISIBLE_POLL_MS = 1000;
export const DEFAULT_SYNC_VISIBLE_STARTUP_GRACE_MS = 30_000;
/** Temporary bpaz observe-first poller log. Does not change fail-fast. */
export const BPAZ_WATCHDOG_TRACE_RELATIVE_PATH = path.join(".pi", "orchestrator", "results", "bpaz-watchdog-trace.jsonl");
const BPAZ_WATCHDOG_EXCERPT_CHARS = 200;

export interface SyncVisibleAgentSpec {
	role: string;
	task: string;
	systemPrompt?: string;
	systemPromptFile?: string;
	tools?: string;
	model?: string;
	thinking?: string;
}

export interface SpawnSyncVisibleAgentsInput {
	adapter: CmuxAdapter;
	worktreePath: string;
	branch?: string;
	agents: SyncVisibleAgentSpec[];
	beadId?: string;
	timeoutMs?: number;
	pollMs?: number;
	startupGraceMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	classifyPane?: (text: string) => VisiblePaneHealth;
}

export interface SyncVisibleAgentResult {
	role: string;
	taskId: string;
	pane: string;
	output: string;
	error?: string;
}

export function isPlanReviewSyncRole(role: string): boolean {
	return /^plan-.+-reviewer$/.test(role.trim());
}

export function buildSyncVisibleTaskBody(task: string, resultFile?: string, planReview = false): string {
	if (planReview) {
		return `${task}

Do not ping. Do not write files. Print the final report in this session.
`;
	}
	const writeLine = resultFile ? `WHEN DONE: write your final report to ${resultFile}\n` : "";
	return `${task}\n\n${writeLine}Do not ping. Child stdout is not delivery.\n`;
}

export function resolveVisibleCmuxAdapter(exec?: CmuxExec): CmuxAdapter {
	const testAdapter = getCmuxAdapterForTests();
	if (testAdapter) return testAdapter;
	if (!exec) throw new Error("нет cmux adapter: BLOCKED");
	return createLiveCmuxAdapter(exec);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => resolve(), ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function safeRename(adapter: CmuxAdapter, surface: string, title: string): Promise<void> {
	if (!surface || !title || typeof adapter.renameSurface !== "function") return;
	try {
		await adapter.renameSurface(surface, title);
	} catch {
		/* title-only best effort */
	}
}

async function closeAndTombstone(
	adapter: CmuxAdapter,
	registryFile: string,
	registry: DispatchRegistry,
	spawned: DispatchRegistryEntry[],
): Promise<void> {
	for (const entry of spawned) {
		try {
			await adapter.closeSurface(entry.pane);
		} catch {
			/* best-effort close */
		}
		const index = registry.entries.findIndex((row) => row.taskId === entry.taskId);
		if (index >= 0) {
			registry.entries[index] = { ...registry.entries[index]!, status: "tombstone", hung: false };
		}
	}
	if (spawned.length > 0) saveRegistry(registryFile, registry);
}

function readResultFile(resultFile: string): string | undefined {
	try {
		if (!fs.existsSync(resultFile)) return undefined;
		const text = fs.readFileSync(resultFile, "utf8");
		return text.trim() ? text : undefined;
	} catch {
		return undefined;
	}
}

const PLAN_REVIEW_VERDICT_RE = /PLAN REVIEW:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)\b/i;

function assistantTextFromEvent(event: unknown, options?: { requireTextOnly?: boolean }): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const rec = event as {
		type?: string;
		message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
	};
	if (rec.type !== "message_end" && rec.type !== "message") return undefined;
	if (rec.message?.role !== "assistant") return undefined;
	const parts = rec.message.content ?? [];
	if (options?.requireTextOnly && parts.some((part) => part.type === "toolCall" || part.type === "tool_call")) {
		return undefined;
	}
	const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
	return text || undefined;
}

/** Last complete assistant text from headless JSONL stdout or a session journal. */
export function extractLastCompleteAssistantText(source: string, options?: { requireTextOnly?: boolean }): string | undefined {
	let finalText: string | undefined;
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			const text = assistantTextFromEvent(JSON.parse(line), options);
			if (text) finalText = text;
		} catch {
			// Incomplete jsonl is ignored.
		}
	}
	return finalText;
}

export function extractFinalAssistantText(source: string): string {
	return extractLastCompleteAssistantText(source) || source;
}

/** Last complete assistant message that contains a real PLAN REVIEW verdict. */
export function extractPlanReviewFromJournal(source: string): string | undefined {
	let found: string | undefined;
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			const text = assistantTextFromEvent(JSON.parse(line));
			if (text && PLAN_REVIEW_VERDICT_RE.test(text)) found = text;
		} catch {
			// Truncated jsonl is not delivery.
		}
	}
	return found;
}

export function extractSyncJournalOutput(source: string, role: string): string | undefined {
	const planReview = extractPlanReviewFromJournal(source);
	if (planReview) return planReview;
	if (isPlanReviewSyncRole(role)) return undefined;
	return extractLastCompleteAssistantText(source, { requireTextOnly: true });
}

function readJournalSource(sessionDir: string): string | undefined {
	try {
		if (!fs.existsSync(sessionDir)) return undefined;
		const stat = fs.statSync(sessionDir);
		if (stat.isFile()) {
			const text = fs.readFileSync(sessionDir, "utf8");
			return text.trim() ? text : undefined;
		}
		const chunks: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const nested = path.join(dir, name);
				const nestedStat = fs.statSync(nested);
				if (nestedStat.isDirectory()) {
					walk(nested);
					continue;
				}
				if (!name.endsWith(".jsonl") && !name.endsWith(".json")) continue;
				const text = fs.readFileSync(nested, "utf8");
				if (text.trim()) chunks.push(text);
			}
		};
		walk(sessionDir);
		return chunks.length > 0 ? chunks.join("\n") : undefined;
	} catch {
		return undefined;
	}
}

function persistThrowawaySessionDir(nsRoot: string, taskId: string): string {
	const sessionDir = path.join(nsRoot, "sessions", taskId);
	fs.mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function isTimeoutMissingReport(error?: string): boolean {
	return Boolean(error && /timed out after/.test(error));
}

function appendBpazWatchdogTrace(worktreePath: string, rec: Record<string, unknown>): void {
	try {
		const file = path.join(worktreePath, BPAZ_WATCHDOG_TRACE_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
	} catch {
		/* observe-only: never change poller decision */
	}
}

export async function spawnSyncVisibleAgents(input: SpawnSyncVisibleAgentsInput): Promise<SyncVisibleAgentResult[]> {
	const timeoutMs = input.timeoutMs ?? DEFAULT_SYNC_VISIBLE_TIMEOUT_MS;
	const pollMs = input.pollMs ?? DEFAULT_SYNC_VISIBLE_POLL_MS;
	const startupGraceMs = input.startupGraceMs ?? DEFAULT_SYNC_VISIBLE_STARTUP_GRACE_MS;
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? defaultSleep;
	const classify = input.classifyPane ?? classifyVisiblePane;
	const adapter = input.adapter;
	const identified = await adapter.identify();
	const dir = nsDir(identified.workspaceId, input.env);
	const registryFile = path.join(dir, "dispatch-registry.json");
	const registry = loadRegistry(registryFile);
	const callerSurface =
		(typeof adapter.callerSurface === "function" ? adapter.callerSurface() : "") || "";
	const spawned: DispatchRegistryEntry[] = [];
	const sessionDirs = new Map<string, string>();
	const results: SyncVisibleAgentResult[] = [];

	const cleanup = async (entries: DispatchRegistryEntry[]) => closeAndTombstone(adapter, registryFile, registry, entries);

	try {
		for (let index = 0; index < input.agents.length; index += 1) {
			if (input.signal?.aborted) throw new Error("aborted");
			const spec = input.agents[index]!;
			const taskId = `sync-${spec.role}-${now()}-${index}`;
			const beadId = (input.beadId ?? "").trim() || `sync:${taskId}`;
			let systemPrompt = spec.systemPrompt ?? "";
			if (!systemPrompt && spec.systemPromptFile) {
				systemPrompt = fs.readFileSync(spec.systemPromptFile, "utf8");
			}
			const files = persistIsolationFiles(dir, taskId, systemPrompt, "pending");
			const sessionDir = persistThrowawaySessionDir(dir, taskId);
			const planReview = isPlanReviewSyncRole(spec.role);
			const taskBody = buildSyncVisibleTaskBody(spec.task, planReview ? undefined : files.resultFile, planReview);
			fs.writeFileSync(files.taskFile, taskBody);
			const argv = buildVisibleChildArgv({
				model: spec.model,
				thinking: spec.thinking,
				systemPromptFile: files.promptFile,
				tools: spec.tools,
				session: { kind: "session-dir", dir: sessionDir },
				taskFile: files.taskFile,
			});
			const argvErrors = validateVisibleChildArgv(argv);
			if (argvErrors.length > 0) throw new Error(`transport=cmux argv fail-close: ${argvErrors.join("; ")}`);
			const payload = buildVisibleChildSpawnPayload(input.worktreePath, argv);
			const spawnFail = visibleCmuxSpawnFailReason({
				branch: input.branch,
				worktreePath: input.worktreePath,
				payload,
			});
			if (spawnFail) throw new Error(spawnFail);
			const livePanes = registry.entries.filter((entry) => entry.status === "spawned");
			const placement = resolveVisibleSplitPlacement({
				callerSurface,
				liveAgentPanes: livePanes,
			});
			let surface = "";
			try {
				const split = await adapter.newSplit({
					anchorSurface: placement.anchorSurface,
					direction: placement.direction,
				});
				surface = split.surface;
				await adapter.send(surface, payload);
			} catch (error) {
				if (surface) await adapter.closeSurface(surface);
				throw error;
			}
			await safeRename(adapter, surface, visibleChildTabTitle(spec.role, beadId));
			if (callerSurface) await safeRename(adapter, callerSurface, ORCHESTRATOR_TAB_TITLE);
			appendPanesEnv(dir, taskId, surface, callerSurface || undefined);
			const entry: DispatchRegistryEntry = {
				taskId,
				beadId,
				pane: surface,
				worktree: input.worktreePath,
				role: spec.role,
				model: spec.model ?? "",
				thinking: spec.thinking,
				taskFile: files.taskFile,
				resultFile: files.resultFile,
				digestFile: files.digestFile,
				promptFile: files.promptFile,
				status: "spawned",
				submitStatus: "none",
				callerSurface: callerSurface || undefined,
				createdAt: new Date(now()).toISOString(),
				layoutColumn: placement.layoutColumn,
				kind: "sync",
			};
			registry.entries.push(entry);
			saveRegistry(registryFile, registry);
			spawned.push(entry);
			sessionDirs.set(taskId, sessionDir);
			results.push({ role: spec.role, taskId, pane: surface, output: "" });
		}

		const startedAt = now();
		const pending = new Set(results.map((row) => row.taskId));
		while (pending.size > 0) {
			if (input.signal?.aborted) throw new Error("aborted");
			if (now() - startedAt > timeoutMs) {
				for (const row of results) {
					if (!pending.has(row.taskId)) continue;
					row.error = `sync visible agents timed out after ${timeoutMs}ms: missing report`;
					pending.delete(row.taskId);
				}
				break;
			}
			for (const row of results) {
				if (!pending.has(row.taskId)) continue;
				const entry = spawned.find((item) => item.taskId === row.taskId);
				if (!entry) continue;
				const createdAtMs = Date.parse(entry.createdAt);
				const ageMs = Number.isFinite(createdAtMs) ? now() - createdAtMs : startupGraceMs;
				const sessionDir = sessionDirs.get(row.taskId);
				const journal = sessionDir ? readJournalSource(sessionDir) : undefined;
				const extracted = journal ? extractSyncJournalOutput(journal, row.role) : undefined;
				if (extracted) {
					appendBpazWatchdogTrace(input.worktreePath, {
						ts: now(),
						pane: entry.pane,
						role: entry.role,
						taskId: row.taskId,
						ageMs,
						health: "journal",
						hasResultFile: false,
						hasJournal: true,
						excerpt: "",
					});
					row.output = extracted;
					pending.delete(row.taskId);
					continue;
				}
				const output = readResultFile(entry.resultFile);
				if (output) {
					appendBpazWatchdogTrace(input.worktreePath, {
						ts: now(),
						pane: entry.pane,
						role: entry.role,
						taskId: row.taskId,
						ageMs,
						health: "result",
						hasResultFile: true,
						excerpt: "",
					});
					row.output = output;
					pending.delete(row.taskId);
					continue;
				}
				let screen: string | undefined;
				try {
					screen = await adapter.readScreen(entry.pane);
				} catch (error) {
					appendBpazWatchdogTrace(input.worktreePath, {
						ts: now(),
						pane: entry.pane,
						role: entry.role,
						taskId: row.taskId,
						ageMs,
						health: "read-error",
						hasResultFile: false,
						excerpt: String(error instanceof Error ? error.message : error).slice(0, BPAZ_WATCHDOG_EXCERPT_CHARS),
					});
					continue;
				}
				if (!screen.trim()) {
					appendBpazWatchdogTrace(input.worktreePath, {
						ts: now(),
						pane: entry.pane,
						role: entry.role,
						taskId: row.taskId,
						ageMs,
						health: "empty",
						hasResultFile: false,
						excerpt: "",
					});
					continue;
				}
				const health = classify(screen);
				appendBpazWatchdogTrace(input.worktreePath, {
					ts: now(),
					pane: entry.pane,
					role: entry.role,
					taskId: row.taskId,
					ageMs,
					health,
					hasResultFile: false,
					excerpt: screen.slice(0, BPAZ_WATCHDOG_EXCERPT_CHARS),
				});
				if (health === "dead" || health === "shell") {
					if (ageMs < startupGraceMs) continue;
					row.error = `dead pane without result: ${entry.pane}`;
					pending.delete(row.taskId);
				}
			}
			if (pending.size === 0) break;
			await sleep(pollMs, input.signal);
		}
	} catch (error) {
		await cleanup(spawned);
		throw error;
	}

	const closable = spawned.filter((entry) => {
		const row = results.find((item) => item.taskId === entry.taskId);
		if (!row) return false;
		if (row.output.trim()) return true;
		if (row.error && !isTimeoutMissingReport(row.error)) return true;
		return false;
	});
	await cleanup(closable);
	return results;
}
