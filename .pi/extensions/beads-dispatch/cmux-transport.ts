import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_SUPERVISOR_TOOLS = "read,bash,edit,write";

export type VisibleSessionMode = { kind: "no-session" } | { kind: "session-dir"; dir: string };

export interface VisibleChildArgvInput {
	model?: string;
	/** Explicit thinking level including "off"; omit/undefined = session inherit (no --thinking). */
	thinking?: string;
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
	/** Optional resolved thinking for respawn; empty/omit = inherit. */
	thinking?: string;
	taskFile: string;
	resultFile: string;
	digestFile: string;
	promptFile: string;
	status: "spawned" | "tombstone";
	submitStatus?: "none" | "result-only" | "submitted" | "verdict";
	callerSurface?: string;
	startCommit?: string;
	sendFailCount?: number;
	hung?: boolean;
	createdAt: string;
}

export interface DispatchRegistry {
	entries: DispatchRegistryEntry[];
}

export type VisiblePaneHealth = "waiting" | "busy" | "shell" | "dead";

export interface CmuxNewSplitOpts {
	/** Surface to split from. When omitted, live adapter uses the identify caller surface. */
	anchorSurface?: string;
}

export interface CmuxAdapter {
	identify(): Promise<{ workspaceId: string }>;
	newSplit(opts?: CmuxNewSplitOpts): Promise<{ surface: string }>;
	send(surface: string, text: string): Promise<void>;
	closeSurface(surface: string): Promise<void>;
	readScreen(surface: string): Promise<string>;
	/** Optional: rename a surface tab after spawn. Live adapter always implements this. */
	renameSurface?(surface: string, title: string): Promise<void>;
	/** Optional: orchestrator/caller surface for rename; live adapter exposes via method. */
	callerSurface?(): string;
}

/**
 * Choose the cmux surface to split right-of for the next visible agent pane.
 * - 0 live candidates (after excludePane) → orchestrator/caller surface
 * - ≥1 candidates → oldest createdAt, then taskId; never re-split orch when another live agent exists
 * - No hard N=2 cap: Nth agent still anchors the first live agent so the right half packs side-by-side
 *   (practical capacity ~4–6 per AGENTS.md Layout geometry; operator judgment beyond that)
 */
export function resolveVisibleSplitAnchor(input: {
	callerSurface: string;
	liveAgentPanes: Array<Pick<DispatchRegistryEntry, "pane" | "createdAt" | "taskId" | "status">>;
	excludePane?: string;
}): string {
	const caller = (input.callerSurface ?? "").trim();
	const exclude = (input.excludePane ?? "").trim();
	const candidates = input.liveAgentPanes
		.filter((entry) => entry.status === "spawned" && Boolean(entry.pane?.trim()) && entry.pane.trim() !== exclude)
		.slice()
		.sort((a, b) => {
			const createdCmp = (a.createdAt || "").localeCompare(b.createdAt || "");
			if (createdCmp !== 0) return createdCmp;
			return (a.taskId || "").localeCompare(b.taskId || "");
		});
	if (candidates.length === 0) return caller;
	return candidates[0]!.pane.trim();
}

export const ORCHESTRATOR_TAB_TITLE = "оркестратор";

/** Last `-` segment of a bead id (`beads-task-issue-tracker-fo5d` → `fo5d`). */
export function beadSuffixFromId(beadId: string): string {
	const id = (beadId ?? "").trim();
	if (!id) return "";
	const idx = id.lastIndexOf("-");
	if (idx < 0 || idx === id.length - 1) return id;
	return id.slice(idx + 1);
}

/** Child pane title: `{role} · {bead-suffix}`. */
export function visibleChildTabTitle(role: string, beadId: string): string {
	return `${role} · ${beadSuffixFromId(beadId)}`;
}

/** Exact argv for `cmux tab-action rename` with `--focus false`. */
export function buildCmuxRenameArgv(surface: string, title: string): string[] {
	return ["tab-action", "--action", "rename", "--surface", surface, "--title", title, "--focus", "false"];
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
	const thinking = typeof input.thinking === "string" ? input.thinking.trim() : "";
	if (thinking) args.push("--thinking", thinking);
	if (input.session.kind === "no-session") args.push("--no-session");
	else args.push("--session", input.session.dir);
	args.push("--append-system-prompt", input.systemPromptFile, "--tools", tools, `Task: read ${input.taskFile} and execute it.`);
	return args;
}

export function buildVisibleChildSpawnPayload(worktreePath: string, argv: string[]): string {
	const quotedArgv = argv.map(posixQuote).join(" ");
	return `cd ${posixQuote(worktreePath)} && ${quotedArgv}\n`;
}

const SESSION_LINE_RE = /\bsession(?:Mode)?(?:\s*[:=]\s*|\s+)(idle|implementing|inreview|waiting|reviewing|planning)\b/i;
const BUSY_RE = /\b(thinking|busy)\b/i;
const SHELL_PROMPT_RE = /(?:^|\n)[^\n]*[$%❯]\s*$/m;

export function classifyVisiblePane(text: string): VisiblePaneHealth {
	const screen = text ?? "";
	if (BUSY_RE.test(screen)) return "busy";
	if (SESSION_LINE_RE.test(screen)) return "waiting";
	if (SHELL_PROMPT_RE.test(screen.trimEnd())) return "shell";
	return "dead";
}

export function buildVisibleFollowupPayload(task: string): string {
	if (task.trim().length === 0) {
		throw new Error("followup_visible_dispatch: пустой task: BLOCKED");
	}
	return task.endsWith("\n") ? task : `${task}\n`;
}

export function followupPayloadLooksLikeSpawnArgv(payload: string): boolean {
	return /^\s*cd\s/.test(payload) && /\s&&\s/.test(payload) && /\bpi\b/.test(payload);
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

export function unlinkFollowupArtifacts(entry: DispatchRegistryEntry): void {
	for (const file of [entry.digestFile, entry.resultFile]) {
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

export function liveEntriesForBead(registry: DispatchRegistry, beadId: string, role?: string): DispatchRegistryEntry[] {
	return registry.entries.filter((entry) => entry.beadId === beadId && entry.status === "spawned" && (role ? entry.role === role : true));
}

/** All live (spawned) registry rows for a bead across every ns dispatch-registry. */
export function findLiveRegistryEntriesForBead(
	beadId: string,
	env: NodeJS.ProcessEnv = process.env,
): Array<{ file: string; registry: DispatchRegistry; entry: DispatchRegistryEntry; index: number }> {
	const matches: Array<{ file: string; registry: DispatchRegistry; entry: DispatchRegistryEntry; index: number }> = [];
	const root = path.join(orchRoot(env), "ns");
	if (!fs.existsSync(root)) return matches;
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name, "dispatch-registry.json");
		if (!fs.existsSync(file)) continue;
		const registry = loadRegistry(file);
		registry.entries.forEach((entry, index) => {
			if (entry.beadId === beadId && entry.status === "spawned") {
				matches.push({ file, registry, entry, index });
			}
		});
	}
	return matches;
}

/** Mark a registry row tombstone in place and persist. */
export function tombstoneRegistryEntry(
	file: string,
	registry: DispatchRegistry,
	index: number,
): DispatchRegistryEntry {
	const entry = registry.entries[index];
	if (!entry) throw new Error(`tombstoneRegistryEntry: no entry at index ${index}`);
	const next: DispatchRegistryEntry = { ...entry, status: "tombstone", hung: false };
	registry.entries[index] = next;
	saveRegistry(file, registry);
	return next;
}

function isSupervisorRole(role: string): boolean {
	return role.includes("supervisor");
}

export function findLiveFollowupEntry(
	beadId: string,
	role?: string,
	env: NodeJS.ProcessEnv = process.env,
): { file: string; registry: DispatchRegistry; entry: DispatchRegistryEntry; index: number } {
	const matches: Array<{ file: string; registry: DispatchRegistry; entry: DispatchRegistryEntry; index: number }> = [];
	const root = path.join(orchRoot(env), "ns");
	if (fs.existsSync(root)) {
		for (const name of fs.readdirSync(root)) {
			const file = path.join(root, name, "dispatch-registry.json");
			if (!fs.existsSync(file)) continue;
			const registry = loadRegistry(file);
			registry.entries.forEach((entry, index) => {
				if (entry.beadId === beadId && entry.status === "spawned") matches.push({ file, registry, entry, index });
			});
		}
	}
	const selected = role ? matches.filter((item) => item.entry.role === role) : matches.filter((item) => isSupervisorRole(item.entry.role));
	const firstSpawnHint = role === "code-reviewer" ? "dispatch_reviewer" : "dispatch_supervisor";
	if (selected.length === 0) throw new Error(`нет live pane; first spawn через ${firstSpawnHint}`);
	if (!role && selected.length > 1) throw new Error("followup_visible_dispatch: неоднозначный role, укажите role: BLOCKED");
	if (role && selected.length > 1) throw new Error(`followup_visible_dispatch: несколько live pane для ${beadId} role=${role}: BLOCKED`);
	const found = selected[0];
	if (!found) throw new Error(`нет live pane; first spawn через ${firstSpawnHint}`);
	return found;
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
