import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	planMode?: string;
	mergeSlotHeld?: boolean;
	planApproved?: boolean | string;
	sessionMode?: string;
	bdStatus?: string;
	runtimeOwnerKey?: string;
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
let pendingInstallTimers: Array<ReturnType<typeof setTimeout>> = [];

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

type FooterPart = readonly [string, string, string];
type FooterTheme = { fg(color: string, text: string): string };
type FooterDensity = "narrow" | "medium" | "wide";

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const ownerKey = currentRuntimeOwnerKey();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.filter((entry: { data?: unknown }) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === ownerKey)
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

function normalizeGitPath(path: string): string {
	return path.replace(/\/+$/, "");
}

function isSameOrChildPath(path: string, parent: string): boolean {
	const normalizedPath = normalizeGitPath(path);
	const normalizedParent = normalizeGitPath(parent);
	return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

async function detectWorktreeAt(pi: ExtensionAPI, cwd: string): Promise<WorktreeInfo | undefined> {
	const root = await gitValue(pi, ["rev-parse", "--show-toplevel"], cwd);
	if (!root) return undefined;

	const absoluteGitDir = await gitValue(pi, ["rev-parse", "--absolute-git-dir"], cwd);
	const commonGitDir = await gitValue(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (absoluteGitDir && commonGitDir) {
		return {
			path: root,
			isLinked: normalizeGitPath(absoluteGitDir) !== normalizeGitPath(commonGitDir),
		};
	}

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
	return { path: currentPath, isLinked: Boolean(primaryPath && normalizeGitPath(currentPath) !== normalizeGitPath(primaryPath)) };
}

async function currentWorktree(pi: ExtensionAPI, candidatePaths: readonly (string | undefined)[]): Promise<WorktreeInfo | undefined> {
	let fallback: WorktreeInfo | undefined;
	const seen = new Set<string>();
	for (const candidatePath of candidatePaths) {
		if (!candidatePath) continue;
		const normalizedPath = normalizeGitPath(candidatePath);
		if (seen.has(normalizedPath)) continue;
		seen.add(normalizedPath);
		const worktree = await detectWorktreeAt(pi, candidatePath);
		if (worktree?.isLinked) return worktree;
		fallback ??= worktree;
	}
	return fallback;
}

function pathBasename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function formatWorktree(info: WorktreeInfo | undefined): string | undefined {
	if (!info?.isLinked) return undefined;
	return pathBasename(info.path);
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

function compactBeadId(id: string): string {
	const fallbackMarker = id.endsWith("*") ? "*" : "";
	const rawId = fallbackMarker ? id.slice(0, -1) : id;
	const suffix = rawId.split("-").filter(Boolean).pop() ?? rawId;
	return `${suffix}${fallbackMarker}`;
}

function contextUsageParts(ctx: ExtensionContext): readonly (readonly [string, string, string])[] {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (!window) return [];
	if (usage?.tokens == null) return [["ctx", `?/${formatTokens(window)}`, "muted"]];

	const used = Math.max(0, usage.tokens);
	const percent = usage.percent ?? (used / window) * 100;
	const color = percent > 90 ? "error" : percent > 70 ? "warning" : "text";
	return [["ctx", `${formatTokens(used)}/${formatTokens(window)}`, color]];
}

function sessionUsageParts(ctx: ExtensionContext): FooterPart[] {
	let input = 0;
	let output = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
	}

	return [
		["in", input ? `↑${formatTokens(input)}` : "-", input ? "text" : "muted"],
		["out", output ? `↓${formatTokens(output)}` : "-", output ? "text" : "muted"],
	];
}

function sanitizeStatus(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function partPlain(label: string, value: string): string {
	return label ? `${label}:${value}` : value;
}

function footerDensity(width: number): FooterDensity {
	if (width >= 120) return "wide";
	if (width >= 70) return "medium";
	return "narrow";
}

function packLine(
	theme: FooterTheme,
	prefixText: string,
	parts: readonly FooterPart[],
	width: number,
): { line: string | undefined; consumed: number } {
	if (parts.length === 0) return { line: undefined, consumed: 0 };
	const prefix = theme.fg("accent", prefixText);
	const firstPlain = partPlain(parts[0][0], parts[0][1]);
	if (visibleWidth(prefix) + visibleWidth(firstPlain) > width) return { line: undefined, consumed: 0 };

	const separator = theme.fg("muted", "  ");
	const rendered: string[] = [];
	let available = width - visibleWidth(prefix);
	let consumed = 0;
	for (const [label, value, color] of parts) {
		const plain = partPlain(label, value);
		const separatorWidth = rendered.length > 0 ? 2 : 0;
		const need = separatorWidth + visibleWidth(plain);
		if (need > available) break;
		rendered.push(themePart(theme, label, value, color));
		available -= need;
		consumed += 1;
	}
	if (rendered.length === 0) return { line: undefined, consumed: 0 };
	const line = prefix + rendered.join(separator);
	if (visibleWidth(line) > width) return { line: undefined, consumed: 0 };
	return { line, consumed };
}

function renderWorkflowFooter(
	ctx: ExtensionContext,
	theme: FooterTheme,
	footerData: { getExtensionStatuses?: () => ReadonlyMap<string, string> },
	width: number,
): string[] {
	const snapshot = latestDashboard;
	if (!snapshot) return [];

	const wf = snapshot.workflow;
	const activeBead = wf.activeBead;
	const displayBead = activeBead ? compactBeadId(activeBead) : "-";
	const dirty = snapshot.dirty;
	const slotHeld = Boolean(wf.mergeSlotHeld);
	const gitState = dirty == null ? "dirty:?" : dirty === 0 ? "clean" : `dirty:${dirty}`;
	const gitStateColor = dirty == null ? "muted" : dirty === 0 ? "success" : "warning";
	const worktree = formatWorktree(snapshot.worktree);
	const statusMap = footerData.getExtensionStatuses?.();
	const statuses = Array.from(statusMap?.entries() ?? [])
		.filter(([key]) => key !== "pi-workflow-dashboard" && key !== "workflow-state")
		.map(([, text]) => sanitizeStatus(text))
		.filter(Boolean)
		.slice(0, 4)
		.join(" · ");

	const sessionMode = wf.sessionMode ?? wf.state ?? "idle";
	const planValue = `${wf.planMode ?? "off"}/${wf.planApproved ? "approved" : "pending"}`;
	const sessionColor = sessionMode === "idle" ? "text" : "accent";
	const beadColor = activeBead ? "accent" : "text";
	const bdValue = wf.bdStatus ?? "-";
	const bdColor = wf.bdStatus ? "accent" : "text";
	const planColor = wf.planMode && wf.planMode !== "off" ? "warning" : "text";
	const slotValue = slotHeld ? "held" : "free";
	const slotColor = slotHeld ? "error" : "success";
	const density = footerDensity(width);

	const sticky4: FooterPart[] =
		density === "wide"
			? [
					["session", sessionMode, sessionColor],
					["bead", displayBead, beadColor],
					["bd", bdValue, bdColor],
					["slot", slotValue, slotColor],
			  ]
			: [
					["s", sessionMode, sessionColor],
					["b", displayBead, beadColor],
					["bd", bdValue, bdColor],
					["sl", slotValue, slotColor],
			  ];

	const statsParts: FooterPart[] = [
		...contextUsageParts(ctx),
		...sessionUsageParts(ctx),
		...(statuses ? ([["ext", statuses, "text"]] as FooterPart[]) : []),
	];

	const lines: string[] = [];

	if (density === "wide") {
		const wideParts: FooterPart[] = [["session", sessionMode, sessionColor]];
		if (worktree) wideParts.push(["wt", worktree, "warning"]);
		wideParts.push(
			["bead", displayBead, beadColor],
			["bd", bdValue, bdColor],
			["plan", planValue, planColor],
			["", gitState, gitStateColor],
			["slot", slotValue, slotColor],
		);
		const first = packLine(theme, "  workflow  ", wideParts, width);
		if (!first.line) return [];
		lines.push(first.line);
		let rest = wideParts.slice(first.consumed);
		if (rest.length > 0) {
			const cont = packLine(theme, "            ", rest, width);
			if (cont.line) {
				lines.push(cont.line);
				rest = rest.slice(cont.consumed);
			}
		}
		if (lines.length < 3) {
			const stats = packLine(theme, "  stats     ", statsParts, width);
			if (stats.line) lines.push(stats.line);
		}
		return lines.slice(0, 3);
	}

	if (density === "medium") {
		const first = packLine(theme, "  workflow  ", sticky4, width);
		if (!first.line) return [];
		lines.push(first.line);
		const stats = packLine(theme, "  stats     ", statsParts, width);
		if (stats.line) lines.push(stats.line);
		return lines.slice(0, 2);
	}

	const coreFirst = packLine(theme, "wf ", sticky4, width);
	if (!coreFirst.line) return [];
	lines.push(coreFirst.line);
	let coreRest = sticky4.slice(coreFirst.consumed);
	if (coreRest.length > 0 && lines.length < 3) {
		const coreCont = packLine(theme, "   ", coreRest, width);
		if (coreCont.line) {
			lines.push(coreCont.line);
			coreRest = coreRest.slice(coreCont.consumed);
		}
	}
	if (worktree && lines.length < 3) {
		const wtPart: FooterPart[] = [["wt", worktree, "warning"]];
		const meta = packLine(theme, "   ", wtPart, width);
		if (meta.line) lines.push(meta.line);
	}
	if (lines.length < 3) {
		const stats = packLine(theme, "st ", statsParts, width);
		if (stats.line) lines.push(stats.line);
	}
	return lines.slice(0, 3);
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
	const worktree = await currentWorktree(pi, [ctx.cwd, wf.worktreePath]);
	const sessionMode = wf.sessionMode ?? wf.state ?? "idle";
	const bead = wf.activeBead ?? "-";
	const slot = wf.mergeSlotHeld ? "held" : "free";
	const plan = `${wf.planMode ?? "off"}/${wf.planApproved ? "approved" : "pending"}`;
	const statusParts = [`session:${sessionMode}`, `bead:${bead}`, `bd:${wf.bdStatus ?? "-"}`, `br:${branch}`, `plan:${plan}`];
	const statusWorktree = formatWorktree(worktree);
	if (statusWorktree) statusParts.push(`wt:${statusWorktree}`);
	statusParts.push(`dirty:${dirty ?? "?"}`, `slot:${slot}`);
	const text = statusParts.join(" ");

	latestDashboard = { workflow: wf, branch, dirty, worktree };
	ctx.ui.setStatus("pi-workflow-dashboard", ctx.ui.theme.fg("accent", text));
	requestFooterRender?.();
}

export default function statusDashboardExtension(pi: ExtensionAPI): void {
	function installAndRefresh(ctx: ExtensionContext): void {
		installWorkflowFooter(ctx);
		void updateDashboard(pi, ctx);
	}

	const eventBus = (pi as unknown as { events?: { on(name: "workflow-state:update", handler: (event: { ctx?: ExtensionContext }) => unknown): void } }).events;
	eventBus?.on("workflow-state:update", async (event) => {
		if (event.ctx) await updateDashboard(pi, event.ctx);
	});

	function clearPendingInstallTimers(): void {
		for (const timer of pendingInstallTimers) clearTimeout(timer);
		pendingInstallTimers = [];
	}

	function installAfterCompetingFooters(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		clearPendingInstallTimers();
		for (const delay of [0, 50, 200, 500]) {
			pendingInstallTimers.push(setTimeout(() => installAndRefresh(ctx), delay));
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
	pi.on("session_shutdown", async () => clearPendingInstallTimers());

	pi.registerCommand("dashboard", {
		description: "Refresh Pi workflow dashboard footer",
		handler: async (_args, ctx) => {
			installWorkflowFooter(ctx);
			await updateDashboard(pi, ctx);
			if (ctx.hasUI) ctx.ui.notify("Pi workflow dashboard refreshed", "info");
		},
	});
}
