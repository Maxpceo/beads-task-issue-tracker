import * as fs from "node:fs";
import * as path from "node:path";

interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
}

interface ExtensionContext {
	cwd: string;
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
	ui: { notify(message: string, level: string): void };
}

interface WorkflowStateSnapshot {
	activeBead?: string;
	state?: string;
	sessionMode?: string;
	planMode?: string;
	planApproved?: boolean | string;
	mergeSlotHeld?: boolean;
	bdStatus?: string;
	runtimeOwnerKey?: string;
}

interface Snapshot {
	workflowContext: string;
	branch: string;
	gitStatus: string;
	dirtyWarning: string;
	inProgress: string;
	inReview: string;
	ready: string;
	blocked: string;
	stale: string;
	openPrs: string;
	mergedWorktreeHints: string;
	recentKnowledge: string;
	worktrees: string;
	createdAt: string;
}

async function run(pi: ExtensionAPI, command: string, args: string[]): Promise<string> {
	const { stdout, stderr, code } = await pi.exec(command, args);
	if (code !== 0) return `(exit ${code}) ${stderr || stdout}`.trim();
	return stdout.trim() || "-";
}

async function runShell(pi: ExtensionAPI, script: string): Promise<string> {
	return run(pi, "bash", ["-lc", script]);
}

function truncate(text: string, maxLines = 40): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return [...lines.slice(0, maxLines), `... truncated ${lines.length - maxLines} lines`].join("\n");
}

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function latestWorkflowState(entries: Array<{ type: string; customType?: string; data?: unknown }>): WorkflowStateSnapshot {
	const ownerKey = currentRuntimeOwnerKey();
	const current = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "workflow-state")
		.filter((entry) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === ownerKey)
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return current?.data ?? {};
}

function renderWorkflowContext(workflow: WorkflowStateSnapshot): string {
	const session = workflow.sessionMode ?? workflow.state ?? "idle";
	const plan = `${workflow.planMode ?? "off"}/${workflow.planApproved ? "approved" : "pending"}`;
	return [`session:${session}`, `bead:${workflow.activeBead ?? "-"}`, `bd:${workflow.bdStatus ?? "-"}`, `plan:${plan}`, `slot:${workflow.mergeSlotHeld ? "held" : "free"}`].join(" | ");
}

function recentKnowledge(cwd: string): string {
	const file = path.join(cwd, ".beads", "memory", "knowledge.jsonl");
	if (!fs.existsSync(file)) return "-";
	const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-20);
	const byKey = new Map<string, any>();
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			byKey.set(entry.key, entry);
		} catch {
			// Ignore malformed memory lines; they should not break session start.
		}
	}
	const entries = [...byKey.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 5);
	return entries.map((entry) => `  [${String(entry.type ?? "info").toUpperCase().slice(0, 5)}] ${String(entry.content ?? "").slice(0, 120)} (${entry.bead ?? entry.source ?? "unknown"})`).join("\n") || "-";
}

function renderSnapshot(snapshot: Snapshot): string {
	return `[PI SESSION START CONTEXT]
Created: ${snapshot.createdAt}

Workflow context:
${snapshot.workflowContext}

Branch:
${snapshot.branch}

Dirty warning:
${truncate(snapshot.dirtyWarning, 20)}

Git status --short:
${truncate(snapshot.gitStatus, 30)}

bd in_progress:
${truncate(snapshot.inProgress, 30)}

bd inreview:
${truncate(snapshot.inReview, 30)}

bd ready:
${truncate(snapshot.ready, 30)}

bd blocked:
${truncate(snapshot.blocked, 20)}

bd stale:
${truncate(snapshot.stale, 20)}

Open PRs:
${truncate(snapshot.openPrs, 20)}

Merged worktree cleanup hints:
${truncate(snapshot.mergedWorktreeHints, 20)}

Recent knowledge:
${truncate(snapshot.recentKnowledge, 20)}

Git worktrees:
${truncate(snapshot.worktrees, 30)}

Use this context to resume interrupted Pi workflow. For details, read .pi/plans/pi-native-workflow-migration.md and inspect active beads. Domain rules live in .pi/rules/domain.md.`;
}

export default function sessionContextExtension(pi: ExtensionAPI): void {
	let snapshot: Snapshot | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const mergedWorktreeScript = `repo=$(git rev-parse --show-toplevel 2>/dev/null || pwd); git worktree list --porcelain 2>/dev/null | awk '/^worktree .*\\/Projects\\/worktrees\\/beads-task-issue-tracker\\// {print $2}' | while read -r wt; do branch=$(git -C "$wt" branch --show-current 2>/dev/null); [ -z "$branch" ] && continue; if git -C "$repo" branch --merged main --format='%(refname:short)' 2>/dev/null | grep -Fxq "$branch"; then echo "✓ $branch merged; cleanup: bd worktree remove $wt"; fi; done`;
		snapshot = {
			workflowContext: renderWorkflowContext(latestWorkflowState(ctx.sessionManager.getEntries())),
			branch: await run(pi, "git", ["branch", "--show-current"]),
			gitStatus: await run(pi, "git", ["status", "--short"]),
			dirtyWarning: await runShell(pi, "if [ -n \"$(git status --porcelain 2>/dev/null)\" ]; then echo '⚠️ Uncommitted changes detected. Commit/stash before starting unrelated work.'; else echo '-'; fi"),
			inProgress: await run(pi, "bd", ["list", "--status=in_progress"]),
			inReview: await run(pi, "bd", ["list", "--status=inreview"]),
			ready: await run(pi, "bd", ["ready"]),
			blocked: await runShell(pi, "bd blocked 2>/dev/null || true"),
			stale: await runShell(pi, "bd stale --days 3 2>/dev/null || true"),
			openPrs: await runShell(pi, "if command -v gh >/dev/null 2>&1; then gh pr list --author '@me' --state open --json number,title,headRefName 2>/dev/null | jq -r '.[] | \"#\\(.number) \\(.title) (\\(.headRefName))\"' 2>/dev/null || true; else echo 'gh unavailable'; fi"),
			mergedWorktreeHints: await runShell(pi, mergedWorktreeScript),
			recentKnowledge: recentKnowledge(ctx.cwd),
			worktrees: await run(pi, "git", ["worktree", "list", "--porcelain"]),
			createdAt: new Date().toISOString(),
		};
		ctx.ui.notify("Pi session context captured", "info");
	});

	pi.on("before_agent_start", async () => {
		if (!snapshot) return undefined;
		return {
			message: {
				customType: "pi-session-context",
				content: renderSnapshot(snapshot),
				display: false,
			},
		};
	});

	pi.registerCommand("session-context", {
		description: "Show captured Pi session-start context",
		handler: async (_args, ctx) => {
			if (!snapshot) {
				ctx.ui.notify("No session context captured yet", "warning");
				return;
			}
			ctx.ui.notify(renderSnapshot(snapshot), "info");
		},
	});
}
