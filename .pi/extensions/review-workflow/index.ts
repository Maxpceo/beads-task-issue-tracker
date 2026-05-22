import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderPathRulesLoaded } from "../path-rules/index";
import { AgentDashboardComponent, getSharedDashboardState, publishDashboardCard } from "../subagent/dashboard";
import { resolveActiveTaskScope, taskScopeFromContext } from "../worktree-scope/index";
interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	registerTool(tool: any): void;
	registerCommand(name: string, config: any): void;
	events?: { emit(name: string, event: Record<string, unknown>): void };
}

interface ToolContext {
	cwd: string;
	ui?: any;
	sessionManager?: { getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }> };
}

const ReviewParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Bead ID to review" },
		startCommit: { type: "string", description: "Start commit override for scoped diff" },
		endCommit: { type: "string", description: "End commit override for scoped diff; use this for stacked branches so later task commits are excluded", default: "HEAD" },
		worktreePath: { type: "string", description: "Task worktree path to review; use when orchestrating review from a main/session worktree after supervisor dispatch" },
		dryRun: { type: "boolean", description: "Prepare review context without spawning reviewer", default: false },
	},
	required: ["beadId"],
	additionalProperties: false,
} as const;

interface SupervisorArtifactEvidence {
	status: "accepted" | "insufficient" | "missing" | "n/a";
	statusLine: string;
	evidence: string;
}

interface ReviewResult {
	beadId: string;
	branch: string;
	worktreePath: string;
	startCommit: string;
	endCommit: string;
	changedFiles: string[];
	automatedChecks: string[];
	checkpoints: string[];
	frontendChecklist: string[];
	supervisorArtifact: SupervisorArtifactEvidence;
	reviewerExitCode?: number;
	reviewerOutput?: string;
	reviewerStderr?: string;
	pathRulesLoaded?: string;
}

const REVIEW_TRANSITIONS: Record<string, string[]> = {
	inreview: ["simplified"],
	simplified: ["reviewed"],
	reviewed: ["accepted", "closed"],
	accepted: ["closed"],
};

const FRONTEND_REVIEW_CHECKLIST = [
	"i18n/locale sync: user-visible strings use t()/i18n and en/ru locale files stay synchronized.",
	"Logging: no console.* in app UI code; project logging patterns are used where applicable.",
	"Keyboard/focus: interactive controls are keyboard reachable and have visible focus states.",
	"Accessible names: icon-only buttons/controls have aria-label/title; form controls have labels.",
	"Semantics: buttons/links use correct elements; no div/span click targets without keyboard handling.",
	"Touch targets: primary interactive targets are at least ~44x44px or have equivalent hit area.",
	"Contrast/state: text and important UI states have sufficient contrast and non-color-only indicators where relevant.",
	"Motion: animations/transitions respect reduced-motion project patterns where relevant.",
	"Responsive/layout: component works at narrow widths without horizontal overflow or content jumping.",
	"Regression evidence: record changed Vue files inspected, checks run/manual notes, and redispatch fix list if any.",
];

export function validateReviewTransition(from: string, to: string, comments = ""): string | undefined {
	const allowed = REVIEW_TRANSITIONS[from] ?? [];
	if (!allowed.includes(to)) return `недопустимый review transition ${from} -> ${to}`;
	if (to === "reviewed" && !/CODE REVIEW:\s*APPROVED|VERDICT:\s*APPROVED/i.test(comments)) return "reviewed требует evidence CODE REVIEW: APPROVED или VERDICT: APPROVED";
	if (to === "accepted" && !/ACCEPTANCE|Acceptance evidence|human acceptance/i.test(comments)) return "accepted требует acceptance evidence";
	if (to === "closed" && from !== "accepted" && !/NO_ACCEPTANCE_REQUIRED|no acceptance criteria/i.test(comments)) return "closed требует status accepted или documented no-acceptance shortcut";
	return undefined;
}

export function frontendReviewChecklist(files: string[]): string[] {
	return files.some((file) => /^app\/.*\.vue$/.test(file)) ? FRONTEND_REVIEW_CHECKLIST : [];
}

async function exec(pi: ExtensionAPI, command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec(command, args);
}

async function execRequired(pi: ExtensionAPI, command: string, args: string[]): Promise<string> {
	const { stdout, stderr, code } = await exec(pi, command, args);
	if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
	return stdout.trim();
}

async function getBead(pi: ExtensionAPI, beadId: string): Promise<any> {
	const raw = await execRequired(pi, "bd", ["show", beadId, "--json"]);
	const parsed = JSON.parse(raw);
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function getComments(pi: ExtensionAPI, beadId: string): Promise<string> {
	const { stdout } = await exec(pi, "bd", ["comments", beadId]);
	return stdout;
}

function findStartCommit(comments: string): string | undefined {
	const matches = [...comments.matchAll(/START_COMMIT:\s*([a-f0-9]{7,40})/gi)];
	return matches.at(-1)?.[1];
}

function findEndCommit(comments: string): string | undefined {
	const matches = [...comments.matchAll(/END_COMMIT:\s*([a-f0-9]{7,40}|HEAD)/gi)];
	return matches.at(-1)?.[1];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactField(text: string, names: string[], value?: string): boolean {
	if (!value) return false;
	const escaped = escapeRegExp(value);
	return names.some((name) => new RegExp(`(^|\\n)\\s*${name}\\s*[:=]\\s*${escaped}(\\s|$)`, "im").test(text));
}

function readFieldValues(text: string, names: string[]): string[] {
	const namePattern = names.map(escapeRegExp).join("|");
	const values: string[] = [];
	const regex = new RegExp(`(^|\\n)\\s*(${namePattern})\\s*[:=]\\s*([^\\n]+)`, "gim");
	for (const match of text.matchAll(regex)) {
		const value = match[3]?.trim();
		if (value) values.push(value);
	}
	return values;
}

function latestFieldValue(text: string, names: string[]): string | undefined {
	return readFieldValues(text, names).at(-1);
}

function latestFieldMatches(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	return latestFieldValue(text, names) === current;
}

function latestFieldIsForeign(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	const latest = latestFieldValue(text, names);
	return Boolean(latest && latest !== current);
}

function hasForeignReviewOwnershipEvidence(comments: string, scope: { branch?: string; worktreePath?: string }): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	return latestFieldIsForeign(comments, branchNames, scope.branch) || latestFieldIsForeign(comments, worktreeNames, scope.worktreePath);
}

function reviewOwnershipBlocks(comments: string): string[] {
	const marker = /^.*(?:PLAN APPROVED|DISPATCH(?: RESULT)?|WORKFLOW SUBMIT FOR REVIEW|REVIEW START|review_bead|PI WORKFLOW).*$/gim;
	const starts = [...comments.matchAll(marker)].map((match) => match.index ?? 0);
	if (starts.length === 0) return [comments];
	return starts.map((start, index) => comments.slice(start, starts[index + 1]).trim()).filter(Boolean);
}

function hasReviewOwnershipEvidence(comments: string, scope: { branch?: string; worktreePath?: string; startCommit?: string; endCommit?: string }): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	const startNames = ["START_COMMIT", "START-COMMIT", "Start-commit", "start"];
	const endNames = ["END_COMMIT", "END-COMMIT", "End-commit", "end"];
	if (hasForeignReviewOwnershipEvidence(comments, scope)) return false;
	const hasBranchOrWorktreeField = new RegExp(`(^|\\n)\\s*(${[...branchNames, ...worktreeNames].join("|")})\\s*[:=]`, "im").test(comments);
	const hasScopedDispatchEvidence = reviewOwnershipBlocks(comments).some((block) => {
		const branchMatches = hasExactField(block, branchNames, scope.branch);
		const worktreeMatches = hasExactField(block, worktreeNames, scope.worktreePath);
		const startMatches = hasExactField(block, startNames, scope.startCommit);
		const blockHasEnd = new RegExp(`(^|\\n)\\s*(${endNames.join("|")})\\s*[:=]`, "im").test(block);
		const endMatches = !blockHasEnd || !scope.endCommit || hasExactField(block, endNames, scope.endCommit);
		return branchMatches && worktreeMatches && startMatches && endMatches;
	});
	const legacyStartMatches = !hasBranchOrWorktreeField && hasExactField(comments, startNames, scope.startCommit) && /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(comments);
	return hasScopedDispatchEvidence || legacyStartMatches;
}

function checksForFiles(files: string[], cwd: string): string[][] {
	const checks: string[][] = [];
	if (files.some((file) => /^(app|tests|i18n)\/|\.(vue|ts)$/.test(file))) {
		checks.push(["pnpm", "--dir", cwd, "test"]);
		checks.push(["npx", "--prefix", cwd, "vue-tsc", "--noEmit"]);
	}
	if (files.some((file) => file.startsWith("src-tauri/") || file.endsWith(".rs"))) {
		checks.push(["cargo", "check", "--manifest-path", path.join(cwd, "src-tauri", "Cargo.toml")]);
	}
	return checks;
}

async function runChecks(pi: ExtensionAPI, files: string[], cwd: string): Promise<string[]> {
	const results: string[] = [];
	for (const check of checksForFiles(files, cwd)) {
		const [command, ...args] = check;
		if (!command) continue;
		const { stdout, stderr, code } = await exec(pi, command, args);
		const output = `${stdout}\n${stderr}`.trim().split("\n").slice(-20).join("\n");
		results.push(`${command} ${args.join(" ")} -> exit ${code}\n${output}`);
		if (code !== 0) break;
	}
	if (results.length === 0) results.push("No automated checks selected for changed files.");
	return results;
}

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

async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-review-"));
	const file = path.join(dir, `${prefix}.md`);
	await fs.promises.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
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

type StructuredReviewOutput = { records: unknown[]; structured: boolean };

const APPROVED_MARKER = /(?:^|\n)\s*(?:[-*>]\s*)?(?:VERDICT|CODE REVIEW)\s*:\s*APPROVED\s*(?=\n|$)/i;
const VERDICT_MARKER = /(?:^|\n)\s*(?:[-*>]\s*)?(VERDICT|CODE REVIEW)\s*:\s*(APPROVED|NOT[_ ]APPROVED)\s*(?=\n|$)/gi;

function parseStructuredReviewOutput(output: string): StructuredReviewOutput {
	const trimmed = output.trim();
	if (!trimmed) return { records: [], structured: false };
	try {
		const parsed = JSON.parse(trimmed);
		return { records: Array.isArray(parsed) ? parsed : [parsed], structured: true };
	} catch {
		// Fall through to JSONL parsing.
	}

	const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) return { records: [], structured: false };
	const records: unknown[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line));
		} catch {
			return { records: [], structured: false };
		}
	}
	return { records, structured: true };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasFinalAnswerSignature(record: Record<string, unknown>): boolean {
	const signature = record.textSignature;
	if (isRecordObject(signature)) return signature.phase === "final_answer";
	if (typeof signature !== "string") return false;
	try {
		const parsed = JSON.parse(signature);
		return isRecordObject(parsed) && parsed.phase === "final_answer";
	} catch {
		return /"phase"\s*:\s*"final_answer"/.test(signature);
	}
}

const TOOL_LIKE_DENYLIST = new Set([
	"tool",
	"tool_result",
	"toolresult",
	"toolcall",
	"tool_call",
	"function_call",
	"function_result",
	"log",
	"debug",
	"thinking",
]);

function normalizeRecordKind(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isToolLikeRecord(record: Record<string, unknown>): boolean {
	for (const key of ["role", "type", "customType", "name"] as const) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const normalized = normalizeRecordKind(value);
		if (TOOL_LIKE_DENYLIST.has(normalized)) return true;
		for (const denied of TOOL_LIKE_DENYLIST) {
			if (normalized.includes(denied)) return true;
		}
	}
	return false;
}

function isAssistantFinalRecord(record: Record<string, unknown>): boolean {
	if (isToolLikeRecord(record)) return false;
	const role = typeof record.role === "string" ? record.role.toLowerCase() : undefined;
	const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
	const message = record.message;
	if (role === "assistant") return true;
	if (isRecordObject(message) && typeof message.role === "string" && message.role.toLowerCase() === "assistant") return true;
	if (type === "text" && hasFinalAnswerSignature(record)) return true;
	if (type && ["message", "message_end", "response", "final"].includes(type)) {
		if (typeof record.role === "string" && record.role.toLowerCase() === "assistant") return true;
	}
	return false;
}

function collectTextBlocks(value: unknown, blocked = false): string[] {
	if (blocked) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((item) => collectTextBlocks(item, blocked));
	if (!isRecordObject(value)) return [];
	const nextBlocked = isToolLikeRecord(value);
	if (nextBlocked) return [];

	const texts: string[] = [];
	for (const key of ["text", "output_text", "response"] as const) {
		const candidate = value[key];
		if (typeof candidate === "string") texts.push(candidate);
	}
	for (const key of ["content", "output", "message"] as const) {
		if (key in value) texts.push(...collectTextBlocks(value[key], nextBlocked));
	}
	return texts;
}

function collectSignedFinalAnswerTexts(value: unknown, blocked = false): string[] {
	if (blocked) return [];
	if (Array.isArray(value)) return value.flatMap((item) => collectSignedFinalAnswerTexts(item, blocked));
	if (!isRecordObject(value)) return [];
	const nextBlocked = isToolLikeRecord(value);
	if (nextBlocked) return [];

	const texts: string[] = [];
	if (hasFinalAnswerSignature(value)) {
		for (const key of ["text", "output_text", "response"] as const) {
			const candidate = value[key];
			if (typeof candidate === "string") texts.push(candidate);
		}
	}
	for (const key of ["content", "output", "message"] as const) {
		if (key in value) texts.push(...collectSignedFinalAnswerTexts(value[key], nextBlocked));
	}
	return texts;
}

function authoritativeReviewTexts(record: unknown): string[] {
	if (!isRecordObject(record)) return [];
	const texts: string[] = [];
	if (isAssistantFinalRecord(record)) {
		const message = record.message;
		if (isRecordObject(message)) texts.push(...collectTextBlocks(message.content));
		texts.push(...collectTextBlocks(record.content));
		texts.push(...collectTextBlocks(record.output));
		texts.push(...collectTextBlocks(record.text));
		texts.push(...collectTextBlocks(record.response));
	}
	texts.push(...collectSignedFinalAnswerTexts(record));
	return texts.filter((text) => text.trim());
}

function latestVerdictIsApproved(texts: string[]): boolean {
	let latest: string | undefined;
	for (const text of texts) {
		VERDICT_MARKER.lastIndex = 0;
		for (const match of text.matchAll(VERDICT_MARKER)) {
			latest = match[2]?.toUpperCase().replace(" ", "_");
		}
	}
	return latest === "APPROVED";
}

export function isReviewApproved(output: string): boolean {
	const structured = parseStructuredReviewOutput(output);
	if (structured.structured) {
		const texts = structured.records.flatMap((record) => authoritativeReviewTexts(record));
		if (texts.length === 0) return false;
		return latestVerdictIsApproved(texts);
	}
	return APPROVED_MARKER.test(output);
}


function extractSupervisorArtifact(comments: string): SupervisorArtifactEvidence {
	const marker = /(^|\n)\s*SUPERVISOR ARTIFACT\s*:?\s*(?:\n|$)/gi;
	const matches = [...comments.matchAll(marker)];
	if (matches.length === 0) {
		return {
			status: "n/a",
			statusLine: "ARTIFACT STATUS: N/A (SUPERVISOR ARTIFACT absent)",
			evidence: "SUPERVISOR ARTIFACT: N/A — no durable supervisor artifact was found in bd comments. Treat this as missing implementation evidence, not acceptance.",
		};
	}
	const start = matches.at(-1)?.index ?? 0;
	const nextMarker = comments.slice(start + 1).search(/\n\s*(?:PI WORKFLOW UPDATE|WORKFLOW CLAIM|PLAN APPROVED|DISPATCH(?: RESULT)?|WORKFLOW SUBMIT FOR REVIEW|REVIEW START|CODE REVIEW|ACCEPTANCE|ACCEPTANCE MATRIX)\b/i);
	const raw = (nextMarker >= 0 ? comments.slice(start, start + 1 + nextMarker) : comments.slice(start)).trim();
	const evidence = raw.split("\n").slice(0, 80).join("\n").slice(0, 4000);
	const explicit = raw.match(/(^|\n)\s*(?:Artifact status|ARTIFACT STATUS)\s*[:=]\s*([^\n]+)/i)?.[2]?.trim();
	const verificationExit = raw.match(/(^|\n)\s*(?:exit code|exit|code)\s*[:=]\s*(-?\d+)/i)?.[2];
	const verificationResult = raw.match(/(^|\n)\s*(?:verification result|result)\s*[:=]\s*([^\n]+)/i)?.[2]?.trim();
	const explicitReject = explicit !== undefined && /\b(rejected|reject|insufficient|missing|fail(?:ed)?|not[_ -]?approved|blocked|needs_context)\b/i.test(explicit);
	const explicitAccept = explicit !== undefined && /\b(accepted|approved|sufficient)\b/i.test(explicit);
	const hasVerificationReject = (verificationExit !== undefined && verificationExit !== "0")
		|| /\b(fail(?:ed)?|not[_ -]?run|not[_ -]?approved|blocked)\b/i.test(verificationResult ?? "");
	const hasVerificationAccept = verificationExit === "0"
		|| /\b(pass(?:ed)?|success(?:ful)?|ok)\b/i.test(verificationResult ?? "");
	const status: SupervisorArtifactEvidence["status"] = explicitReject || hasVerificationReject ? "insufficient" : explicitAccept || hasVerificationAccept ? "accepted" : "missing";
	const statusLine = status === "accepted"
		? "ARTIFACT STATUS: accepted (SUPERVISOR ARTIFACT present; evidence only, not acceptance)"
		: status === "insufficient"
			? "ARTIFACT STATUS: insufficient (SUPERVISOR ARTIFACT present but rejected/failed/missing required evidence)"
			: "ARTIFACT STATUS: missing (SUPERVISOR ARTIFACT present but lacks sufficient Artifact status/verification evidence)";
	return { status, statusLine, evidence };
}

function refreshDashboardWidget(ctx?: { ui?: any }): void {
	const state = getSharedDashboardState();
	if (!state?.visible || !ctx?.ui) return;
	ctx.ui.setWidget("subagent-dashboard", (_tui: unknown, theme: any) => new AgentDashboardComponent(() => getSharedDashboardState()!, theme));
}

function publishReviewerDashboardCard(ctx: { ui?: any } | undefined, card: Partial<Parameters<typeof publishDashboardCard>[0]>): void {
	publishDashboardCard({
		agent: "code-reviewer",
		description: "workflow review: code-reviewer",
		source: "project",
		status: "running",
		startedAt: Date.now(),
		toolCount: 0,
		...card,
	});
	refreshDashboardWidget(ctx);
}

async function runReviewer(cwd: string, prompt: string, signal?: AbortSignal, ctx?: { ui?: any }): Promise<{ code: number; output: string; stderr: string }> {
	const agentPath = path.join(cwd, ".pi", "agents", "code-reviewer.md");
	if (!fs.existsSync(agentPath)) throw new Error("Отсутствует .pi/agents/code-reviewer.md");
	const parsed = parseFrontmatter(fs.readFileSync(agentPath, "utf8"));
	const system = await writeTempFile("code-reviewer-system", parsed.body);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", system.file];
	if (parsed.data.tools) args.push("--tools", parsed.data.tools);
	if (parsed.data.model) args.push("--model", parsed.data.model);
	args.push(`Task: ${prompt}`);
	try {
		const invocation = getPiInvocation(args);
		const startedAt = Date.now();
		publishReviewerDashboardCard(ctx, { status: "running", task: prompt.split("\n")[0] || "Review bead", startedAt, lastPreview: "starting code-reviewer..." });
		return await new Promise((resolve) => {
			const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			let stderr = "";
			let wasAborted = false;
			let settled = false;
			const finish = (code: number, finalStderr = stderr) => {
				if (settled) return;
				settled = true;
				const status = wasAborted ? "aborted" : code === 0 ? "completed" : "failed";
				publishReviewerDashboardCard(ctx, {
					status,
					startedAt,
					completedAt: Date.now(),
					lastPreview: output.trim().split("\n").at(-1)?.slice(0, 160) || "reviewer finished",
					errorMessage: finalStderr.trim() || undefined,
				});
				resolve({ code, output, stderr: finalStderr });
			};
			proc.stdout.on("data", (data) => {
				output += data.toString();
				publishReviewerDashboardCard(ctx, { status: "running", startedAt, lastPreview: output.trim().split("\n").at(-1)?.slice(0, 160) || "receiving output..." });
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
		await fs.promises.rm(system.file, { force: true });
		await fs.promises.rm(system.dir, { force: true, recursive: true });
	}
}

function render(result: ReviewResult): string {
	return [
		`bead=${result.beadId}`,
		`branch=${result.branch}`,
		`worktree=${result.worktreePath}`,
		`startCommit=${result.startCommit}`,
		`endCommit=${result.endCommit}`,
		`diff=${result.startCommit}..${result.endCommit}`,
		`changedFiles=${result.changedFiles.join(", ") || "-"}`,
		"checkpoints:",
		...result.checkpoints.map((item) => `- ${item}`),
		result.frontendChecklist.length > 0 ? "frontendReviewChecklist:" : "frontendReviewChecklist: not applicable",
		...result.frontendChecklist.map((item) => `- ${item}`),
		"SUPERVISOR ARTIFACT:",
		result.supervisorArtifact.statusLine,
		result.supervisorArtifact.evidence,
		"SUPERVISOR ARTIFACT NOTE: artifact evidence may be cited in acceptance matrix, but it is not acceptance by itself.",
		result.pathRulesLoaded ?? "PATH_RULES_LOADED:\nNot evaluated.",
		"automatedChecks:",
		...result.automatedChecks.map((item) => `---\n${item}`),
		result.reviewerExitCode === undefined ? "reviewer=not run" : `reviewerExit=${result.reviewerExitCode}`,
		result.reviewerStderr ? `reviewerStderr:\n${result.reviewerStderr}` : "",
		result.reviewerOutput ? `reviewerOutput:\n${result.reviewerOutput.slice(-8000)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export default function reviewWorkflowExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_bead",
		label: "Review Bead",
		description: "Executable Pi review workflow: guard inreview, run relevant checks, then run code-reviewer agent.",
		parameters: ReviewParams,
		async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			try {
				const bead = await getBead(pi, params.beadId);
				if (bead.status !== "inreview") throw new Error(`review_bead требует status inreview, получен ${bead.status}`);
				const comments = await getComments(pi, params.beadId);
				const stateScope = resolveActiveTaskScope(taskScopeFromContext(ctx));
				const matchingStateScope = stateScope.ok && stateScope.scope.activeBead === params.beadId ? stateScope.scope : undefined;
				const startCommit = params.startCommit || findStartCommit(comments) || matchingStateScope?.startCommit;
				if (!startCommit) throw new Error("startCommit не передан и START_COMMIT не найден в comments.");
				const endCommit = params.endCommit || findEndCommit(comments) || matchingStateScope?.endCommit || "HEAD";
				const reviewCwd = params.worktreePath || matchingStateScope?.worktreePath || ctx.cwd;
				const branch = await execRequired(pi, "git", ["-C", reviewCwd, "branch", "--show-current"]);
				const worktreePath = await execRequired(pi, "git", ["-C", reviewCwd, "rev-parse", "--show-toplevel"]);
				if (!hasReviewOwnershipEvidence(comments, { branch, worktreePath, startCommit, endCommit })) {
					throw new Error(`review_bead отклонён для ${params.beadId}: нет совпадающего branch/worktree/start ownership evidence для review scope ${worktreePath || reviewCwd}. Agents могут проверить bd comments ${params.beadId}, вызвать workflow_reset для stale local state или явно подтвердить takeover и привязать verified dispatch evidence через workflow_update(bead=${params.beadId}, session=reviewing, branch=<branch>, worktree=<worktree>, start=<sha>, end=<sha>) перед повторным review_bead с worktreePath=<worktree>.`);
				}
				pi.events?.emit("workflow-state:update", { activeBead: params.beadId, sessionMode: "reviewing", branch, worktreePath, startCommit, endCommit });
				const changedRaw = await execRequired(pi, "git", ["-C", reviewCwd, "diff", "--name-only", `${startCommit}..${endCommit}`]);
				const changedFiles = changedRaw.split("\n").map((line) => line.trim()).filter(Boolean);
				const automatedChecks = params.dryRun ? ["dryRun: automated checks skipped"] : await runChecks(pi, changedFiles, reviewCwd);
				const frontendChecklist = frontendReviewChecklist(changedFiles);
				const pathRulesLoaded = await renderPathRulesLoaded(reviewCwd, changedFiles);
				const supervisorArtifact = extractSupervisorArtifact(comments);
				const checkpoints = [
					"Selected model: bd statuses inreview -> simplified -> reviewed -> accepted -> closed with structured comments as audit evidence.",
					`Supervisor artifact handoff: ${supervisorArtifact.statusLine}; artifact is evidence only and must not auto-accept work.`,
					"NOT APPROVED path: keep/return bead inreview and redispatch supervisor with exact fixes; do not advance to reviewed/accepted/closed.",
					"APPROVED path: record CODE REVIEW APPROVED evidence, run acceptance checks, then move reviewed -> accepted -> closed.",
					"Terminal guard: standard and direct closed transitions require accepted/reviewing workflow state and policy evidence; direct bypass is blocked by beads-policy.",
					"Epic completion guard: beads-policy blocks standard and direct epic close while any child bead is not closed, unless an explicit documented override is used.",
					"Merge validation: per-task bead close may happen before merge; explicit merge-to-main performs PR/origin-main evidence and final session verdict checks.",
				];
				const result: ReviewResult = { beadId: params.beadId, branch, worktreePath, startCommit, endCommit, changedFiles, automatedChecks, checkpoints, frontendChecklist, supervisorArtifact, pathRulesLoaded };
				if (!params.dryRun) {
					await exec(pi, "bd", ["comments", "add", params.beadId, `REVIEW START (review_bead)\n\nBRANCH: ${branch}\nWORKTREE: ${worktreePath}\nSTART_COMMIT: ${startCommit}\nEND_COMMIT: ${endCommit}\n\nSIMPLIFIED: review_bead simplify gate completed; scoped diff ${startCommit}..${endCommit} prepared for code review.

SUPERVISOR ARTIFACT HANDOFF
${supervisorArtifact.statusLine}
${supervisorArtifact.evidence}

Artifact evidence may be cited in acceptance matrix, but it is not acceptance by itself.`]);
					await execRequired(pi, "bd", ["update", params.beadId, "--status", "simplified"]);
					const prompt = `BEAD_ID: ${params.beadId}\nBRANCH: ${branch}\nSTART_COMMIT: ${startCommit}\nEND_COMMIT: ${endCommit}\n\nReview git diff ${startCommit}..${endCommit}. Automated checks already run by review_bead:\n${automatedChecks.join("\n\n")}\n\nReview status note: review_bead temporarily moves the bead to bd status simplified while the reviewer runs. Do not reject solely because bd show reports simplified during this review; if the final verdict is not approved, review_bead must restore status inreview after reviewer exit.\n\nSUPERVISOR ARTIFACT HANDOFF:\n${supervisorArtifact.statusLine}\n${supervisorArtifact.evidence}\nArtifact evidence may be cited in acceptance matrix, but it is not acceptance by itself.\n\n${frontendChecklist.length > 0 ? `Frontend checklist required:\n- ${frontendChecklist.join("\n- ")}` : "Frontend checklist: not applicable"}\n\n${pathRulesLoaded}`;
					const reviewer = await runReviewer(reviewCwd, prompt, signal, ctx);
					result.reviewerExitCode = reviewer.code;
					result.reviewerOutput = reviewer.output;
					result.reviewerStderr = reviewer.stderr;
					if (isReviewApproved(reviewer.output)) {
						await exec(pi, "bd", ["comments", "add", params.beadId, `CODE REVIEW: APPROVED\n\nSUPERVISOR ARTIFACT HANDOFF\n${supervisorArtifact.statusLine}\n${supervisorArtifact.evidence}\n\nreview_bead evidence:\n${automatedChecks.join("\n\n")}\n\n${frontendChecklist.length > 0 ? `FRONTEND REVIEW CHECKLIST:\n- ${frontendChecklist.join("\n- ")}` : "FRONTEND REVIEW CHECKLIST: not applicable"}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "reviewed"]);
						await exec(pi, "bd", ["comments", "add", params.beadId, `ACCEPTANCE: review_bead acceptance checks completed.\n\nSUPERVISOR ARTIFACT HANDOFF\n${supervisorArtifact.statusLine}\nArtifact evidence may be cited in ACCEPTANCE MATRIX when mapped to criteria with fresh verification; artifact is not acceptance by itself.\n\n${automatedChecks.join("\n\n")}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "accepted"]);
						await exec(pi, "bd", ["close", params.beadId, "--reason", "Reviewed and accepted by review_bead"]);
						pi.events?.emit("workflow-state:update", { activeBead: params.beadId, sessionMode: "closed", branch, worktreePath, startCommit, endCommit });
					} else {
						await exec(pi, "bd", ["comments", "add", params.beadId, `CODE REVIEW: NOT APPROVED\n\nSUPERVISOR ARTIFACT HANDOFF\n${supervisorArtifact.statusLine}\n${supervisorArtifact.evidence}\n\nRedispatch required before completion.\n\n${reviewer.output.slice(-4000)}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "inreview"]);
						pi.events?.emit("workflow-state:update", { activeBead: params.beadId, sessionMode: "inreview", branch, worktreePath, startCommit, endCommit });
					}
				}
				return { content: [{ type: "text", text: render(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `review_bead не выполнен: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerCommand("review-bead", {
		description: "Show usage for the review_bead tool",
		handler: async (args: string, ctx: { ui: { notify(message: string, level: string): void } }) => {
			const beadId = args.trim();
			ctx.ui.notify(
				beadId
					? `Попросите агента вызвать review_bead с beadId=${beadId}. Tool проверит status, запустит checks и вызовет code-reviewer.`
					: "Usage: /review-bead <bead-id>, затем попросите агента вызвать review_bead.",
				"info",
			);
		},
	});
}
