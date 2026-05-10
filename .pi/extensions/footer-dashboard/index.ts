import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface WorkflowStateSnapshot {
	activeBead?: string;
	state?: string;
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

interface FooterCache {
	dirtyCount?: number;
	worktree?: WorktreeInfo;
	lastRefresh: number;
}

const STATUS_KEYS_TO_HIDE = new Set(["pi-workflow-dashboard", "workflow-state"]);
const REFRESH_THROTTLE_MS = 2_000;

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data ?? {};
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatPath(path: string | undefined, maxWidth = 34): string {
	if (!path) return "-";
	const home = process.env.HOME;
	const display = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	return visibleWidth(display) > maxWidth ? truncateToWidth(display, maxWidth, "…") : display;
}

function isSameOrChildPath(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

function formatWorktree(info: WorktreeInfo | undefined): string {
	if (!info) return "?";
	if (!info.isLinked) return "primary";
	const name = info.path.split("/").filter(Boolean).pop() ?? formatPath(info.path, 18);
	return `linked:${name}`;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function visibleJoin(parts: string[], separator: string): string {
	return parts.filter(Boolean).join(separator);
}

function sectionLine(
	width: number,
	theme: ExtensionContext["ui"]["theme"],
	label: string,
	parts: string[],
	options: { dimParts?: boolean } = {},
): string {
	const prefix = `${theme.fg("accent", theme.bold(label))} ${theme.fg("dim", "│")} `;
	const separator = ` ${theme.fg("dim", "│")} `;
	const body = visibleJoin(parts, separator);
	const line = prefix + (options.dimParts ? theme.fg("dim", body) : body);
	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

function usageParts(ctx: ExtensionContext): string[] {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			input += message.usage.input;
			output += message.usage.output;
			cacheRead += message.usage.cacheRead;
			cacheWrite += message.usage.cacheWrite;
			cost += message.usage.cost.total;
		}
	}

	const parts: string[] = [];
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	if (cost) parts.push(`$${cost.toFixed(3)}`);
	return parts;
}

function contextPart(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!usage || usage.percent === null || !contextWindow) return "ctx ?";
	return `ctx ${Math.round(usage.percent)}%/${formatTokens(contextWindow)}`;
}

function modelParts(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
	return [`model ${model}`, `think ${pi.getThinkingLevel()}`, contextPart(ctx), ...usageParts(ctx)];
}

function workflowParts(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string[] {
	const workflow = latestWorkflowState(ctx);
	const statuses = footerData.getExtensionStatuses();
	const statusParts = Array.from(statuses.entries())
		.filter(([key]) => !STATUS_KEYS_TO_HIDE.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter(Boolean);

	const parts = [
		`state ${workflow.state ?? "idle"}`,
		`bead ${workflow.activeBead ?? "-"}`,
		`plan ${workflow.planMode ?? "off"}`,
		`merge ${workflow.mergeSlotHeld ? "held" : "free"}`,
	];

	if (statusParts.length > 0) parts.push(...statusParts);
	return parts;
}

async function detectDirtyCount(pi: ExtensionAPI, cwd: string): Promise<number | undefined> {
	const { stdout, code } = await pi.exec("git", ["-C", cwd, "status", "--short"]);
	if (code !== 0) return undefined;
	return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

async function detectWorktree(pi: ExtensionAPI, cwd: string): Promise<WorktreeInfo | undefined> {
	const rootResult = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) return undefined;
	const root = rootResult.stdout.trim() || undefined;
	if (!root) return undefined;

	const worktreeResult = await pi.exec("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
	if (worktreeResult.code !== 0) return { path: root, isLinked: false };

	const paths = worktreeResult.stdout
		.split("\n\n")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => record.split("\n")[0]?.match(/^worktree\s+(.+)$/)?.[1])
		.filter((path): path is string => Boolean(path));
	const primaryPath = paths[0];
	const currentPath = paths.find((path) => isSameOrChildPath(cwd, path) || root === path) ?? root;
	return { path: currentPath, isLinked: Boolean(primaryPath && currentPath !== primaryPath) };
}

export default function footerDashboardExtension(pi: ExtensionAPI): void {
	let cache: FooterCache = { lastRefresh: 0 };
	let activeTui: TUI | undefined;

	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (!ctx.hasUI) return;
		const now = Date.now();
		if (!force && now - cache.lastRefresh < REFRESH_THROTTLE_MS) return;
		cache = {
			dirtyCount: await detectDirtyCount(pi, ctx.cwd),
			worktree: await detectWorktree(pi, ctx.cwd),
			lastRefresh: now,
		};
		activeTui?.requestRender();
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribeBranch();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const workflow = latestWorkflowState(ctx);
					const branch = footerData.getGitBranch() ?? workflow.branch ?? "-";
					const dirty = cache.dirtyCount === undefined ? "?" : `${cache.dirtyCount}`;

					return [
						sectionLine(width, theme, "repo", [
							`branch ${branch}`,
							`dirty ${dirty}`,
							`wt ${formatWorktree(cache.worktree)}`,
						]),
						sectionLine(width, theme, "model", modelParts(pi, ctx), { dimParts: true }),
						sectionLine(width, theme, "workflow", workflowParts(ctx, footerData)),
					];
				},
			} satisfies Component & { dispose(): void };
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		await refresh(ctx, true);
	});

	pi.on("turn_start", async (_event, ctx) => refresh(ctx));
	pi.on("turn_end", async (_event, ctx) => refresh(ctx, true));
	pi.on("tool_result", async (_event, ctx) => refresh(ctx));

	pi.registerCommand("footer-dashboard", {
		description: "Refresh structured Pi footer dashboard",
		handler: async (_args, ctx) => {
			installFooter(ctx);
			await refresh(ctx, true);
			ctx.ui.notify("Footer dashboard refreshed", "info");
		},
	});
}
