import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	publishDashboardCard,
	registerDashboardWidgetHost,
} from "../subagent/dashboard";
import { inferTargetFilesFromText, renderPathRulesLoaded } from "../path-rules/index";
import { resolveActiveTaskScope, taskScopeErrorToPolicyReason, taskScopeFromContext, type TaskScope } from "../worktree-scope/index";
import { resolveAgentModelFromCwd } from "../agent-models/index";
import {
	appendPanesEnv,
	beadSuffixFromId,
	buildCloseWorkspaceArgv,
	buildCmuxRenameArgv,
	buildListPaneSurfacesArgv,
	buildListWorkspacesArgv,
	buildNewWorkspaceArgv,
	buildReorderWorkspaceArgv,
	buildSetWorkspaceColorArgv,
	buildSpawnLockComment,
	buildSpawnLockReleaseComment,
	buildSpawnLockSpawnedComment,
	buildTaskWorkspaceChildCommand,
	buildTaskWorkspaceName,
	buildVisibleChildArgv,
	buildVisibleFollowupPayload,
	buildVisibleChildSpawnPayload,
	classifyVisiblePane,
	extractWorkspaceGroupId,
	findLiveFollowupEntry,
	findLiveRegistryEntriesForBead,
	findLiveSupervisorSpawnsForWorktree,
	findRegistryByTaskId,
	findWorkspaceRow,
	getCmuxAdapterForTests,
	isSpawnLockBlocking,
	liveEntriesForBead,
	loadRegistry,
	mainCheckoutFromGitCommonDir,
	nsDir,
	orchRoot,
	ORCHESTRATOR_TAB_TITLE,
	parseFirstTerminalSurfaceRef,
	parseNewWorkspaceRef,
	persistIsolationFiles,
	pickTaskWorkspaceColor,
	posixQuote,
	readDigestPreview,
	resolveVisibleSplitAnchor,
	saveRegistry,
	tombstoneRegistryEntry,
	unlinkFollowupArtifacts,
	unlinkIsolationFiles,
	validateTaskWorkspaceTitle,
	validateVisibleChildArgv,
	visibleChildTabTitle,
	visibleCmuxSpawnFailReason,
	worktreeOrchDir,
	type CmuxAdapter,
	type DispatchRegistryEntry,
} from "./cmux-transport";
export {
	beadSuffixFromId,
	buildCloseWorkspaceArgv,
	buildCmuxRenameArgv,
	buildListPaneSurfacesArgv,
	buildListWorkspacesArgv,
	buildNewWorkspaceArgv,
	buildReorderWorkspaceArgv,
	buildSetWorkspaceColorArgv,
	buildSpawnLockComment,
	buildSpawnLockReleaseComment,
	buildSpawnLockSpawnedComment,
	buildTaskWorkspaceChildCommand,
	buildTaskWorkspaceName,
	buildVisibleChildArgv,
	buildVisibleChildSpawnPayload,
	buildVisibleFollowupPayload,
	classifyVisiblePane,
	countTitleWords,
	extractWorkspaceGroupId,
	followupPayloadLooksLikeSpawnArgv,
	findLiveFollowupEntry,
	findLiveRegistryEntriesForBead,
	findLiveSupervisorSpawnsForWorktree,
	findWorkspaceRow,
	isSpawnLockBlocking,
	mainCheckoutFromGitCommonDir,
	ORCHESTRATOR_TAB_TITLE,
	parseFirstTerminalSurfaceRef,
	parseNewWorkspaceRef,
	parseSpawnLockComment,
	pickTaskWorkspaceColor,
	resolveVisibleSplitAnchor,
	SPAWN_LOCK_MARKER,
	TASK_WORKSPACE_COLOR_PALETTE,
	tombstoneRegistryEntry,
	unlinkFollowupArtifacts,
	posixQuote,
	validateTaskWorkspaceTitle,
	validateVisibleChildArgv,
	visibleChildTabTitle,
	visibleCmuxSpawnFailReason,
	pruneRegistry,
	persistIsolationFiles,
	setCmuxAdapterForTests,
	orchRoot,
	nsDir,
	loadRegistry,
	saveRegistry,
	findRegistryByTaskId,
} from "./cmux-transport";

interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	registerTool(tool: any): void;
	events: { emit(name: string, event: Record<string, unknown>): void };
}

interface ToolContext {
	cwd: string;
	ui?: any;
	sessionManager?: { getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }> };
}

interface BeadInfo {
	id: string;
	title?: string;
	description?: string;
	status?: string;
	assignee?: string;
	labels?: string[];
	dependencies?: DependencyInfo[];
	parent?: string;
}

interface DependencyInfo {
	id?: string;
	issue_id?: string;
	depends_on_id?: string;
	status?: string;
	type?: string;
	dependency_type?: string;
	title?: string;
}

interface BeadComment {
	text?: string;
	created_at?: string;
}

interface AgentConfig {
	name: string;
	filePath: string;
	systemPrompt: string;
	tools?: string;
	model?: string;
	/** Explicit thinking including "off"; undefined = session inherit. */
	thinking?: string;
}

interface DispatchResult {
	agent: string;
	beadId: string;
	branch: string;
	worktreePath: string;
	startCommit: string;
	endCommit?: string;
	exitCode: number;
	output: string;
	stderr: string;
	/** Resolved child model id when set; omit/empty means session inherit. */
	model?: string;
	/** Resolved thinking when set (including "off"); omit means session inherit. */
	thinking?: string;
	transport?: DispatchTransport;
	status?: string;
	pane?: string;
	taskFile?: string;
	resultFile?: string;
	registryKey?: string;
	/** Sticky tab-title rename outcomes (cmux visible spawn). */
	renameAttempts?: number;
	renameFailures?: number;
	renameLastError?: string;
}

type DispatchTransport = "headless" | "cmux";
type DispatchToolParams = { beadId: string; agent?: string; task?: string; cwd?: string; dryRun?: boolean; transport?: DispatchTransport };

/**
 * Explicit transport always wins.
 * Omit + interactive UI (ctx.hasUI) → cmux (no headless hang when agent forgets transport).
 * Omit + no UI (CI/headless host) → headless.
 */
export function resolveDispatchTransport(
	params: { transport?: DispatchTransport | string },
	ctx?: unknown,
): DispatchTransport {
	if (params.transport === "cmux" || params.transport === "headless") return params.transport;
	const hasUI = Boolean(ctx && typeof ctx === "object" && "hasUI" in ctx && (ctx as { hasUI?: boolean }).hasUI);
	return hasUI ? "cmux" : "headless";
}

interface SupervisorDispatchApi<Ctx = unknown> {
	dispatchSupervisor(params: DispatchToolParams, ctx: Ctx, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const SUPERVISOR_DISPATCH_API_KEY = "__piSupervisorDispatchApi";

interface SupervisorDispatchApiRegistryState {
	byPi: WeakMap<object, SupervisorDispatchApi>;
	latest?: SupervisorDispatchApi;
}

function supervisorDispatchApiRegistry(): SupervisorDispatchApiRegistryState {
	const root = globalThis as typeof globalThis & { [SUPERVISOR_DISPATCH_API_KEY]?: SupervisorDispatchApiRegistryState };
	root[SUPERVISOR_DISPATCH_API_KEY] ??= { byPi: new WeakMap<object, SupervisorDispatchApi>() };
	return root[SUPERVISOR_DISPATCH_API_KEY];
}

export function registerSupervisorDispatchApi<Ctx = unknown>(pi: object, api: SupervisorDispatchApi<Ctx>): void {
	const registry = supervisorDispatchApiRegistry();
	const typedApi = api as SupervisorDispatchApi;
	registry.byPi.set(pi, typedApi);
	registry.latest = typedApi;
}

export async function requestSupervisorDispatch<Ctx = unknown>(pi: object, params: DispatchToolParams, ctx: Ctx, signal?: AbortSignal): Promise<{ ok: boolean; text: string; details?: unknown; error?: string }> {
	const registry = supervisorDispatchApiRegistry();
	const api = registry.byPi.get(pi) ?? registry.latest;
	if (!api) return { ok: false, text: "", error: "runtime hook missing: dispatch_supervisor API is unavailable" };
	try {
		const result = await api.dispatchSupervisor(params, ctx, signal);
		const text = result.content.map((item) => item.text).join("\n");
		const details = result.details as { error?: string } | undefined;
		if (details?.error) return { ok: false, text, details: result.details, error: details.error };
		return { ok: true, text, details: result.details };
	} catch (error) {
		return { ok: false, text: "", error: (error as Error).message };
	}
}

interface ReviewerDispatchApi<Ctx = unknown> {
	dispatchReviewer(params: DispatchToolParams, ctx: Ctx, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const REVIEWER_DISPATCH_API_KEY = "__piReviewerDispatchApi";

interface ReviewerDispatchApiRegistryState {
	byPi: WeakMap<object, ReviewerDispatchApi>;
	latest?: ReviewerDispatchApi;
}

function reviewerDispatchApiRegistry(): ReviewerDispatchApiRegistryState {
	const root = globalThis as typeof globalThis & { [REVIEWER_DISPATCH_API_KEY]?: ReviewerDispatchApiRegistryState };
	root[REVIEWER_DISPATCH_API_KEY] ??= { byPi: new WeakMap<object, ReviewerDispatchApi>() };
	return root[REVIEWER_DISPATCH_API_KEY];
}

export function registerReviewerDispatchApi<Ctx = unknown>(pi: object, api: ReviewerDispatchApi<Ctx>): void {
	const registry = reviewerDispatchApiRegistry();
	const typedApi = api as ReviewerDispatchApi;
	registry.byPi.set(pi, typedApi);
	registry.latest = typedApi;
}

export async function requestReviewerDispatch<Ctx = unknown>(pi: object, params: DispatchToolParams, ctx: Ctx, signal?: AbortSignal): Promise<{ ok: boolean; text: string; details?: unknown; error?: string }> {
	const registry = reviewerDispatchApiRegistry();
	const api = registry.byPi.get(pi) ?? registry.latest;
	if (!api) return { ok: false, text: "", error: "runtime hook missing: dispatch_reviewer API is unavailable" };
	try {
		const result = await api.dispatchReviewer(params, ctx, signal);
		const text = result.content.map((item) => item.text).join("\n");
		const details = result.details as { error?: string } | undefined;
		if (details?.error) return { ok: false, text, details: result.details, error: details.error };
		return { ok: true, text, details: result.details };
	} catch (error) {
		return { ok: false, text: "", error: (error as Error).message };
	}
}

/** Parsed inbound visible ping from ping.sh / cmux send into orch input. */
export type ParsedVisiblePing = {
	kind: "ok" | "error";
	taskId?: string;
	missingId: boolean;
	text: string;
};

/**
 * Parse orch-inbound `[PING]` / `[PING-ERROR]` lines.
 * taskId from `taskId=` OR `задача <id>`; missing id → missingId=true (caller STOPs, no complete).
 */
export function parseVisiblePing(text: string): ParsedVisiblePing | undefined {
	const raw = text ?? "";
	const errorMatch = raw.match(/\[PING-ERROR\]/i);
	const okMatch = !errorMatch && raw.match(/\[PING\]/i);
	if (!errorMatch && !okMatch) return undefined;
	const taskIdEquals = raw.match(/\btaskId\s*=\s*([^\s,;]+)/i)?.[1];
	const taskIdZadacha = raw.match(/задача\s+([^\s:.,;]+)/iu)?.[1];
	const taskId = (taskIdEquals ?? taskIdZadacha)?.replace(/[\]'"`]+$/u, "").trim() || undefined;
	return {
		kind: errorMatch ? "error" : "ok",
		taskId,
		missingId: !taskId,
		text: raw,
	};
}

const DispatchParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Bead ID to dispatch" },
		agent: { type: "string", description: "Agent name override" },
		task: { type: "string", description: "Short task summary. Full context is read from bead." },
		cwd: { type: "string", description: "Working directory for the subagent process" },
		dryRun: { type: "boolean", description: "Prepare and log dispatch without spawning Pi", default: false },
	},
	required: ["beadId"],
	additionalProperties: false,
} as const;

const SupervisorDispatchParams = {
	type: "object",
	properties: {
		...DispatchParams.properties,
		transport: {
			type: "string",
			enum: ["headless", "cmux"],
			description:
				"cmux = visible pane spawn-ack; headless = blocking dark window. Omit: cmux when interactive UI (hasUI), headless when no UI (CI). Explicit transport=headless required for CI/dark-window.",
		},
	},
	required: ["beadId"],
	additionalProperties: false,
} as const;

const ReviewerDispatchParams = {
	type: "object",
	properties: {
		...DispatchParams.properties,
		transport: {
			type: "string",
			enum: ["headless", "cmux"],
			description:
				"cmux = one visible code-reviewer pane; headless = blocking fallback. Omit: cmux when interactive UI (hasUI), headless when no UI (CI). Explicit transport=headless required for CI/dark-window.",
		},
	},
	required: ["beadId"],
	additionalProperties: false,
} as const;

const FollowupVisibleDispatchParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Bead ID with a live spawned supervisor or code-reviewer pane" },
		task: { type: "string", description: "Follow-up task text sent into the waiting Pi (not spawn argv)" },
		role: { type: "string", description: "Pane role when more than one live pane exists; use code-reviewer for the visible reviewer" },
	},
	required: ["beadId", "task"],
	additionalProperties: false,
} as const;

type FollowupVisibleParams = { beadId: string; task: string; role?: string };

const SpawnTaskWorkspaceParams = {
	type: "object",
	properties: {
		beadId: {
			type: "string",
			description: "Open target bead to run in a parallel cmux workspace. Parent must NOT workflow_claim this id.",
		},
		title: {
			type: "string",
			description: "Exactly 2–3 words of essence without · suffix or bead id. Tool appends · {suffix}.",
		},
		description: {
			type: "string",
			description: "Optional workspace description (defaults to bead title).",
		},
		color: {
			type: "string",
			description: "Optional sidebar row color (name or #hex). Default rotates Indigo→Teal→Orange→Purple→Green→Amber, skipping parent color.",
		},
		dryRun: {
			type: "boolean",
			description: "Plan argv only: no cmux create, no SPAWN_LOCK write.",
			default: false,
		},
	},
	required: ["beadId", "title"],
	additionalProperties: false,
} as const;

type SpawnTaskWorkspaceToolParams = {
	beadId: string;
	title: string;
	description?: string;
	color?: string;
	dryRun?: boolean;
};

export type SpawnTaskWorkspaceResult = {
	status: "spawned" | "dry-run" | "blocked";
	beadId: string;
	workspaceName: string;
	workspaceRef?: string;
	surface?: string;
	mainCwd: string;
	color?: string;
	colorWarning?: string;
	renameWarning?: string;
	groupUsed?: boolean;
	argvPlan?: string[][];
	text: string;
};

const FOLLOWUP_ALLOWED_STATUSES = new Set(["in_progress", "inreview"]);

function parseFrontmatter(markdown: string): { data: Record<string, string>; body: string } {
	if (!markdown.startsWith("---\n")) return { data: {}, body: markdown };
	const end = markdown.indexOf("\n---\n", 4);
	if (end < 0) return { data: {}, body: markdown };
	const raw = markdown.slice(4, end);
	const data: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match?.[1]) data[match[1]] = (match[2] ?? "").replace(/^['\"]|['\"]$/g, "");
	}
	return { data, body: markdown.slice(end + 5).trimStart() };
}

function loadAgent(cwd: string, name: string): AgentConfig {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	if (!fs.existsSync(filePath)) {
		throw new Error(`Agent not found: ${filePath}. Create .pi/agents/${name}.md first.`);
	}
	const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
	// Project .pi/agent-models.json is source of truth (role override > class > inherit).
	// Frontmatter model is not used for routing.
	const resolved = resolveAgentModelFromCwd(cwd, name);
	return {
		name: parsed.data.name || name,
		filePath,
		systemPrompt: parsed.body,
		tools: parsed.data.tools,
		model: resolved.model,
		thinking: resolved.thinking,
	};
}

async function execJson(pi: ExtensionAPI, command: string, args: string[]): Promise<any> {
	const { stdout, stderr, code } = await pi.exec(command, args);
	if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
	return JSON.parse(stdout);
}

async function getBead(pi: ExtensionAPI, beadId: string): Promise<BeadInfo> {
	const json = await execJson(pi, "bd", ["show", beadId, "--json"]);
	const bead = Array.isArray(json) ? json[0] : json;
	if (!bead?.id) throw new Error(`bd show returned no bead for ${beadId}`);
	return bead;
}

async function getComments(pi: ExtensionAPI, beadId: string): Promise<BeadComment[]> {
	const json = await execJson(pi, "bd", ["comments", beadId, "--json"]);
	return Array.isArray(json) ? json : [];
}

async function getGitValue(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const { stdout, stderr, code } = await pi.exec("git", ["-C", cwd, ...args]);
	if (code !== 0) throw new Error(`git -C ${cwd} ${args.join(" ")} failed: ${stderr || stdout}`);
	return stdout.trim();
}

/** Pick supervisor role from bead labels/text. Bare "tauri" in prose (role names) must not force tauri-supervisor. */
export function chooseSupervisor(bead: BeadInfo): string {
	const labels = new Set(bead.labels ?? []);
	const text = `${bead.title ?? ""}\n${bead.description ?? ""}`.toLowerCase();
	// Keep rust|cargo|src-tauri; omit bare tauri so role-words like tauri-supervisor do not misroute.
	if (labels.has("backend") || labels.has("tracker") || /rust|cargo|src-tauri/.test(text)) return "tauri-supervisor";
	if (labels.has("ci") || labels.has("dx") || /test|vitest|ci|workflow/.test(text)) return "test-supervisor";
	if (labels.has("frontend") || labels.has("ui") || labels.has("data") || /vue|component|composable|page|app\//.test(text)) {
		return "vue-supervisor";
	}
	return "test-supervisor";
}

const REQUIRED_HANDOFF_SECTIONS = [
	"### Origin",
	"### Files",
	"### Current state",
	"### Target state",
	"### Investigation findings",
	"### Decisions",
	"### Rejected alternatives",
	"### Dependencies / blockers",
	"### Acceptance criteria",
	"### Verification / acceptance checks",
	"### Out of scope",
];

const TERMINAL_STATUSES = new Set(["closed", "done", "cancelled", "deferred"]);
/** Terminal for happy-path pane close: includes blocked (no reuse planned). reviewed is NOT terminal. */
const CLOSE_VISIBLE_TERMINAL_STATUSES = new Set(["closed", "done", "cancelled", "deferred", "blocked"]);
/** Non-terminal STOP close allowlist (grey-matrix hop). pendingFix still wins. */
const CLOSE_VISIBLE_STOP_CLOSE_STATUSES = new Set(["reviewed"]);
const ALLOWED_SUPERVISOR_STATUSES = new Set(["in_progress"]);

const VAGUE_ACCEPTANCE_PATTERN = /\b(done|works|fixed|complete|completed|ok|looks good|as expected|готово|работает|исправлено|завершено|нормально)\b/i;
export const PLAN_APPROVED_READINESS_MATRIX = {
	marker: "PLAN APPROVED",
	fields: [
		{ name: "Approved-by", aliases: ["Approved-by:"] },
		{ name: "Approved-at", aliases: ["Approved-at:"] },
		{ name: "Start commit", aliases: ["Start-commit:", "START_COMMIT:"] },
		{ name: "Files to change", aliases: ["Files to change:"] },
		{ name: "Acceptance", aliases: ["Acceptance:"] },
		{ name: "Verification / acceptance checks", aliases: ["Verification / acceptance checks:"] },
	],
	intent: [
		{ name: "current Plan", aliases: ["Plan:"] },
		{ name: "legacy Problem + Approach", aliases: ["Problem:", "Approach:"] },
	],
	acceptedContextFields: [
		"Problem:",
		"Approach:",
		"Rejected alternatives:",
		"Edge-case review:",
		"Worktree / cwd:",
		"WORKTREE_LOCK:",
		"Risks / rollback:",
		"AUTO_EXECUTE_ALLOWED: true",
	],
} as const;

function hasBullet(section: string): boolean {
	return /(^|\n)\s*([-*]|\d+\.)\s+\S+/.test(section);
}

function isVagueOnly(section: string): boolean {
	const compact = section
		.replace(/(^|\n)\s*([-*]|\d+\.)\s+/g, " ")
		.replace(/[`*_"']/g, "")
		.trim();
	return compact.length > 0 && compact.length < 80 && VAGUE_ACCEPTANCE_PATTERN.test(compact);
}

function hasConcreteBullets(section: string): boolean {
	return hasBullet(section) && !isVagueOnly(section);
}

function extractSection(text: string, heading: string): string {
	const start = text.indexOf(heading);
	if (start < 0) return "";
	const after = text.slice(start + heading.length);
	const next = after.search(/\n###\s+/);
	return (next >= 0 ? after.slice(0, next) : after).trim();
}

function isPlanApprovedComment(text: string): boolean {
	const firstLine = firstNonEmptyLine(text) ?? "";
	return /^(?:#{1,6}\s*)?PLAN APPROVED\b/.test(firstLine);
}

function getPlanComment(comments: BeadComment[]): string | undefined {
	return comments.map((comment) => comment.text ?? "").reverse().find((text) => isPlanApprovedComment(text));
}

function extractRecordedStartCommit(comments: BeadComment[]): string | undefined {
	for (const text of comments.map((comment) => comment.text ?? "").reverse()) {
		if (!/DISPATCH(?: RESULT)?|WORKFLOW SUBMIT FOR REVIEW|PI WORKFLOW UPDATE|PLAN APPROVED/.test(text)) continue;
		const match = text.match(/(?:^|\n)\s*(?:START_COMMIT|Start-commit):\s*([0-9a-f]{7,40})\b/i);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

function visibleDispatchTaskId(beadId: string, role: string): string {
	const beadSlug = beadId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-24);
	const roleSlug = role.replace(/[^a-zA-Z0-9._-]+/g, "-");
	return `task-${beadSlug}-${roleSlug}`;
}

const VISIBLE_REVIEWER_VERDICT_RE = /(?:^|\n)\s*(?:[-*>]\s*)?(?:VERDICT|CODE REVIEW)\s*:\s*(APPROVED|NOT[_ ]APPROVED)\b/gi;

function parseVisibleReviewerVerdict(text: string): "APPROVED" | "NOT APPROVED" | undefined {
	let latest: string | undefined;
	VISIBLE_REVIEWER_VERDICT_RE.lastIndex = 0;
	for (const match of text.matchAll(VISIBLE_REVIEWER_VERDICT_RE)) {
		latest = (match[1] ?? "").toUpperCase().replace(/_/g, " ");
	}
	if (latest === "APPROVED") return "APPROVED";
	if (latest === "NOT APPROVED") return "NOT APPROVED";
	return undefined;
}

function hasPlanAlias(plan: string, alias: string): boolean {
	const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\n)\\s*${escaped}`).test(plan);
}

function missingPlanFields(plan: string | undefined): string[] {
	if (!plan) {
		return [
			PLAN_APPROVED_READINESS_MATRIX.marker,
			...PLAN_APPROVED_READINESS_MATRIX.fields.map((field) => `${field.name} (${field.aliases.join(" or ")})`),
			"Implementation intent (Plan: or Problem: + Approach:)",
		];
	}
	const missing: string[] = [];
	if (!plan.includes(PLAN_APPROVED_READINESS_MATRIX.marker)) missing.push(PLAN_APPROVED_READINESS_MATRIX.marker);
	for (const field of PLAN_APPROVED_READINESS_MATRIX.fields) {
		if (!field.aliases.some((alias) => hasPlanAlias(plan, alias))) missing.push(`${field.name} (${field.aliases.join(" or ")})`);
	}
	const hasIntent = PLAN_APPROVED_READINESS_MATRIX.intent.some((group) => group.aliases.every((alias) => hasPlanAlias(plan, alias)));
	if (!hasIntent) missing.push("Implementation intent (Plan: or Problem: + Approach:)");
	return missing;
}

function dependencyId(dep: DependencyInfo): string | undefined {
	return dep.depends_on_id ?? dep.id;
}

function dependencyType(dep: DependencyInfo): string | undefined {
	return dep.type ?? dep.dependency_type;
}

function unresolvedBlockers(bead: BeadInfo): DependencyInfo[] {
	return (bead.dependencies ?? []).filter((dep) => dependencyType(dep) === "blocks" && dep.status !== "closed");
}

export function validateSupervisorReadiness(bead: BeadInfo, comments: BeadComment[]): string[] {
	const errors: string[] = [];
	if (!bead.id) errors.push("bead не найден или bd show не вернул id");
	if (bead.status && TERMINAL_STATUSES.has(bead.status)) errors.push(`terminal bead нельзя dispatch: status=${bead.status}`);
	if (!ALLOWED_SUPERVISOR_STATUSES.has(bead.status ?? "")) errors.push(`dispatch_supervisor требует status in_progress, получен ${bead.status ?? "unknown"}`);
	if ((bead.labels ?? []).length === 0) errors.push("перед supervisor dispatch у bead должен быть хотя бы один label");

	const missingSections = REQUIRED_HANDOFF_SECTIONS.filter((section) => !bead.description?.includes(section));
	if (missingSections.length > 0) errors.push(`отсутствуют handoff sections: ${missingSections.join(", ")}`);
	if (!hasConcreteBullets(extractSection(bead.description ?? "", "### Acceptance criteria"))) errors.push("Acceptance criteria должны содержать конкретные bullet-проверки без vague формулировок");
	if (!hasConcreteBullets(extractSection(bead.description ?? "", "### Verification / acceptance checks"))) errors.push("Verification / acceptance checks должны содержать конкретные bullet-проверки без vague формулировок");

	const blockers = unresolvedBlockers(bead);
	if (blockers.length > 0) errors.push(`есть unresolved blockers: ${blockers.map((dep) => dependencyId(dep) ?? "unknown").join(", ")}`);
	const plan = getPlanComment(comments);
	const missingFields = missingPlanFields(plan);
	if (missingFields.length > 0) errors.push(`в PLAN APPROVED comment отсутствуют fields: ${missingFields.join(", ")}`);
	if ((bead.parent || (bead.dependencies ?? []).some((dep) => dependencyType(dep) === "parent-child")) && !getParentId(bead)) {
		errors.push("dispatch epic child требует parent/EPIC_ID context");
	}
	return errors;
}

function getParentId(bead: BeadInfo): string | undefined {
	return bead.parent ?? (bead.dependencies ?? []).find((dep) => dependencyType(dep) === "parent-child")?.depends_on_id;
}


function firstNonEmptyLine(section: string): string | undefined {
	return section.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
}

function extractPlanField(plan: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*`).exec(plan);
	if (!match) return "";
	const start = (match.index ?? 0) + match[0].length;
	const rest = plan.slice(start);
	const next = rest.search(/\n\s*[A-Za-z][A-Za-z0-9 /_-]*:\s*/);
	return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function sectionOrNa(plan: string, heading: string): string {
	const section = extractPlanField(plan, heading).trim();
	return section.length > 0 ? section : "N/A";
}

function normalizeListSection(section: string): string {
	const lines = section
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : "N/A";
}

function buildExecutionContract(bead: BeadInfo, plan: string): string {
	const planFiles = normalizeListSection(sectionOrNa(plan, "Files to change:"));
	const beadFiles = normalizeListSection(extractSection(bead.description ?? "", "### Files"));
	const outOfScope = normalizeListSection(extractSection(bead.description ?? "", "### Out of scope"));
	const verification = normalizeListSection(sectionOrNa(plan, "Verification / acceptance checks:"));
	const worktreeLock = sectionOrNa(plan, "WORKTREE_LOCK:");
	const siblingStreams = sectionOrNa(plan, "Sibling streams:");
	const explicitDoNotTouch = sectionOrNa(plan, "Do not touch:");
	const doNotTouch = explicitDoNotTouch !== "N/A" ? explicitDoNotTouch : outOfScope;

	return `EXECUTION CONTRACT:

Write zone:
${planFiles !== "N/A" ? planFiles : beadFiles}

Do not touch:
${doNotTouch}

Sibling streams:
${siblingStreams}

Stop rules:
- Stop with NEEDS_CONTEXT if requirements, acceptance, dependencies, write zone, or verification are unclear.
- Stop with BLOCKED if branch/worktree/start commit are unsafe, required dependencies are unresolved, checks fail without a scoped local fix, or policy/tooling blocks required work.
- Do not edit outside Write zone without explicit approval; if the approved plan needs expansion, stop and report the exact scope gap.
- Worktree lock: ${firstNonEmptyLine(worktreeLock) ?? "N/A"}

Verification:
${verification}

SUPERVISOR ARTIFACT:
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Files changed: <paths or N/A>
- Verification: <command/manual check, exit code or observed result, output excerpt; use N/A only with reason>
- Commit: <sha or not committed with reason>
- Concerns: <risks/follow-ups or N/A>
- Artifact status: <complete | incomplete, with reason if incomplete>`;
}

function wrapperWorkflowBoundary(): string {
	return `WRAPPER WORKFLOW BOUNDARY:
- dispatch_supervisor already performed typed workflow preflight before spawning this supervisor.
- Do not call or depend on workflow_status, workflow_submit_for_review, workflow_complete, dispatch_supervisor, dispatch_reviewer, dispatch_docs_agent, or review_bead inside the child process.
- If the approved plan contains older wording that assigns typed workflow preflight/submit to the supervisor, treat it as wrapper responsibility and continue with implementation evidence only.
- After implementation, commit explicit files, write result+digest, and run the task-body ping.sh; the wrapper/orchestrator owns review-transition routing after ping.
- Visible ping.sh is still required on DONE/BLOCKED/NEEDS_CONTEXT. Chat completion report is not delivery.`;
}

function normalizeArtifactText(output: string): string {
	return output.replace(/\\n/g, "\n");
}

export function supervisorArtifactReadyForReview(result: { exitCode: number; output: string }, startCommit: string, endCommit: string): boolean {
	if (result.exitCode !== 0 || endCommit === startCommit) return false;
	const artifact = normalizeArtifactText(result.output);
	const hasDoneStatus = /Status:\s*DONE(?:_WITH_CONCERNS)?\b/i.test(artifact);
	const hasCompleteArtifact = /Artifact status:\s*complete\b/i.test(artifact);
	const hasVerificationEvidence = /Verification:\s*(?!N\/A\b|not run\b|not\s+run\b).*(exit(?:\s+code)?\s*=?\s*\d+|observed result|output excerpt|manual check|passed|pass\b)/is.test(artifact);
	const hasCommitEvidence = /Commit:\s*(?!N\/A\b|not committed\b)[0-9a-f]{7,40}\b/i.test(artifact);
	return hasDoneStatus && hasCompleteArtifact && hasVerificationEvidence && hasCommitEvidence;
}

function summarizeContext(bead: BeadInfo): string {
	const parent = getParentId(bead) ?? "-";
	return [`Title: ${bead.title ?? bead.id}`, `Status: ${bead.status ?? "unknown"}`, `Labels: ${(bead.labels ?? []).join(", ") || "-"}`, `EPIC_ID: ${parent}`].join("\n");
}

export function buildSupervisorPrompt(bead: BeadInfo, comments: BeadComment[], branch: string, startCommit: string, task?: string, pathRules = "PATH_RULES_LOADED:\nNot evaluated."): string {
	const plan = getPlanComment(comments) ?? "PLAN APPROVED comment not found";
	const epicId = getParentId(bead) ?? "-";
	return `BEAD_ID: ${bead.id}
EPIC_ID: ${epicId}
BRANCH: ${branch}
START_COMMIT: ${startCommit}

TASK: ${task || bead.title || "Implement the bead"}

CONTEXT SUMMARY:
${summarizeContext(bead)}

${wrapperWorkflowBoundary()}

APPROVED PLAN:
${plan}

${buildExecutionContract(bead, plan)}

${pathRules}

Read the bead first:
- bd show ${bead.id}
- bd comments ${bead.id}

Do not guess:
- If requirements, acceptance, dependencies, or approach are unclear, stop before editing and return NEEDS_CONTEXT with specific questions.
- If you are in over your head, stop and return BLOCKED or NEEDS_CONTEXT; bad work is worse than no work.

Status vocabulary:
- DONE: implementation complete with evidence and commit.
- DONE_WITH_CONCERNS: complete but follow-up risk remains.
- BLOCKED: cannot proceed due to dependency/environment/policy.
- NEEDS_CONTEXT: needs user/orchestrator clarification.

Follow Pi supervisor discipline:
- Do not call bd close.
- Do not git push.
- Do not set orchestrator statuses (simplified/reviewed/accepted).
- Provide fresh evidence for every completion claim: command, output summary, exit code.
- If blocked or uncertain, stop with BLOCKED or NEEDS_CONTEXT.

When implementation is complete:
1. Run relevant checks.
2. Commit only explicit files if code changed.
3. Do not call typed workflow tools; do not push or close the bead.
4. Return a concise completion report with the SUPERVISOR ARTIFACT fields.`;
}

function buildReviewerPrompt(bead: BeadInfo, branch: string, startCommit: string, task?: string): string {
	return `BEAD_ID: ${bead.id}
BRANCH: ${branch}
START_COMMIT: ${startCommit}

REVIEW TASK: ${task || "Review implementation for this bead"}

Read bd show/comments and review git diff ${startCommit}..HEAD.
First verify spec compliance against bead context and PLAN comments. Then review code quality.
Return verdict: APPROVED or NOT APPROVED [SPEC_GAP|QUALITY] with evidence.`;
}

function buildDocsPrompt(bead: BeadInfo, branch: string, startCommit: string, task?: string): string {
	return `BEAD_ID: ${bead.id}
BRANCH: ${branch}
START_COMMIT: ${startCommit}

DOCS TASK: ${task || "Update documentation if needed for this work"}

Review git diff ${startCommit}..HEAD and update CHANGELOG.md, README.md, or docs/ only if user-facing docs are affected.
Return DOCS REPORT with files changed and evidence.`;
}

async function writeTempPrompt(agentName: string, prompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dispatch-"));
	const file = path.join(dir, `prompt-${agentName}.md`);
	await fs.promises.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
	return { command: process.execPath, args };
}

function bindDashboardHost(ctx?: { ui?: any; hasUI?: boolean }): void {
	if (!ctx) return;
	registerDashboardWidgetHost({
		hasUI: Boolean(ctx.hasUI ?? ctx.ui),
		ui: ctx.ui,
	});
}

function publishWorkflowDashboardCard(ctx: { ui?: any; hasUI?: boolean } | undefined, agent: AgentConfig, card: Partial<Parameters<typeof publishDashboardCard>[0]>): void {
	bindDashboardHost(ctx);
	publishDashboardCard({
		agent: agent.name,
		description: `workflow dispatch: ${agent.name}`,
		source: "project",
		status: "running",
		startedAt: Date.now(),
		toolCount: 0,
		...card,
	});
}

async function runPiAgent(agent: AgentConfig, prompt: string, cwd: string, signal?: AbortSignal, ctx?: { ui?: any }): Promise<{ exitCode: number; output: string; stderr: string }> {
	const systemPrompt = await writeTempPrompt(agent.name, agent.systemPrompt);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPrompt.file];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools) args.push("--tools", agent.tools);
	args.push(`Task: ${prompt}`);

	try {
		const invocation = getPiInvocation(args);
		const startedAt = Date.now();
		publishWorkflowDashboardCard(ctx, agent, { status: "running", task: prompt.split("\n")[0] || "Workflow dispatch", startedAt, lastPreview: "starting Pi workflow agent..." });
		return await new Promise((resolve) => {
			const proc = spawnForDispatch(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			let stderr = "";
			let wasAborted = false;
			let settled = false;
			const finish = (exitCode: number, finalStderr = stderr) => {
				if (settled) return;
				settled = true;
				const status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
				publishWorkflowDashboardCard(ctx, agent, {
					status,
					startedAt,
					completedAt: Date.now(),
					lastPreview: output.trim().split("\n").at(-1)?.slice(0, 160) || "workflow agent finished",
					errorMessage: finalStderr.trim() || undefined,
				});
				resolve({ exitCode, output, stderr: finalStderr });
			};
			proc.stdout.on("data", (data) => {
				output += data.toString();
				publishWorkflowDashboardCard(ctx, agent, { status: "running", startedAt, lastPreview: output.trim().split("\n").at(-1)?.slice(0, 160) || "receiving output..." });
			});
			proc.stderr.on("data", (data) => (stderr += data.toString()));
			proc.on("close", (code) => finish(code ?? 0));
			proc.on("error", (error) => finish(1, `${stderr}\n${error.message}`));
			if (signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		await fs.promises.rm(systemPrompt.file, { force: true });
		await fs.promises.rm(systemPrompt.dir, { force: true, recursive: true });
	}
}

let spawnForDispatch = spawn;
let runPiAgentForDispatch = runPiAgent;

export function setSpawnForDispatchTestOverride(override: typeof spawn | null): void {
	spawnForDispatch = override ?? spawn;
}

export function setRunPiAgentForDispatchTestOverride(override: typeof runPiAgent | null): void {
	runPiAgentForDispatch = override ?? runPiAgent;
}

async function addDispatchComment(pi: ExtensionAPI, beadId: string, agent: string, branch: string, worktreePath: string, startCommit: string, prompt: string): Promise<void> {
	const comment = `DISPATCH (${agent})\n\nBRANCH: ${branch}\nWORKTREE: ${worktreePath}\nSTART_COMMIT: ${startCommit}\n\n${prompt}`;
	await pi.exec("bd", ["comments", "add", beadId, comment]);
}

async function addEndCommitComment(pi: ExtensionAPI, beadId: string, agent: string, branch: string, worktreePath: string, startCommit: string, endCommit: string): Promise<void> {
	const comment = `DISPATCH RESULT (${agent})\n\nBRANCH: ${branch}\nWORKTREE: ${worktreePath}\nSTART_COMMIT: ${startCommit}\nEND_COMMIT: ${endCommit}`;
	await pi.exec("bd", ["comments", "add", beadId, comment]);
}

async function submitForReviewFromWrapper(pi: ExtensionAPI, beadId: string, agent: string, branch: string, worktreePath: string, startCommit: string, endCommit: string, artifact: string): Promise<void> {
	const evidence = normalizeArtifactText(artifact).slice(-4000);
	const comment = `WORKFLOW SUBMIT FOR REVIEW (dispatch_supervisor wrapper)\n\nAgent: ${agent}\nBRANCH: ${branch}\nWORKTREE: ${worktreePath}\nSTART_COMMIT: ${startCommit}\nEND_COMMIT: ${endCommit}\nReason: supervisor artifact reported complete implementation evidence.\n\n${evidence}`;
	const commentResult = await pi.exec("bd", ["comments", "add", beadId, comment]);
	if (commentResult.code !== 0) throw new Error(`dispatch_supervisor wrapper submit не записал review evidence: ${commentResult.stderr || commentResult.stdout}`);
	const updateResult = await pi.exec("bd", ["update", beadId, "--status", "inreview", "--json"]);
	if (updateResult.code !== 0) throw new Error(`dispatch_supervisor wrapper submit не перевёл bead в inreview: ${updateResult.stderr || updateResult.stdout}`);
}

function emitVisibleDispatchBind(
	pi: ExtensionAPI,
	input: { beadId: string; state: "implementing" | "inreview" | "reviewing"; branch?: string; worktreePath: string; startCommit?: string },
	ctx?: ToolContext,
): void {
	pi.events.emit("workflow-state:update", {
		ctx,
		activeBead: input.beadId,
		state: input.state,
		sessionMode: input.state,
		branch: input.branch,
		worktreePath: input.worktreePath,
		startCommit: input.startCommit,
	});
}

async function addCodeReviewVerdictComment(pi: ExtensionAPI, beadId: string, verdict: "APPROVED" | "NOT APPROVED", evidence: string): Promise<void> {
	const comment = `CODE REVIEW: ${verdict}\n\n${evidence.slice(-4000)}`;
	const commentResult = await pi.exec("bd", ["comments", "add", beadId, comment]);
	if (commentResult.code !== 0) throw new Error(`complete_visible_dispatch не записал CODE REVIEW: ${commentResult.stderr || commentResult.stdout}`);
}

function followupBindState(role: string): "implementing" | "reviewing" {
	return role === "code-reviewer" ? "reviewing" : "implementing";
}

export type CloseVisibleDispatchResult = {
	status: "closed" | "skipped" | "noop";
	text: string;
	closed: string[];
	tombstoned: string[];
};

/** Unlink isolation/followup files for leftover tombstoned rows of this bead (after earlier stopClose). */
function unlinkLeftoverTombstonesForBead(beadId: string): string[] {
	const cleaned: string[] = [];
	const root = path.join(orchRoot(), "ns");
	if (!fs.existsSync(root)) return cleaned;
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name, "dispatch-registry.json");
		if (!fs.existsSync(file)) continue;
		const registry = loadRegistry(file);
		for (const entry of registry.entries) {
			if (entry.beadId !== beadId || entry.status !== "tombstone") continue;
			unlinkIsolationFiles(entry);
			unlinkFollowupArtifacts(entry);
			cleaned.push(entry.taskId);
		}
	}
	return cleaned;
}

/**
 * Orchestrator hop after bead is terminal (or STOP close on reviewed) and no pending-fix reuse is needed.
 * Closes only this bead's live registry panes (close-surface) and tombstones them.
 * stopClose=true: allow status=reviewed only; tombstone without unlinking isolation/followup (later terminal close cleans leftovers).
 * Does not touch foreign panes. pendingFix keeps the pane for followup_visible_dispatch (wins over stopClose).
 */
export async function closeVisibleDispatch(
	pi: ExtensionAPI,
	params: { beadId: string; pendingFix?: boolean; stopClose?: boolean },
	_ctx?: ToolContext,
): Promise<CloseVisibleDispatchResult> {
	if (params.pendingFix) {
		return {
			status: "skipped",
			text: "pending-fix: pane kept for followup_visible_dispatch; close-surface not called",
			closed: [],
			tombstoned: [],
		};
	}
	const bead = await getBead(pi, params.beadId);
	const status = bead.status ?? "unknown";
	const stopClose = params.stopClose === true;
	if (stopClose) {
		if (!CLOSE_VISIBLE_STOP_CLOSE_STATUSES.has(status)) {
			throw new Error(
				`close_visible_dispatch: stopClose requires status=reviewed (got ${status}); in_progress/inreview/open not allowed: BLOCKED`,
			);
		}
	} else if (!CLOSE_VISIBLE_TERMINAL_STATUSES.has(status)) {
		throw new Error(
			`close_visible_dispatch: bead not terminal (status=${status}); keep pane for live work/review: BLOCKED`,
		);
	}
	const live = findLiveRegistryEntriesForBead(params.beadId);
	if (live.length === 0) {
		const leftoverCleaned = stopClose ? [] : unlinkLeftoverTombstonesForBead(params.beadId);
		return {
			status: "noop",
			text: leftoverCleaned.length > 0
				? `no live panes for ${params.beadId}; cleaned leftover tombstones=${leftoverCleaned.join(",")}`
				: `no live panes for ${params.beadId}`,
			closed: [],
			tombstoned: [],
		};
	}
	const adapter = resolveFollowupAdapter(pi);
	const closed: string[] = [];
	const tombstoned: string[] = [];
	// Group by registry file so we can reload after each write safely.
	for (const item of live) {
		const pane = item.entry.pane;
		if (pane) {
			try {
				await adapter.closeSurface(pane);
				closed.push(pane);
			} catch (error) {
				// Surface may already be gone; still tombstone so registry is not live.
				closed.push(`${pane} (close-error: ${(error as Error).message})`);
			}
		}
		const registry = loadRegistry(item.file);
		const index = registry.entries.findIndex(
			(entry) => entry.taskId === item.entry.taskId && entry.pane === item.entry.pane,
		);
		if (index >= 0) {
			const next = tombstoneRegistryEntry(item.file, registry, index);
			tombstoned.push(next.taskId);
			// stopClose keeps isolation/followup files until a later terminal close unlinks leftovers.
			if (!stopClose) {
				unlinkIsolationFiles(next);
				unlinkFollowupArtifacts(next);
			}
		}
	}
	const leftoverCleaned = stopClose ? [] : unlinkLeftoverTombstonesForBead(params.beadId);
	const leftoverNote = leftoverCleaned.length > 0 ? `; leftover-unlinked=${leftoverCleaned.join(",")}` : "";
	const stopNote = stopClose ? "; stopClose (files retained)" : "";
	return {
		status: "closed",
		text: `closed ${closed.length} pane(s) for ${params.beadId}: ${closed.join(", ") || "-"}; tombstoned=${tombstoned.join(",") || "-"}${stopNote}${leftoverNote}`,
		closed,
		tombstoned,
	};
}

type CompleteVisibleDispatchResult = { status: "noop" | "incomplete" | "submitted" | "result-only" | "verdict"; text: string };

/** Concurrent lock only: one in-flight complete per taskId; later callers await the same promise. */
const completeVisibleDispatchInflight = new Map<string, Promise<CompleteVisibleDispatchResult>>();

async function completeVisibleDispatchUnlocked(pi: ExtensionAPI, params: { taskId: string }, ctx?: ToolContext): Promise<CompleteVisibleDispatchResult> {
	const found = findRegistryByTaskId(params.taskId);
	if (!found) throw new Error(`complete_visible_dispatch: нет registry для ${params.taskId}`);
	const { file, registry, entry, index } = found;
	if (entry.submitStatus === "submitted") return { status: "noop", text: "already submitted" };
	if (entry.submitStatus === "verdict") return { status: "noop", text: "already recorded verdict" };
	const preview = readDigestPreview(entry.digestFile, entry.resultFile);
	if (!preview.exists) return { status: "incomplete", text: "нет digest/result" };
	const resultText = fs.existsSync(entry.resultFile) ? fs.readFileSync(entry.resultFile, "utf8") : preview.text;
	if (!entry.startCommit) throw new Error(`complete_visible_dispatch: нет START_COMMIT для ${params.taskId}`);
	const startCommit = entry.startCommit;
	let branch = "";
	try {
		branch = await getGitValue(pi, entry.worktree, ["branch", "--show-current"]);
	} catch {
		branch = "";
	}
	if (entry.role === "code-reviewer") {
		const verdict = parseVisibleReviewerVerdict(resultText);
		if (!verdict) {
			registry.entries[index] = { ...entry, submitStatus: "result-only" };
			saveRegistry(file, registry);
			emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: "reviewing", branch, worktreePath: entry.worktree, startCommit }, ctx);
			return { status: "result-only", text: preview.text };
		}
		await addCodeReviewVerdictComment(pi, entry.beadId, verdict, resultText);
		registry.entries[index] = { ...entry, submitStatus: "verdict" };
		saveRegistry(file, registry);
		emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: "inreview", branch, worktreePath: entry.worktree, startCommit }, ctx);
		return { status: "verdict", text: `CODE REVIEW: ${verdict}` };
	}
	const endCommit = await getGitValue(pi, entry.worktree, ["rev-parse", "HEAD"]);
	const ready = supervisorArtifactReadyForReview({ output: resultText, exitCode: 0 }, startCommit, endCommit);
	if (!ready) {
		await addEndCommitComment(pi, entry.beadId, entry.role, branch, entry.worktree, startCommit, endCommit);
		registry.entries[index] = { ...entry, submitStatus: "result-only" };
		saveRegistry(file, registry);
		emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: "implementing", branch, worktreePath: entry.worktree, startCommit }, ctx);
		return { status: "result-only", text: preview.text };
	}
	await addEndCommitComment(pi, entry.beadId, entry.role, branch, entry.worktree, startCommit, endCommit);
	await submitForReviewFromWrapper(pi, entry.beadId, entry.role, branch, entry.worktree, startCommit, endCommit, resultText);
	registry.entries[index] = { ...entry, submitStatus: "submitted" };
	saveRegistry(file, registry);
	emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: "inreview", branch, worktreePath: entry.worktree, startCommit }, ctx);
	return { status: "submitted", text: resultText.slice(0, 2000) };
}

export async function completeVisibleDispatch(pi: ExtensionAPI, params: { taskId: string }, ctx?: ToolContext): Promise<CompleteVisibleDispatchResult> {
	const existing = completeVisibleDispatchInflight.get(params.taskId);
	if (existing) return existing;
	const pending = completeVisibleDispatchUnlocked(pi, params, ctx).finally(() => {
		if (completeVisibleDispatchInflight.get(params.taskId) === pending) {
			completeVisibleDispatchInflight.delete(params.taskId);
		}
	});
	completeVisibleDispatchInflight.set(params.taskId, pending);
	return pending;
}

function patchFollowupEntry(
	found: { file: string; registry: ReturnType<typeof loadRegistry>; entry: DispatchRegistryEntry; index: number },
	patch: Partial<DispatchRegistryEntry>,
): DispatchRegistryEntry {
	const next = { ...found.entry, ...patch };
	found.registry.entries[found.index] = next;
	saveRegistry(found.file, found.registry);
	found.entry = next;
	return next;
}

async function validateFollowupReusePreflight(
	pi: ExtensionAPI,
	entry: DispatchRegistryEntry,
	ctx?: ToolContext,
): Promise<{ branch: string; worktreePath: string }> {
	const cwd = entry.worktree;
	const branch = await getGitValue(pi, cwd, ["branch", "--show-current"]);
	const worktreePath = await getGitValue(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (path.resolve(worktreePath) !== path.resolve(entry.worktree)) {
		throw new Error(`followup_visible_dispatch preflight заблокирован: worktree mismatch, git=${worktreePath}, registry=${entry.worktree}`);
	}
	const stateScope = resolveActiveTaskScope(taskScopeFromContext(ctx));
	if (stateScope.ok) {
		if (stateScope.scope.activeBead && stateScope.scope.activeBead !== entry.beadId) {
			throw new Error(`followup_visible_dispatch preflight заблокирован: active bead mismatch, workflow-state=${stateScope.scope.activeBead}, requested=${entry.beadId}`);
		}
		if (stateScope.scope.branch && stateScope.scope.branch !== branch) {
			throw new Error(`followup_visible_dispatch preflight заблокирован: branch mismatch, git=${branch}, workflow-state=${stateScope.scope.branch}`);
		}
		if (stateScope.scope.worktreePath && path.resolve(stateScope.scope.worktreePath) !== path.resolve(worktreePath)) {
			throw new Error(`followup_visible_dispatch preflight заблокирован: worktree mismatch, git=${worktreePath}, workflow-state=${stateScope.scope.worktreePath}`);
		}
	}
	return { branch, worktreePath };
}

function resolveFollowupAdapter(pi: ExtensionAPI): CmuxAdapter {
	const testAdapter = getCmuxAdapterForTests();
	if (testAdapter) return testAdapter;
	return createLiveCmuxAdapter(pi.exec);
}

async function sendFollowupWithHungCap(
	adapter: CmuxAdapter,
	found: { file: string; registry: ReturnType<typeof loadRegistry>; entry: DispatchRegistryEntry; index: number },
	payload: string,
): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await adapter.send(found.entry.pane, payload);
			patchFollowupEntry(found, { sendFailCount: 0, hung: false });
			return;
		} catch (error) {
			const failCount = (found.entry.sendFailCount ?? 0) + 1;
			const hung = failCount >= 2;
			patchFollowupEntry(found, { sendFailCount: failCount, hung });
			if (hung) {
				throw new Error(`followup_visible_dispatch: hung cap-2 для ${found.entry.taskId}: BLOCKED`);
			}
		}
	}
	throw new Error(`followup_visible_dispatch: send failed: BLOCKED`);
}

async function respawnVisibleFollowup(
	adapter: CmuxAdapter,
	found: { file: string; registry: ReturnType<typeof loadRegistry>; entry: DispatchRegistryEntry; index: number },
	task: string,
	branch: string,
	signal?: AbortSignal,
): Promise<{ entry: DispatchRegistryEntry; rename: StickyRenameMetrics }> {
	const entry = found.entry;
	const taskBody = task.endsWith("\n") ? task : `${task}\n`;
	if (entry.taskFile) {
		fs.mkdirSync(path.dirname(entry.taskFile), { recursive: true });
		fs.writeFileSync(entry.taskFile, taskBody);
	}
	const argv = buildVisibleChildArgv({
		model: entry.model || undefined,
		thinking: entry.thinking || undefined,
		systemPromptFile: entry.promptFile,
		session: { kind: "no-session" },
		taskFile: entry.taskFile,
	});
	const argvErrors = validateVisibleChildArgv(argv);
	if (argvErrors.length > 0) throw new Error(`transport=cmux argv fail-close: ${argvErrors.join("; ")}`);
	const payload = buildVisibleChildSpawnPayload(entry.worktree, argv);
	const spawnFail = visibleCmuxSpawnFailReason({ branch, worktreePath: entry.worktree, payload });
	if (spawnFail) throw new Error(spawnFail);
	await adapter.identify();
	const livePanes = liveEntriesForBead(found.registry, entry.beadId);
	const callerSurface = resolveCallerSurface(adapter, entry);
	const orchSurface = callerSurface || entry.callerSurface || "";
	const anchorSurface = resolveVisibleSplitAnchor({
		callerSurface,
		liveAgentPanes: livePanes,
		excludePane: entry.pane,
	});
	let surface = "";
	try {
		const split = await adapter.newSplit({ anchorSurface });
		surface = split.surface;
		await adapter.send(surface, payload);
	} catch (error) {
		if (surface) await adapter.closeSurface(surface);
		throw error;
	}
	const childTitle = visibleChildTabTitle(entry.role, entry.beadId);
	const stickyOpts = {
		childSurface: surface,
		childTitle,
		orchSurface: orchSurface || undefined,
		orchTitle: ORCHESTRATOR_TAB_TITLE,
		signal,
	};
	// Immediate pair, then registry/tombstone ASAP, then remaining sticky retries.
	let rename = await ensureStickyTabTitles(adapter, { ...stickyOpts, schedule: [0] });
	await adapter.closeSurface(entry.pane);
	unlinkFollowupArtifacts(entry);
	const next = patchFollowupEntry(found, {
		pane: surface,
		submitStatus: "none",
		sendFailCount: 0,
		hung: false,
	});
	const restSchedule = STICKY_TAB_TITLE_DELAYS_MS.slice(1);
	if (restSchedule.length > 0) {
		rename = mergeStickyRenameMetrics(rename, await ensureStickyTabTitles(adapter, { ...stickyOpts, schedule: restSchedule }));
	}
	return { entry: next, rename };
}

export async function followupVisibleDispatch(
	pi: ExtensionAPI,
	params: FollowupVisibleParams,
	ctx?: ToolContext,
	signal?: AbortSignal,
): Promise<{
	status: "sent" | "busy" | "spawned";
	text: string;
	taskId: string;
	pane: string;
	renameAttempts?: number;
	renameFailures?: number;
	renameLastError?: string;
}> {
	const found = findLiveFollowupEntry(params.beadId, params.role);
	let entry = found.entry;
	if (entry.hung) {
		throw new Error(`followup_visible_dispatch: hung pane для ${entry.taskId}; close-surface + tombstone before new spawn: BLOCKED`);
	}
	const payload = buildVisibleFollowupPayload(params.task);
	const bead = await getBead(pi, params.beadId);
	if (bead.status && (TERMINAL_STATUSES.has(bead.status) || bead.status === "blocked")) {
		throw new Error(`followup_visible_dispatch: terminal/blocked bead нельзя follow-up: status=${bead.status}: BLOCKED`);
	}
	if (!FOLLOWUP_ALLOWED_STATUSES.has(bead.status ?? "")) {
		throw new Error(`followup_visible_dispatch требует status in_progress|inreview, получен ${bead.status ?? "unknown"}: BLOCKED`);
	}
	const { branch, worktreePath } = await validateFollowupReusePreflight(pi, entry, ctx);
	const adapter = resolveFollowupAdapter(pi);
	let screen: string;
	try {
		screen = await adapter.readScreen(entry.pane);
	} catch (error) {
		throw new Error(`cmux read-screen failed: ${(error as Error).message}: BLOCKED`);
	}
	const health = classifyVisiblePane(screen);
	if (health === "busy") {
		return {
			status: "busy",
			text: `visible pane busy (thinking); 0 send, 0 spawn; renameAttempts=0 renameFailures=0`,
			taskId: entry.taskId,
			pane: entry.pane,
			renameAttempts: 0,
			renameFailures: 0,
		};
	}
	if (health === "shell" || health === "dead") {
		const respawned = await respawnVisibleFollowup(adapter, found, params.task, branch, signal);
		entry = respawned.entry;
		emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: followupBindState(entry.role), branch, worktreePath, startCommit: entry.startCommit }, ctx);
		return {
			status: "spawned",
			text: `followup respawn pane=${entry.pane} taskId=${entry.taskId} ${formatStickyRenameMetrics(respawned.rename)}`,
			taskId: entry.taskId,
			pane: entry.pane,
			renameAttempts: respawned.rename.renameAttempts,
			renameFailures: respawned.rename.renameFailures,
			renameLastError: respawned.rename.renameLastError,
		};
	}
	unlinkFollowupArtifacts(entry);
	entry = patchFollowupEntry(found, { submitStatus: "none", sendFailCount: 0, hung: false });
	await sendFollowupWithHungCap(adapter, found, payload);
	// waiting reuse: one re-apply pair after successful send (no multi-delay).
	const orchSurface = resolveCallerSurface(adapter, entry);
	const rename = await renameTitlePair(
		adapter,
		entry.pane,
		visibleChildTabTitle(entry.role, entry.beadId),
		orchSurface || entry.callerSurface,
		ORCHESTRATOR_TAB_TITLE,
	);
	emitVisibleDispatchBind(pi, { beadId: entry.beadId, state: followupBindState(entry.role), branch, worktreePath, startCommit: entry.startCommit }, ctx);
	return {
		status: "sent",
		text: `followup sent pane=${entry.pane} taskId=${entry.taskId} ${formatStickyRenameMetrics(rename)}`,
		taskId: entry.taskId,
		pane: found.entry.pane,
		renameAttempts: rename.renameAttempts,
		renameFailures: rename.renameFailures,
		renameLastError: rename.renameLastError,
	};
}

async function validateSupervisorPreflight(pi: ExtensionAPI, params: { beadId: string; cwd?: string }, ctx?: ToolContext): Promise<{ scope: TaskScope; cwd: string; branch: string; worktreePath: string; startCommit: string; currentHead: string; evidence: string }> {
	const stateScope = resolveActiveTaskScope(taskScopeFromContext(ctx));
	if (!stateScope.ok) throw new Error(taskScopeErrorToPolicyReason(stateScope.error, params.beadId, "dispatch_supervisor preflight"));
	if (stateScope.scope.activeBead !== params.beadId) {
		throw new Error(`dispatch_supervisor preflight заблокирован: active bead mismatch, workflow-state=${stateScope.scope.activeBead ?? "-"}, requested=${params.beadId}`);
	}
	if (!stateScope.scope.startCommit) {
		throw new Error(`dispatch_supervisor preflight заблокирован: recorded START_COMMIT отсутствует для ${params.beadId}`);
	}
	const cwd = params.cwd ?? stateScope.scope.worktreePath;
	if (path.resolve(cwd) !== path.resolve(stateScope.scope.worktreePath)) {
		throw new Error(`dispatch_supervisor preflight заблокирован: cwd mismatch, requested=${path.resolve(cwd)}, workflow-state=${stateScope.scope.worktreePath}`);
	}
	const branch = await getGitValue(pi, cwd, ["branch", "--show-current"]);
	const worktreePath = await getGitValue(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const currentHead = await getGitValue(pi, cwd, ["rev-parse", "HEAD"]);
	if (branch !== stateScope.scope.branch) {
		throw new Error(`dispatch_supervisor preflight заблокирован: branch mismatch, git=${branch}, workflow-state=${stateScope.scope.branch}`);
	}
	if (path.resolve(worktreePath) !== path.resolve(stateScope.scope.worktreePath)) {
		throw new Error(`dispatch_supervisor preflight заблокирован: worktree mismatch, git=${worktreePath}, workflow-state=${stateScope.scope.worktreePath}`);
	}
	if (currentHead !== stateScope.scope.startCommit) {
		throw new Error(`dispatch_supervisor preflight заблокирован: recorded START_COMMIT stale, git HEAD=${currentHead}, workflow-state START_COMMIT=${stateScope.scope.startCommit}`);
	}
	const evidence = `PREFLIGHT EVIDENCE\nactiveBead=${stateScope.scope.activeBead}\nbranch=${branch}\nworktree=${worktreePath}\nstartCommit=${stateScope.scope.startCommit}\nhead=${currentHead}`;
	return { scope: stateScope.scope, cwd, branch, worktreePath, startCommit: stateScope.scope.startCommit, currentHead, evidence };
}

function cmuxSpawnAckResult(
	agentName: string,
	beadId: string,
	branch: string,
	worktreePath: string,
	startCommit: string,
	ack: {
		pane: string;
		taskFile: string;
		resultFile: string;
		registryKey: string;
		taskId: string;
		model?: string;
		thinking?: string;
		renameAttempts?: number;
		renameFailures?: number;
		renameLastError?: string;
	},
): DispatchResult {
	const output = JSON.stringify({ status: "spawned", model: ack.model ?? null, thinking: ack.thinking ?? null, ...ack }, null, 2);
	return {
		agent: agentName,
		beadId,
		branch,
		worktreePath,
		startCommit,
		exitCode: 0,
		output,
		stderr: "",
		model: ack.model,
		thinking: ack.thinking,
		transport: "cmux",
		status: "spawned",
		pane: ack.pane,
		taskFile: ack.taskFile,
		resultFile: ack.resultFile,
		registryKey: ack.registryKey,
		renameAttempts: ack.renameAttempts,
		renameFailures: ack.renameFailures,
		renameLastError: ack.renameLastError,
	};
}

function createLiveCmuxAdapter(exec: ExtensionAPI["exec"]): CmuxAdapter & { callerSurface(): string } {
	let callerSurface = "";
	return {
		callerSurface: () => callerSurface,
		async identify() {
			const result = await exec("cmux", ["identify", "--json"]);
			if (result.code !== 0) throw new Error("нет cmux (identify failed): BLOCKED");
			let data: { caller?: { workspace_ref?: string; surface_ref?: string; surface?: string }; workspace?: string };
			try {
				data = JSON.parse(result.stdout || "{}") as typeof data;
			} catch {
				throw new Error("нет cmux (identify json): BLOCKED");
			}
			const caller = data.caller ?? {};
			const workspaceId = String(caller.workspace_ref || data.workspace || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
			if (!workspaceId) throw new Error("нет cmux workspace: BLOCKED");
			callerSurface = String(caller.surface_ref || caller.surface || "").trim();
			if (!callerSurface) throw new Error("нет caller surface: BLOCKED");
			return { workspaceId };
		},
		async newSplit(opts?: { anchorSurface?: string }) {
			const anchor = String(opts?.anchorSurface || callerSurface || "").trim();
			if (!anchor) throw new Error("нет caller surface: BLOCKED");
			// Explicit --focus false: pin non-stealing spawn across cmux versions (default is already false).
			// Anchor is first live agent when present so orch stays exclusive left (kgvd).
			const result = await exec("cmux", ["new-split", "right", "--surface", anchor, "--focus", "false"]);
			if (result.code !== 0) throw new Error(`cmux new-split failed: ${result.stderr || result.stdout}`);
			const match = `${result.stdout || ""}`.match(/surface:\S+/);
			if (!match?.[0]) throw new Error(`new-split не вернул surface: ${result.stdout}`);
			return { surface: match[0] };
		},
		async send(surface, text) {
			const result = await exec("cmux", ["send", "--surface", surface, text]);
			if (result.code !== 0) throw new Error(`cmux send failed: ${result.stderr || result.stdout}`);
		},
		async readScreen(surface) {
			const result = await exec("cmux", ["read-screen", "--surface", surface, "--lines", "20"]);
			if (result.code !== 0) throw new Error(`cmux read-screen failed: ${result.stderr || result.stdout}`);
			return `${result.stdout ?? ""}`;
		},
		async closeSurface(surface) {
			await exec("cmux", ["close-surface", "--surface", surface]);
		},
		async renameSurface(surface, title) {
			const result = await exec("cmux", buildCmuxRenameArgv(surface, title));
			if (result.code !== 0) throw new Error(`cmux rename failed: ${result.stderr || result.stdout}`);
		},
	};
}

function resolveCallerSurface(adapter: CmuxAdapter, entry?: DispatchRegistryEntry): string {
	const fromMethod = typeof adapter.callerSurface === "function" ? adapter.callerSurface() : "";
	return String(fromMethod || entry?.callerSurface || "").trim();
}

/** Fail-soft tab rename: never fails spawn, never closeSurface. Single-shot without metrics. */
async function safeRenameSurface(adapter: CmuxAdapter, surface: string, title: string): Promise<void> {
	if (!surface || !title || typeof adapter.renameSurface !== "function") return;
	try {
		await adapter.renameSurface(surface, title);
	} catch {
		/* title-only best effort */
	}
}

/**
 * Relative ms offsets from the first immediate rename pair.
 * Immediate + 4 delayed re-applies hedge Pi/cmux cwd-title overwrite after child start.
 */
export const STICKY_TAB_TITLE_DELAYS_MS = [0, 300, 800, 1500, 3000] as const;

export type StickyRenameMetrics = {
	renameAttempts: number;
	renameFailures: number;
	renameLastError?: string;
};

export type StickyDelayFn = (ms: number, signal?: AbortSignal) => Promise<void>;

let stickyDelayForTests: StickyDelayFn | null = null;

/** Test hook: inject delay (use 0ms). Null restores default. */
export function setStickyTabTitleDelayForTests(fn: StickyDelayFn | null): void {
	stickyDelayForTests = fn;
}

function emptyStickyRenameMetrics(): StickyRenameMetrics {
	return { renameAttempts: 0, renameFailures: 0 };
}

function mergeStickyRenameMetrics(a: StickyRenameMetrics, b: StickyRenameMetrics): StickyRenameMetrics {
	const out: StickyRenameMetrics = {
		renameAttempts: a.renameAttempts + b.renameAttempts,
		renameFailures: a.renameFailures + b.renameFailures,
	};
	const last = b.renameLastError ?? a.renameLastError;
	if (last) out.renameLastError = last;
	return out;
}

function formatStickyRenameMetrics(metrics: StickyRenameMetrics): string {
	const parts = [`renameAttempts=${metrics.renameAttempts}`, `renameFailures=${metrics.renameFailures}`];
	if (metrics.renameLastError) parts.push(`renameLastError=${metrics.renameLastError}`);
	return parts.join(" ");
}

async function defaultStickyDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

function resolveStickyDelay(explicit?: StickyDelayFn): StickyDelayFn {
	if (explicit) return explicit;
	if (stickyDelayForTests) return stickyDelayForTests;
	// Unit/integration tests (VITEST or injected adapter) skip wall-clock sticky waits unless a test opts in.
	if (getCmuxAdapterForTests() || process.env.VITEST) return async () => {};
	return defaultStickyDelay;
}

/** Outcome-aware single rename (metrics path). Does not use void safeRenameSurface. */
export async function renameOnce(
	adapter: CmuxAdapter,
	surface: string,
	title: string,
): Promise<{ ok: boolean; error?: string }> {
	if (!surface || !title || typeof adapter.renameSurface !== "function") {
		return { ok: false, error: "renameSurface unavailable" };
	}
	try {
		await adapter.renameSurface(surface, title);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: (error as Error).message || String(error) };
	}
}

async function renameTitlePair(
	adapter: CmuxAdapter,
	childSurface: string,
	childTitle: string,
	orchSurface: string | undefined,
	orchTitle: string,
): Promise<StickyRenameMetrics> {
	const metrics = emptyStickyRenameMetrics();
	// Missing renameSurface → 0 attempts (edge case); sticky still fail-soft.
	if (typeof adapter.renameSurface !== "function") return metrics;
	if (childSurface && childTitle) {
		metrics.renameAttempts += 1;
		const child = await renameOnce(adapter, childSurface, childTitle);
		if (!child.ok) {
			metrics.renameFailures += 1;
			if (child.error) metrics.renameLastError = child.error;
		}
	}
	const orch = (orchSurface ?? "").trim();
	if (orch && orchTitle) {
		metrics.renameAttempts += 1;
		const orchResult = await renameOnce(adapter, orch, orchTitle);
		if (!orchResult.ok) {
			metrics.renameFailures += 1;
			if (orchResult.error) metrics.renameLastError = orchResult.error;
		}
	}
	return metrics;
}

/**
 * Re-apply child (+ optional orch) titles on a full delay schedule.
 * Always runs the full schedule unless signal aborts; no title-read early-exit.
 */
export async function ensureStickyTabTitles(
	adapter: CmuxAdapter,
	opts: {
		childSurface: string;
		childTitle: string;
		orchSurface?: string;
		orchTitle?: string;
		delay?: StickyDelayFn;
		signal?: AbortSignal;
		/** Absolute ms offsets from the start of this call (default full sticky window). */
		schedule?: readonly number[];
	},
): Promise<StickyRenameMetrics> {
	const schedule = opts.schedule ?? STICKY_TAB_TITLE_DELAYS_MS;
	const delayFn = resolveStickyDelay(opts.delay);
	const orchTitle = opts.orchTitle ?? ORCHESTRATOR_TAB_TITLE;
	let metrics = emptyStickyRenameMetrics();
	let prevAt = 0;
	for (let i = 0; i < schedule.length; i++) {
		if (opts.signal?.aborted) break;
		const at = schedule[i] ?? 0;
		const gap = Math.max(0, at - prevAt);
		prevAt = at;
		if (gap > 0) await delayFn(gap, opts.signal);
		if (opts.signal?.aborted) break;
		const tick = await renameTitlePair(
			adapter,
			opts.childSurface,
			opts.childTitle,
			opts.orchSurface,
			orchTitle,
		);
		metrics = mergeStickyRenameMetrics(metrics, tick);
	}
	return metrics;
}

function posixSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function dispatchVisibleCmux(input: {
	pi: ExtensionAPI;
	params: DispatchToolParams;
	bead: BeadInfo;
	agent: AgentConfig;
	agentName: string;
	prompt: string;
	branch: string;
	worktreePath: string;
	startCommit: string;
	cwd: string;
	mode: "supervisor" | "reviewer";
	ctx?: ToolContext;
	signal?: AbortSignal;
}): Promise<DispatchResult> {
	const { pi, params, bead, agent, agentName, prompt, branch, worktreePath, startCommit, mode, ctx, signal } = input;
	const taskId = visibleDispatchTaskId(bead.id, agentName);
	if (params.dryRun) {
		const argv = buildVisibleChildArgv({
			model: agent.model,
			thinking: agent.thinking,
			systemPromptFile: `/tmp/dry-prompt-${taskId}.md`,
			tools: agent.tools,
			session: { kind: "no-session" },
			taskFile: `/tmp/dry-task-${taskId}.md`,
		});
		const argvErrors = validateVisibleChildArgv(argv);
		if (argvErrors.length > 0) throw new Error(`transport=cmux argv fail-close: ${argvErrors.join("; ")}`);
		return cmuxSpawnAckResult(agentName, bead.id, branch, worktreePath, startCommit, {
			pane: "",
			taskFile: `/tmp/dry-task-${taskId}.md`,
			resultFile: `/tmp/dry-result-${taskId}.md`,
			registryKey: taskId,
			taskId,
			model: agent.model,
			thinking: agent.thinking,
		});
	}
	const testAdapter = getCmuxAdapterForTests();
	const liveAdapter = testAdapter ? null : createLiveCmuxAdapter(pi.exec);
	const adapter = testAdapter ?? liveAdapter;
	if (!adapter) throw new Error("нет cmux adapter: BLOCKED");
	const identified = await adapter.identify();
	const dir = nsDir(identified.workspaceId);
	const registryFile = path.join(dir, "dispatch-registry.json");
	const existing = loadRegistry(registryFile);
	if (liveEntriesForBead(existing, bead.id, agentName).length > 0) {
		const followupHint = agentName === "code-reviewer" ? `{ beadId, role: "code-reviewer" }` : `{ beadId }`;
		throw new Error(`повторный spawn для ${bead.id}: BLOCKED (live pane already registered; use followup_visible_dispatch(${followupHint}))`);
	}
	const resultsDir = path.join(worktreeOrchDir(worktreePath), "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultFile = path.join(resultsDir, `${taskId}.md`);
	const digestFile = path.join(resultsDir, `${taskId}.digest`);
	const pingScript = path.join(worktreePath, ".pi/orchestrator/ping.sh");
	const pingCommand = `AGENT_NAME=${posixSingleQuote(agentName)} DIGEST_FILE=${posixSingleQuote(digestFile)} bash ${posixSingleQuote(pingScript)} ${posixSingleQuote(taskId)}`;
	const pingErrorCommand = `${pingCommand} error`;
	const pingContract = `3. Only ping by running this exact command (POSIX-quoted absolute paths; worktreePath is git toplevel):
   ${pingCommand}
   After BLOCKED or NEEDS_CONTEXT, run the same command with KIND=error:
   ${pingErrorCommand}
   If ping.sh send exits non-zero, retry once; then BLOCKED and report stderr.
   Forbidden: printing Ping or [PING] in this pane; raw cmux send / send-key enter.
   Child stdout is not delivery. Do not ping before digest/result exist.`;
	const taskBody = mode === "reviewer"
		? `${prompt}

WHEN YOU BELIEVE YOUR REVIEW IS DONE:
1. Write CODE REVIEW verdict (APPROVED or NOT APPROVED) plus evidence to ${resultFile}
2. Write digest ≤10 lines to ${digestFile}
${pingContract}
Do not write SUPERVISOR ARTIFACT.
Do not call review_bead.
Do not spawn a supervisor.
`
		: `${prompt}

WHEN YOU BELIEVE YOUR CONTRACT IS DONE:
1. Write SUPERVISOR ARTIFACT to ${resultFile}
2. Write digest ≤10 lines to ${digestFile}
${pingContract}
Next step is review, same as today. Do not call review yourself.
`;
	const files = persistIsolationFiles(dir, taskId, agent.systemPrompt, taskBody);
	files.resultFile = resultFile;
	files.digestFile = digestFile;
	const argv = buildVisibleChildArgv({
		model: agent.model,
		thinking: agent.thinking,
		systemPromptFile: files.promptFile,
		tools: agent.tools,
		session: { kind: "no-session" },
		taskFile: files.taskFile,
	});
	const argvErrors = validateVisibleChildArgv(argv);
	if (argvErrors.length > 0) throw new Error(`transport=cmux argv fail-close: ${argvErrors.join("; ")}`);
	const payload = buildVisibleChildSpawnPayload(worktreePath, argv);
	const callerSurface = resolveCallerSurface(adapter);
	const livePanes = liveEntriesForBead(existing, bead.id);
	const anchorSurface = resolveVisibleSplitAnchor({
		callerSurface,
		liveAgentPanes: livePanes,
	});
	let surface = "";
	try {
		const split = await adapter.newSplit({ anchorSurface });
		surface = split.surface;
		const spawnFail = visibleCmuxSpawnFailReason({ branch, worktreePath, payload });
		if (spawnFail) throw new Error(spawnFail);
		await adapter.send(surface, payload);
	} catch (error) {
		if (surface) await adapter.closeSurface(surface);
		throw error;
	}
	const childTitle = visibleChildTabTitle(agentName, bead.id);
	const stickyOpts = {
		childSurface: surface,
		childTitle,
		orchSurface: callerSurface || undefined,
		orchTitle: ORCHESTRATOR_TAB_TITLE,
		signal,
	};
	// 1) immediate rename pair → 2) registry ASAP → 3) remaining sticky retries → 4) ack+metrics
	let rename = await ensureStickyTabTitles(adapter, { ...stickyOpts, schedule: [0] });
	appendPanesEnv(dir, taskId, surface, callerSurface || undefined);
	const entry: DispatchRegistryEntry = {
		taskId,
		beadId: bead.id,
		pane: surface,
		worktree: worktreePath,
		role: agentName,
		model: agent.model ?? "",
		thinking: agent.thinking,
		taskFile: files.taskFile,
		resultFile: files.resultFile,
		digestFile: files.digestFile,
		promptFile: files.promptFile,
		status: "spawned",
		submitStatus: "none",
		callerSurface: callerSurface || undefined,
		startCommit,
		createdAt: new Date().toISOString(),
	};
	existing.entries.push(entry);
	try {
		saveRegistry(registryFile, existing);
	} catch (error) {
		await adapter.closeSurface(surface);
		throw error;
	}
	const restSchedule = STICKY_TAB_TITLE_DELAYS_MS.slice(1);
	if (restSchedule.length > 0) {
		rename = mergeStickyRenameMetrics(rename, await ensureStickyTabTitles(adapter, { ...stickyOpts, schedule: restSchedule }));
	}
	const renameLine = formatStickyRenameMetrics(rename);
	await addDispatchComment(
		pi,
		bead.id,
		agentName,
		branch,
		worktreePath,
		startCommit,
		`transport=cmux spawn-ack taskId=${taskId} pane=${surface} ${renameLine}\nDIGEST_FILE=${files.digestFile}\nRESULT_FILE=${files.resultFile}`,
	);
	emitVisibleDispatchBind(pi, { beadId: bead.id, state: mode === "reviewer" ? "reviewing" : "implementing", branch, worktreePath, startCommit }, ctx);
	return cmuxSpawnAckResult(agentName, bead.id, branch, worktreePath, startCommit, {
		pane: surface,
		taskFile: files.taskFile,
		resultFile: files.resultFile,
		registryKey: taskId,
		taskId,
		model: agent.model,
		thinking: agent.thinking,
		renameAttempts: rename.renameAttempts,
		renameFailures: rename.renameFailures,
		renameLastError: rename.renameLastError,
	});
}

async function dispatch(
	pi: ExtensionAPI,
	mode: "supervisor" | "reviewer" | "docs",
	params: DispatchToolParams,
	signal?: AbortSignal,
	defaultCwd?: string,
	ctx?: ToolContext,
): Promise<DispatchResult> {
	const supervisorPreflight = mode === "supervisor" ? await validateSupervisorPreflight(pi, params, ctx) : undefined;
	const stateScope = mode === "supervisor" ? undefined : resolveActiveTaskScope(taskScopeFromContext(ctx));
	const cwd = supervisorPreflight?.cwd ?? params.cwd ?? (stateScope?.ok && stateScope.scope.activeBead === params.beadId ? stateScope.scope.worktreePath : undefined) ?? defaultCwd ?? process.cwd();
	const bead = await getBead(pi, params.beadId);
	const comments = await getComments(pi, params.beadId);
	if (mode === "docs" && params.transport) {
		throw new Error("dispatch_docs_agent does not accept transport");
	}
	const transport = mode === "docs" ? undefined : resolveDispatchTransport(params, ctx);
	if (mode === "supervisor") {
		const readinessErrors = validateSupervisorReadiness(bead, comments);
		if (readinessErrors.length > 0) throw new Error(`dispatch_supervisor readiness не пройдена: ${readinessErrors.join("; ")}`);
	}
	if (mode === "reviewer" && bead.status !== "inreview") {
		throw new Error(`dispatch_reviewer требует bead status inreview, получен ${bead.status}`);
	}

	const branch = supervisorPreflight?.branch ?? await getGitValue(pi, cwd, ["branch", "--show-current"]);
	const worktreePath = supervisorPreflight?.worktreePath ?? await getGitValue(pi, cwd, ["rev-parse", "--show-toplevel"]);
	let startCommit = supervisorPreflight?.startCommit ?? await getGitValue(pi, cwd, ["rev-parse", "HEAD"]);
	if (mode === "reviewer" && transport === "cmux") {
		const reviewerScope = resolveActiveTaskScope(taskScopeFromContext(ctx));
		if (reviewerScope.ok && reviewerScope.scope.activeBead === params.beadId) {
			if (reviewerScope.scope.branch && reviewerScope.scope.branch !== branch) {
				throw new Error(`dispatch_reviewer preflight заблокирован: branch mismatch, git=${branch}, workflow-state=${reviewerScope.scope.branch}`);
			}
			if (reviewerScope.scope.worktreePath && path.resolve(reviewerScope.scope.worktreePath) !== path.resolve(worktreePath)) {
				throw new Error(`dispatch_reviewer preflight заблокирован: worktree mismatch, git=${worktreePath}, workflow-state=${reviewerScope.scope.worktreePath}`);
			}
			if (reviewerScope.scope.startCommit) startCommit = reviewerScope.scope.startCommit;
		}
		if (!reviewerScope.ok || reviewerScope.scope.activeBead !== params.beadId || !reviewerScope.scope.startCommit) {
			const recorded = extractRecordedStartCommit(comments);
			if (recorded) startCommit = recorded;
		}
		const hasWorkflowStart = reviewerScope.ok && reviewerScope.scope.activeBead === params.beadId && Boolean(reviewerScope.scope.startCommit);
		if (!hasWorkflowStart && !extractRecordedStartCommit(comments)) {
			throw new Error(`dispatch_reviewer preflight заблокирован: recorded START_COMMIT отсутствует для ${params.beadId}`);
		}
	}
	const agentName = params.agent ?? (mode === "supervisor" ? chooseSupervisor(bead) : mode === "reviewer" ? "code-reviewer" : "documentation-expert");
	const agent = loadAgent(cwd, agentName);
	const contextText = `${bead.title ?? ""}\n${bead.description ?? ""}\n${comments.map((comment) => comment.text ?? "").join("\n")}`;
	const targetFiles = inferTargetFilesFromText(contextText);
	const pathRules = await renderPathRulesLoaded(cwd, targetFiles);
	const prompt =
		mode === "supervisor"
			? buildSupervisorPrompt(bead, comments, branch, startCommit, params.task, pathRules)
			: mode === "reviewer"
				? `${buildReviewerPrompt(bead, branch, startCommit, params.task)}\n\n${pathRules}`
				: `${buildDocsPrompt(bead, branch, startCommit, params.task)}\n\n${pathRules}`;

	if ((mode === "supervisor" || mode === "reviewer") && transport === "cmux") {
		return await dispatchVisibleCmux({ pi, params, bead, agent, agentName, prompt, branch, worktreePath, startCommit, cwd, mode, ctx, signal });
	}

	await addDispatchComment(pi, bead.id, agentName, branch, worktreePath, startCommit, supervisorPreflight ? `${supervisorPreflight.evidence}\n\n${prompt}` : prompt);
	if (mode === "supervisor") {
		pi.events.emit("workflow-state:update", { activeBead: bead.id, state: "implementing", sessionMode: "implementing", branch, worktreePath, startCommit });
	} else if (mode === "reviewer") {
		pi.events.emit("workflow-state:update", { activeBead: bead.id, state: "reviewing", sessionMode: "reviewing", branch, worktreePath, startCommit });
	}
	if (params.dryRun) {
		return {
			agent: agentName,
			beadId: bead.id,
			branch,
			worktreePath,
			startCommit,
			exitCode: 0,
			output: prompt,
			stderr: "",
			model: agent.model,
			thinking: agent.thinking,
		};
	}

	const result = await runPiAgentForDispatch(agent, prompt, cwd, signal, ctx);
	if (mode === "supervisor") {
		const endCommit = await getGitValue(pi, cwd, ["rev-parse", "HEAD"]);
		await addEndCommitComment(pi, bead.id, agentName, branch, worktreePath, startCommit, endCommit);
		let updatedBead = await getBead(pi, bead.id);
		if (updatedBead.status !== "inreview" && supervisorArtifactReadyForReview(result, startCommit, endCommit)) {
			await submitForReviewFromWrapper(pi, bead.id, agentName, branch, worktreePath, startCommit, endCommit, result.output);
			updatedBead = await getBead(pi, bead.id);
		}
		const readyForReview = updatedBead.status === "inreview";
		pi.events.emit("workflow-state:update", {
			activeBead: bead.id,
			state: readyForReview ? "inreview" : "implementing",
			sessionMode: readyForReview ? "inreview" : "implementing",
			branch,
			worktreePath,
			startCommit,
			endCommit,
		});
		return { agent: agentName, beadId: bead.id, branch, worktreePath, startCommit, endCommit, model: agent.model, thinking: agent.thinking, ...result };
	}
	return { agent: agentName, beadId: bead.id, branch, worktreePath, startCommit, model: agent.model, thinking: agent.thinking, ...result };
}

function renderDispatchResult(result: DispatchResult): string {
	const renameBits =
		typeof result.renameAttempts === "number"
			? formatStickyRenameMetrics({
					renameAttempts: result.renameAttempts,
					renameFailures: result.renameFailures ?? 0,
					renameLastError: result.renameLastError,
			  })
			: "";
	return [
		`agent=${result.agent}`,
		`bead=${result.beadId}`,
		`branch=${result.branch}`,
		`worktree=${result.worktreePath}`,
		`start=${result.startCommit}`,
		result.endCommit ? `end=${result.endCommit}` : "",
		result.transport ? `transport=${result.transport}` : "",
		result.status ? `status=${result.status}` : "",
		result.model ? `model=${result.model}` : "model=(session inherit)",
		result.thinking ? `thinking=${result.thinking}` : "thinking=(session inherit)",
		`exit=${result.exitCode}`,
		renameBits,
		result.stderr ? `stderr:\n${result.stderr}` : "",
		result.output ? `output:\n${result.output.slice(-8000)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function readActiveBeadFromContext(ctx?: ToolContext): string | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const isWorkflow =
			entry?.type === "workflow-state" || (entry?.type === "custom" && entry?.customType === "workflow-state");
		if (!isWorkflow) continue;
		const data = entry?.data as { activeBead?: string } | undefined;
		const active = data?.activeBead?.trim();
		if (active) return active;
	}
	return undefined;
}

function isOpenBeadStatus(status: string | undefined): boolean {
	const normalized = (status ?? "").trim().toLowerCase();
	return normalized === "open" || normalized === "todo";
}

async function resolveMainCheckout(pi: ExtensionAPI, cwd: string): Promise<string> {
	const commonDir = await getGitValue(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const main = mainCheckoutFromGitCommonDir(commonDir);
	if (!main) throw new Error("не удалось определить main checkout (git-common-dir): BLOCKED");
	return main;
}

async function identifyCallerWorkspace(
	pi: ExtensionAPI,
): Promise<{ workspaceId: string; workspaceRef: string; surface?: string }> {
	const result = await pi.exec("cmux", ["identify", "--json"]);
	if (result.code !== 0) throw new Error("нет cmux (identify failed): BLOCKED");
	let data: {
		caller?: { workspace_ref?: string; surface_ref?: string; surface?: string };
		workspace?: string;
	};
	try {
		data = JSON.parse(result.stdout || "{}") as typeof data;
	} catch {
		throw new Error("нет cmux (identify json): BLOCKED");
	}
	const caller = data.caller ?? {};
	const workspaceRef = String(caller.workspace_ref || data.workspace || "").trim();
	if (!workspaceRef) throw new Error("нет cmux workspace: BLOCKED");
	const workspaceId = workspaceRef.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	const surface = String(caller.surface_ref || caller.surface || "").trim() || undefined;
	return { workspaceId, workspaceRef, surface };
}

/**
 * Open a parallel task as a new cmux workspace + interactive Pi session.
 * Parent does not claim the target; child runs claim-bead from main checkout.
 */
export async function spawnTaskWorkspace(
	pi: ExtensionAPI,
	params: SpawnTaskWorkspaceToolParams,
	ctx?: ToolContext,
): Promise<SpawnTaskWorkspaceResult> {
	const beadId = (params.beadId ?? "").trim();
	const title = (params.title ?? "").trim();
	if (!beadId) throw new Error("beadId обязателен: BLOCKED");

	const titleError = validateTaskWorkspaceTitle(title);
	if (titleError) throw new Error(`${titleError}: BLOCKED`);

	const hasUI = Boolean(ctx && typeof ctx === "object" && ("hasUI" in ctx ? (ctx as { hasUI?: boolean }).hasUI : ctx.ui));
	if (!hasUI && !params.dryRun) {
		throw new Error("spawn_task_workspace требует интерактивный cmux UI (hasUI); headless/CI не поддерживается: BLOCKED");
	}

	const activeBead = readActiveBeadFromContext(ctx);
	if (activeBead && activeBead === beadId) {
		throw new Error(
			`spawn_task_workspace на свой active bead ${beadId} запрещён — это не замена claim/dispatch: BLOCKED`,
		);
	}

	const bead = await getBead(pi, beadId);
	if (!isOpenBeadStatus(bead.status)) {
		throw new Error(
			`target bead ${beadId} status=${bead.status ?? "unknown"} (нужен open); busy/inreview/terminal → BLOCKED`,
		);
	}

	const comments = await getComments(pi, beadId);
	const lockState = isSpawnLockBlocking(comments, beadId);
	if (lockState.blocked) {
		throw new Error(
			`SPAWN_LOCK уже держит ${beadId} (status=${lockState.lock?.status ?? "pending"}, parent=${lockState.lock?.parentWorkspace ?? "?"}): BLOCKED`,
		);
	}

	const cwd = ctx?.cwd || process.cwd();
	const mainCwd = await resolveMainCheckout(pi, cwd);
	const workspaceName = buildTaskWorkspaceName(title, beadId);
	const description = (params.description ?? bead.title ?? workspaceName).trim();
	const childCommand = buildTaskWorkspaceChildCommand(beadId);

	let callerWorkspaceRef = "workspace:caller";
	let parentColor: string | null = null;
	let groupId: string | undefined;
	let siblingColors: string[] = [];

	if (!params.dryRun || hasUI) {
		try {
			const identified = await identifyCallerWorkspace(pi);
			callerWorkspaceRef = identified.workspaceRef;
			const listResult = await pi.exec("cmux", buildListWorkspacesArgv());
			if (listResult.code === 0) {
				const row = findWorkspaceRow(listResult.stdout || "", callerWorkspaceRef);
				if (row) {
					parentColor = typeof row.custom_color === "string" ? row.custom_color : null;
					groupId = extractWorkspaceGroupId(row);
				}
				try {
					const parsed = JSON.parse(listResult.stdout || "{}") as {
						workspaces?: Array<Record<string, unknown>>;
					};
					siblingColors = (parsed.workspaces ?? [])
						.map((w) => (typeof w.custom_color === "string" ? w.custom_color : null))
						.filter((c): c is string => Boolean(c));
				} catch {
					/* ignore */
				}
			}
		} catch (error) {
			if (!params.dryRun) throw error;
			// dryRun without live cmux still returns argv plan with placeholders
		}
	}

	const color = pickTaskWorkspaceColor({
		explicit: params.color,
		parentColor,
		siblingColors,
	});

	const baseCreateArgv = buildNewWorkspaceArgv({
		name: workspaceName,
		cwd: mainCwd,
		command: childCommand,
		description,
		focus: false,
		groupId,
		groupPlacement: groupId ? "afterCurrent" : undefined,
		groupReference: groupId ? callerWorkspaceRef : undefined,
	});
	const createWithoutGroupArgv = buildNewWorkspaceArgv({
		name: workspaceName,
		cwd: mainCwd,
		command: childCommand,
		description,
		focus: false,
	});
	const colorArgv = buildSetWorkspaceColorArgv("workspace:NEW", color);
	const renameArgv = buildCmuxRenameArgv("surface:NEW", ORCHESTRATOR_TAB_TITLE);
	const reorderArgv = buildReorderWorkspaceArgv("workspace:NEW", callerWorkspaceRef);

	const argvPlan: string[][] = [baseCreateArgv, colorArgv];
	if (!groupId) argvPlan.push(reorderArgv);
	argvPlan.push(renameArgv);

	if (params.dryRun) {
		const text = [
			`spawn_task_workspace dry-run beadId=${beadId}`,
			`name=${workspaceName}`,
			`mainCwd=${mainCwd}`,
			`color=${color}`,
			`group=${groupId ?? "(none → reorder --after)"}`,
			"argv:",
			...argvPlan.map((row) => `  cmux ${row.map((part) => ( /\s/.test(part) ? posixQuote(part) : part)).join(" ")}`),
		].join("\n");
		return {
			status: "dry-run",
			beadId,
			workspaceName,
			mainCwd,
			color,
			groupUsed: Boolean(groupId),
			argvPlan,
			text,
		};
	}

	// Live path requires cmux identify (already done above or throws).
	await identifyCallerWorkspace(pi).then((id) => {
		callerWorkspaceRef = id.workspaceRef;
	});

	const lockComment = buildSpawnLockComment({
		beadId,
		parentWorkspace: callerWorkspaceRef,
		parentBead: activeBead,
		status: "pending",
	});
	const lockWrite = await pi.exec("bd", ["comments", "add", beadId, lockComment]);
	if (lockWrite.code !== 0) {
		throw new Error(`не удалось записать SPAWN_LOCK: ${lockWrite.stderr || lockWrite.stdout}: BLOCKED`);
	}

	const releaseLock = async (reason: string) => {
		await pi.exec("bd", ["comments", "add", beadId, buildSpawnLockReleaseComment(beadId, reason)]);
	};

	let workspaceRef: string | undefined;
	let usedGroup = Boolean(groupId);
	let createArgv = baseCreateArgv;

	const tryCreate = async (argv: string[]): Promise<{ ok: boolean; ref?: string; error?: string }> => {
		const result = await pi.exec("cmux", argv);
		if (result.code !== 0) {
			return { ok: false, error: (result.stderr || result.stdout || "cmux new-workspace failed").trim() };
		}
		const ref = parseNewWorkspaceRef(result.stdout || "");
		if (!ref) return { ok: false, error: `new-workspace не вернул workspace ref: ${result.stdout}` };
		return { ok: true, ref };
	};

	let created = await tryCreate(createArgv);
	if (!created.ok && groupId) {
		// Group-create fail → one retry without group. Close only if a partial ref appeared.
		if (created.error && /workspace:\d+/.test(created.error)) {
			const partial = parseNewWorkspaceRef(created.error);
			if (partial) await pi.exec("cmux", buildCloseWorkspaceArgv(partial));
		}
		usedGroup = false;
		createArgv = createWithoutGroupArgv;
		created = await tryCreate(createArgv);
	}

	if (!created.ok || !created.ref) {
		await releaseLock(`create-failed: ${created.error ?? "unknown"}`);
		throw new Error(`cmux new-workspace failed: ${created.error ?? "unknown"}: BLOCKED`);
	}
	workspaceRef = created.ref;

	let colorWarning: string | undefined;
	const colorResult = await pi.exec("cmux", buildSetWorkspaceColorArgv(workspaceRef, color));
	if (colorResult.code !== 0) {
		colorWarning = `set-color failed: ${(colorResult.stderr || colorResult.stdout || "").trim()}`;
	}

	if (!usedGroup) {
		const reorder = await pi.exec("cmux", buildReorderWorkspaceArgv(workspaceRef, callerWorkspaceRef));
		if (reorder.code !== 0) {
			// Placement is best-effort after create succeeded.
			colorWarning = [colorWarning, `reorder failed: ${(reorder.stderr || reorder.stdout || "").trim()}`]
				.filter(Boolean)
				.join("; ");
		}
	}

	let surface: string | undefined;
	let renameWarning: string | undefined;
	const surfacesResult = await pi.exec("cmux", buildListPaneSurfacesArgv(workspaceRef));
	if (surfacesResult.code === 0) {
		surface = parseFirstTerminalSurfaceRef(surfacesResult.stdout || "");
	}
	if (surface) {
		const renameResult = await pi.exec("cmux", buildCmuxRenameArgv(surface, ORCHESTRATOR_TAB_TITLE));
		if (renameResult.code !== 0) {
			renameWarning = `rename failed: ${(renameResult.stderr || renameResult.stdout || "").trim()}`;
		}
	} else {
		renameWarning = "list-pane-surfaces не вернул surface; inner tab rename skipped";
	}

	await pi.exec("bd", ["comments", "add", beadId, buildSpawnLockSpawnedComment(beadId, workspaceRef, surface)]);

	const text = [
		`spawn_task_workspace status=spawned beadId=${beadId}`,
		`workspace=${workspaceRef} name=${workspaceName}`,
		`mainCwd=${mainCwd}`,
		`color=${color}${colorWarning ? ` warning=${colorWarning}` : ""}`,
		`surface=${surface ?? "-"}${renameWarning ? ` renameWarning=${renameWarning}` : ""}`,
		`groupUsed=${usedGroup}`,
		"Parent did not claim target. Child Pi starts claim-bead from main checkout.",
	].join("\n");

	return {
		status: "spawned",
		beadId,
		workspaceName,
		workspaceRef,
		surface,
		mainCwd,
		color,
		colorWarning,
		renameWarning,
		groupUsed: usedGroup,
		argvPlan: [createArgv, buildSetWorkspaceColorArgv(workspaceRef, color), ...(usedGroup ? [] : [buildReorderWorkspaceArgv(workspaceRef, callerWorkspaceRef)]), ...(surface ? [buildCmuxRenameArgv(surface, ORCHESTRATOR_TAB_TITLE)] : [])],
		text,
	};
}

export default function beadsDispatchExtension(pi: ExtensionAPI): void {
	const dispatchSupervisorTool = async (_id: string, params: DispatchToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) => {
		try {
			const result = await dispatch(pi, "supervisor", params, signal, ctx.cwd, ctx);
			return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
		} catch (error) {
			return { content: [{ type: "text", text: `dispatch_supervisor не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
		}
	};

	registerSupervisorDispatchApi(pi, {
		dispatchSupervisor(params: DispatchToolParams, ctx: ToolContext, signal?: AbortSignal) {
			return dispatchSupervisorTool("post-approval-continuation", params, signal, undefined, ctx);
		},
	});

	const dispatchReviewerTool = async (_id: string, params: DispatchToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) => {
		try {
			const result = await dispatch(pi, "reviewer", params, signal, ctx.cwd, ctx);
			return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
		} catch (error) {
			return { content: [{ type: "text", text: `dispatch_reviewer не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
		}
	};

	registerReviewerDispatchApi(pi, {
		dispatchReviewer(params: DispatchToolParams, ctx: ToolContext, signal?: AbortSignal) {
			return dispatchReviewerTool("autopilot-hop-reviewer", params, signal, undefined, ctx);
		},
	});

	pi.registerTool({
		name: "dispatch_supervisor",
		label: "Dispatch Supervisor",
		description: "Typed beads workflow dispatch to the appropriate Pi supervisor agent. Requires bead status in_progress. Interactive omit/hasUI → cmux pane; explicit transport=headless for CI/dark-window.",
		parameters: SupervisorDispatchParams,
		execute: dispatchSupervisorTool,
	});

	pi.registerTool({
		name: "dispatch_reviewer",
		label: "Dispatch Reviewer",
		description: "Typed beads workflow dispatch to the Pi code-reviewer agent. Requires bead status inreview. Interactive omit/hasUI → cmux pane (no headless hang). Explicit transport=headless for CI/dark-window; explicit transport=cmux always pane.",
		parameters: ReviewerDispatchParams,
		execute: dispatchReviewerTool,
	});

	pi.registerTool({
		name: "followup_visible_dispatch",
		label: "Follow-up Visible Dispatch",
		description: "Единственный typed hop для live/inreview reuse видимой панели супервизора или code-reviewer. Не first-spawn. User-facing hop skills (5o03) этим tool не выполнен.",
		parameters: FollowupVisibleDispatchParams,
		async execute(_id: string, params: FollowupVisibleParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			try {
				const result = await followupVisibleDispatch(pi, params, ctx, signal);
				return { content: [{ type: "text", text: `followup_visible_dispatch status=${result.status}\n${result.text}` }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `followup_visible_dispatch не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerTool({
		name: "complete_visible_dispatch",
		label: "Complete Visible Dispatch",
		description: "Orchestrator-only: after supervisor ping, record DISPATCH RESULT and submit if the artifact is complete; after code-reviewer ping, record CODE REVIEW verdict. Does not spawn.",
		parameters: {
			type: "object",
			properties: { taskId: { type: "string", description: "Visible dispatch registry taskId" } },
			required: ["taskId"],
			additionalProperties: false,
		},
		async execute(_id: string, params: { taskId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			try {
				const result = await completeVisibleDispatch(pi, params, ctx);
				return { content: [{ type: "text", text: `complete_visible_dispatch status=${result.status}\n${result.text}` }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `complete_visible_dispatch не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerTool({
		name: "close_visible_dispatch",
		label: "Close Visible Dispatch",
		description:
			"Orchestrator-only: after bead is terminal (closed/blocked/deferred) OR stopClose on reviewed (grey-matrix STOP) and no pending-fix reuse, cmux close-surface each live registry pane for this bead and tombstone them. stopClose keeps isolation/followup files until later terminal close. pendingFix=true skips close (NOT APPROVED / followup reuse) and wins over stopClose. Does not sweep foreign panes.",
		parameters: {
			type: "object",
			properties: {
				beadId: { type: "string", description: "Bead whose live supervisor/reviewer panes should be closed" },
				pendingFix: {
					type: "boolean",
					description: "When true (NOT APPROVED / pending-fix), do not close-surface; keep pane for followup_visible_dispatch",
					default: false,
				},
				stopClose: {
					type: "boolean",
					description: "When true, allow close on status=reviewed only (grey-matrix STOP); tombstone without unlinking isolation/followup. BLOCKED for in_progress/inreview/open.",
					default: false,
				},
			},
			required: ["beadId"],
			additionalProperties: false,
		},
		async execute(
			_id: string,
			params: { beadId: string; pendingFix?: boolean; stopClose?: boolean },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			try {
				const result = await closeVisibleDispatch(pi, params, ctx);
				return {
					content: [{ type: "text", text: `close_visible_dispatch status=${result.status}\n${result.text}` }],
					details: result,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `close_visible_dispatch не выполнен: ${(error as Error).message}` }],
					details: { error: (error as Error).message },
				};
			}
		},
	});

	pi.registerTool({
		name: "dispatch_docs_agent",
		label: "Dispatch Docs Agent",
		description: "Typed beads workflow dispatch to the Pi documentation-expert agent.",
		parameters: DispatchParams,
		async execute(_id: string, params: DispatchToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			try {
				const result = await dispatch(pi, "docs", params, signal, ctx.cwd, ctx);
				return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `dispatch_docs_agent не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerTool({
		name: "spawn_task_workspace",
		label: "Spawn Task Workspace",
		description:
			"Open a parallel open bead in a new cmux workspace with a fresh Pi session. Parent does not claim the target. Child starts on main checkout and runs claim-bead itself. Name = `{title} · {suffix}`; inner tab = оркестратор; sidebar color rotates Indigo→Teal→Orange→Purple→Green→Amber. Not available in plan mode. Not a substitute for dispatch_supervisor.",
		parameters: SpawnTaskWorkspaceParams,
		async execute(
			_id: string,
			params: SpawnTaskWorkspaceToolParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			try {
				const result = await spawnTaskWorkspace(pi, params, ctx);
				return { content: [{ type: "text", text: result.text }], details: result };
			} catch (error) {
				return {
					content: [{ type: "text", text: `spawn_task_workspace не выполнен: ${(error as Error).message}` }],
					details: { error: (error as Error).message },
				};
			}
		},
	});
}
