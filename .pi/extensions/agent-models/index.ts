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
import {
	BACK_MODEL_ID,
	customPickerAvailable,
	FALLBACK_SELECT_CAP,
	FILTER_NOTIFY,
	filterAvailableModels,
	interpretPick,
	MODEL_PICKER_OVERLAY_OPTIONS,
	MODEL_PICKER_VIEWPORT,
	pinThenCap,
	runSearchableModelPicker,
	UNBOUNDED_SELECT_MAX,
	type CustomFn,
} from "./searchable-picker";

export {
	BACK_MODEL_ID,
	FALLBACK_SELECT_CAP,
	filterAvailableModels,
	interpretPick,
	MODEL_PICKER_OVERLAY_OPTIONS,
	MODEL_PICKER_VIEWPORT,
	pinThenCap,
	UNBOUNDED_SELECT_MAX,
};

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

export type ExtensionUiMode = "tui" | "rpc" | "json" | "print";

type CommandUi = {
	notify?: (message: string, level?: string) => void;
	select?: (title: string, options: string[]) => Promise<string | undefined | null>;
	input?: (title: string, initial?: string) => Promise<string | undefined | null>;
	confirm?: (title: string, message: string) => Promise<boolean>;
	custom?: CustomFn;
};

/** Model entry for live catalog / thinking filter (provider/id + optional Pi meta). */
export type AvailableModelInfo = {
	/** Canonical id `provider/modelId` (or bare id when provider unknown). */
	id: string;
	provider?: string;
	modelId?: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type ListAvailableModelsFn = (
	config: AgentModelsConfig,
) => AvailableModelInfo[] | Promise<AvailableModelInfo[]>;

/** Minimal model meta for Pi-canon thinking filter. */
export type ThinkingModelMeta = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type ModelRegistryLike = {
	/** Sync snapshot of models with configured auth (may be empty until refresh). */
	getAvailable?: () => unknown;
	/** All known models (built-in + custom), independent of availability snapshot. */
	getAll?: () => unknown;
	/** Best-effort async reload so getAvailable snapshot fills. */
	refresh?: (options?: unknown) => unknown | Promise<unknown>;
	/** True when provider has configured auth (API key/OAuth). */
	hasConfiguredAuth?: (modelOrProvider: unknown) => boolean;
};

export type ScopedModelLike = {
	model?: unknown;
	thinkingLevel?: string;
};

export type AgentModelsCommandContext = {
	cwd?: string;
	hasUI?: boolean;
	mode?: ExtensionUiMode;
	ui?: CommandUi;
	/** Pi extension ctx.modelRegistry — optional live catalogue source. */
	modelRegistry?: ModelRegistryLike;
	/** Pi extension ctx.scopedModels — preferred when non-empty. */
	scopedModels?: ReadonlyArray<ScopedModelLike>;
	/** Injectable catalog for tests; overrides registry/scoped wiring when set. */
	listAvailableModels?: ListAvailableModelsFn;
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

export const DEFAULT_CATALOG_TIMEOUT_MS = 2500;

/** Normalize a raw Pi model / string into AvailableModelInfo. */
export function normalizeAvailableModel(raw: unknown): AvailableModelInfo | null {
	if (typeof raw === "string") {
		const id = normalizeModelId(raw);
		return id ? { id } : null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const m = raw as Record<string, unknown>;
	const provider = typeof m.provider === "string" && m.provider.trim() ? m.provider.trim() : undefined;
	const rawId = typeof m.id === "string" && m.id.trim() ? m.id.trim() : undefined;
	const rawName = typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined;
	let id: string | undefined;
	let modelId: string | undefined;
	// Pi Model: { provider, id } where id is bare model id. Our info.id is always provider/id.
	// Also accept already-canonical id ("provider/model") without double-prefixing.
	if (provider && rawId) {
		if (rawId.includes("/")) {
			id = rawId;
			const prefix = `${provider}/`;
			modelId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId.split("/").slice(1).join("/");
		} else {
			modelId = rawId;
			id = `${provider}/${rawId}`;
		}
	} else if (rawId) {
		id = rawId;
		modelId = rawId.includes("/") ? rawId.split("/").slice(1).join("/") : rawId;
	} else if (provider && rawName) {
		modelId = rawName;
		id = `${provider}/${rawName}`;
	} else {
		id = normalizeModelId(rawName);
	}
	if (!id) return null;
	const info: AvailableModelInfo = { id };
	if (provider) info.provider = provider;
	else if (id.includes("/")) info.provider = id.split("/")[0];
	if (modelId) info.modelId = modelId;
	if (rawName) info.name = rawName;
	if (typeof m.reasoning === "boolean") info.reasoning = m.reasoning;
	if (m.thinkingLevelMap && typeof m.thinkingLevelMap === "object" && !Array.isArray(m.thinkingLevelMap)) {
		const map: Partial<Record<ThinkingLevel, string | null>> = {};
		for (const level of THINKING_LEVELS) {
			if (!(level in (m.thinkingLevelMap as object))) continue;
			const v = (m.thinkingLevelMap as Record<string, unknown>)[level];
			if (v === null) map[level] = null;
			else if (typeof v === "string") map[level] = v;
		}
		if (Object.keys(map).length > 0) info.thinkingLevelMap = map;
	}
	return info;
}

export function normalizeAvailableModels(rawList: unknown): AvailableModelInfo[] {
	if (!Array.isArray(rawList)) return [];
	const out: AvailableModelInfo[] = [];
	const seen = new Set<string>();
	for (const raw of rawList) {
		const info = normalizeAvailableModel(raw);
		if (!info || seen.has(info.id)) continue;
		seen.add(info.id);
		out.push(info);
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Collect models from a Pi ModelRegistry-like object.
 * Pi sync getAvailable() reads an availability *snapshot* that stays empty until
 * refresh()/async getAvailable runs — always try refresh first, then getAvailable,
 * then getAll filtered by hasConfiguredAuth when available.
 */
export async function collectModelsFromRegistry(registry: ModelRegistryLike): Promise<AvailableModelInfo[]> {
	const refresh = registry.refresh;
	if (typeof refresh === "function") {
		try {
			await Promise.resolve(refresh.call(registry));
		} catch {
			// best-effort — still try snapshot / getAll
		}
	}

	if (typeof registry.getAvailable === "function") {
		try {
			const raw = await Promise.resolve(registry.getAvailable.call(registry));
			const list = normalizeAvailableModels(raw);
			if (list.length > 0) return list;
		} catch {
			// fall through to getAll
		}
	}

	if (typeof registry.getAll === "function") {
		try {
			const rawAll = await Promise.resolve(registry.getAll.call(registry));
			let list = normalizeAvailableModels(rawAll);
			const hasAuth = registry.hasConfiguredAuth;
			if (typeof hasAuth === "function" && list.length > 0) {
				const filtered = list.filter((m) => {
					try {
						// Pi accepts Model object or provider id string.
						if (m.provider && hasAuth.call(registry, m.provider)) return true;
						return Boolean(hasAuth.call(registry, m));
					} catch {
						return true;
					}
				});
				if (filtered.length > 0) list = filtered;
			}
			return list;
		} catch {
			return [];
		}
	}

	return [];
}

/**
 * Build injectable listAvailableModels from Pi command ctx.
 * Prefer non-empty scopedModels; else modelRegistry (refresh → getAvailable → getAll).
 * Returns undefined when neither source exists (caller uses config fallback).
 */
export function buildListAvailableModelsFromContext(ctx: {
	modelRegistry?: ModelRegistryLike;
	scopedModels?: ReadonlyArray<ScopedModelLike>;
	listAvailableModels?: ListAvailableModelsFn;
}): ListAvailableModelsFn | undefined {
	if (ctx.listAvailableModels) return ctx.listAvailableModels;
	const scoped = ctx.scopedModels;
	const hasScoped = Array.isArray(scoped) && scoped.length > 0;
	const registry = ctx.modelRegistry;
	const hasRegistry =
		!!registry &&
		(typeof registry.getAvailable === "function" ||
			typeof registry.getAll === "function" ||
			typeof registry.refresh === "function");
	if (!hasScoped && !hasRegistry) return undefined;
	return async () => {
		if (hasScoped) {
			return normalizeAvailableModels(scoped!.map((entry) => entry?.model ?? entry));
		}
		return collectModelsFromRegistry(registry!);
	};
}

export type ModelCatalogResult = {
	models: AvailableModelInfo[];
	source: "live" | "fallback";
};

/**
 * Resolve picker catalog: live listAvailableModels with timeout/catch,
 * else defaultModelCatalog fallback. Empty live list also falls back.
 */
export async function resolveModelCatalog(
	config: AgentModelsConfig,
	listAvailableModels?: ListAvailableModelsFn,
	timeoutMs: number = DEFAULT_CATALOG_TIMEOUT_MS,
): Promise<ModelCatalogResult> {
	const fallback = (): ModelCatalogResult => ({
		models: defaultModelCatalog(config).map((id) => ({ id })),
		source: "fallback",
	});
	if (!listAvailableModels) return fallback();
	try {
		const raced = await Promise.race([
			Promise.resolve()
				.then(() => listAvailableModels(config))
				.then((models) => ({ ok: true as const, models }))
				.catch(() => ({ ok: false as const, models: null })),
			new Promise<{ ok: false; models: null }>((resolve) => {
				setTimeout(() => resolve({ ok: false, models: null }), Math.max(0, timeoutMs));
			}),
		]);
		if (!raced.ok || !raced.models || raced.models.length === 0) return fallback();
		return { models: normalizeAvailableModels(raced.models), source: "live" };
	} catch {
		return fallback();
	}
}

/**
 * Pi-canon mirror of getSupportedThinkingLevels:
 * - reasoning === false → ["off"]
 * - no map → off..high (xhigh/max hidden)
 * - map null → hide; string → show; omitted standard → show; omitted xhigh/max → hide
 * - unknown/free-text model (no meta) → off..high defaults
 */
export function supportedThinkingLevels(model?: ThinkingModelMeta | null): ThinkingLevel[] {
	if (model && model.reasoning === false) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model?.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function isThinkingSupported(level: ThinkingLevel, model?: ThinkingModelMeta | null): boolean {
	return supportedThinkingLevels(model).includes(level);
}

export function findModelMeta(models: AvailableModelInfo[], modelId: string | undefined | null): AvailableModelInfo | undefined {
	const needle = normalizeModelId(modelId);
	if (!needle) return undefined;
	const lower = needle.toLowerCase();
	return models.find((m) => {
		if (m.id.toLowerCase() === lower) return true;
		if (m.modelId && m.provider && `${m.provider}/${m.modelId}`.toLowerCase() === lower) return true;
		if (m.modelId && m.modelId.toLowerCase() === lower) return true;
		return false;
	});
}

/** Compact human overview for menu «Обзор». */
export function formatCompactOverview(config: AgentModelsConfig, projectRoot?: string): string {
	const lines: string[] = [];
	lines.push("Обзор agent-models");
	const classNames = Object.keys(config.classes).sort();
	lines.push(`Мощность (${classNames.length}):`);
	if (classNames.length === 0) lines.push("  (нет)");
	else {
		for (const name of classNames) {
			const thinking = config.classThinking?.[name] ?? "inherit";
			lines.push(`  ${name} (${classDisplayLabel(name)}): ${config.classes[name]} · thinking=${thinking}`);
		}
	}
	const agents = projectRoot
		? listKnownAgents(projectRoot, config)
		: Array.from(new Set([...Object.keys(config.agentClasses), ...Object.keys(config.roles)])).sort();
	const mapped = agents.filter((a) => config.agentClasses[a] || roleEntry(config.roles, a));
	const unmapped = agents.filter((a) => !config.agentClasses[a] && !roleEntry(config.roles, a));
	lines.push(`Агенты: ${agents.length} (настроено ${mapped.length}, inherit ${unmapped.length})`);
	for (const name of agents.slice(0, 12)) {
		const resolved = resolveAgentModel(name, config);
		const cls = resolved.className ?? "—";
		const model = resolved.model ?? "session";
		const thinking = resolved.thinking ?? "inherit";
		lines.push(`  ${name}: ${cls} · ${model} · ${thinking}`);
	}
	if (agents.length > 12) lines.push(`  … ещё ${agents.length - 12}`);
	if (projectRoot) {
		const stale = listStaleAgentKeys(projectRoot, config);
		if (stale.length > 0) lines.push(`Stale keys: ${stale.join(", ")}`);
	}
	return lines.join("\n");
}

export type MenuUi = {
	select: (title: string, options: string[]) => Promise<string | undefined | null>;
	input?: (title: string, initial?: string) => Promise<string | undefined | null>;
	notify?: (message: string, level?: string) => void;
	confirm?: (title: string, message: string) => Promise<boolean>;
	custom?: CustomFn;
};

export type MenuResult = { ok: boolean; text: string; cancelled?: boolean; wrote?: boolean };

export type RunAgentModelsMenuOptions = {
	listAvailableModels?: ListAvailableModelsFn;
	catalogTimeoutMs?: number;
	mode?: ExtensionUiMode;
};

export const MENU_EXIT = "← Выход";
export const MENU_BACK = "← Назад";
const INHERIT_THINKING_ID = "__inherit__";
const OTHER_MODEL_ID = "__other__";
const INHERIT_THINKING_LABEL = "как у class/сессии (inherit, без --thinking)";
const OTHER_MODEL_LABEL = "Другая…";

const ROOT_OVERVIEW = "overview";
const ROOT_CLASS = "class-wizard";
const ROOT_AGENT = "agent-wizard";
const ROOT_CLEANUP = "cleanup";

type NavPick = { type: "pick"; id: string } | { type: "back" } | { type: "exit" };

type SelectOption = { id: string; label: string };

function uniqueLabels(options: SelectOption[]): SelectOption[] {
	const seen = new Map<string, number>();
	return options.map((opt) => {
		const count = seen.get(opt.label) ?? 0;
		seen.set(opt.label, count + 1);
		if (count === 0) return opt;
		return { id: opt.id, label: `${opt.label} [${opt.id}]` };
	});
}

async function selectWithNav(
	ui: MenuUi,
	title: string,
	options: SelectOption[],
	mode: "root" | "nested",
): Promise<NavPick> {
	const opts = uniqueLabels(options);
	const labelToId = new Map(opts.map((o) => [o.label, o.id]));
	const display = mode === "nested"
		? [...opts.map((o) => o.label), MENU_BACK]
		: [...opts.map((o) => o.label), MENU_EXIT];
	const choice = await ui.select(title, display);
	if (choice == null) return mode === "nested" ? { type: "back" } : { type: "exit" };
	if (choice === MENU_BACK) return { type: "back" };
	if (choice === MENU_EXIT) return { type: "exit" };
	const id = labelToId.get(choice);
	if (id == null) return mode === "nested" ? { type: "back" } : { type: "exit" };
	return { type: "pick", id };
}

function thinkingSelectOptions(includeInherit: boolean, model?: ThinkingModelMeta | null): SelectOption[] {
	const levels = supportedThinkingLevels(model);
	const opts: SelectOption[] = levels.map((level) => ({
		id: level,
		label: level === "off" ? "off (явно --thinking off)" : level,
	}));
	if (includeInherit) opts.unshift({ id: INHERIT_THINKING_ID, label: INHERIT_THINKING_LABEL });
	return opts;
}

function modelSelectOptions(models: AvailableModelInfo[]): SelectOption[] {
	const opts = models.map((m) => {
		const provider = m.provider ?? (m.id.includes("/") ? m.id.split("/")[0] : undefined);
		const label = provider ? `${m.id}` : m.id;
		const suffix = m.name && m.name !== m.modelId && m.name !== m.id ? ` — ${m.name}` : "";
		return { id: m.id, label: `${label}${suffix}` };
	});
	opts.push({ id: OTHER_MODEL_ID, label: OTHER_MODEL_LABEL });
	return opts;
}

function agentBadge(config: AgentModelsConfig, name: string): string {
	const parts: string[] = [];
	const cls = config.agentClasses[name];
	if (cls) parts.push(`class=${cls}`);
	else parts.push("unmapped");
	const role = roleEntry(config.roles, name);
	if (role?.model) parts.push(`model=${role.model}`);
	if (role?.thinking) parts.push(`thinking=${role.thinking}`);
	const resolved = resolveAgentModel(name, config);
	if (!role?.model && resolved.model) parts.push(`→ ${resolved.model}`);
	return parts.join(", ");
}

async function confirmDestructive(ui: MenuUi, title: string, message: string): Promise<boolean> {
	if (ui.confirm) return ui.confirm(title, message);
	const pick = await selectWithNav(
		ui,
		`${title}: ${message}`,
		[
			{ id: "yes", label: "Да, удалить" },
			{ id: "no", label: "Нет" },
		],
		"nested",
	);
	return pick.type === "pick" && pick.id === "yes";
}

async function pickOtherModelId(
	ui: MenuUi,
	models: AvailableModelInfo[],
	initial?: string,
): Promise<{ modelId: string; meta?: AvailableModelInfo; catalog: AvailableModelInfo[] } | "back"> {
	const typed = await ui.input?.("Model id (provider/id)", initial ?? "");
	if (typed == null || !typed.trim()) return "back";
	const modelId = typed.trim();
	return { modelId, meta: findModelMeta(models, modelId), catalog: models };
}

async function pickModelIdFallback(
	ui: MenuUi,
	title: string,
	models: AvailableModelInfo[],
	initial?: string,
): Promise<{ modelId: string; meta?: AvailableModelInfo; catalog: AvailableModelInfo[] } | "back"> {
	let list = models;
	if (ui.input) {
		const query = await ui.input("Фильтр моделей");
		if (query == null) return "back";
		list = filterAvailableModels(list, query);
	}
	if (list.length >= UNBOUNDED_SELECT_MAX) {
		const total = list.length;
		list = pinThenCap(list, initial, FALLBACK_SELECT_CAP);
		ui.notify?.(`Каталог обрезан: показаны ${list.length} из ${total}. ${FILTER_NOTIFY}`, "warning");
	}
	const pick = await selectWithNav(ui, title, modelSelectOptions(list), "nested");
	if (pick.type !== "pick") return "back";
	const interpreted = interpretPick(pick.id);
	if (interpreted === "back") return "back";
	if (interpreted === "other") return pickOtherModelId(ui, models, initial);
	return { modelId: interpreted.modelId, meta: findModelMeta(models, interpreted.modelId), catalog: models };
}

async function pickModelId(
	ui: MenuUi,
	title: string,
	config: AgentModelsConfig,
	listAvailableModels: ListAvailableModelsFn | undefined,
	catalogTimeoutMs: number,
	initial?: string,
	mode?: ExtensionUiMode,
): Promise<{ modelId: string; meta?: AvailableModelInfo; catalog: AvailableModelInfo[] } | "back"> {
	const catalog = await resolveModelCatalog(config, listAvailableModels, catalogTimeoutMs);
	if (catalog.source === "fallback") {
		ui.notify?.("Каталог моделей: fallback из конфига (registry/таймаут)", "warning");
	}
	const useCustom =
		typeof ui.custom === "function" && mode === "tui" && customPickerAvailable();
	if (useCustom && ui.custom) {
		try {
			// Path (a): catch only around await runSearchableModelPicker (throw until first return).
			const raw = await runSearchableModelPicker({
				custom: ui.custom,
				title,
				models: catalog.models,
				initial,
			});
			const interpreted = interpretPick(raw);
			if (interpreted === "back") return "back";
			if (interpreted === "other") return pickOtherModelId(ui, catalog.models, initial);
			return {
				modelId: interpreted.modelId,
				meta: findModelMeta(catalog.models, interpreted.modelId),
				catalog: catalog.models,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ui.notify?.(`Searchable picker недоступен, fallback select: ${msg}`, "warning");
		}
	}
	return pickModelIdFallback(ui, title, catalog.models, initial);
}

async function pickThinkingLevel(
	ui: MenuUi,
	title: string,
	includeInherit: boolean,
	model?: ThinkingModelMeta | null,
): Promise<ThinkingLevel | "inherit" | "back"> {
	const pick = await selectWithNav(ui, title, thinkingSelectOptions(includeInherit, model), "nested");
	if (pick.type !== "pick") return "back";
	if (pick.id === INHERIT_THINKING_ID) return "inherit";
	const level = normalizeThinkingLevel(pick.id);
	if (!level || !isThinkingSupported(level, model)) {
		ui.notify?.(`Уровень thinking "${pick.id}" неподдерживается моделью`, "warning");
		return "back";
	}
	return level;
}

async function warnOrphanThinking(
	ui: MenuUi,
	stored: ThinkingLevel | undefined,
	modelMeta: ThinkingModelMeta | undefined,
	contextLabel: string,
): Promise<"keep" | "clear" | "repick" | "back"> {
	if (!stored || isThinkingSupported(stored, modelMeta)) return "keep";
	const allowed = supportedThinkingLevels(modelMeta).join(", ");
	ui.notify?.(
		`Thinking "${stored}" для ${contextLabel} не поддерживается новой моделью. Доступно: ${allowed}`,
		"warning",
	);
	const pick = await selectWithNav(
		ui,
		`Orphan thinking (${stored}) — ${contextLabel}`,
		[
			{ id: "repick", label: "Выбрать другой уровень" },
			{ id: "clear", label: "Сбросить (inherit)" },
			{ id: "keep", label: "Оставить как есть" },
		],
		"nested",
	);
	if (pick.type !== "pick") return "back";
	if (pick.id === "repick" || pick.id === "clear" || pick.id === "keep") return pick.id;
	return "back";
}

/**
 * Interactive menu with back-nav, live catalog, thinking filter, IA wizards.
 * Nested Esc/null/← Назад → previous; root Esc/← Выход → leave. No write on unconfirmed step.
 */
export async function runAgentModelsMenu(
	cwd: string,
	ui: MenuUi,
	options: RunAgentModelsMenuOptions = {},
): Promise<MenuResult> {
	const projectRoot = requireProjectRoot(cwd);
	let wrote = false;
	const listAvailableModels = options.listAvailableModels;
	const catalogTimeoutMs = options.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
	const uiMode = options.mode;

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

	const runClassWizard = async (): Promise<"root" | "exit"> => {
		while (true) {
			const { config } = reload();
			const classes = Object.keys(config.classes).sort();
			if (classes.length === 0) {
				ui.notify?.("Нет classes в конфиге", "warning");
				return "root";
			}
			const classPick = await selectWithNav(
				ui,
				"Мощность — выберите class",
				classes.map((name) => ({
					id: name,
					label: `${name} (${classDisplayLabel(name)}) — ${config.classes[name]} · thinking=${config.classThinking?.[name] ?? "inherit"}`,
				})),
				"nested",
			);
			if (classPick.type === "exit") return "exit";
			if (classPick.type === "back") return "root";
			const className = classPick.id;

			// Step: model
			const modelResult = await pickModelId(
				ui,
				`Модель для ${className} (${classDisplayLabel(className)})`,
				config,
				listAvailableModels,
				catalogTimeoutMs,
				config.classes[className],
				uiMode,
			);
			if (modelResult === "back") continue;

			config.classes[className] = modelResult.modelId;
			const modelPath = save(config);
			ui.notify?.(`set class ${className} → ${modelResult.modelId}\nfile: ${modelPath}`, "info");

			const storedThinking = config.classThinking?.[className];
			const orphan = await warnOrphanThinking(ui, storedThinking, modelResult.meta, `class ${className}`);
			if (orphan === "back") continue;
			if (orphan === "clear") {
				if (config.classThinking) delete config.classThinking[className];
				const p = save(config);
				ui.notify?.(`unset class-thinking ${className}\nfile: ${p}`, "info");
			} else if (orphan === "repick" || orphan === "keep") {
				// fall through to thinking step when repick; keep skips forced change but still offers thinking step
			}

			const thinkingChoice = await pickThinkingLevel(
				ui,
				`Thinking для class ${className}`,
				true,
				modelResult.meta,
			);
			if (thinkingChoice === "back") continue;
			if (thinkingChoice === "inherit") {
				if (config.classThinking) delete config.classThinking[className];
				const p = save(config);
				ui.notify?.(`unset class-thinking ${className}\nfile: ${p}`, "info");
			} else {
				config.classThinking = { ...(config.classThinking ?? {}), [className]: thinkingChoice };
				const p = save(config);
				ui.notify?.(`set class-thinking ${className} → ${thinkingChoice}\nfile: ${p}`, "info");
			}
			return "root";
		}
	};

	const runAgentWizard = async (): Promise<"root" | "exit"> => {
		while (true) {
			const { config } = reload();
			const agents = listKnownAgents(projectRoot, config);
			if (agents.length === 0) {
				ui.notify?.("Нет агентов (.pi/agents и JSON пусты)", "warning");
				return "root";
			}
			const agentPick = await selectWithNav(
				ui,
				"Настроить агента",
				agents.map((name) => ({ id: name, label: `${name} — ${agentBadge(config, name)}` })),
				"nested",
			);
			if (agentPick.type === "exit") return "exit";
			if (agentPick.type === "back") return "root";
			const agent = agentPick.id;

			while (true) {
				const latest = reload().config;
				const action = await selectWithNav(
					ui,
					`Агент ${agent} — ${agentBadge(latest, agent)}`,
					[
						{ id: "class", label: "Назначить class (strong/standard/cheap)" },
						{ id: "model", label: "Override model" },
						{ id: "thinking", label: "Override thinking" },
						{ id: "clear-model", label: "Сбросить override model" },
						{ id: "clear-thinking", label: "Сбросить override thinking" },
						{ id: "clear-class", label: "Сбросить agent-class" },
					],
					"nested",
				);
				if (action.type === "exit") return "exit";
				if (action.type === "back") break;

				const cfg = reload().config;

				if (action.id === "class") {
					const classes = Object.keys(cfg.classes).sort();
					const classPick = await selectWithNav(
						ui,
						`Class для ${agent}`,
						classes.map((name) => ({ id: name, label: `${name} (${classDisplayLabel(name)})` })),
						"nested",
					);
					if (classPick.type !== "pick") continue;
					if (!(classPick.id in cfg.classes)) continue;
					cfg.agentClasses[agent] = classPick.id;
					const p = save(cfg);
					ui.notify?.(`set agent-class ${agent} → ${classPick.id}\nfile: ${p}`, "info");
					continue;
				}

				if (action.id === "model") {
					const modelResult = await pickModelId(
						ui,
						`Model override для ${agent}`,
						cfg,
						listAvailableModels,
						catalogTimeoutMs,
						roleEntry(cfg.roles, agent)?.model,
					uiMode,
					);
					if (modelResult === "back") continue;
					setRoleModel(cfg, agent, modelResult.modelId);
					const p = save(cfg);
					ui.notify?.(`set role ${agent} → ${modelResult.modelId}\nfile: ${p}`, "info");

					const stored = roleEntry(cfg.roles, agent)?.thinking;
					const orphan = await warnOrphanThinking(ui, stored, modelResult.meta, `agent ${agent}`);
					if (orphan === "clear") {
						unsetRoleThinking(cfg, agent);
						const p2 = save(cfg);
						ui.notify?.(`unset role-thinking ${agent}\nfile: ${p2}`, "info");
					} else if (orphan === "repick") {
						const t = await pickThinkingLevel(ui, `Thinking для ${agent}`, true, modelResult.meta);
						if (t !== "back" && t !== "inherit") {
							setRoleThinking(cfg, agent, t);
							const p2 = save(cfg);
							ui.notify?.(`set role-thinking ${agent} → ${t}\nfile: ${p2}`, "info");
						} else if (t === "inherit") {
							unsetRoleThinking(cfg, agent);
							const p2 = save(cfg);
							ui.notify?.(`unset role-thinking ${agent}\nfile: ${p2}`, "info");
						}
					}
					continue;
				}

				if (action.id === "thinking") {
					const resolved = resolveAgentModel(agent, cfg);
					const catalog = await resolveModelCatalog(cfg, listAvailableModels, catalogTimeoutMs);
					const meta = findModelMeta(catalog.models, resolved.model);
					const t = await pickThinkingLevel(ui, `Thinking для ${agent}`, true, meta);
					if (t === "back") continue;
					if (t === "inherit") {
						unsetRoleThinking(cfg, agent);
						const p = save(cfg);
						ui.notify?.(`unset role-thinking ${agent}\nfile: ${p}`, "info");
					} else {
						setRoleThinking(cfg, agent, t);
						const p = save(cfg);
						ui.notify?.(`set role-thinking ${agent} → ${t}\nfile: ${p}`, "info");
					}
					continue;
				}

				if (action.id === "clear-model") {
					unsetRoleModel(cfg, agent);
					const p = save(cfg);
					ui.notify?.(`unset role model ${agent}\nfile: ${p}`, "info");
					continue;
				}

				if (action.id === "clear-thinking") {
					unsetRoleThinking(cfg, agent);
					const p = save(cfg);
					ui.notify?.(`unset role-thinking ${agent}\nfile: ${p}`, "info");
					continue;
				}

				if (action.id === "clear-class") {
					delete cfg.agentClasses[agent];
					const p = save(cfg);
					ui.notify?.(`unset agent-class ${agent}\nfile: ${p}`, "info");
					continue;
				}
			}
		}
	};

	const runCleanup = async (): Promise<"root" | "exit"> => {
		while (true) {
			const { config } = reload();
			const action = await selectWithNav(
				ui,
				"Уборка",
				[
					{ id: "stale", label: "Убрать stale JSON keys" },
					{ id: "class-thinking", label: "Сбросить class thinking" },
				],
				"nested",
			);
			if (action.type === "exit") return "exit";
			if (action.type === "back") return "root";

			if (action.id === "stale") {
				const stale = listStaleAgentKeys(projectRoot, config);
				if (stale.length === 0) {
					ui.notify?.("Stale keys нет", "info");
					continue;
				}
				const pick = await selectWithNav(
					ui,
					"Удалить stale key",
					[
						...stale.map((name) => ({ id: name, label: name })),
						{ id: "__all__", label: "Удалить все stale" },
					],
					"nested",
				);
				if (pick.type !== "pick") continue;
				const targets = pick.id === "__all__" ? stale : [pick.id];
				if (pick.id === "__all__") {
					const ok = await confirmDestructive(
						ui,
						"Удалить все stale",
						`Удалить ${targets.length} keys: ${targets.join(", ")}?`,
					);
					if (!ok) continue;
				}
				for (const name of targets) {
					delete config.agentClasses[name];
					delete config.roles[name];
				}
				const p = save(config);
				ui.notify?.(`removed stale: ${targets.join(", ")}\nfile: ${p}`, "info");
				continue;
			}

			if (action.id === "class-thinking") {
				const names = Object.keys(config.classThinking ?? {}).sort();
				if (names.length === 0) {
					ui.notify?.("Нет classThinking", "info");
					continue;
				}
				const pick = await selectWithNav(
					ui,
					"Сбросить class thinking",
					names.map((name) => ({ id: name, label: `${name} = ${config.classThinking?.[name]}` })),
					"nested",
				);
				if (pick.type !== "pick") continue;
				if (config.classThinking) delete config.classThinking[pick.id];
				const p = save(config);
				ui.notify?.(`unset class-thinking ${pick.id}\nfile: ${p}`, "info");
				continue;
			}
		}
	};

	const runOverview = async (): Promise<"root" | "exit"> => {
		while (true) {
			const { config } = reload();
			const pick = await selectWithNav(
				ui,
				"Обзор",
				[
					{ id: "compact", label: "Краткий обзор" },
					{ id: "raw", label: "Подробнее (raw dump)" },
				],
				"nested",
			);
			if (pick.type === "exit") return "exit";
			if (pick.type === "back") return "root";
			if (pick.id === "compact") {
				ui.notify?.(formatCompactOverview(config, projectRoot), "info");
				continue;
			}
			if (pick.id === "raw") {
				const loaded = loadAgentModels(cwd);
				ui.notify?.(formatAgentModelsShow(loaded, cwd), "info");
				continue;
			}
		}
	};

	while (true) {
		const root = await selectWithNav(
			ui,
			"agent-models — что настроить?",
			[
				{ id: ROOT_OVERVIEW, label: "Обзор" },
				{ id: ROOT_CLASS, label: "Настроить мощность (class)" },
				{ id: ROOT_AGENT, label: "Настроить агента" },
				{ id: ROOT_CLEANUP, label: "Уборка" },
			],
			"root",
		);
		if (root.type === "exit" || root.type === "back") {
			return { ok: true, text: wrote ? "menu done (saved)" : "menu cancelled", cancelled: !wrote, wrote };
		}

		let next: "root" | "exit" = "root";
		if (root.id === ROOT_OVERVIEW) next = await runOverview();
		else if (root.id === ROOT_CLASS) next = await runClassWizard();
		else if (root.id === ROOT_AGENT) next = await runAgentWizard();
		else if (root.id === ROOT_CLEANUP) next = await runCleanup();

		if (next === "exit") {
			return { ok: true, text: wrote ? "menu done (saved)" : "menu cancelled", cancelled: !wrote, wrote };
		}
	}
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
				const listAvailableModels = buildListAvailableModelsFromContext(ctx);
				const result = await runAgentModelsMenu(
					cwd,
					{
						select: ctx.ui.select,
						input: ctx.ui.input,
						notify: ctx.ui.notify,
						confirm: ctx.ui.confirm,
						custom: ctx.ui.custom,
					},
					{ listAvailableModels, mode: ctx.mode },
				);
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
				mode: ctx.mode,
				ui: ctx.ui,
				// Forward Pi catalogue sources — do not strip.
				modelRegistry: ctx.modelRegistry,
				scopedModels: ctx.scopedModels,
				listAvailableModels: ctx.listAvailableModels,
			});
			notify(ctx, result.text, result.ok ? "info" : "error");
		},
	});
}

// Silence unused helper in case tree-shaking keeps API stable for tests.
void knownClassNames;
void assertKnownClass;
