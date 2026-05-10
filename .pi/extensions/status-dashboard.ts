import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	mergeSlotHeld?: boolean;
}

interface WorktreeInfo {
	path: string;
	isLinked: boolean;
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data ?? {};
}

async function gitValue(pi: ExtensionAPI, args: string[], cwd?: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", cwd ? ["-C", cwd, ...args] : args);
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function dirtyCount(pi: ExtensionAPI, cwd: string): Promise<number | undefined> {
	const { stdout, code } = await pi.exec("git", ["-C", cwd, "status", "--short"]);
	if (code !== 0) return undefined;
	return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

function isSameOrChildPath(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

async function currentWorktree(pi: ExtensionAPI, cwd: string): Promise<WorktreeInfo | undefined> {
	const root = await gitValue(pi, ["rev-parse", "--show-toplevel"], cwd);
	if (!root) return undefined;
	const { stdout, code } = await pi.exec("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
	if (code !== 0) return { path: root, isLinked: false };
	const paths = stdout
		.split("\n\n")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => record.split("\n")[0]?.match(/^worktree\s+(.+)$/)?.[1])
		.filter((path): path is string => Boolean(path));
	const primaryPath = paths[0];
	const currentPath = paths.find((path) => isSameOrChildPath(cwd, path) || root === path) ?? root;
	return { path: currentPath, isLinked: Boolean(primaryPath && currentPath !== primaryPath) };
}

function formatWorktree(info: WorktreeInfo | undefined): string {
	if (!info) return "?";
	if (!info.isLinked) return "primary";
	const name = info.path.split("/").filter(Boolean).pop() ?? info.path;
	return `linked:${name}`;
}

async function updateDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const wf = latestWorkflowState(ctx);
	const branch = (await gitValue(pi, ["branch", "--show-current"], ctx.cwd)) ?? wf.branch ?? "-";
	const dirty = await dirtyCount(pi, ctx.cwd);
	const worktree = await currentWorktree(pi, ctx.cwd);
	const state = wf.state ?? "idle";
	const bead = wf.activeBead ?? "-";
	const slot = wf.mergeSlotHeld ? "held" : "free";
	const text = `bead:${bead} state:${state} br:${branch} wt:${formatWorktree(worktree)} dirty:${dirty ?? "?"} slot:${slot}`;
	ctx.ui.setStatus("pi-workflow-dashboard", ctx.ui.theme.fg("accent", text));
}

export default function statusDashboardExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => updateDashboard(pi, ctx));
	pi.on("turn_start", async (_event, ctx) => updateDashboard(pi, ctx));
	pi.on("turn_end", async (_event, ctx) => updateDashboard(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => updateDashboard(pi, ctx));

	pi.registerCommand("dashboard", {
		description: "Refresh Pi workflow dashboard footer",
		handler: async (_args, ctx) => {
			await updateDashboard(pi, ctx);
			if (ctx.hasUI) ctx.ui.notify("Pi workflow dashboard refreshed", "info");
		},
	});
}
