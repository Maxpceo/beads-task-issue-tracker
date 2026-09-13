import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_SUPERVISOR_TOOLS = "read,bash,edit,write";

export type VisibleSessionMode = { kind: "no-session" } | { kind: "session-dir"; dir: string };

export interface VisibleChildArgvInput {
	model?: string;
	systemPromptFile: string;
	tools?: string;
	session: VisibleSessionMode;
	taskFile: string;
}

export interface DispatchRegistryEntry {
	taskId: string;
	beadId: string;
	pane: string;
	worktree: string;
	role: string;
	model: string;
	taskFile: string;
	resultFile: string;
	digestFile: string;
	promptFile: string;
	status: "spawned" | "tombstone";
	submitStatus?: "none" | "result-only" | "submitted";
	callerSurface?: string;
	startCommit?: string;
	createdAt: string;
}

export interface DispatchRegistry {
	entries: DispatchRegistryEntry[];
}

export interface CmuxAdapter {
	identify(): Promise<{ workspaceId: string }>;
	newSplit(): Promise<{ surface: string }>;
	send(surface: string, text: string): Promise<void>;
	closeSurface(surface: string): Promise<void>;
	readScreen?(surface: string): Promise<boolean>;
}

export function orchRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.ORCH_ROOT) return env.ORCH_ROOT;
	const home = env.HOME || os.homedir();
	return path.join(home, ".pi", "orchestrator");
}

export function nsDir(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(orchRoot(env), "ns", workspaceId);
}

export const PROTECTED_SPAWN_BRANCHES = new Set(["main", "master"]);

export function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isProtectedSpawnBranch(branch?: string): boolean {
	return Boolean(branch && PROTECTED_SPAWN_BRANCHES.has(branch));
}

export function buildVisibleChildArgv(input: VisibleChildArgvInput): string[] {
	const tools = input.tools?.trim() || DEFAULT_SUPERVISOR_TOOLS;
	const args = ["pi"];
	if (input.model) args.push("--model", input.model);
	if (input.session.kind === "no-session") args.push("--no-session");
	else args.push("--session", input.session.dir);
	args.push("--append-system-prompt", input.systemPromptFile, "--tools", tools, `Task: read ${input.taskFile} and execute it.`);
	return args;
}

export function buildVisibleChildSpawnPayload(worktreePath: string, argv: string[]): string {
	const quotedArgv = argv.map(posixQuote).join(" ");
	return `cd ${posixQuote(worktreePath)} && ${quotedArgv}\n`;
}

export function visibleCmuxSpawnFailReason(input: { branch?: string; worktreePath?: string; payload?: string }): string | undefined {
	const worktreePath = input.worktreePath?.trim() ?? "";
	if (!worktreePath) return "transport=cmux spawn fail-close: payload without task worktree";
	if (isProtectedSpawnBranch(input.branch)) return `transport=cmux spawn fail-close: spawn target is protected branch ${input.branch}`;
	const payload = input.payload ?? "";
	if (!payload.includes(worktreePath) || !/\bcd\b/.test(payload) || !payload.includes("pi")) {
		return "transport=cmux spawn fail-close: payload without task worktree";
	}
	return undefined;
}

export function validateVisibleChildArgv(args: string[]): string[] {
	const errors: string[] = [];
	const hasAppend = args.includes("--append-system-prompt");
	const hasTools = args.includes("--tools");
	const hasNoSession = args.includes("--no-session");
	const hasSessionDir = args.includes("--session");
	if (!hasAppend) errors.push("missing --append-system-prompt");
	if (!hasTools) errors.push("missing --tools");
	if (!hasNoSession && !hasSessionDir) errors.push("missing --no-session or throwaway --session dir");
	return errors;
}

export function emptyRegistry(): DispatchRegistry {
	return { entries: [] };
}

export function loadRegistry(file: string): DispatchRegistry {
	if (!fs.existsSync(file)) return emptyRegistry();
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DispatchRegistry;
	return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

export function saveRegistry(file: string, registry: DispatchRegistry): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

export function pruneRegistry(registry: DispatchRegistry, live: Set<string>): DispatchRegistry {
	return {
		entries: registry.entries.map((entry) => {
			if (entry.status === "tombstone") return entry;
			if (live.has(entry.pane)) return entry;
			return { ...entry, status: "tombstone" };
		}),
	};
}

export function persistIsolationFiles(dir: string, taskId: string, systemPrompt: string, taskBody: string): { promptFile: string; taskFile: string; resultFile: string; digestFile: string } {
	const prompts = path.join(dir, "prompts");
	const tasks = path.join(dir, "tasks");
	const results = path.join(dir, "results");
	fs.mkdirSync(prompts, { recursive: true });
	fs.mkdirSync(tasks, { recursive: true });
	fs.mkdirSync(results, { recursive: true });
	const promptFile = path.join(prompts, `${taskId}.md`);
	const taskFile = path.join(tasks, `${taskId}.md`);
	const resultFile = path.join(results, `${taskId}.md`);
	const digestFile = path.join(results, `${taskId}.digest`);
	fs.writeFileSync(promptFile, systemPrompt);
	fs.writeFileSync(taskFile, taskBody);
	return { promptFile, taskFile, resultFile, digestFile };
}

export function unlinkIsolationFiles(entry: DispatchRegistryEntry): void {
	for (const file of [entry.promptFile, entry.taskFile]) {
		try {
			if (file && fs.existsSync(file)) fs.unlinkSync(file);
		} catch {
			/* ignore */
		}
	}
}

export interface SpawnAck {
	status: "spawned";
	pane: string;
	taskFile: string;
	resultFile: string;
	registryKey: string;
	taskId: string;
}

let cmuxAdapterForTests: CmuxAdapter | null = null;

export function setCmuxAdapterForTests(adapter: CmuxAdapter | null): void {
	cmuxAdapterForTests = adapter;
}

export function getCmuxAdapterForTests(): CmuxAdapter | null {
	return cmuxAdapterForTests;
}

export function worktreeOrchDir(worktree: string): string {
	return path.join(worktree, ".pi", "orchestrator");
}

export function liveEntriesForBead(registry: DispatchRegistry, beadId: string): DispatchRegistryEntry[] {
	return registry.entries.filter((entry) => entry.beadId === beadId && entry.status === "spawned");
}

export function findRegistryByTaskId(taskId: string, env: NodeJS.ProcessEnv = process.env): { file: string; registry: DispatchRegistry; entry: DispatchRegistryEntry; index: number } | undefined {
	const root = path.join(orchRoot(env), "ns");
	if (!fs.existsSync(root)) return undefined;
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name, "dispatch-registry.json");
		if (!fs.existsSync(file)) continue;
		const registry = loadRegistry(file);
		const index = registry.entries.findIndex((entry) => entry.taskId === taskId);
		if (index < 0) continue;
		const entry = registry.entries[index];
		if (!entry) continue;
		return { file, registry, entry, index };
	}
	return undefined;
}

export function readDigestPreview(digestFile: string, resultFile: string): { exists: boolean; text: string } {
	const source = fs.existsSync(digestFile) ? digestFile : fs.existsSync(resultFile) ? resultFile : "";
	if (!source) return { exists: false, text: "" };
	const text = fs.readFileSync(source, "utf8").split("\n").slice(0, 10).join("\n").trim();
	return { exists: true, text };
}

export function artifactLooksComplete(text: string): boolean {
	return /Status:\s*(DONE|DONE_WITH_CONCERNS)/i.test(text) && /Artifact status:\s*complete/i.test(text);
}

export function appendPanesEnv(ns: string, taskId: string, pane: string, orchestratorSurface?: string): void {
	const file = path.join(ns, "panes.env");
	fs.mkdirSync(ns, { recursive: true });
	const lines: string[] = [];
	if (orchestratorSurface) lines.push(`orchestrator=${orchestratorSurface}`);
	lines.push(`task-${taskId}=${pane}`);
	fs.appendFileSync(file, `${lines.join("\n")}\n`);
}
