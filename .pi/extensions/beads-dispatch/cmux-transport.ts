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

function realpathOrResolved(targetPath: string): string {
	try {
		return fs.realpathSync(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}

/**
 * Live (spawned, non-hung) supervisor registry rows whose recorded worktree
 * resolves to the same realpath as the given repo root. Used by beads-policy to
 * recognize spawned supervisor child contexts that have no local workflow-state.
 * Fail-closed: a corrupt/unreadable foreign ns file is skipped per file, a
 * missing ns root yields no matches, and nothing here throws.
 */
export function findLiveSupervisorSpawnsForWorktree(
	worktreePath: string,
	env: NodeJS.ProcessEnv = process.env,
): DispatchRegistryEntry[] {
	if (!worktreePath?.trim()) return [];
	const target = realpathOrResolved(worktreePath);
	const root = path.join(orchRoot(env), "ns");
	let names: string[] = [];
	try {
		if (!fs.existsSync(root)) return [];
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const matches: DispatchRegistryEntry[] = [];
	for (const name of names) {
		const file = path.join(root, name, "dispatch-registry.json");
		let registry: DispatchRegistry;
		try {
			registry = loadRegistry(file);
		} catch {
			continue;
		}
		for (const entry of registry.entries) {
			if (entry.status !== "spawned") continue;
			if (entry.hung === true) continue;
			if (!isSupervisorRole(entry.role)) continue;
			if (!entry.worktree?.trim()) continue;
			if (realpathOrResolved(entry.worktree) !== target) continue;
			matches.push(entry);
		}
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

/** Sidebar row colors for parallel task workspaces (rotate; never reuse parent). */
export const TASK_WORKSPACE_COLOR_PALETTE = ["Indigo", "Teal", "Orange", "Purple", "Green", "Amber"] as const;

export type TaskWorkspaceColor = (typeof TASK_WORKSPACE_COLOR_PALETTE)[number];

/** Known named-color → hex map for parent exclusion when cmux returns custom_color hex. */
export const TASK_WORKSPACE_COLOR_HEX: Record<TaskWorkspaceColor, string> = {
	Indigo: "#283593",
	Teal: "#00796B",
	Orange: "#EF6C00",
	Purple: "#7B1FA2",
	Green: "#2E7D32",
	Amber: "#FF8F00",
};

/** SPAWN_LOCK comment marker on the target bead. */
export const SPAWN_LOCK_MARKER = "SPAWN_LOCK";

/** Default stale window for pending SPAWN_LOCK before another spawn may clear it. */
export const SPAWN_LOCK_STALE_MS = 10 * 60 * 1000;

export interface SpawnLockInfo {
	beadId: string;
	createdAt?: string;
	parentWorkspace?: string;
	status?: string;
	raw: string;
}

/** Count whitespace-separated words in a title (Unicode-aware). */
export function countTitleWords(title: string): number {
	return (title ?? "")
		.trim()
		.split(/\s+/u)
		.filter(Boolean).length;
}

/** Title must be exactly 2–3 words of essence (no bead id / suffix). */
export function validateTaskWorkspaceTitle(title: string): string | undefined {
	const trimmed = (title ?? "").trim();
	if (!trimmed) return "title обязателен: ровно 2–3 слова сути без suffix и без bead id";
	if (/·/.test(trimmed)) {
		return "title не должен содержать · suffix — tool добавит его сам";
	}
	const words = countTitleWords(trimmed);
	if (words < 2 || words > 3) {
		return `title должен быть ровно 2–3 слова (получено ${words}): «${trimmed}»`;
	}
	return undefined;
}

/** Workspace display name: `{title} · {suffix}`. */
export function buildTaskWorkspaceName(title: string, beadId: string): string {
	const suffix = beadSuffixFromId(beadId);
	const base = (title ?? "").trim();
	if (!suffix) return base;
	if (base.endsWith(` · ${suffix}`) || base.endsWith(`· ${suffix}`)) return base;
	return `${base} · ${suffix}`;
}

/** Child Pi start command: ASCII flags only; Russian text only as the message argument. Never `pi --name`. */
export function buildTaskWorkspaceChildCommand(beadId: string, message?: string): string {
	const id = (beadId ?? "").trim();
	const prompt =
		(message ?? "").trim() ||
		`Возьми ${id}. Это параллельная Pi-сессия в отдельном cmux workspace: сделай claim-bead сам, создай канонический worktree, не трогай bead родителя.`;
	return `pi --approve -- ${posixQuote(prompt)}`;
}

export interface NewWorkspaceArgvInput {
	name: string;
	cwd: string;
	command: string;
	description?: string;
	focus?: boolean;
	groupId?: string;
	groupPlacement?: "afterCurrent" | "top" | "end";
	groupReference?: string;
}

/** Exact argv for `cmux new-workspace` / `cmux workspace create`. */
export function buildNewWorkspaceArgv(input: NewWorkspaceArgvInput): string[] {
	const args = ["new-workspace", "--focus", input.focus === true ? "true" : "false"];
	if (input.name) args.push("--name", input.name);
	if (input.description) args.push("--description", input.description);
	if (input.cwd) args.push("--cwd", input.cwd);
	if (input.command) args.push("--command", input.command);
	const groupId = (input.groupId ?? "").trim();
	if (groupId) {
		args.push("--group", groupId);
		args.push("--group-placement", input.groupPlacement ?? "afterCurrent");
		const ref = (input.groupReference ?? "").trim();
		if (ref) args.push("--group-reference", ref);
	}
	return args;
}

export function buildReorderWorkspaceArgv(workspace: string, afterWorkspace: string): string[] {
	return ["reorder-workspace", "--workspace", workspace, "--after", afterWorkspace];
}

export function buildSetWorkspaceColorArgv(workspace: string, color: string): string[] {
	return ["workspace-action", "--workspace", workspace, "--action", "set-color", "--color", color];
}

export function buildCloseWorkspaceArgv(workspace: string): string[] {
	return ["close-workspace", "--workspace", workspace];
}

export function buildListPaneSurfacesArgv(workspace: string): string[] {
	return ["list-pane-surfaces", "--workspace", workspace, "--json"];
}

export function buildListWorkspacesArgv(): string[] {
	return ["workspace", "list", "--json"];
}

/** Normalize color token (name or #hex) for comparison. */
export function normalizeColorToken(color: string | null | undefined): string {
	const raw = (color ?? "").trim();
	if (!raw) return "";
	if (raw.startsWith("#")) return raw.toUpperCase();
	const named = TASK_WORKSPACE_COLOR_PALETTE.find((c) => c.toLowerCase() === raw.toLowerCase());
	if (named) return named;
	return raw;
}

function colorTokenEquals(a: string, b: string): boolean {
	const left = normalizeColorToken(a);
	const right = normalizeColorToken(b);
	if (!left || !right) return false;
	if (left === right) return true;
	const leftHex = left.startsWith("#")
		? left
		: TASK_WORKSPACE_COLOR_HEX[left as TaskWorkspaceColor]?.toUpperCase();
	const rightHex = right.startsWith("#")
		? right
		: TASK_WORKSPACE_COLOR_HEX[right as TaskWorkspaceColor]?.toUpperCase();
	return Boolean(leftHex && rightHex && leftHex === rightHex);
}

/**
 * Pick sidebar row color: explicit wins; otherwise rotate palette skipping parent color.
 * Sibling colors are preferred-avoided but not hard-required when palette exhausted.
 */
export function pickTaskWorkspaceColor(input: {
	explicit?: string;
	parentColor?: string | null;
	siblingColors?: Array<string | null | undefined>;
}): string {
	const explicit = (input.explicit ?? "").trim();
	if (explicit) return explicit;
	const parent = input.parentColor ?? null;
	const siblings = (input.siblingColors ?? []).map((c) => normalizeColorToken(c ?? "")).filter(Boolean);
	const freeOfParent = TASK_WORKSPACE_COLOR_PALETTE.filter((c) => !colorTokenEquals(c, parent ?? ""));
	const pool = freeOfParent.length > 0 ? freeOfParent : [...TASK_WORKSPACE_COLOR_PALETTE];
	const freeOfSiblings = pool.filter((c) => !siblings.some((s) => colorTokenEquals(c, s)));
	if (freeOfSiblings.length > 0) return freeOfSiblings[0]!;
	return pool[0]!;
}

/** Main checkout path from absolute git-common-dir (not a linked worktree path). */
export function mainCheckoutFromGitCommonDir(commonDir: string): string {
	const normalized = path.resolve((commonDir ?? "").replace(/\/$/, ""));
	if (!normalized) return "";
	if (path.basename(normalized) === ".git") return path.dirname(normalized);
	// Bare or nonstandard common dir: treat as the checkout itself.
	return normalized;
}

/** Parse `OK workspace:N` / JSON ref from new-workspace stdout. */
export function parseNewWorkspaceRef(stdout: string): string | undefined {
	const text = stdout ?? "";
	const okMatch = text.match(/\bworkspace:\d+\b/);
	if (okMatch?.[0]) return okMatch[0];
	try {
		const parsed = JSON.parse(text) as { ref?: string; workspace_ref?: string; workspace?: string };
		const ref = parsed.ref || parsed.workspace_ref || parsed.workspace;
		if (typeof ref === "string" && ref.trim()) return ref.trim();
	} catch {
		/* plain text */
	}
	return undefined;
}

/** First terminal surface ref inside a list-pane-surfaces JSON payload. */
export function parseFirstTerminalSurfaceRef(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout || "{}") as {
			surfaces?: Array<{ ref?: string; type?: string; selected?: boolean }>;
		};
		const surfaces = Array.isArray(parsed.surfaces) ? parsed.surfaces : [];
		const selected = surfaces.find((s) => s.selected && s.ref);
		if (selected?.ref) return String(selected.ref).trim();
		const terminal = surfaces.find((s) => s.ref && (!s.type || s.type === "terminal"));
		if (terminal?.ref) return String(terminal.ref).trim();
		const any = surfaces.find((s) => s.ref);
		return any?.ref ? String(any.ref).trim() : undefined;
	} catch {
		const match = `${stdout || ""}`.match(/surface:\S+/);
		return match?.[0];
	}
}

/**
 * Extract optional group id from a workspace list JSON row.
 * Only returns a value when a group-related field is present — never invents groups.
 */
export function extractWorkspaceGroupId(workspace: Record<string, unknown> | null | undefined): string | undefined {
	if (!workspace || typeof workspace !== "object") return undefined;
	const keys = ["group_id", "groupId", "group_ref", "groupRef", "group"];
	for (const key of keys) {
		const value = workspace[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			for (const nested of ["ref", "id", "group_ref", "group_id"]) {
				const nestedValue = obj[nested];
				if (typeof nestedValue === "string" && nestedValue.trim()) return nestedValue.trim();
			}
		}
	}
	return undefined;
}

export function findWorkspaceRow(
	listStdout: string,
	workspaceRef: string,
): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(listStdout || "{}") as { workspaces?: Array<Record<string, unknown>> };
		const rows = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
		return rows.find((row) => String(row.ref || row.workspace_ref || "") === workspaceRef);
	} catch {
		return undefined;
	}
}

export function buildSpawnLockComment(input: {
	beadId: string;
	parentWorkspace: string;
	parentBead?: string;
	createdAt?: string;
	status?: string;
}): string {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const status = input.status ?? "pending";
	const lines = [
		`${SPAWN_LOCK_MARKER} ${input.beadId}`,
		`createdAt: ${createdAt}`,
		`parentWorkspace: ${input.parentWorkspace}`,
		`status: ${status}`,
	];
	if (input.parentBead) lines.push(`parentBead: ${input.parentBead}`);
	return lines.join("\n");
}

export function parseSpawnLockComment(text: string): SpawnLockInfo | undefined {
	const raw = text ?? "";
	if (!raw.includes(SPAWN_LOCK_MARKER)) return undefined;
	const beadMatch = raw.match(new RegExp(`${SPAWN_LOCK_MARKER}\\s+(\\S+)`));
	const beadId = beadMatch?.[1]?.trim() ?? "";
	if (!beadId) return undefined;
	const createdAt = raw.match(/createdAt:\s*(\S+)/u)?.[1];
	const parentWorkspace = raw.match(/parentWorkspace:\s*(\S+)/u)?.[1];
	const status = raw.match(/status:\s*(\S+)/u)?.[1];
	return { beadId, createdAt, parentWorkspace, status, raw };
}

/** True when a non-stale SPAWN_LOCK still occupies the target. */
export function isSpawnLockBlocking(
	comments: Array<{ text?: string; created_at?: string }>,
	beadId: string,
	nowMs: number = Date.now(),
	staleMs: number = SPAWN_LOCK_STALE_MS,
): { blocked: boolean; lock?: SpawnLockInfo; stale?: boolean } {
	const locks = comments
		.map((c) => parseSpawnLockComment(c.text ?? ""))
		.filter((lock): lock is SpawnLockInfo => Boolean(lock && lock.beadId === beadId));
	if (locks.length === 0) return { blocked: false };
	const latest = locks[locks.length - 1]!;
	if (latest.status === "released" || latest.status === "failed") return { blocked: false, lock: latest };
	if (latest.status === "spawned") {
		// Live spawn lock: block until child claim moves bead off open (tool preflight also checks status).
		return { blocked: true, lock: latest };
	}
	const createdMs = latest.createdAt ? Date.parse(latest.createdAt) : Number.NaN;
	const age = Number.isFinite(createdMs) ? nowMs - createdMs : 0;
	if (age > staleMs) return { blocked: false, lock: latest, stale: true };
	return { blocked: true, lock: latest };
}

export function buildSpawnLockReleaseComment(beadId: string, reason: string): string {
	return `${SPAWN_LOCK_MARKER} ${beadId}\nstatus: released\nreason: ${reason}\nreleasedAt: ${new Date().toISOString()}`;
}

export function buildSpawnLockSpawnedComment(beadId: string, workspaceRef: string, surface?: string): string {
	const lines = [
		`${SPAWN_LOCK_MARKER} ${beadId}`,
		`status: spawned`,
		`workspace: ${workspaceRef}`,
		`spawnedAt: ${new Date().toISOString()}`,
	];
	if (surface) lines.push(`surface: ${surface}`);
	return lines.join("\n");
}
