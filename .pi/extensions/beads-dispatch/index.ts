import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publishDashboardCard, getSharedDashboardState, AgentDashboardComponent, registerDashboardRenderer } from "../subagent/dashboard";
import { inferTargetFilesFromText, renderPathRulesLoaded } from "../path-rules/index";
import { resolveActiveTaskScope, taskScopeFromContext } from "../worktree-scope/index";

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
}

type DispatchToolParams = { beadId: string; agent?: string; task?: string; cwd?: string; dryRun?: boolean };

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
	return {
		name: parsed.data.name || name,
		filePath,
		systemPrompt: parsed.body,
		tools: parsed.data.tools,
		model: parsed.data.model,
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

function chooseSupervisor(bead: BeadInfo): string {
	const labels = new Set(bead.labels ?? []);
	const text = `${bead.title ?? ""}\n${bead.description ?? ""}`.toLowerCase();
	if (labels.has("backend") || labels.has("tracker") || /rust|tauri|cargo|src-tauri/.test(text)) return "tauri-supervisor";
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

function getPlanComment(comments: BeadComment[]): string | undefined {
	return comments.map((comment) => comment.text ?? "").reverse().find((text) => /PLAN APPROVED/.test(text));
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
- Concerns: <risks/follow-ups or N/A>
- Artifact status: <complete | incomplete, with reason if incomplete>`;
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
3. Set bead status to inreview if appropriate.
4. Return a concise completion report.`;
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

function refreshDashboardWidget(ctx?: { ui?: any }): void {
	const state = getSharedDashboardState();
	if (!state?.visible || !ctx?.ui) return;
	ctx.ui.setWidget("subagent-dashboard", (tui: { requestRender?: () => void } | undefined, theme: any) => {
		registerDashboardRenderer(tui);
		return new AgentDashboardComponent(() => getSharedDashboardState()!, theme);
	});
}

function publishWorkflowDashboardCard(ctx: { ui?: any } | undefined, agent: AgentConfig, card: Partial<Parameters<typeof publishDashboardCard>[0]>): void {
	publishDashboardCard({
		agent: agent.name,
		description: `workflow dispatch: ${agent.name}`,
		source: "project",
		status: "running",
		startedAt: Date.now(),
		toolCount: 0,
		...card,
	});
	refreshDashboardWidget(ctx);
}

async function runPiAgent(agent: AgentConfig, prompt: string, cwd: string, signal?: AbortSignal, ctx?: { ui?: any }): Promise<{ exitCode: number; output: string; stderr: string }> {
	const systemPrompt = await writeTempPrompt(agent.name, agent.systemPrompt);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPrompt.file];
	if (agent.model) args.push("--model", agent.model);
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

async function dispatch(
	pi: ExtensionAPI,
	mode: "supervisor" | "reviewer" | "docs",
	params: { beadId: string; agent?: string; task?: string; cwd?: string; dryRun?: boolean },
	signal?: AbortSignal,
	defaultCwd?: string,
	ctx?: ToolContext,
): Promise<DispatchResult> {
	const stateScope = resolveActiveTaskScope(taskScopeFromContext(ctx));
	const cwd = params.cwd ?? (stateScope.ok && stateScope.scope.activeBead === params.beadId ? stateScope.scope.worktreePath : undefined) ?? defaultCwd ?? process.cwd();
	const bead = await getBead(pi, params.beadId);
	const comments = await getComments(pi, params.beadId);
	if (mode === "supervisor") {
		const readinessErrors = validateSupervisorReadiness(bead, comments);
		if (readinessErrors.length > 0) throw new Error(`dispatch_supervisor readiness не пройдена: ${readinessErrors.join("; ")}`);
	}
	if (mode === "reviewer" && bead.status !== "inreview") {
		throw new Error(`dispatch_reviewer требует bead status inreview, получен ${bead.status}`);
	}

	const branch = await getGitValue(pi, cwd, ["branch", "--show-current"]);
	const worktreePath = await getGitValue(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const startCommit = await getGitValue(pi, cwd, ["rev-parse", "HEAD"]);
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

	await addDispatchComment(pi, bead.id, agentName, branch, worktreePath, startCommit, prompt);
	if (mode === "supervisor") {
		pi.events.emit("workflow-state:update", { activeBead: bead.id, state: "implementing", sessionMode: "implementing", branch, worktreePath, startCommit });
	} else if (mode === "reviewer") {
		pi.events.emit("workflow-state:update", { activeBead: bead.id, state: "reviewing", sessionMode: "reviewing", branch, worktreePath, startCommit });
	}
	if (params.dryRun) return { agent: agentName, beadId: bead.id, branch, worktreePath, startCommit, exitCode: 0, output: prompt, stderr: "" };

	const result = await runPiAgentForDispatch(agent, prompt, cwd, signal, ctx);
	if (mode === "supervisor") {
		const endCommit = await getGitValue(pi, cwd, ["rev-parse", "HEAD"]);
		const updatedBead = await getBead(pi, bead.id);
		await addEndCommitComment(pi, bead.id, agentName, branch, worktreePath, startCommit, endCommit);
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
		return { agent: agentName, beadId: bead.id, branch, worktreePath, startCommit, endCommit, ...result };
	}
	return { agent: agentName, beadId: bead.id, branch, worktreePath, startCommit, ...result };
}

function renderDispatchResult(result: DispatchResult): string {
	return [
		`agent=${result.agent}`,
		`bead=${result.beadId}`,
		`branch=${result.branch}`,
		`worktree=${result.worktreePath}`,
		`start=${result.startCommit}`,
		result.endCommit ? `end=${result.endCommit}` : "",
		`exit=${result.exitCode}`,
		result.stderr ? `stderr:\n${result.stderr}` : "",
		result.output ? `output:\n${result.output.slice(-8000)}` : "",
	]
		.filter(Boolean)
		.join("\n");
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

	pi.registerTool({
		name: "dispatch_supervisor",
		label: "Dispatch Supervisor",
		description: "Typed beads workflow dispatch to the appropriate Pi supervisor agent. Requires bead status in_progress.",
		parameters: DispatchParams,
		execute: dispatchSupervisorTool,
	});

	pi.registerTool({
		name: "dispatch_reviewer",
		label: "Dispatch Reviewer",
		description: "Typed beads workflow dispatch to the Pi code-reviewer agent. Requires bead status inreview.",
		parameters: DispatchParams,
		async execute(_id: string, params: DispatchToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			try {
				const result = await dispatch(pi, "reviewer", params, signal, ctx.cwd, ctx);
				return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `dispatch_reviewer не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
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
}
