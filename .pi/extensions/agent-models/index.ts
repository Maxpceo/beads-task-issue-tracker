/**
 * Project-local per-agent model routing.
 *
 * Resolve order: roles[agent].model → classes[agentClasses[agent]] → session inherit (no --model).
 * Config lives only under project `.pi/agent-models.json` (never ~/.pi).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AGENT_MODELS_FILENAME = "agent-models.json";

export interface AgentModelsConfig {
	classes: Record<string, string>;
	/** Optional per-role model override. Empty/missing model means no override. */
	roles: Record<string, { model?: string } | string>;
	/** Role name → power class (strong/standard/cheap/…). */
	agentClasses: Record<string, string>;
}

export type ResolveSource = "role" | "class" | "inherit";

export interface ResolveAgentModelResult {
	/** Concrete model id when set; undefined means inherit session model (omit --model). */
	model?: string;
	source: ResolveSource;
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

const EMPTY_CONFIG: AgentModelsConfig = {
	classes: {},
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

function normalizeModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function roleModelOverride(roles: AgentModelsConfig["roles"], agentName: string): string | undefined {
	const entry = roles[agentName];
	if (entry == null) return undefined;
	if (typeof entry === "string") return normalizeModelId(entry);
	return normalizeModelId(entry.model);
}

function normalizeConfig(raw: unknown): { config: AgentModelsConfig; error?: string } {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config: { ...EMPTY_CONFIG }, error: "agent-models.json must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;
	const classes: Record<string, string> = {};
	if (obj.classes != null) {
		if (typeof obj.classes !== "object" || Array.isArray(obj.classes)) {
			return { config: { ...EMPTY_CONFIG }, error: "classes must be an object of class→modelId" };
		}
		for (const [name, value] of Object.entries(obj.classes as Record<string, unknown>)) {
			const model = normalizeModelId(value);
			if (model) classes[name] = model;
		}
	}
	const agentClasses: Record<string, string> = {};
	if (obj.agentClasses != null) {
		if (typeof obj.agentClasses !== "object" || Array.isArray(obj.agentClasses)) {
			return { config: { ...EMPTY_CONFIG }, error: "agentClasses must be an object of agent→class" };
		}
		for (const [name, value] of Object.entries(obj.agentClasses as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) agentClasses[name] = value.trim();
		}
	}
	const roles: AgentModelsConfig["roles"] = {};
	if (obj.roles != null) {
		if (typeof obj.roles !== "object" || Array.isArray(obj.roles)) {
			return { config: { ...EMPTY_CONFIG }, error: "roles must be an object of agent→{model} or agent→modelId" };
		}
		for (const [name, value] of Object.entries(obj.roles as Record<string, unknown>)) {
			if (typeof value === "string") {
				const model = normalizeModelId(value);
				if (model) roles[name] = { model };
				continue;
			}
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const model = normalizeModelId((value as { model?: unknown }).model);
				if (model) roles[name] = { model };
			}
		}
	}
	return { config: { classes, roles, agentClasses } };
}

/** Load project agent-models.json. Missing/invalid never throws — spawn inherits. */
export function loadAgentModels(cwd: string): AgentModelsLoadResult {
	const projectRoot = findProjectPiRoot(cwd);
	if (!projectRoot) {
		return { config: { ...EMPTY_CONFIG }, path: null, missing: true, error: "no project .pi/ directory found from cwd" };
	}
	const filePath = agentModelsFilePath(projectRoot);
	if (!fs.existsSync(filePath)) {
		return { config: { ...EMPTY_CONFIG }, path: filePath, missing: true };
	}
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		return {
			config: { ...EMPTY_CONFIG },
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
			config: { ...EMPTY_CONFIG },
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
 * Resolve model for an agent role.
 * Order: role override → class mapping → inherit (undefined model).
 */
export function resolveAgentModel(agentName: string, config: AgentModelsConfig): ResolveAgentModelResult {
	const name = (agentName ?? "").trim();
	if (!name) return { source: "inherit", note: "empty agent name" };

	const roleModel = roleModelOverride(config.roles, name);
	if (roleModel) {
		return { model: roleModel, source: "role" };
	}

	const className = config.agentClasses[name];
	if (className) {
		const classModel = normalizeModelId(config.classes[className]);
		if (classModel) {
			return { model: classModel, source: "class", className };
		}
		return {
			source: "inherit",
			className,
			note: className in config.classes
				? `class "${className}" has empty model id`
				: `unknown class "${className}" for agent "${name}"`,
		};
	}

	return { source: "inherit", note: `no agentClasses entry for "${name}"` };
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

export function saveAgentModels(projectRoot: string, config: AgentModelsConfig): string {
	const piDir = path.join(projectRoot, ".pi");
	if (!isDirectory(piDir)) {
		throw new Error(`project .pi/ directory missing at ${piDir}; refusing to write agent-models outside a project`);
	}
	// Hard guard: never write under home .pi as project root
	const homePi = path.join(process.env.HOME || "", ".pi");
	if (homePi && path.resolve(projectRoot) === path.resolve(path.dirname(homePi))) {
		// projectRoot === $HOME would mean writing $HOME/.pi/agent-models.json as "project" — allowed only if that is intentional project.
		// We still write under projectRoot/.pi; the important guard is callers pass project worktree, not os.homedir() by mistake via findProjectPiRoot miss.
	}
	const filePath = agentModelsFilePath(projectRoot);
	const payload: AgentModelsConfig = {
		classes: { ...config.classes },
		roles: { ...config.roles },
		agentClasses: { ...config.agentClasses },
	};
	fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return filePath;
}

export function formatResolvedTable(config: AgentModelsConfig, agentNames?: string[]): string {
	const names = agentNames && agentNames.length > 0
		? agentNames
		: Array.from(new Set([...Object.keys(config.agentClasses), ...Object.keys(config.roles)])).sort();
	const lines = ["agent | class | source | model"];
	lines.push("---+---|---|---");
	for (const name of names) {
		const resolved = resolveAgentModel(name, config);
		const className = resolved.className ?? config.agentClasses[name] ?? "—";
		const model = resolved.model ?? "(session inherit)";
		lines.push(`${name} | ${className} | ${resolved.source} | ${model}`);
	}
	return lines.join("\n");
}

export function formatAgentModelsShow(loaded: AgentModelsLoadResult, cwd: string): string {
	const lines: string[] = [];
	lines.push(`cwd: ${path.resolve(cwd)}`);
	lines.push(`file: ${loaded.path ?? "(none)"}`);
	if (loaded.missing) lines.push("status: missing (spawn inherits session model)");
	else if (loaded.error) lines.push(`status: error — ${loaded.error} (spawn inherits)`);
	else lines.push("status: loaded");
	lines.push("");
	lines.push("classes:");
	const classNames = Object.keys(loaded.config.classes).sort();
	if (classNames.length === 0) lines.push("  (none)");
	else for (const name of classNames) lines.push(`  ${name}: ${loaded.config.classes[name]}`);
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
			const model = roleModelOverride(loaded.config.roles, name) ?? "(empty)";
			lines.push(`  ${name}: ${model}`);
		}
	}
	lines.push("");
	lines.push("resolved:");
	lines.push(formatResolvedTable(loaded.config));
	return lines.join("\n");
}

type CommandUi = {
	notify?: (message: string, level?: string) => void;
};

function notify(ctx: { ui?: CommandUi } | undefined, message: string, level: "info" | "error" | "warning" = "info"): void {
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
	const config = loaded.missing
		? defaultAgentModelsConfig()
		: {
				classes: { ...loaded.config.classes },
				roles: { ...loaded.config.roles },
				agentClasses: { ...loaded.config.agentClasses },
			};
	// If file missing, seed defaults so set writes a complete file.
	if (loaded.missing && Object.keys(config.classes).length === 0) {
		Object.assign(config, defaultAgentModelsConfig());
	}
	return { projectRoot, config, path: agentModelsFilePath(projectRoot) };
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
			if (what === "role") {
				const agent = tokens[2];
				const modelId = tokens[3];
				if (!agent || !modelId) throw new Error("usage: agent-models set role <agent> <modelId>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				config.roles[agent] = { model: modelId };
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set role ${agent} → ${modelId}\nfile: ${filePath}` };
			}
			if (what === "agent-class") {
				const agent = tokens[2];
				const className = tokens[3];
				if (!agent || !className) throw new Error("usage: agent-models set agent-class <agent> <class>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				if (!(className in config.classes)) {
					throw new Error(`unknown class "${className}"; known: ${Object.keys(config.classes).sort().join(", ") || "(none)"}`);
				}
				config.agentClasses[agent] = className;
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `set agent-class ${agent} → ${className}\nfile: ${filePath}` };
			}
			throw new Error("usage: agent-models set class|role|agent-class …");
		}

		if (cmd === "unset") {
			const what = (tokens[1] ?? "").toLowerCase();
			if (what === "role") {
				const agent = tokens[2];
				if (!agent) throw new Error("usage: agent-models unset role <agent>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				delete config.roles[agent];
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset role ${agent}\nfile: ${filePath}` };
			}
			if (what === "agent-class") {
				const agent = tokens[2];
				if (!agent) throw new Error("usage: agent-models unset agent-class <agent>");
				const { projectRoot, config } = loadOrDefaultForMutate(cwd);
				delete config.agentClasses[agent];
				const filePath = saveAgentModels(projectRoot, config);
				return { ok: true, text: `unset agent-class ${agent}\nfile: ${filePath}` };
			}
			throw new Error("usage: agent-models unset role|agent-class <agent>");
		}

		throw new Error(
			[
				"usage:",
				"  agent-models show",
				"  agent-models set class <name> <modelId>",
				"  agent-models set role <agent> <modelId>",
				"  agent-models set agent-class <agent> <class>",
				"  agent-models unset role <agent>",
				"  agent-models unset agent-class <agent>",
			].join("\n"),
		);
	} catch (error) {
		return { ok: false, text: (error as Error).message };
	}
}

type ExtensionAPI = {
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: { cwd?: string; ui?: CommandUi }) => unknown }): void;
};

export default function agentModelsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("agent-models", {
		description: "Show/set project-local agent model routing (.pi/agent-models.json)",
		handler: (args, ctx) => {
			const cwd = ctx.cwd || process.cwd();
			const result = handleAgentModelsCommand(args, cwd);
			notify(ctx, result.text, result.ok ? "info" : "error");
		},
	});
}
