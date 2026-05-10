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
	reviewerExitCode?: number;
	reviewerOutput?: string;
	reviewerStderr?: string;
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
				const result: ReviewResult = { beadId: params.beadId, branch, startCommit, changedFiles, automatedChecks };
				if (!params.dryRun) {
					const prompt = `BEAD_ID: ${params.beadId}\nBRANCH: ${branch}\nSTART_COMMIT: ${startCommit}\n\nReview git diff ${startCommit}..HEAD. Automated checks already run by review_bead:\n${automatedChecks.join("\n\n")}`;
					const reviewer = await runReviewer(ctx.cwd, prompt, signal);
					result.reviewerExitCode = reviewer.code;
					result.reviewerOutput = reviewer.output;
					result.reviewerStderr = reviewer.stderr;
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
