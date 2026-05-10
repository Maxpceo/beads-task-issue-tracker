import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	mergeSlotHeld?: boolean;
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data ?? {};
}

async function gitValue(pi: ExtensionAPI, args: string[]): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", args);
	if (code !== 0) return undefined;
	return stdout.trim() || undefined;
}

async function dirtyCount(pi: ExtensionAPI): Promise<number | undefined> {
	const { stdout, code } = await pi.exec("git", ["status", "--short"]);
	if (code !== 0) return undefined;
	return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

async function currentWorktree(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const root = await gitValue(pi, ["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;
	const { stdout, code } = await pi.exec("git", ["worktree", "list", "--porcelain"]);
	if (code !== 0) return root;
	const records = stdout.split("\n\n").map((record) => record.trim()).filter(Boolean);
	for (const record of records) {
		const first = record.split("\n")[0];
		const match = first?.match(/^worktree\s+(.+)$/);
		if (match && (cwd.startsWith(match[1]) || root === match[1])) return match[1];
	}
	return root;
}

function shorten(path: string | undefined): string {
	if (!path) return "no";
	const home = process.env.HOME;
	const display = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	return display.length > 36 ? `…${display.slice(-35)}` : display;
}

async function updateDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const wf = latestWorkflowState(ctx);
	const branch = wf.branch ?? (await gitValue(pi, ["branch", "--show-current"])) ?? "-";
	const dirty = await dirtyCount(pi);
	const worktree = wf.worktreePath ?? (await currentWorktree(pi, ctx.cwd));
	const state = wf.state ?? "idle";
	const bead = wf.activeBead ?? "-";
	const slot = wf.mergeSlotHeld ? "held" : "free";
	const text = `bead:${bead} state:${state} br:${branch} wt:${shorten(worktree)} dirty:${dirty ?? "?"} slot:${slot}`;
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
