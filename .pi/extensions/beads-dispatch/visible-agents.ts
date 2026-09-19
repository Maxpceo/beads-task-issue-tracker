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

export function buildSyncVisibleTaskBody(task: string, resultFile: string): string {
	return `${task}

WHEN DONE: write your final report to ${resultFile}
Do not ping. Child stdout is not delivery.
`;
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

export async function spawnSyncVisibleAgents(input: SpawnSyncVisibleAgentsInput): Promise<SyncVisibleAgentResult[]> {
	const timeoutMs = input.timeoutMs ?? DEFAULT_SYNC_VISIBLE_TIMEOUT_MS;
	const pollMs = input.pollMs ?? DEFAULT_SYNC_VISIBLE_POLL_MS;
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
	const results: SyncVisibleAgentResult[] = [];

	const cleanup = async () => closeAndTombstone(adapter, registryFile, registry, spawned);

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
			const taskBody = buildSyncVisibleTaskBody(spec.task, files.resultFile);
			fs.writeFileSync(files.taskFile, taskBody);
			const argv = buildVisibleChildArgv({
				model: spec.model,
				thinking: spec.thinking,
				systemPromptFile: files.promptFile,
				tools: spec.tools,
				session: { kind: "no-session" },
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
			results.push({ role: spec.role, taskId, pane: surface, output: "" });
		}

		const startedAt = now();
		const pending = new Set(results.map((row) => row.taskId));
		while (pending.size > 0) {
			if (input.signal?.aborted) throw new Error("aborted");
			if (now() - startedAt > timeoutMs) {
				throw new Error(`sync visible agents timed out after ${timeoutMs}ms`);
			}
			for (const row of results) {
				if (!pending.has(row.taskId)) continue;
				const entry = spawned.find((item) => item.taskId === row.taskId);
				if (!entry) continue;
				const output = readResultFile(entry.resultFile);
				if (output) {
					row.output = output;
					pending.delete(row.taskId);
					continue;
				}
				let screen = "";
				try {
					screen = await adapter.readScreen(entry.pane);
				} catch {
					screen = "";
				}
				if (classify(screen) === "dead") {
					row.error = `dead pane without result: ${entry.pane}`;
					pending.delete(row.taskId);
				}
			}
			if (pending.size === 0) break;
			await sleep(pollMs, input.signal);
		}
	} catch (error) {
		await cleanup();
		throw error;
	}

	await cleanup();
	return results;
}
