import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface BeadInfo {
	id: string;
	title?: string;
	description?: string;
	status?: string;
	assignee?: string;
	labels?: string[];
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
	startCommit: string;
	exitCode: number;
	output: string;
	stderr: string;
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
		if (match) data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
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

async function getGitValue(pi: ExtensionAPI, args: string[]): Promise<string> {
	const { stdout, stderr, code } = await pi.exec("git", args);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
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

function buildSupervisorPrompt(bead: BeadInfo, branch: string, startCommit: string, task?: string): string {
	return `BEAD_ID: ${bead.id}
BRANCH: ${branch}
START_COMMIT: ${startCommit}

TASK: ${task || bead.title || "Implement the bead"}

Read the bead first:
- bd show ${bead.id}
- bd comments ${bead.id}

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

async function runPiAgent(agent: AgentConfig, prompt: string, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; output: string; stderr: string }> {
	const systemPrompt = await writeTempPrompt(agent.name, agent.systemPrompt);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPrompt.file];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools) args.push("--tools", agent.tools);
	args.push(`Task: ${prompt}`);

	try {
		const invocation = getPiInvocation(args);
		return await new Promise((resolve) => {
			const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			let stderr = "";
			proc.stdout.on("data", (data) => (output += data.toString()));
			proc.stderr.on("data", (data) => (stderr += data.toString()));
			proc.on("close", (code) => resolve({ exitCode: code ?? 0, output, stderr }));
			proc.on("error", (error) => resolve({ exitCode: 1, output, stderr: `${stderr}\n${error.message}` }));
			if (signal) {
				const kill = () => proc.kill("SIGTERM");
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		await fs.promises.rm(systemPrompt.file, { force: true });
		await fs.promises.rm(systemPrompt.dir, { force: true, recursive: true });
	}
}

async function addDispatchComment(pi: ExtensionAPI, beadId: string, agent: string, branch: string, startCommit: string, prompt: string): Promise<void> {
	const comment = `DISPATCH (${agent})\n\nBRANCH: ${branch}\nSTART_COMMIT: ${startCommit}\n\n${prompt}`;
	await pi.exec("bd", ["comments", "add", beadId, comment]);
}

async function dispatch(
	pi: ExtensionAPI,
	mode: "supervisor" | "reviewer" | "docs",
	params: { beadId: string; agent?: string; task?: string; cwd?: string; dryRun?: boolean },
	signal?: AbortSignal,
	defaultCwd?: string,
): Promise<DispatchResult> {
	const cwd = params.cwd ?? defaultCwd ?? process.cwd();
	const bead = await getBead(pi, params.beadId);
	if (mode === "supervisor" && bead.status !== "in_progress") {
		throw new Error(`dispatch_supervisor requires bead status in_progress, got ${bead.status}`);
	}
	if (mode === "reviewer" && bead.status !== "inreview") {
		throw new Error(`dispatch_reviewer requires bead status inreview, got ${bead.status}`);
	}

	const branch = await getGitValue(pi, ["branch", "--show-current"]);
	const startCommit = await getGitValue(pi, ["rev-parse", "HEAD"]);
	const agentName = params.agent ?? (mode === "supervisor" ? chooseSupervisor(bead) : mode === "reviewer" ? "code-reviewer" : "documentation-expert");
	const agent = loadAgent(cwd, agentName);
	const prompt =
		mode === "supervisor"
			? buildSupervisorPrompt(bead, branch, startCommit, params.task)
			: mode === "reviewer"
				? buildReviewerPrompt(bead, branch, startCommit, params.task)
				: buildDocsPrompt(bead, branch, startCommit, params.task);

	await addDispatchComment(pi, bead.id, agentName, branch, startCommit, prompt);
	if (params.dryRun) return { agent: agentName, beadId: bead.id, branch, startCommit, exitCode: 0, output: prompt, stderr: "" };

	const result = await runPiAgent(agent, prompt, cwd, signal);
	return { agent: agentName, beadId: bead.id, branch, startCommit, ...result };
}

function renderDispatchResult(result: DispatchResult): string {
	return [
		`agent=${result.agent}`,
		`bead=${result.beadId}`,
		`branch=${result.branch}`,
		`start=${result.startCommit}`,
		`exit=${result.exitCode}`,
		result.stderr ? `stderr:\n${result.stderr}` : "",
		result.output ? `output:\n${result.output.slice(-8000)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

export default function beadsDispatchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "dispatch_supervisor",
		label: "Dispatch Supervisor",
		description: "Typed beads workflow dispatch to the appropriate Pi supervisor agent. Requires bead status in_progress.",
		parameters: DispatchParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(pi, "supervisor", params, signal, ctx.cwd);
				return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `dispatch_supervisor failed: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerTool({
		name: "dispatch_reviewer",
		label: "Dispatch Reviewer",
		description: "Typed beads workflow dispatch to the Pi code-reviewer agent. Requires bead status inreview.",
		parameters: DispatchParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(pi, "reviewer", params, signal, ctx.cwd);
				return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `dispatch_reviewer failed: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});

	pi.registerTool({
		name: "dispatch_docs_agent",
		label: "Dispatch Docs Agent",
		description: "Typed beads workflow dispatch to the Pi documentation-expert agent.",
		parameters: DispatchParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				const result = await dispatch(pi, "docs", params, signal, ctx.cwd);
				return { content: [{ type: "text", text: renderDispatchResult(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: `dispatch_docs_agent failed: ${(error as Error).message}` }], details: { error: (error as Error).message } };
			}
		},
	});
}
