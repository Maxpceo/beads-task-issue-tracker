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

export function buildVisibleChildArgv(input: VisibleChildArgvInput): string[] {
	const tools = input.tools?.trim() || DEFAULT_SUPERVISOR_TOOLS;
	const args = ["pi"];
	if (input.model) args.push("--model", input.model);
	if (input.session.kind === "no-session") args.push("--no-session");
	else args.push("--session", input.session.dir);
	args.push("--append-system-prompt", input.systemPromptFile, "--tools", tools, `Task: read ${input.taskFile} and execute it.`);
	return args;
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
