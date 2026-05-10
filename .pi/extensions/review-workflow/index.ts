import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ReviewParams = {
	type: "object",
	properties: {
		beadId: { type: "string", description: "Bead ID to review" },
		startCommit: { type: "string", description: "Start commit override for scoped diff" },
		dryRun: { type: "boolean", description: "Prepare review context without spawning reviewer", default: false },
	},
	required: ["beadId"],
	additionalProperties: false,
} as const;

interface ReviewResult {
	beadId: string;
	branch: string;
	startCommit: string;
	changedFiles: string[];
	automatedChecks: string[];
	checkpoints: string[];
	frontendChecklist: string[];
	reviewerExitCode?: number;
	reviewerOutput?: string;
	reviewerStderr?: string;
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
	if (!allowed.includes(to)) return `invalid review transition ${from} -> ${to}`;
	if (to === "reviewed" && !/CODE REVIEW:\s*APPROVED|VERDICT:\s*APPROVED/i.test(comments)) return "reviewed requires CODE REVIEW APPROVED evidence";
	if (to === "accepted" && !/ACCEPTANCE|Acceptance evidence|human acceptance/i.test(comments)) return "accepted requires acceptance evidence";
	if (to === "closed" && from !== "accepted" && !/NO_ACCEPTANCE_REQUIRED|no acceptance criteria/i.test(comments)) return "closed requires accepted status or documented no-acceptance shortcut";
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

function checksForFiles(files: string[]): string[][] {
	const checks: string[][] = [];
	if (files.some((file) => /^(app|tests|i18n)\/|\.(vue|ts)$/.test(file))) {
		checks.push(["pnpm", "test"]);
		checks.push(["npx", "vue-tsc", "--noEmit"]);
	}
	if (files.some((file) => file.startsWith("src-tauri/") || file.endsWith(".rs"))) {
		checks.push(["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml"]);
	}
	return checks;
}

async function runChecks(pi: ExtensionAPI, files: string[]): Promise<string[]> {
	const results: string[] = [];
	for (const [command, ...args] of checksForFiles(files)) {
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
		if (match) data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
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

async function runReviewer(cwd: string, prompt: string, signal?: AbortSignal): Promise<{ code: number; output: string; stderr: string }> {
	const agentPath = path.join(cwd, ".pi", "agents", "code-reviewer.md");
	if (!fs.existsSync(agentPath)) throw new Error("Missing .pi/agents/code-reviewer.md");
	const parsed = parseFrontmatter(fs.readFileSync(agentPath, "utf8"));
	const system = await writeTempFile("code-reviewer-system", parsed.body);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", system.file];
	if (parsed.data.tools) args.push("--tools", parsed.data.tools);
	if (parsed.data.model) args.push("--model", parsed.data.model);
	args.push(`Task: ${prompt}`);
	try {
		const invocation = getPiInvocation(args);
		return await new Promise((resolve) => {
			const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			let stderr = "";
			proc.stdout.on("data", (data) => (output += data.toString()));
			proc.stderr.on("data", (data) => (stderr += data.toString()));
			proc.on("close", (code) => resolve({ code: code ?? 0, output, stderr }));
			proc.on("error", (error) => resolve({ code: 1, output, stderr: `${stderr}\n${error.message}` }));
			if (signal) {
				const kill = () => proc.kill("SIGTERM");
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
		`startCommit=${result.startCommit}`,
		`changedFiles=${result.changedFiles.join(", ") || "-"}`,
		"checkpoints:",
		...result.checkpoints.map((item) => `- ${item}`),
		result.frontendChecklist.length > 0 ? "frontendReviewChecklist:" : "frontendReviewChecklist: not applicable",
		...result.frontendChecklist.map((item) => `- ${item}`),
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const bead = await getBead(pi, params.beadId);
				if (bead.status !== "inreview") throw new Error(`review_bead requires status inreview, got ${bead.status}`);
				const comments = await getComments(pi, params.beadId);
				const startCommit = params.startCommit || findStartCommit(comments);
				if (!startCommit) throw new Error("No startCommit provided and no START_COMMIT found in comments.");
				const branch = await execRequired(pi, "git", ["branch", "--show-current"]);
				const changedRaw = await execRequired(pi, "git", ["diff", "--name-only", `${startCommit}..HEAD`]);
				const changedFiles = changedRaw.split("\n").map((line) => line.trim()).filter(Boolean);
				const automatedChecks = params.dryRun ? ["dryRun: automated checks skipped"] : await runChecks(pi, changedFiles);
				const frontendChecklist = frontendReviewChecklist(changedFiles);
				const checkpoints = [
					"Selected model: bd statuses inreview -> simplified -> reviewed -> accepted -> closed with structured comments as audit evidence.",
					"NOT APPROVED path: keep/return bead inreview and redispatch supervisor with exact fixes; do not advance to reviewed/accepted/closed.",
					"APPROVED path: record CODE REVIEW APPROVED evidence, run acceptance checks, then move reviewed -> accepted -> closed.",
					"Terminal guard: standard and direct closed transitions require accepted/reviewing workflow state and policy evidence; direct bypass is blocked by beads-policy.",
					"Epic completion guard: beads-policy blocks standard and direct epic close while any child bead is not closed, unless an explicit documented override is used.",
					"PR merged validation: beads-policy blocks terminal completion on remote feature branches until HEAD is merged into origin/main, gh reports a merged PR, or an explicit documented exception is supplied.",
				];
				const result: ReviewResult = { beadId: params.beadId, branch, startCommit, changedFiles, automatedChecks, checkpoints, frontendChecklist };
				if (!params.dryRun) {
					await exec(pi, "bd", ["comments", "add", params.beadId, "SIMPLIFIED: review_bead simplify gate completed; scoped diff prepared for code review."]);
					await execRequired(pi, "bd", ["update", params.beadId, "--status", "simplified"]);
					const prompt = `BEAD_ID: ${params.beadId}\nBRANCH: ${branch}\nSTART_COMMIT: ${startCommit}\n\nReview git diff ${startCommit}..HEAD. Automated checks already run by review_bead:\n${automatedChecks.join("\n\n")}\n\n${frontendChecklist.length > 0 ? `Frontend checklist required:\n- ${frontendChecklist.join("\n- ")}` : "Frontend checklist: not applicable"}`;
					const reviewer = await runReviewer(ctx.cwd, prompt, signal);
					result.reviewerExitCode = reviewer.code;
					result.reviewerOutput = reviewer.output;
					result.reviewerStderr = reviewer.stderr;
					if (/VERDICT:\s*APPROVED|CODE REVIEW:\s*APPROVED/i.test(reviewer.output)) {
						await exec(pi, "bd", ["comments", "add", params.beadId, `CODE REVIEW: APPROVED\n\nreview_bead evidence:\n${automatedChecks.join("\n\n")}\n\n${frontendChecklist.length > 0 ? `FRONTEND REVIEW CHECKLIST:\n- ${frontendChecklist.join("\n- ")}` : "FRONTEND REVIEW CHECKLIST: not applicable"}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "reviewed"]);
						await exec(pi, "bd", ["comments", "add", params.beadId, `ACCEPTANCE: review_bead acceptance checks completed.\n\n${automatedChecks.join("\n\n")}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "accepted"]);
					} else {
						await exec(pi, "bd", ["comments", "add", params.beadId, `CODE REVIEW: NOT APPROVED\n\nRedispatch required before completion.\n\n${reviewer.output.slice(-4000)}`]);
						await execRequired(pi, "bd", ["update", params.beadId, "--status", "inreview"]);
					}
				}
				return { content: [{ type: "text", text: render(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `review_bead failed: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerCommand("review-bead", {
		description: "Show usage for the review_bead tool",
		handler: async (args, ctx) => {
			const beadId = args.trim();
			ctx.ui.notify(
				beadId
					? `Ask the agent to call review_bead with beadId=${beadId}. The tool will guard status, run checks, and invoke code-reviewer.`
					: "Usage: /review-bead <bead-id> then ask the agent to call review_bead.",
				"info",
			);
		},
	});
}
