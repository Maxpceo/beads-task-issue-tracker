interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	events: { on(name: string, handler: (event: WorkflowStateUpdateEvent) => void): void };
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
}

interface ExtensionContext {
	hasUI?: boolean;
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
	ui: {
		notify(message: string, level?: string): void;
		setStatus(key: string, value: string | undefined): void;
		setWidget(key: string, value: WidgetFactory | undefined, options?: { placement?: string }): void;
		theme: { fg(style: string, value: string): string };
	};
}

interface Component {
	render(width: number): string[];
	invalidate(): void;
}

type WidgetFactory = (tui: unknown, theme: ExtensionContext["ui"]["theme"]) => Component;

interface WorkflowStateSnapshot {
	activeBead?: string;
	state?: string;
	sessionMode?: string;
	bdStatus?: string;
	updatedAt?: string;
	runtimeOwnerKey?: string;
}

interface WorkflowStateUpdateEvent {
	ctx?: ExtensionContext;
}

interface BeadPurposeSnapshot {
	bead?: string;
	sessionMode: string;
	bdStatus?: string;
	title?: string;
	lookupFailed: boolean;
	nextAction?: string;
}

const WIDGET_KEY = "bead-purpose";
const STATUS_KEY = "bead-purpose";
const ACTIVE_STATES_WITHOUT_STALE_ACTIONS = new Set(["idle", "accepted", "closed", "blocked", "deferred", "merged"]);
const TERMINAL_BD_STATUSES = new Set(["closed", "blocked", "deferred"]);

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const ownerKey = currentRuntimeOwnerKey();
	const last = ctx.sessionManager
		.getEntries()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.filter((entry: { data?: unknown }) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === ownerKey)
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data ?? { state: "idle" };
}

function nextActionFor(state: string): string | undefined {
	switch (state) {
		case "claimed":
			return "Next: plan-bead";
		case "planning":
			return "Next: approve plan";
		case "plan_approved":
			return "Next: dispatch supervisor";
		case "implementing":
			return "Next: implement, check, commit";
		case "inreview":
			return "Next: review-bead";
		case "reviewing":
			return "Next: finish review chain";
		case "landing":
			return "Next: land checkpoint";
		default:
			return undefined;
	}
}

function isActivePurpose(state: WorkflowStateSnapshot): state is WorkflowStateSnapshot & { activeBead: string } {
	if (!state.activeBead) return false;
	if (state.bdStatus && TERMINAL_BD_STATUSES.has(state.bdStatus)) return false;
	return !ACTIVE_STATES_WITHOUT_STALE_ACTIONS.has(state.sessionMode ?? state.state ?? "idle");
}

function parseBdTitle(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout);
		const bead = Array.isArray(parsed) ? parsed[0] : parsed;
		const title = bead?.title;
		return typeof title === "string" && title.trim() ? title.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function resolveBeadTitle(pi: ExtensionAPI, bead: string): Promise<{ title?: string; lookupFailed: boolean }> {
	const result = await pi.exec("bd", ["show", bead, "--json"]);
	if (result.code !== 0) return { lookupFailed: true };
	const title = parseBdTitle(result.stdout);
	return { title, lookupFailed: !title };
}

function truncatePlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${chars.slice(0, maxWidth - 1).join("")}…`;
}

function compactSnapshot(snapshot: BeadPurposeSnapshot): string {
	const bead = snapshot.bead ?? "-";
	const fallback = snapshot.lookupFailed ? " · title unavailable" : "";
	const next = snapshot.nextAction ? ` · ${snapshot.nextAction}` : "";
	const title = snapshot.title ? ` · ${snapshot.title}` : "";
	const bd = snapshot.bdStatus ? ` · bd:${snapshot.bdStatus}` : "";
	return `purpose: ${bead} · session:${snapshot.sessionMode}${bd}${fallback}${next}${title}`;
}

function compactBeadId(id: string | undefined): string {
	if (!id) return "-";
	return id.split("-").filter(Boolean).pop() ?? id;
}

function compactWidgetSnapshot(snapshot: BeadPurposeSnapshot): string {
	const bead = compactBeadId(snapshot.bead);
	const title = snapshot.title ? ` · ${snapshot.title}` : "";
	const next = snapshot.nextAction ? ` · ${snapshot.nextAction}` : "";
	const fallback = snapshot.lookupFailed ? " · title unavailable" : "";
	const bd = snapshot.bdStatus ? ` · bd:${snapshot.bdStatus}` : "";
	return `purpose: ${bead} · session:${snapshot.sessionMode}${bd}${title}${next}${fallback}`;
}

function renderPurposeWidget(snapshot: BeadPurposeSnapshot, theme: ExtensionContext["ui"]["theme"]): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const line = truncatePlain(compactWidgetSnapshot(snapshot), Math.max(0, width));
			return [theme.fg("accent", line)];
		},
	};
}

export default function beadPurposeExtension(pi: ExtensionAPI): void {
	const titleCache = new Map<string, string | undefined>();
	let refreshGeneration = 0;

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const generation = ++refreshGeneration;
		if (!ctx.hasUI) return;
		const workflow = latestWorkflowState(ctx);
		const sessionMode = workflow.sessionMode ?? workflow.state ?? "idle";

		if (!isActivePurpose({ ...workflow, sessionMode })) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "purpose:no active bead"));
			return;
		}

		let lookupFailed = false;
		let title = titleCache.get(workflow.activeBead);
		if (!titleCache.has(workflow.activeBead)) {
			const resolved = await resolveBeadTitle(pi, workflow.activeBead);
			if (generation !== refreshGeneration) return;
			const currentWorkflow = latestWorkflowState(ctx);
			const currentSessionMode = currentWorkflow.sessionMode ?? currentWorkflow.state ?? "idle";
			if (!isActivePurpose({ ...currentWorkflow, sessionMode: currentSessionMode }) || currentWorkflow.activeBead !== workflow.activeBead || currentSessionMode !== sessionMode) return;
			title = resolved.title;
			lookupFailed = resolved.lookupFailed;
			titleCache.set(workflow.activeBead, title);
		} else if (!title) {
			lookupFailed = true;
		}

		const snapshot: BeadPurposeSnapshot = {
			bead: workflow.activeBead,
			sessionMode,
			bdStatus: workflow.bdStatus,
			title,
			lookupFailed,
			nextAction: nextActionFor(sessionMode),
		};

		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => renderPurposeWidget(snapshot, theme));
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", truncatePlain(compactSnapshot(snapshot), 90)));
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("resources_discover", async (_event, ctx) => refresh(ctx));
	pi.on("turn_start", async (_event, ctx) => refresh(ctx));
	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("tool_result", async (_event, ctx) => refresh(ctx));
	pi.events.on("workflow-state:update", (event: WorkflowStateUpdateEvent) => {
		if (event.ctx) void refresh(event.ctx);
	});

	pi.registerCommand("bead-purpose", {
		description: "Refresh non-blocking active bead purpose widget",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (ctx.hasUI) ctx.ui.notify("Bead purpose widget refreshed", "info");
		},
	});
}
