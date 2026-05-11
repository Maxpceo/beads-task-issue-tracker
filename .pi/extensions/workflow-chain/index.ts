import * as fs from "node:fs";
import * as path from "node:path";

interface ExecResult { stdout: string; stderr: string; code: number }
interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<ExecResult>;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
}

interface SessionEntry { type: string; customType?: string; data?: unknown }
interface ExtensionContext {
	cwd: string;
	hasUI?: boolean;
	sessionManager: { getEntries(): SessionEntry[] };
	ui: {
		notify(message: string, level?: string): void;
		setStatus?(key: string, value: string | undefined): void;
		setWidget?(key: string, value: string[] | undefined): void;
		theme?: { fg(style: string, value: string): string };
	};
}

type StepType = "readOnlyBuiltin" | "typedWorkflow" | "message" | "wait";
type StepStatus = "pending" | "running" | "done" | "error";
type WorkflowStateName = "idle" | "claimed" | "planning" | "plan_approved" | "implementing" | "inreview" | "reviewing" | "accepted" | "closed" | "landing" | "merged" | "blocked" | "deferred";

export interface WorkflowChainStep {
	id?: string;
	type: StepType;
	title?: string;
	message?: string;
	operation?: string;
	requiredState?: WorkflowStateName | WorkflowStateName[];
	handoff?: string;
	ms?: number;
}

export interface WorkflowChain {
	id: string;
	title: string;
	description?: string;
	steps: WorkflowChainStep[];
}

export interface LoadChainsResult {
	chains: WorkflowChain[];
	source: string;
	warnings: string[];
	error?: string;
}

export interface WorkflowSnapshot {
	activeBead?: string;
	state: WorkflowStateName;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
}

export interface StepRunState {
	index: number;
	id: string;
	title: string;
	type: StepType;
	status: StepStatus;
	elapsedMs?: number;
	output?: string;
	error?: string;
}

const CONFIG_PATHS = [
	".pi/workflow-chains.json",
	".pi/workflow-chains.yaml",
	".pi/agents/workflow-chains.json",
	".pi/agents/workflow-chains.yaml",
] as const;

const MAX_WAIT_MS = 1000;
const MAX_OUTPUT_CHARS = 600;
const MAX_OUTPUT_LINES = 12;

const BUILTIN_CHAINS: WorkflowChain[] = [
	{
		id: "demo-status",
		title: "Demo: workflow status",
		description: "Safe built-in demo chain with message, read-only status, wait, and truncated output steps.",
		steps: [
			{ id: "intro", type: "message", title: "Intro", message: "Workflow-chain demo run started." },
			{ id: "state", type: "readOnlyBuiltin", title: "Current workflow state", operation: "workflowStatus" },
			{ id: "wait", type: "wait", title: "Capped wait", ms: 25 },
			{ id: "truncate", type: "readOnlyBuiltin", title: "Truncated demo output", operation: "demoLongOutput" },
		],
	},
	{
		id: "supervisor-handoff",
		title: "Supervisor handoff preview",
		description: "Read-only preview of the typed supervisor dispatch handoff; run is blocked in v1.",
		steps: [
			{ id: "preflight", type: "typedWorkflow", title: "Dispatch supervisor", operation: "dispatch_supervisor", requiredState: "plan_approved", handoff: "Use the typed dispatch-supervisor skill/tool instead of workflow-chain run." },
		],
	},
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStepType(value: unknown): value is StepType {
	return value === "readOnlyBuiltin" || value === "typedWorkflow" || value === "message" || value === "wait";
}

function validateChain(raw: unknown, source: string, index: number): WorkflowChain {
	if (!isRecord(raw)) throw new Error(`${source}: chains[${index}] must be an object`);
	const id = asString(raw.id);
	if (!id) throw new Error(`${source}: chains[${index}].id is required`);
	const title = asString(raw.title) ?? id;
	if (!Array.isArray(raw.steps)) throw new Error(`${source}: chain ${id} steps must be an array`);
	const steps = raw.steps.map((stepRaw, stepIndex): WorkflowChainStep => {
		if (!isRecord(stepRaw)) throw new Error(`${source}: chain ${id} steps[${stepIndex}] must be an object`);
		if (!isStepType(stepRaw.type)) throw new Error(`${source}: chain ${id} steps[${stepIndex}] has unknown step type ${String(stepRaw.type)}`);
		const step: WorkflowChainStep = {
			id: asString(stepRaw.id),
			type: stepRaw.type,
			title: asString(stepRaw.title),
			message: asString(stepRaw.message),
			operation: asString(stepRaw.operation),
			handoff: asString(stepRaw.handoff),
			ms: asNumber(stepRaw.ms),
		};
		if (typeof stepRaw.requiredState === "string") step.requiredState = stepRaw.requiredState as WorkflowStateName;
		else if (Array.isArray(stepRaw.requiredState)) step.requiredState = stepRaw.requiredState.filter((item): item is WorkflowStateName => typeof item === "string") as WorkflowStateName[];
		if (step.type === "message" && !step.message) throw new Error(`${source}: chain ${id} message step requires message`);
		if ((step.type === "readOnlyBuiltin" || step.type === "typedWorkflow") && !step.operation) throw new Error(`${source}: chain ${id} ${step.type} step requires operation`);
		return step;
	});
	return { id, title, description: asString(raw.description), steps };
}

function parseJsonConfig(text: string, source: string): WorkflowChain[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${source}: malformed JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.chains)) throw new Error(`${source}: expected object with chains[]`);
	return parsed.chains.map((chain, index) => validateChain(chain, source, index));
}

function parseScalar(value: string): string | number | string[] {
	const trimmed = value.trim();
	if (/^['"].*['"]$/.test(trimmed)) return trimmed.slice(1, -1);
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	if (/^\[.*\]$/.test(trimmed)) return trimmed.slice(1, -1).split(",").map((item) => String(parseScalar(item.trim()))).filter(Boolean);
	return trimmed;
}

export function parseWorkflowChainsYaml(text: string, source = "workflow-chains.yaml"): WorkflowChain[] {
	const lines = text.split(/\r?\n/).map((raw, number) => ({ number: number + 1, raw, line: raw.replace(/#.*$/, "") })).filter((item) => item.line.trim());
	if (lines.length === 0) return [];
	if (lines[0]?.line.trim() !== "chains:") throw new Error(`${source}: YAML must start with chains:`);
	const chains: Record<string, unknown>[] = [];
	let currentChain: Record<string, unknown> | undefined;
	let currentStep: Record<string, unknown> | undefined;
	let inSteps = false;
	for (const item of lines.slice(1)) {
		const match = item.line.match(/^(\s*)(?:-\s+)?([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
		if (!match) throw new Error(`${source}: unsupported YAML syntax at line ${item.number}`);
		const indent = match[1]?.length ?? 0;
		const isList = /^\s*-\s+/.test(item.line);
		const key = match[2] ?? "";
		const value = match[3] ?? "";
		if (indent === 2 && isList) {
			currentChain = {};
			chains.push(currentChain);
			currentStep = undefined;
			inSteps = false;
			currentChain[key] = parseScalar(value);
			continue;
		}
		if (!currentChain) throw new Error(`${source}: malformed indentation or list marker at line ${item.number}`);
		if (indent === 4 && !isList) {
			if (key === "steps" && value === "") {
				inSteps = true;
				currentChain.steps = [];
				continue;
			}
			currentChain[key] = parseScalar(value);
			continue;
		}
		if (indent === 6 && isList && inSteps) {
			currentStep = {};
			(currentChain.steps as Record<string, unknown>[]).push(currentStep);
			currentStep[key] = parseScalar(value);
			continue;
		}
		if (indent === 8 && !isList && currentStep) {
			currentStep[key] = parseScalar(value);
			continue;
		}
		throw new Error(`${source}: malformed indentation or list marker at line ${item.number}`);
	}
	return chains.map((chain, index) => validateChain(chain, source, index));
}

function validateDuplicates(chains: WorkflowChain[], source: string): void {
	const seen = new Set<string>();
	for (const chain of chains) {
		if (seen.has(chain.id)) throw new Error(`${source}: duplicate chain id ${chain.id}`);
		seen.add(chain.id);
	}
}

export function loadWorkflowChains(cwd: string): LoadChainsResult {
	const warnings: string[] = [];
	for (const relativePath of CONFIG_PATHS) {
		const absolute = path.join(cwd, relativePath);
		if (!fs.existsSync(absolute)) continue;
		try {
			const content = fs.readFileSync(absolute, "utf8");
			const configured = relativePath.endsWith(".json") ? parseJsonConfig(content, relativePath) : parseWorkflowChainsYaml(content, relativePath);
			validateDuplicates(configured, relativePath);
			const builtInIds = new Set(BUILTIN_CHAINS.map((chain) => chain.id));
			for (const chain of configured) {
				if (builtInIds.has(chain.id)) throw new Error(`${relativePath}: configured chain id ${chain.id} duplicates a built-in chain`);
			}
			return { chains: [...BUILTIN_CHAINS, ...configured], source: relativePath, warnings };
		} catch (error) {
			return { chains: BUILTIN_CHAINS, source: relativePath, warnings, error: (error as Error).message };
		}
	}
	warnings.push("No project workflow-chain config found; showing built-in safe demo chains only.");
	return { chains: BUILTIN_CHAINS, source: "built-in", warnings };
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowSnapshot {
	const entry = ctx.sessionManager.getEntries().filter((item) => item.type === "custom" && item.customType === "workflow-state").pop();
	const data = isRecord(entry?.data) ? entry.data : {};
	return {
		activeBead: asString(data.activeBead),
		state: (asString(data.state) as WorkflowStateName | undefined) ?? "idle",
		branch: asString(data.branch),
		worktreePath: asString(data.worktreePath),
		startCommit: asString(data.startCommit),
	};
}

function stepTitle(step: WorkflowChainStep, index: number): string {
	return step.title ?? step.id ?? `${step.type} ${index + 1}`;
}

export function dryRunRows(chain: WorkflowChain, state: WorkflowSnapshot): string[] {
	return chain.steps.map((step, index) => {
		const required = Array.isArray(step.requiredState) ? step.requiredState.join("|") : step.requiredState ?? "-";
		const policy = step.type === "typedWorkflow" ? "blocked: typed handoff only" : "safe: no bd mutation";
		const operation = step.operation ?? step.message ?? `${Math.min(step.ms ?? 0, MAX_WAIT_MS)}ms`;
		const guard = step.requiredState && !stateMatches(state.state, step.requiredState) ? `guard: current ${state.state} not in ${required}` : `guard: ${required}`;
		return `${index + 1}. ${stepTitle(step, index)} | type=${step.type} | op=${operation} | ${guard} | ${policy}`;
	});
}

function stateMatches(current: WorkflowStateName, required: WorkflowStateName | WorkflowStateName[]): boolean {
	return Array.isArray(required) ? required.includes(current) : current === required;
}

export function typedWorkflowBlockReason(chain: WorkflowChain, state: WorkflowSnapshot): string | undefined {
	const step = chain.steps.find((item) => item.type === "typedWorkflow");
	if (!step) return undefined;
	if (step.requiredState && !stateMatches(state.state, step.requiredState)) {
		const required = Array.isArray(step.requiredState) ? step.requiredState.join("|") : step.requiredState;
		return `Blocked before mutation: ${stepTitle(step, chain.steps.indexOf(step))} requires workflow state ${required}, current state is ${state.state}. Handoff: ${step.handoff ?? step.operation}.`;
	}
	return `Blocked before mutation: workflow-critical typed step ${step.operation} is handoff-only in workflow-chain v1. Use ${step.handoff ?? step.operation} instead.`;
}

function truncateOutput(value: string): string {
	const lines = value.split(/\r?\n/).slice(0, MAX_OUTPUT_LINES);
	let text = lines.join("\n");
	if (value.split(/\r?\n/).length > MAX_OUTPUT_LINES) text += "\n… truncated lines";
	if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS - 1)}…`;
	return text;
}

async function executeReadOnly(pi: ExtensionAPI, operation: string, state: WorkflowSnapshot): Promise<string> {
	if (operation === "workflowStatus") return `state=${state.state} bead=${state.activeBead ?? "-"} branch=${state.branch ?? "-"}`;
	if (operation === "gitBranch") {
		const result = await pi.exec("git", ["branch", "--show-current"]);
		if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git branch failed");
		return result.stdout.trim();
	}
	if (operation === "gitStatus") {
		const result = await pi.exec("git", ["status", "--short"]);
		if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git status failed");
		return result.stdout.trim() || "clean";
	}
	if (operation === "demoLongOutput") return Array.from({ length: 30 }, (_, index) => `demo output line ${index + 1}`).join("\n");
	throw new Error(`Unknown readOnlyBuiltin operation ${operation}`);
}

function renderRunStates(states: StepRunState[]): string[] {
	return states.map((step) => {
		const elapsed = step.elapsedMs === undefined ? "" : ` ${step.elapsedMs}ms`;
		const suffix = step.error ? ` error=${step.error}` : step.output ? ` output=${step.output.replace(/\s+/g, " ")}` : "";
		return `${step.index + 1}. ${step.status}${elapsed} ${step.title} (${step.type})${suffix}`;
	});
}

async function runSafeChain(pi: ExtensionAPI, chain: WorkflowChain, state: WorkflowSnapshot, ctx: ExtensionContext): Promise<StepRunState[]> {
	const states = chain.steps.map((step, index): StepRunState => ({ index, id: step.id ?? String(index + 1), title: stepTitle(step, index), type: step.type, status: "pending" }));
	const update = () => ctx.ui.setWidget?.("workflow-chain", renderRunStates(states));
	update();
	for (const [index, step] of chain.steps.entries()) {
		const current = states[index];
		if (!current) continue;
		const started = Date.now();
		current.status = "running";
		update();
		try {
			if (step.type === "message") current.output = truncateOutput(step.message ?? "");
			else if (step.type === "wait") await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(step.ms ?? 0, 0), MAX_WAIT_MS)));
			else if (step.type === "readOnlyBuiltin") current.output = truncateOutput(await executeReadOnly(pi, step.operation ?? "", state));
			else throw new Error("typedWorkflow steps are not executable in workflow-chain v1");
			current.status = "done";
		} catch (error) {
			current.status = "error";
			current.error = truncateOutput((error as Error).message);
			current.elapsedMs = Date.now() - started;
			update();
			break;
		}
		current.elapsedMs = Date.now() - started;
		update();
	}
	return states;
}

function notify(ctx: ExtensionContext, message: string, level: string): void {
	ctx.ui.notify(message, level);
}

function renderList(result: LoadChainsResult): string {
	const lines = [`Workflow chains (${result.source})`];
	for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
	if (result.error) lines.push(`Config error: ${result.error}`);
	if (result.chains.length === 0) lines.push("No workflow chains available.");
	for (const chain of result.chains) lines.push(`- ${chain.id}: ${chain.title}${chain.description ? ` — ${chain.description}` : ""}`);
	lines.push("Usage: /workflow-chain dry-run <chainId> | /workflow-chain run <chainId>");
	return lines.join("\n");
}

async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const [action, chainId] = args.trim().split(/\s+/).filter(Boolean);
	const loaded = loadWorkflowChains(ctx.cwd);
	const state = latestWorkflowState(ctx);
	ctx.ui.setStatus?.("workflow-chain", "chain");
	if (!action || action === "list") {
		notify(ctx, renderList(loaded), loaded.error ? "error" : "info");
		return;
	}
	if (action === "help") {
		notify(ctx, "Usage: /workflow-chain [list] | dry-run <chainId> | run <chainId>. Alias: /chain", "info");
		return;
	}
	if (!chainId || (action !== "dry-run" && action !== "run")) {
		notify(ctx, `Unknown or incomplete workflow-chain command: ${args || "(empty)"}. Usage: /workflow-chain dry-run <chainId> | run <chainId>`, "error");
		return;
	}
	if (loaded.error) {
		notify(ctx, `Workflow-chain config error; run blocked. ${loaded.error}`, "error");
		return;
	}
	const chain = loaded.chains.find((item) => item.id === chainId);
	if (!chain) {
		notify(ctx, `Unknown workflow chain ${chainId}. Available: ${loaded.chains.map((item) => item.id).join(", ") || "none"}`, "error");
		return;
	}
	if (action === "dry-run") {
		const rows = dryRunRows(chain, state);
		ctx.ui.setWidget?.("workflow-chain", rows);
		notify(ctx, [`Dry-run ${chain.id}: ${chain.title}`, ...rows].join("\n"), "info");
		return;
	}
	const block = typedWorkflowBlockReason(chain, state);
	if (block) {
		notify(ctx, block, "error");
		return;
	}
	const states = await runSafeChain(pi, chain, state, ctx);
	const failed = states.find((step) => step.status === "error");
	notify(ctx, [`Run ${chain.id}: ${failed ? "error" : "done"}`, ...renderRunStates(states)].join("\n"), failed ? "error" : "success");
}

export default function workflowChainExtension(pi: ExtensionAPI): void {
	const command = { description: "List, dry-run, or run safe Pi workflow chains", handler: async (args: string, ctx: ExtensionContext) => handleCommand(pi, args, ctx) };
	pi.registerCommand("workflow-chain", command);
	pi.registerCommand("chain", command);
}
