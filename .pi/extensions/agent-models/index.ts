/**
 * Project-local per-agent model + thinking routing.
 *
 * Model resolve: roles[agent].model → classes[agentClasses[agent]] → session inherit (no --model).
 * Thinking resolve: roles[agent].thinking → classThinking[agentClasses[agent]] → inherit (no --thinking).
 * Explicit thinking "off" passes `--thinking off` (not the same as inherit).
 * Config lives only under project `.pi/agent-models.json` (never ~/.pi).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AGENT_MODELS_FILENAME = "agent-models.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleOverride {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface AgentModelsConfig {
	classes: Record<string, string>;
	/** Optional per-class thinking; independent of classes model map. */
	classThinking?: Record<string, ThinkingLevel>;
	/** Optional per-role override. String form is model-only legacy. */
	roles: Record<string, RoleOverride | string>;
	/** Role name → power class (strong/standard/cheap/…). */
	agentClasses: Record<string, string>;
}

export type ResolveSource = "role" | "class" | "inherit";

export interface ResolveAgentModelResult {
	/** Concrete model id when set; undefined means inherit session model (omit --model). */
	model?: string;
	/** Concrete thinking when set; undefined means inherit (omit --thinking). Explicit "off" is set. */
	thinking?: ThinkingLevel;
	source: ResolveSource;
	/** Source of the thinking field independently of model source. */
	thinkingSource: ResolveSource;
	className?: string;
	/** Human-readable note for show/dry-run. */
	note?: string;
}

export interface AgentModelsLoadResult {
	config: AgentModelsConfig;
	path: string | null;
	/** true when file missing or unreadable — spawn should inherit, not fail. */
	missing: boolean;
	/** Parse/shape error message when present; spawn still inherits. */
	error?: string;
}

export const CLASS_LABELS: Record<string, string> = {
	strong: "Сильная",
	standard: "Обычная",
	cheap: "Дешёвая",
};

const EMPTY_CONFIG: AgentModelsConfig = {
	classes: {},
	classThinking: {},
	roles: {},
	agentClasses: {},
};

export function defaultAgentModelsConfig(): AgentModelsConfig {
	return {
		classes: {
			strong: "xai/grok-4.5",
			standard: "xai/grok-4.5",
			cheap: "xai/grok-4.5",
		},
		classThinking: {},
		roles: {},
		agentClasses: {
			"code-reviewer": "strong",
			architect: "strong",
			"vue-supervisor": "standard",
			"tauri-supervisor": "standard",
			"test-supervisor": "standard",
			detective: "standard",
			"documentation-expert": "cheap",
			"plan-edge-reviewer": "cheap",
			"plan-consistency-reviewer": "cheap",
			"plan-dead-zone-reviewer": "cheap",
		},
	};
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from cwd looking for a directory that contains `.pi/`. */
export function findProjectPiRoot(cwd: string): string | null {
	let currentDir = path.resolve(cwd || process.cwd());
	while (true) {
		const piDir = path.join(currentDir, ".pi");
		if (isDirectory(piDir)) return currentDir;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function agentModelsFilePath(projectRoot: string): string {
	return path.join(projectRoot, ".pi", AGENT_MODELS_FILENAME);
}

export function projectAgentsDir(projectRoot: string): string {
	return path.join(projectRoot, ".pi", "agents");
}

function normalizeModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? (trimmed as ThinkingLevel) : undefined;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function roleEntry(roles: AgentModelsConfig["roles"], agentName: string): RoleOverride | undefined {
	const entry = roles[agentName];
	if (entry == null) return undefined;
	if (typeof entry === "string") {
		const model = normalizeModelId(entry);
		return model ? { model } : undefined;
	}
	const model = normalizeModelId(entry.model);
	const thinking = normalizeThinkingLevel(entry.thinking);
	if (!model && !thinking) return undefined;
	const out: RoleOverride = {};
	if (model) out.model = model;
	if (thinking) out.thinking = thinking;
	return out;
}

function roleModelOverride(roles: AgentModelsConfig["roles"], agentName: string): string | undefined {
	return roleEntry(roles, agentName)?.model;
}

function roleThinkingOverride(roles: AgentModelsConfig["roles"], agentName: string): ThinkingLevel | undefined {
	return roleEntry(roles, agentName)?.thinking;
}

/** Normalize raw JSON into config. Invalid thinking values are omitted; thinking-only roles kept. */
export function normalizeConfig(raw: unknown): { config: AgentModelsConfig; error?: string } {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config: { ...EMPTY_CONFIG, classThinking: {}, roles: {}, classes: {}, agentClasses: {} }, error: "agent-models.json must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;
	const classes: Record<string, string> = {};
	if (obj.classes != null) {
		if (typeof obj.classes !== "object" || Array.isArray(obj.classes)) {
			return { config: { ...EMPTY_CONFIG, classThinking: {}, roles: {}, classes: {}, agentClasses: {} }, error: "classes must be an object of class→modelId" };
		}
		for (const [name, value] of Object.entries(obj.classes as Record<string, unknown>)) {
			const model = normalizeModelId(value);
			if (model) classes[name] = model;
		}
	}
	const classThinking: Record<string, ThinkingLevel> = {};
	if (obj.classThinking != null) {
		if (typeof obj.classThinking !== "object" || Array.isArray(obj.classThinking)) {
			return { config: { ...EMPTY_CONFIG, classThinking: {}, roles: {}, classes: {}, agentClasses: {} }, error: "classThinking must be an object of class→thinking level" };
		}
		for (const [name, value] of Object.entries(obj.classThinking as Record<string, unknown>)) {
			const level = normalizeThinkingLevel(value);
			if (level) classThinking[name] = level;
		}
	}
	const agentClasses: Record<string, string> = {};
	if (obj.agentClasses != null) {
		if (typeof obj.agentClasses !== "object" || Array.isArray(obj.agentClasses)) {
			return { config: { ...EMPTY_CONFIG, classThinking: {}, roles: {}, classes: {}, agentClasses: {} }, error: "agentClasses must be an object of agent→class" };
		}
		for (const [name, value] of Object.entries(obj.agentClasses as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) agentClasses[name] = value.trim();
		}
	}
	const roles: AgentModelsConfig["roles"] = {};
	if (obj.roles != null) {
		if (typeof obj.roles !== "object" || Array.isArray(obj.roles)) {
			return { config: { ...EMPTY_CONFIG, classThinking: {}, roles: {}, classes: {}, agentClasses: {} }, error: "roles must be an object of agent→{model,thinking} or agent→modelId" };
		}
		for (const [name, value] of Object.entries(obj.roles as Record<string, unknown>)) {
			if (typeof value === "string") {
				const model = normalizeModelId(value);
				if (model) roles[name] = { model };
				continue;
			}
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const model = normalizeModelId((value as { model?: unknown }).model);
				const thinking = normalizeThinkingLevel((value as { thinking?: unknown }).thinking);
				if (model || thinking) {
					const entry: RoleOverride = {};
					if (model) entry.model = model;
					if (thinking) entry.thinking = thinking;
					roles[name] = entry;
				}
			}
		}
	}
	return { config: { classes, classThinking, roles, agentClasses } };
}

function cloneConfig(config: AgentModelsConfig): AgentModelsConfig {
	return {
		classes: { ...config.classes },
		classThinking: { ...(config.classThinking ?? {}) },
		roles: { ...config.roles },
		agentClasses: { ...config.agentClasses },
	};
}

/** Load project agent-models.json. Missing/invalid never throws — spawn inherits. */
export function loadAgentModels(cwd: string): AgentModelsLoadResult {
	const projectRoot = findProjectPiRoot(cwd);
	if (!projectRoot) {
		return { config: cloneConfig(EMPTY_CONFIG), path: null, missing: true, error: "no project .pi/ directory found from cwd" };
	}
	const filePath = agentModelsFilePath(projectRoot);
	if (!fs.existsSync(filePath)) {
		return { config: cloneConfig(EMPTY_CONFIG), path: filePath, missing: true };
	}
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		return {
			config: cloneConfig(EMPTY_CONFIG),
			path: filePath,
			missing: true,
			error: `cannot read ${filePath}: ${(error as Error).message}`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: cloneConfig(EMPTY_CONFIG),
			path: filePath,
			missing: false,
			error: `invalid JSON in ${filePath}: ${(error as Error).message}`,
		};
	}
	const normalized = normalizeConfig(raw);
	return {
		config: normalized.config,
		path: filePath,
		missing: false,
		error: normalized.error,
	};
}

/**
 * Resolve model + thinking for an agent role.
 * Model and thinking resolve independently (role → class → inherit).
 */
export function resolveAgentModel(agentName: string, config: AgentModelsConfig): ResolveAgentModelResult {
	const name = (agentName ?? "").trim();
	if (!name) {
		return { source: "inherit", thinkingSource: "inherit", note: "empty agent name" };
	}

	const className = config.agentClasses[name];
	const classThinkingMap = config.classThinking ?? {};

	let model: string | undefined;
	let source: ResolveSource = "inherit";
	let note: string | undefined;

	const roleModel = roleModelOverride(config.roles, name);
	if (roleModel) {
		model = roleModel;
		source = "role";
	} else if (className) {
		const classModel = normalizeModelId(config.classes[className]);
		if (classModel) {
			model = classModel;
			source = "class";
		} else {
			note = className in config.classes
				? `class "${className}" has empty model id`
				: `unknown class "${className}" for agent "${name}"`;
		}
	} else {
		note = `no agentClasses entry for "${name}"`;
	}

	let thinking: ThinkingLevel | undefined;
	let thinkingSource: ResolveSource = "inherit";
	const roleThinking = roleThinkingOverride(config.roles, name);
	if (roleThinking) {
		thinking = roleThinking;
		thinkingSource = "role";
	} else if (className) {
		const classThinking = normalizeThinkingLevel(classThinkingMap[className]);
		if (classThinking) {
			thinking = classThinking;
			thinkingSource = "class";
		}
	}

	return {
		model,
		thinking,
		source,
		thinkingSource,
		className: className || undefined,
		note,
	};
}

/** Resolve using project file under cwd (or nearest project .pi). */
export function resolveAgentModelFromCwd(cwd: string, agentName: string): ResolveAgentModelResult & { configPath: string | null; loadError?: string } {
	const loaded = loadAgentModels(cwd);
	const resolved = resolveAgentModel(agentName, loaded.config);
	return {
		...resolved,
		configPath: loaded.path,
		loadError: loaded.error,
	};
}

/** Append `--model <id>` when resolved; leave argv unchanged on inherit. */
export function appendModelArg(args: string[], model?: string): string[] {
	const id = normalizeModelId(model);
	if (!id) return args;
	return [...args, "--model", id];
}

/** Push `--model` into an existing argv builder list (mutates). */
export function pushModelArg(args: string[], model?: string): void {
	const id = normalizeModelId(model);
	if (id) args.push("--model", id);
}

/**
 * Append `--thinking <level>` when set (including explicit "off").
 * Inherit (undefined) omits the flag.
 */
export function appendThinkingArg(args: string[], thinking?: string): string[] {
	const level = normalizeThinkingLevel(thinking);
	if (!level) return args;
	return [...args, "--thinking", level];
}

/** Push `--thinking` into an existing argv builder list (mutates). Explicit off is passed. */
export function pushThinkingArg(args: string[], thinking?: string): void {
	const level = normalizeThinkingLevel(thinking);
	if (level) args.push("--thinking", level);
}

export function saveAgentModels(projectRoot: string, config: AgentModelsConfig): string {
	const piDir = path.join(projectRoot, ".pi");
	if (!isDirectory(piDir)) {
		throw new Error(`project .pi/ directory missing at ${piDir}; refusing to write agent-models outside a project`);
	}
	const filePath = agentModelsFilePath(projectRoot);
	const classThinking = { ...(config.classThinking ?? {}) };
	const rolesOut: Record<string, RoleOverride> = {};
	for (const [name, value] of Object.entries(config.roles)) {
		const entry = typeof value === "string"
			? (normalizeModelId(value) ? { model: normalizeModelId(value)! } : undefined)
			: roleEntry({ [name]: value }, name);
		if (entry) rolesOut[name] = entry;
	}
	const payload: Record<string, unknown> = {
		classes: { ...config.classes },
		roles: rolesOut,
		agentClasses: { ...config.agentClasses },
	};
	if (Object.keys(classThinking).length > 0) {
		payload.classThinking = classThinking;
	}
	fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return filePath;
}

/**
 * List project agent stems from `.pi/agents/*.md` (skip README.md).
 * No auto-write of agentClasses.
 */
export function listProjectAgents(projectRoot: string): string[] {
	const dir = projectAgentsDir(projectRoot);
	if (!isDirectory(dir)) return [];
	const names: string[] = [];
	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const stem = entry.slice(0, -3);
		if (!stem || stem.toLowerCase() === "readme") continue;
		const full = path.join(dir, entry);
		try {
			if (!fs.statSync(full).isFile()) continue;
		} catch {
			continue;
		}
		names.push(stem);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

/** Union of scanned agents + agentClasses keys + roles keys (for show/menu). */
export function listKnownAgents(projectRoot: string, config: AgentModelsConfig): string[] {
	const set = new Set<string>([
		...listProjectAgents(projectRoot),
		...Object.keys(config.agentClasses),
		...Object.keys(config.roles),
	]);
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Stale JSON keys not present as `.pi/agents/<name>.md`. */
export function listStaleAgentKeys(projectRoot: string, config: AgentModelsConfig): string[] {
	const scanned = new Set(listProjectAgents(projectRoot));
	const keys = new Set([...Object.keys(config.agentClasses), ...Object.keys(config.roles)]);
	return Array.from(keys).filter((name) => !scanned.has(name)).sort((a, b) => a.localeCompare(b));
}

export function classDisplayLabel(className: string): string {
	return CLASS_LABELS[className] ?? className;
}

export function formatResolvedTable(config: AgentModelsConfig, agentNames?: string[], projectRoot?: string): string {
	const names = agentNames && agentNames.length > 0
		? agentNames
		: projectRoot
			? listKnownAgents(projectRoot, config)
			: Array.from(new Set([...Object.keys(config.agentClasses), ...Object.keys(config.roles)])).sort();
	const lines = ["agent | class | model source | model | thinking source | thinking"];
	lines.push("---+---|---|---|---|---");
	for (const name of names) {
		const resolved = resolveAgentModel(name, config);
		const className = resolved.className ?? config.agentClasses[name] ?? "—";
		const model = resolved.model ?? "(session inherit)";
		const thinking = resolved.thinking ?? "(session inherit)";
		lines.push(`${name} | ${className} | ${resolved.source} | ${model} | ${resolved.thinkingSource} | ${thinking}`);
	}
	return lines.join("\n");
}

export function formatAgentModelsShow(loaded: AgentModelsLoadResult, cwd: string): string {
	const projectRoot = findProjectPiRoot(cwd);
	const lines: string[] = [];
	lines.push(`cwd: ${path.resolve(cwd)}`);
	lines.push(`file: ${loaded.path ?? "(none)"}`);
	if (loaded.missing) lines.push("status: missing (spawn inherits session model/thinking)");
	else if (loaded.error) lines.push(`status: error — ${loaded.error} (spawn inherits)`);
	else lines.push("status: loaded");
	lines.push("");
	lines.push("classes:");
	const classNames = Object.keys(loaded.config.classes).sort();
	if (classNames.length === 0) lines.push("  (none)");
	else {
		for (const name of classNames) {
			const label = classDisplayLabel(name);
			const thinking = loaded.config.classThinking?.[name];
			const thinkingPart = thinking ? `, thinking=${thinking}` : "";
			lines.push(`  ${name} (${label}): ${loaded.config.classes[name]}${thinkingPart}`);
		}
	}
	const orphanThinking = Object.keys(loaded.config.classThinking ?? {})
		.filter((name) => !(name in loaded.config.classes))
		.sort();
	if (orphanThinking.length > 0) {
		lines.push("classThinking (no model class yet):");
		for (const name of orphanThinking) {
			lines.push(`  ${name}: ${loaded.config.classThinking![name]}`);
		}
	}
	lines.push("");
	lines.push("agentClasses:");
	const agents = Object.keys(loaded.config.agentClasses).sort();
	if (agents.length === 0) lines.push("  (none)");
	else for (const name of agents) lines.push(`  ${name}: ${loaded.config.agentClasses[name]}`);
	lines.push("");
	lines.push("role overrides:");
	const roleNames = Object.keys(loaded.config.roles).sort();
	if (roleNames.length === 0) lines.push("  (none)");
	else {
		for (const name of roleNames) {
			const entry = roleEntry(loaded.config.roles, name);
			const parts: string[] = [];
			if (entry?.model) parts.push(`model=${entry.model}`);
			if (entry?.thinking) parts.push(`thinking=${entry.thinking}`);
			lines.push(`  ${name}: ${parts.join(", ") || "(empty)"}`);
		}
	}
	if (projectRoot) {
		const scanned = listProjectAgents(projectRoot);
		const unmapped = scanned.filter((name) => !loaded.config.agentClasses[name] && !loaded.config.roles[name]);
		lines.push("");
		lines.push("project agents (.pi/agents):");
		if (scanned.length === 0) lines.push("  (none)");
		else {
			for (const name of scanned) {
				const mapped = loaded.config.agentClasses[name] ? `class=${loaded.config.agentClasses[name]}` : "unmapped → inherit";
				lines.push(`  ${name}: ${mapped}`);
			}
		}
		if (unmapped.length > 0) {
			lines.push(`unmapped (inherit until assign): ${unmapped.join(", ")}`);
		}
		const stale = listStaleAgentKeys(projectRoot, loaded.config);
		if (stale.length > 0) {
			lines.push(`stale JSON keys (no .md): ${stale.join(", ")}`);
		}
	}
	lines.push("");
	lines.push("resolved:");
	lines.push(formatResolvedTable(loaded.config, undefined, projectRoot ?? undefined));
	return lines.join("\n");
}

type CommandUi = {
	notify?: (message: string, level?: string) => void;
	select?: (title: string, options: string[]) => Promise<string | undefined | null>;
	input?: (title: string, initial?: string) => Promise<string | undefined | null>;
	confirm?: (title: string, message: string) => Promise<boolean>;
};

export type AgentModelsCommandContext = {
	cwd?: string;
	hasUI?: boolean;
	ui?: CommandUi;
};

function notify(ctx: AgentModelsCommandContext | undefined, message: string, level: "info" | "error" | "warning" = "info"): void {
	ctx?.ui?.notify?.(message, level);
}

function requireProjectRoot(cwd: string): string {
	const root = findProjectPiRoot(cwd);
	if (!root) throw new Error("no project .pi/ found from cwd; /agent-models only writes project-local config");
	return root;
}

function loadOrDefaultForMutate(cwd: string): { projectRoot: string; config: AgentModelsConfig; path: string } {
	const projectRoot = requireProjectRoot(cwd);
	const loaded = loadAgentModels(projectRoot);
	if (loaded.error && !loaded.missing) {
		throw new Error(`cannot mutate broken agent-models.json: ${loaded.error}`);
	}
	const config = loaded.missing ? defaultAgentModelsConfig() : cloneConfig(loaded.config);
	if (loaded.missing && Object.keys(config.classes).length === 0) {
		Object.assign(config, defaultAgentModelsConfig());
	}
	// Ensure classThinking object always present for mutate helpers.
	config.classThinking = { ...(config.classThinking ?? {}) };
	return { projectRoot, config, path: agentModelsFilePath(projectRoot) };
}

function setRoleModel(config: AgentModelsConfig, agent: string, modelId: string): void {
	const existing = roleEntry(config.roles, agent) ?? {};
	const next: RoleOverride = { ...existing, model: modelId };
	config.roles[agent] = next;
}

function setRoleThinking(config: AgentModelsConfig, agent: string, thinking: ThinkingLevel): void {
	const existing = roleEntry(config.roles, agent) ?? {};
	const next: RoleOverride = { ...existing, thinking };
	config.roles[agent] = next;
}

function unsetRoleModel(config: AgentModelsConfig, agent: string): void {
	const existing = roleEntry(config.roles, agent);
	if (!existing) {
		delete config.roles[agent];
		return;
	}
	if (existing.thinking) {
		config.roles[agent] = { thinking: existing.thinking };
	} else {
		delete config.roles[agent];
	}
}

function unsetRoleThinking(config: AgentModelsConfig, agent: string): void {
	const existing = roleEntry(config.roles, agent);
	if (!existing) {
		delete config.roles[agent];
		return;
	}
	if (existing.model) {
		config.roles[agent] = { model: existing.model };
	} else {
		delete config.roles[agent];
	}
}

function knownClassNames(config: AgentModelsConfig): string[] {
	return Array.from(new Set([...Object.keys(config.classes), ...Object.keys(config.classThinking ?? {})])).sort();
}

function assertKnownClass(config: AgentModelsConfig, className: string): void {
	if (!(className in config.classes) && !(className in (config.classThinking ?? {}))) {
		// set class-thinking / set agent-class require the class to exist in classes map (mirror set agent-class).
		if (!(className in config.classes)) {
			throw new Error(`unknown class "${className}"; known: ${Object.keys(config.classes).sort().join(", ") || "(none)"}`);
		}
	}
}

function assertClassForAgentClass(config: AgentModelsConfig, className: string): void {
	if (!(className in config.classes)) {
		throw new Error(`unknown class "${className}"; known: ${Object.keys(config.classes).sort().join(", ") || "(none)"}`);
	}
}

function assertClassForThinking(config: AgentModelsConfig, className: string): void {
	// set class-thinking rejects unknown class (mirror set agent-class) — class must be in classes.
	if (!(className in config.classes)) {
		throw new Error(`unknown class "${className}"; known: ${Object.keys(config.classes).sort().join(", ") || "(none)"}`);
	}
}

export function handleAgentModelsCommand(args: string, cwd: string): { ok: boolean; text: string } {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const cmd = (tokens[0] ?? "show").toLowerCase();

	try {
		if (cmd === "show" || cmd === "") {
			const loaded = loadAgentModels(cwd);
			return { ok: true, text: formatAgentModelsShow(loaded, cwd) };
		}

		if (cmd === "set") {
			const what = (tokens[1] ?? "").toLowerCase();
			if (what === "class") {
				const name = tokens[2];
				const modelId = tokens[3];
				if (!name || !modelId) throw new Error("usage: agent-models set class <name> <modelId>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				config.classes[name] = modelId;
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set class ${name} → ${modelId}\nfile: ${filePath}` };
			}
			if (what === "class-thinking") {
				const name = tokens[2];
				const levelRaw = tokens[3];
				if (!name || !levelRaw) throw new Error("usage: agent-models set class-thinking <name> <off|minimal|low|medium|high|xhigh|max>");
				const level = normalizeThinkingLevel(levelRaw);
				if (!level) throw new Error(`invalid thinking level "${levelRaw}"; expected: ${THINKING_LEVELS.join("|")}`);
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				assertClassForThinking(config, name);
				config.classThinking = { ...(config.classThinking ?? {}), [name]: level };
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set class-thinking ${name} → ${level}\nfile: ${filePath}` };
			}
			if (what === "role") {
				const agent = tokens[2];
				const modelId = tokens[3];
				if (!agent || !modelId) throw new Error("usage: agent-models set role <agent> <modelId>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				setRoleModel(config, agent, modelId);
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set role ${agent} → ${modelId}\nfile: ${filePath}` };
			}
			if (what === "role-thinking") {
				const agent = tokens[2];
				const levelRaw = tokens[3];
				if (!agent || !levelRaw) throw new Error("usage: agent-models set role-thinking <agent> <off|minimal|low|medium|high|xhigh|max>");
				const level = normalizeThinkingLevel(levelRaw);
				if (!level) throw new Error(`invalid thinking level "${levelRaw}"; expected: ${THINKING_LEVELS.join("|")}`);
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				setRoleThinking(config, agent, level);
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set role-thinking ${agent} → ${level}\nfile: ${filePath}` };
			}
			if (what === "agent-class") {
				const agent = tokens[2];
				const className = tokens[3];
				if (!agent || !className) throw new Error("usage: agent-models set agent-class <agent> <class>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				assertClassForAgentClass(config, className);
				config.agentClasses[agent] = className;
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set agent-class ${agent} → ${className}\nfile: ${filePath}` };
			}
			throw new Error("usage: agent-models set class|class-thinking|role|role-thinking|agent-class …");
		}

		if (cmd === "unset") {
			const what = (tokens[1] ?? "").toLowerCase();
			if (what === "role") {
				const agent = tokens[2];
				if (!agent) throw new Error("usage: agent-models unset role <agent>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				unsetRoleModel(config, agent);
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset role model ${agent}\nfile: ${filePath}` };
			}
			if (what === "role-thinking") {
				const agent = tokens[2];
				if (!agent) throw new Error("usage: agent-models unset role-thinking <agent>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				unsetRoleThinking(config, agent);
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset role-thinking ${agent}\nfile: ${filePath}` };
			}
			if (what === "class-thinking") {
				const name = tokens[2];
				if (!name) throw new Error("usage: agent-models unset class-thinking <name>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				if (config.classThinking) delete config.classThinking[name];
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset class-thinking ${name}\nfile: ${filePath}` };
			}
			if (what === "agent-class") {
				const agent = tokens[2];
				if (!agent) throw new Error("usage: agent-models unset agent-class <agent>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				delete config.agentClasses[agent];
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset agent-class ${agent}\nfile: ${filePath}` };
			}
			throw new Error("usage: agent-models unset role|role-thinking|class-thinking|agent-class …");
		}

		throw new Error(
			[
				"usage:",
				"  agent-models show",
				"  agent-models set class <name> <modelId>",
				"  agent-models set class-thinking <name> <level>",
				"  agent-models set role <agent> <modelId>",
				"  agent-models set role-thinking <agent> <level>",
				"  agent-models set agent-class <agent> <class>",
				"  agent-models unset role <agent>",
				"  agent-models unset role-thinking <agent>",
				"  agent-models unset class-thinking <name>",
				"  agent-models unset agent-class <agent>",
				"  (empty args + UI → interactive menu)",
			].join("\n"),
		);
	} catch (error) {
		return { ok: false, text: (error as Error).message };
	}
}

/** Default model catalog shown in picker (plus «Другая…»). */
export function defaultModelCatalog(config: AgentModelsConfig): string[] {
	const set = new Set<string>();
	for (const id of Object.values(config.classes)) {
		const model = normalizeModelId(id);
		if (model) set.add(model);
	}
	for (const value of Object.values(config.roles)) {
		const entry = typeof value === "string" ? { model: value } : value;
		const model = normalizeModelId(entry?.model);
		if (model) set.add(model);
	}
	if (set.size === 0) {
		set.add("xai/grok-4.5");
	}
	return Array.from(set).sort();
}

export type MenuUi = {
	select: (title: string, options: string[]) => Promise<string | undefined | null>;
	input?: (title: string, initial?: string) => Promise<string | undefined | null>;
	notify?: (message: string, level?: string) => void;
};

export type MenuResult = { ok: boolean; text: string; cancelled?: boolean; wrote?: boolean };

const MENU_EXIT = "← Выход";
const MENU_BACK = "← Назад";
const INHERIT_THINKING_LABEL = "как у class/сессии (inherit, без --thinking)";
const OTHER_MODEL_LABEL = "Другая…";

function thinkingMenuOptions(includeInherit: boolean): string[] {
	const levels = THINKING_LEVELS.map((level) => level === "off" ? "off (явно --thinking off)" : level);
	return includeInherit ? [INHERIT_THINKING_LABEL, ...levels] : levels;
}

function parseThinkingChoice(choice: string | undefined | null): ThinkingLevel | "inherit" | null {
	if (choice == null) return null;
	if (choice === INHERIT_THINKING_LABEL || choice === MENU_BACK) return choice === MENU_BACK ? null : "inherit";
	if (choice.startsWith("off")) return "off";
	const level = normalizeThinkingLevel(choice);
	return level ?? null;
}

/**
 * Pure-ish interactive menu. Uses ui.select/input; cancel (null/undefined) → no write.
 * Testable with mocked ui.
 */
export async function runAgentModelsMenu(cwd: string, ui: MenuUi): Promise<MenuResult> {
	const projectRoot = requireProjectRoot(cwd);
	let wrote = false;

	const reload = () => {
		const loaded = loadAgentModels(projectRoot);
		const config = loaded.missing || loaded.error ? defaultAgentModelsConfig() : cloneConfig(loaded.config);
		config.classThinking = { ...(config.classThinking ?? {}) };
		return { loaded, config };
	};

	const save = (config: AgentModelsConfig): string => {
		const filePath = saveAgentModels(projectRoot, config);
		wrote = true;
		return filePath;
	};

	const topLoop = true;
	while (topLoop) {
		const { config } = reload();
		const main = await ui.select("agent-models — что настроить?", [
			"Показать текущие настройки",
			"Мощность class (model)",
			"Thinking class",
			"Назначить agent → class",
			"Override model агента",
			"Override thinking агента",
			"Сбросить override model агента",
			"Сбросить override thinking агента",
			"Сбросить class thinking",
			"Сбросить agent-class",
			"Убрать stale JSON keys",
			MENU_EXIT,
		]);
		if (main == null || main === MENU_EXIT) {
			return { ok: true, text: wrote ? "menu done (saved)" : "menu cancelled", cancelled: !wrote, wrote };
		}

		if (main === "Показать текущие настройки") {
			const loaded = loadAgentModels(cwd);
			const text = formatAgentModelsShow(loaded, cwd);
			ui.notify?.(text, "info");
			continue;
		}

		if (main === "Мощность class (model)") {
			const classes = Object.keys(config.classes).sort();
			if (classes.length === 0) {
				ui.notify?.("Нет classes в конфиге", "warning");
				continue;
			}
			const classChoice = await ui.select(
				"Class model",
				classes.map((name) => `${name} (${classDisplayLabel(name)}) — ${config.classes[name]}`),
			);
			if (classChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const className = classes.find((name) => classChoice.startsWith(`${name} `) || classChoice.startsWith(`${name}(`))
				?? classChoice.split(" ")[0];
			if (!className || !(className in config.classes)) continue;
			const models = [...defaultModelCatalog(config), OTHER_MODEL_LABEL];
			const modelChoice = await ui.select(`Model for ${className}`, models);
			if (modelChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			let modelId = modelChoice;
			if (modelChoice === OTHER_MODEL_LABEL) {
				const typed = await ui.input?.("Model id (provider/id)", config.classes[className]);
				if (typed == null || !typed.trim()) return { ok: true, text: "cancelled", cancelled: true, wrote };
				modelId = typed.trim();
			}
			config.classes[className] = modelId;
			const filePath = save(config);
			ui.notify?.(`set class ${className} → ${modelId}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Thinking class") {
			const classes = Object.keys(config.classes).sort();
			if (classes.length === 0) {
				ui.notify?.("Нет classes в конфиге", "warning");
				continue;
			}
			const classChoice = await ui.select(
				"Class thinking",
				classes.map((name) => {
					const current = config.classThinking?.[name] ?? "inherit";
					return `${name} (${classDisplayLabel(name)}) — thinking=${current}`;
				}),
			);
			if (classChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const className = classes.find((name) => classChoice.startsWith(`${name} `)) ?? classChoice.split(" ")[0];
			if (!className) continue;
			const levelChoice = await ui.select(`Thinking for class ${className}`, thinkingMenuOptions(true));
			const parsed = parseThinkingChoice(levelChoice);
			if (parsed == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			if (parsed === "inherit") {
				if (config.classThinking) delete config.classThinking[className];
				const filePath = save(config);
				ui.notify?.(`unset class-thinking ${className}\nfile: ${filePath}`, "info");
			} else {
				config.classThinking = { ...(config.classThinking ?? {}), [className]: parsed };
				const filePath = save(config);
				ui.notify?.(`set class-thinking ${className} → ${parsed}\nfile: ${filePath}`, "info");
			}
			continue;
		}

		if (main === "Назначить agent → class") {
			const agents = listKnownAgents(projectRoot, config);
			if (agents.length === 0) {
				ui.notify?.("Нет агентов (.pi/agents и JSON пусты)", "warning");
				continue;
			}
			const agentChoice = await ui.select(
				"Agent → class",
				agents.map((name) => {
					const mapped = config.agentClasses[name];
					const label = mapped ? `class=${mapped}` : "inherit (unmapped)";
					return `${name} — ${label}`;
				}),
			);
			if (agentChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const agent = agents.find((name) => agentChoice.startsWith(`${name} `) || agentChoice === name) ?? agentChoice.split(" ")[0];
			if (!agent) continue;
			const classes = Object.keys(config.classes).sort();
			const classChoice = await ui.select(
				`Class for ${agent}`,
				classes.map((name) => `${name} (${classDisplayLabel(name)})`),
			);
			if (classChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const className = classes.find((name) => classChoice.startsWith(name)) ?? classChoice.split(" ")[0];
			if (!className || !(className in config.classes)) continue;
			config.agentClasses[agent] = className;
			const filePath = save(config);
			ui.notify?.(`set agent-class ${agent} → ${className}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Override model агента") {
			const agents = listKnownAgents(projectRoot, config);
			const agentChoice = await ui.select("Agent model override", agents);
			if (agentChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const models = [...defaultModelCatalog(config), OTHER_MODEL_LABEL];
			const modelChoice = await ui.select(`Model for ${agentChoice}`, models);
			if (modelChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			let modelId = modelChoice;
			if (modelChoice === OTHER_MODEL_LABEL) {
				const typed = await ui.input?.("Model id (provider/id)", "");
				if (typed == null || !typed.trim()) return { ok: true, text: "cancelled", cancelled: true, wrote };
				modelId = typed.trim();
			}
			setRoleModel(config, agentChoice, modelId);
			const filePath = save(config);
			ui.notify?.(`set role ${agentChoice} → ${modelId}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Override thinking агента") {
			const agents = listKnownAgents(projectRoot, config);
			const agentChoice = await ui.select("Agent thinking override", agents);
			if (agentChoice == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const levelChoice = await ui.select(`Thinking for ${agentChoice}`, thinkingMenuOptions(true));
			const parsed = parseThinkingChoice(levelChoice);
			if (parsed == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			if (parsed === "inherit") {
				unsetRoleThinking(config, agentChoice);
				const filePath = save(config);
				ui.notify?.(`unset role-thinking ${agentChoice}\nfile: ${filePath}`, "info");
			} else {
				setRoleThinking(config, agentChoice, parsed);
				const filePath = save(config);
				ui.notify?.(`set role-thinking ${agentChoice} → ${parsed}\nfile: ${filePath}`, "info");
			}
			continue;
		}

		if (main === "Сбросить override model агента") {
			const roleAgents = Object.keys(config.roles).filter((name) => roleEntry(config.roles, name)?.model).sort();
			if (roleAgents.length === 0) {
				ui.notify?.("Нет role model overrides", "info");
				continue;
			}
			const agent = await ui.select("Unset role model", roleAgents);
			if (agent == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			unsetRoleModel(config, agent);
			const filePath = save(config);
			ui.notify?.(`unset role model ${agent}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Сбросить override thinking агента") {
			const roleAgents = Object.keys(config.roles).filter((name) => roleEntry(config.roles, name)?.thinking).sort();
			if (roleAgents.length === 0) {
				ui.notify?.("Нет role thinking overrides", "info");
				continue;
			}
			const agent = await ui.select("Unset role thinking", roleAgents);
			if (agent == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			unsetRoleThinking(config, agent);
			const filePath = save(config);
			ui.notify?.(`unset role-thinking ${agent}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Сбросить class thinking") {
			const names = Object.keys(config.classThinking ?? {}).sort();
			if (names.length === 0) {
				ui.notify?.("Нет classThinking", "info");
				continue;
			}
			const name = await ui.select("Unset class thinking", names);
			if (name == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			if (config.classThinking) delete config.classThinking[name];
			const filePath = save(config);
			ui.notify?.(`unset class-thinking ${name}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Сбросить agent-class") {
			const agents = Object.keys(config.agentClasses).sort();
			if (agents.length === 0) {
				ui.notify?.("Нет agentClasses", "info");
				continue;
			}
			const agent = await ui.select("Unset agent-class", agents);
			if (agent == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			delete config.agentClasses[agent];
			const filePath = save(config);
			ui.notify?.(`unset agent-class ${agent}\nfile: ${filePath}`, "info");
			continue;
		}

		if (main === "Убрать stale JSON keys") {
			const stale = listStaleAgentKeys(projectRoot, config);
			if (stale.length === 0) {
				ui.notify?.("Stale keys нет", "info");
				continue;
			}
			const agent = await ui.select("Remove stale key", [...stale, "Удалить все stale"]);
			if (agent == null) return { ok: true, text: "cancelled", cancelled: true, wrote };
			const targets = agent === "Удалить все stale" ? stale : [agent];
			for (const name of targets) {
				delete config.agentClasses[name];
				delete config.roles[name];
			}
			const filePath = save(config);
			ui.notify?.(`removed stale: ${targets.join(", ")}\nfile: ${filePath}`, "info");
			continue;
		}
	}

	return { ok: true, text: "menu done", wrote };
}

/**
 * Command entry used by extension + tests.
 * empty args + hasUI → menu; empty/show without UI → show text.
 */
export async function handleAgentModelsInvocation(
	args: string,
	ctx: AgentModelsCommandContext,
): Promise<{ ok: boolean; text: string }> {
	const cwd = ctx.cwd || process.cwd();
	const trimmed = (args ?? "").trim();
	if (!trimmed) {
		if (ctx.hasUI && ctx.ui?.select) {
			try {
				const result = await runAgentModelsMenu(cwd, {
					select: ctx.ui.select,
					input: ctx.ui.input,
					notify: ctx.ui.notify,
				});
				return { ok: result.ok, text: result.text };
			} catch (error) {
				return { ok: false, text: (error as Error).message };
			}
		}
		return handleAgentModelsCommand("show", cwd);
	}
	return handleAgentModelsCommand(trimmed, cwd);
}

type ExtensionAPI = {
	registerCommand(name: string, config: {
		description: string;
		handler: (args: string, ctx: AgentModelsCommandContext) => unknown | Promise<unknown>;
	}): void;
};

export default function agentModelsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("agent-models", {
		description: "Menu/CLI for project-local agent model + thinking routing (.pi/agent-models.json)",
		handler: async (args, ctx) => {
			const result = await handleAgentModelsInvocation(args, {
				cwd: ctx.cwd || process.cwd(),
				hasUI: ctx.hasUI,
				ui: ctx.ui,
			});
			notify(ctx, result.text, result.ok ? "info" : "error");
		},
	});
}

// Silence unused helper in case tree-shaking keeps API stable for tests.
void knownClassNames;
void assertKnownClass;
