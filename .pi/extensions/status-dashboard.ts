import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	planMode?: string;
	mergeSlotHeld?: boolean;
}

interface WorktreeInfo {
	path: string;
	isLinked: boolean;
}

interface DashboardSnapshot {
	workflow: WorkflowStateSnapshot;
	branch: string;
	dirty?: number;
	worktree?: WorktreeInfo;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
let latestDashboard: DashboardSnapshot | undefined;
let requestFooterRender: (() => void) | undefined;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function visibleWidth(text: string): number {
	return [...stripAnsi(text)].length;
}

function truncatePlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const chars = [...text];
	if (chars.length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${chars.slice(0, maxWidth - 1).join("")}…`;
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

function themePart(theme: { fg(color: string, text: string): string }, label: string, value: string, valueColor = "text"): string {
	if (!label) return theme.fg(valueColor, value);
	return `${theme.fg("muted", `${label}:`)}${theme.fg(valueColor, value)}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function sessionUsageParts(ctx: ExtensionContext): readonly (readonly [string, string, string])[] {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cacheRead += usage?.cacheRead ?? 0;
		cacheWrite += usage?.cacheWrite ?? 0;
	}

	return [
		["in", input ? `↑${formatTokens(input)}` : "-", input ? "text" : "muted"],
		["out", output ? `↓${formatTokens(output)}` : "-", output ? "text" : "muted"],
		["cache", `R${formatTokens(cacheRead)}/W${formatTokens(cacheWrite)}`, cacheRead || cacheWrite ? "accent" : "muted"],
	] as const;
}

function sanitizeStatus(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function fitParts(
	theme: { fg(color: string, text: string): string },
	prefixText: string,
	parts: readonly (readonly [string, string, string])[],
	width: number,
): string {
	const prefix = theme.fg("accent", prefixText);
	const separator = theme.fg("muted", "  ");
	let available = Math.max(0, width - visibleWidth(prefix));
	const rendered: string[] = [];

	for (const [label, value, color] of parts) {
		const plain = label ? `${label}:${value}` : value;
		const separatorWidth = rendered.length > 0 ? 2 : 0;
		if (available <= separatorWidth) break;
		const maxPartWidth = available - separatorWidth;
		const labelWidth = label ? label.length + 1 : 0;
		const truncatedValue = truncatePlain(value, Math.max(1, maxPartWidth - labelWidth));
		const part = themePart(theme, label, truncatedValue, color);
		rendered.push(part);
		available -= separatorWidth + Math.min(visibleWidth(plain), maxPartWidth);
	}

	return prefix + rendered.join(separator);
}

function renderWorkflowFooter(
	ctx: ExtensionContext,
	theme: { fg(color: string, text: string): string },
	footerData: { getExtensionStatuses?: () => ReadonlyMap<string, string> },
	width: number,
): string[] {
	const snapshot = latestDashboard;
	if (!snapshot) return [];

	const wf = snapshot.workflow;
	const dirty = snapshot.dirty;
	const slotHeld = Boolean(wf.mergeSlotHeld);
	const gitState = dirty == null ? "dirty:?" : dirty === 0 ? "clean" : `dirty:${dirty}`;
	const gitStateColor = dirty == null ? "muted" : dirty === 0 ? "success" : "warning";
	const worktree = wf.worktreePath ? `wf:${wf.worktreePath.split("/").filter(Boolean).pop() ?? wf.worktreePath}` : formatWorktree(snapshot.worktree);
	const statusMap = footerData.getExtensionStatuses?.();
	const statuses = Array.from(statusMap?.entries() ?? [])
		.filter(([key]) => key !== "pi-workflow-dashboard" && key !== "workflow-state")
		.map(([, text]) => sanitizeStatus(text))
		.filter(Boolean)
		.slice(0, 4)
		.join(" · ");

	const workflowParts = [
		["wf", wf.state ?? "idle", wf.state === "idle" ? "text" : "accent"],
		["bead", wf.activeBead ?? "-", wf.activeBead ? "accent" : "text"],
		["plan", wf.planMode ?? "off", wf.planMode && wf.planMode !== "off" ? "warning" : "text"],
		["wt", worktree, snapshot.worktree?.isLinked || wf.worktreePath ? "warning" : "text"],
		["", gitState, gitStateColor],
		["slot", slotHeld ? "held" : "free", slotHeld ? "error" : "success"],
	] as const;
	const statsParts = [
		...sessionUsageParts(ctx),
		...(statuses ? [["ext", statuses, "text"] as const] : []),
	] as const;

	return [
		fitParts(theme, "  workflow  ", workflowParts, width),
		fitParts(theme, "  stats     ", statsParts, width),
	];
}

function installWorkflowFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		requestFooterRender = () => tui.requestRender();
		return {
			invalidate() {},
			render(width: number) {
				return renderWorkflowFooter(ctx, theme, footerData, width);
			},
			dispose() {
				if (requestFooterRender) requestFooterRender = undefined;
			},
		};
	});
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

	latestDashboard = { workflow: wf, branch, dirty, worktree };
	ctx.ui.setStatus("pi-workflow-dashboard", ctx.ui.theme.fg("accent", text));
	requestFooterRender?.();
}

export default function statusDashboardExtension(pi: ExtensionAPI): void {
	function installAndRefresh(ctx: ExtensionContext): void {
		installWorkflowFooter(ctx);
		void updateDashboard(pi, ctx);
	}

	function installAfterCompetingFooters(ctx: ExtensionContext): void {
		for (const delay of [0, 50, 200, 500]) {
			setTimeout(() => installAndRefresh(ctx), delay);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		installWorkflowFooter(ctx);
		await updateDashboard(pi, ctx);
		installAfterCompetingFooters(ctx);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		installAndRefresh(ctx);
		installAfterCompetingFooters(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		installWorkflowFooter(ctx);
		await updateDashboard(pi, ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		installWorkflowFooter(ctx);
		await updateDashboard(pi, ctx);
	});
	pi.on("tool_result", async (_event, ctx) => updateDashboard(pi, ctx));

	pi.registerCommand("dashboard", {
		description: "Refresh Pi workflow dashboard footer",
		handler: async (_args, ctx) => {
			installWorkflowFooter(ctx);
			await updateDashboard(pi, ctx);
			if (ctx.hasUI) ctx.ui.notify("Pi workflow dashboard refreshed", "info");
		},
	});
}
