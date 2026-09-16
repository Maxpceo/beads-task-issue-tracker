interface ExtensionAPI {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
	events: { on(name: string, handler: (event: WorkflowStateUpdateEvent) => void): void };
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
}

interface ExtensionContext {
	hasUI?: boolean;
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
}

interface WorkflowStateSnapshot {
	activeBead?: string;
	state?: string;
	sessionMode?: string;
	runtimeOwnerKey?: string;
}

interface WorkflowStateUpdateEvent {
	ctx?: ExtensionContext;
}

type ApplyAction = "set" | "set-suffix-only" | "clear";

interface AppliedSignature {
	workspaceId: string;
	action: ApplyAction;
	beadId: string;
	effectiveMode: string;
	pill: string;
	descriptionPresent: boolean;
}

interface ModeVisual {
	icon: string;
	color: string;
	progress: string;
}

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";
const TITLE_MAX_CODE_POINTS = 40;
/** Modes that always clear the pill when a bead is still bound. */
const CLEAR_WITH_BEAD_MODES = new Set(["merged", "deferred"]);
/** After close / land wait: keep landing visual even when activeBead was cleared. */
const LANDING_WAIT_MODES = new Set(["closed", "landing"]);

const MODE_VISUAL: Record<string, ModeVisual> = {
	claimed: { icon: "circle.fill", color: "#0a84ff", progress: "0.15" },
	planning: { icon: "circle.fill", color: "#0a84ff", progress: "0.30" },
	plan_approved: { icon: "checkmark.circle", color: "#0a84ff", progress: "0.45" },
	implementing: { icon: "hammer", color: "#ff9500", progress: "0.60" },
	inreview: { icon: "eye", color: "#ffd60a", progress: "0.80" },
	reviewing: { icon: "eye", color: "#ffd60a", progress: "0.90" },
	accepted: { icon: "checkmark.circle", color: "#30d158", progress: "0.95" },
	landing: { icon: "arrow.up.circle", color: "#0a84ff", progress: "0.98" },
};

function titleFromLastApplied(last: AppliedSignature | undefined, beadId: string): string | undefined {
	if (!beadId) return undefined;
	if (!last?.descriptionPresent || !last.pill) return undefined;
	const marker = " · ";
	const idx = last.pill.indexOf(marker);
	if (idx < 0) return undefined;
	const title = last.pill.slice(idx + marker.length).trim();
	return title || undefined;
}

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

/** Latest owned workflow-state snapshot, or undefined when none exists (no-op, not clear). */
function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot | undefined {
	const ownerKey = currentRuntimeOwnerKey();
	const last = ctx.sessionManager
		.getEntries()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.filter((entry: { data?: unknown }) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === ownerKey)
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	return last?.data;
}

/** Last `-` segment of a bead id (`beads-task-issue-tracker-fo5d` → `fo5d`). */
function beadSuffixFromId(beadId: string): string {
	const id = (beadId ?? "").trim();
	if (!id) return "";
	const idx = id.lastIndexOf("-");
	if (idx < 0 || idx === id.length - 1) return id;
	return id.slice(idx + 1);
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

function truncateTitle(text: string, maxCodePoints: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxCodePoints) return text;
	if (maxCodePoints <= 0) return "";
	if (maxCodePoints === 1) return "…";
	return `${chars.slice(0, maxCodePoints - 1).join("")}…`;
}

function buildPill(beadId: string, title: string | undefined): string {
	const suffix = beadSuffixFromId(beadId);
	if (!title) return suffix;
	return `${suffix} · ${truncateTitle(title, TITLE_MAX_CODE_POINTS)}`;
}

function readEnvWorkspaceId(): string | undefined {
	const raw = process.env.CMUX_WORKSPACE_ID;
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed ? trimmed : undefined;
}

function parseIdentifyWorkspace(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as {
			caller?: { workspace_ref?: unknown };
			workspace?: unknown;
			data?: { workspace?: unknown };
		};
		const candidates = [parsed?.caller?.workspace_ref, parsed?.data?.workspace, parsed?.workspace];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim()) return candidate;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function signaturesEqual(a: AppliedSignature | undefined, b: AppliedSignature): boolean {
	if (!a) return false;
	return (
		a.workspaceId === b.workspaceId &&
		a.action === b.action &&
		a.beadId === b.beadId &&
		a.effectiveMode === b.effectiveMode &&
		a.pill === b.pill &&
		a.descriptionPresent === b.descriptionPresent
	);
}

export default function cmuxSidebarExtension(pi: ExtensionAPI): void {
	const titleCache = new Map<string, string>();
	let refreshGeneration = 0;
	let queue: Promise<void> = Promise.resolve();
	let cachedWorkspaceId: string | undefined;
	let identifyFailed = false;
	let lastApplied: AppliedSignature | undefined;

	async function runCmux(args: string[]): Promise<boolean> {
		try {
			const result = await pi.exec("cmux", args);
			return result.code === 0;
		} catch {
			return false;
		}
	}

	async function resolveWorkspaceId(allowIdentify: boolean): Promise<string | undefined> {
		if (cachedWorkspaceId) return cachedWorkspaceId;
		const fromEnv = readEnvWorkspaceId();
		if (fromEnv) {
			cachedWorkspaceId = fromEnv;
			return cachedWorkspaceId;
		}
		if (identifyFailed || !allowIdentify) return undefined;
		try {
			const result = await pi.exec("cmux", ["identify", "--json"]);
			if (result.code !== 0) {
				identifyFailed = true;
				return undefined;
			}
			const workspaceId = parseIdentifyWorkspace(result.stdout);
			if (!workspaceId) {
				identifyFailed = true;
				return undefined;
			}
			cachedWorkspaceId = workspaceId;
			return cachedWorkspaceId;
		} catch {
			identifyFailed = true;
			return undefined;
		}
	}

	async function resolveTitle(beadId: string): Promise<string | undefined> {
		const cached = titleCache.get(beadId);
		if (cached) return cached;
		try {
			const result = await pi.exec("bd", ["show", beadId, "--json"]);
			if (result.code !== 0) return undefined;
			const title = parseBdTitle(result.stdout);
			if (!title) return undefined;
			titleCache.set(beadId, title);
			return title;
		} catch {
			return undefined;
		}
	}

	async function applyClear(workspaceId: string, generation: number): Promise<boolean> {
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["clear-status", "task", "--workspace", workspaceId]))) return false;
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["clear-progress", "--workspace", workspaceId]))) return false;
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["workspace-action", "--action", "clear-description", "--workspace", workspaceId]))) return false;
		return generation === refreshGeneration;
	}

	async function applyMapped(
		workspaceId: string,
		mode: string,
		visual: ModeVisual,
		pill: string,
		title: string | undefined,
		generation: number,
	): Promise<boolean> {
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["set-status", "task", pill, "--workspace", workspaceId, "--icon", visual.icon, "--color", visual.color]))) {
			return false;
		}
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["set-progress", visual.progress, "--label", mode, "--workspace", workspaceId]))) return false;
		if (title) {
			if (generation !== refreshGeneration) return false;
			if (!(await runCmux(["workspace-action", "--action", "set-description", "--description", title, "--workspace", workspaceId]))) {
				return false;
			}
		}
		return generation === refreshGeneration;
	}

	async function applyBlocked(
		workspaceId: string,
		pill: string,
		title: string | undefined,
		generation: number,
	): Promise<boolean> {
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["set-status", "task", pill, "--workspace", workspaceId, "--icon", "xmark.octagon", "--color", "#ff453a"]))) {
			return false;
		}
		if (generation !== refreshGeneration) return false;
		if (!(await runCmux(["clear-progress", "--workspace", workspaceId]))) return false;
		if (title) {
			if (generation !== refreshGeneration) return false;
			if (!(await runCmux(["workspace-action", "--action", "set-description", "--description", title, "--workspace", workspaceId]))) {
				return false;
			}
		}
		return generation === refreshGeneration;
	}

	async function runRefresh(ctx: ExtensionContext, generation: number): Promise<void> {
		try {
			if (generation !== refreshGeneration) return;

			const snapshot = latestWorkflowState(ctx);
			// Absence of owned entry = no-op (do NOT clear leftover sidebar).
			if (!snapshot) return;

			const workspaceId = await resolveWorkspaceId(true);
			if (generation !== refreshGeneration) return;
			if (!workspaceId) return;

			const effectiveMode = snapshot.sessionMode ?? snapshot.state ?? "idle";
			const activeBead = typeof snapshot.activeBead === "string" ? snapshot.activeBead.trim() : "";
			const ownsWrittenStatus =
				lastApplied?.action === "set" || lastApplied?.action === "set-suffix-only";

			const applyOwnedClear = async (mode: string, beadId: string): Promise<void> => {
				const signature: AppliedSignature = {
					workspaceId,
					action: "clear",
					beadId,
					effectiveMode: mode,
					pill: "",
					descriptionPresent: false,
				};
				if (signaturesEqual(lastApplied, signature)) return;
				const ok = await applyClear(workspaceId, generation);
				if (ok) lastApplied = signature;
			};

			// No bead: never-set early-return only here (first mapped set with empty lastApplied stays live).
			if (!activeBead) {
				if (LANDING_WAIT_MODES.has(effectiveMode)) {
					// closed/landing without bead = waiting for land/merge. Keep landing pill.
					if (!ownsWrittenStatus || !lastApplied) return;

					const landingVisual = MODE_VISUAL.landing;
					const beadId = lastApplied.beadId;
					const pill = lastApplied.pill || (beadId ? beadSuffixFromId(beadId) : "");
					const title = (beadId ? titleCache.get(beadId) : undefined) ?? titleFromLastApplied(lastApplied, beadId);
					const action: ApplyAction = lastApplied.action === "set" || lastApplied.action === "set-suffix-only"
						? lastApplied.action
						: title
							? "set"
							: "set-suffix-only";
					const signature: AppliedSignature = {
						workspaceId,
						action,
						beadId,
						effectiveMode: "landing",
						pill,
						descriptionPresent: Boolean(title),
					};
					if (signaturesEqual(lastApplied, signature)) return;
					const ok = await applyMapped(workspaceId, "landing", landingVisual, pill, title, generation);
					if (ok) lastApplied = signature;
					return;
				}

				// Any other owned no-bead mode (idle/reset/merged/blocked/deferred/…) → clear×3.
				if (!ownsWrittenStatus) return;
				await applyOwnedClear(effectiveMode, "");
				return;
			}

			// Bead bound: merged/deferred clear unconditionally.
			if (CLEAR_WITH_BEAD_MODES.has(effectiveMode)) {
				await applyOwnedClear(effectiveMode, activeBead);
				return;
			}

			// closed/landing with bead → landing visual (label landing, stable signature mode).
			if (LANDING_WAIT_MODES.has(effectiveMode)) {
				const landingVisual = MODE_VISUAL.landing;
				const title = await resolveTitle(activeBead);
				if (generation !== refreshGeneration) return;
				const fresh = latestWorkflowState(ctx);
				if (!fresh) return;
				const freshMode = fresh.sessionMode ?? fresh.state ?? "idle";
				const freshBead = typeof fresh.activeBead === "string" ? fresh.activeBead.trim() : "";
				if (freshBead !== activeBead || freshMode !== effectiveMode) return;

				const pill = buildPill(activeBead, title);
				const action: ApplyAction = title ? "set" : "set-suffix-only";
				const signature: AppliedSignature = {
					workspaceId,
					action,
					beadId: activeBead,
					effectiveMode: "landing",
					pill,
					descriptionPresent: Boolean(title),
				};
				if (signaturesEqual(lastApplied, signature)) return;
				const ok = await applyMapped(workspaceId, "landing", landingVisual, pill, title, generation);
				if (ok) lastApplied = signature;
				return;
			}

			if (effectiveMode === "blocked") {
				const title = await resolveTitle(activeBead);
				if (generation !== refreshGeneration) return;
				const pill = buildPill(activeBead, title);
				const action: ApplyAction = title ? "set" : "set-suffix-only";
				const signature: AppliedSignature = {
					workspaceId,
					action,
					beadId: activeBead,
					effectiveMode,
					pill,
					descriptionPresent: Boolean(title),
				};
				if (signaturesEqual(lastApplied, signature)) return;
				const ok = await applyBlocked(workspaceId, pill, title, generation);
				if (ok) lastApplied = signature;
				return;
			}

			const visual = MODE_VISUAL[effectiveMode];
			if (!visual) {
				// Unmapped mode with active bead (e.g. idle): leftover status kept, no-op.
				return;
			}

			const title = await resolveTitle(activeBead);
			if (generation !== refreshGeneration) return;
			// Re-read after await so a newer trigger can supersede before any cmux write.
			if (generation !== refreshGeneration) return;
			const fresh = latestWorkflowState(ctx);
			if (!fresh) return;
			const freshMode = fresh.sessionMode ?? fresh.state ?? "idle";
			const freshBead = typeof fresh.activeBead === "string" ? fresh.activeBead.trim() : "";
			if (freshBead !== activeBead || freshMode !== effectiveMode) return;

			const pill = buildPill(activeBead, title);
			const action: ApplyAction = title ? "set" : "set-suffix-only";
			const signature: AppliedSignature = {
				workspaceId,
				action,
				beadId: activeBead,
				effectiveMode,
				pill,
				descriptionPresent: Boolean(title),
			};
			if (signaturesEqual(lastApplied, signature)) return;
			const ok = await applyMapped(workspaceId, effectiveMode, visual, pill, title, generation);
			if (ok) lastApplied = signature;
		} catch {
			// Snapshot/title path errors must not kill the queue.
		}
	}

	function scheduleRefresh(ctx: ExtensionContext): void {
		const generation = ++refreshGeneration;
		queue = queue
			.then(async () => {
				await runRefresh(ctx, generation);
			})
			.catch(() => {
				// Keep queue alive after unexpected failures.
			});
	}

	pi.on("session_start", (_event, ctx) => {
		identifyFailed = false;
		scheduleRefresh(ctx);
	});
	pi.on("resources_discover", (_event, ctx) => {
		scheduleRefresh(ctx);
	});
	pi.on("turn_start", (_event, ctx) => {
		scheduleRefresh(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		scheduleRefresh(ctx);
	});
	pi.on("tool_result", (_event, ctx) => {
		scheduleRefresh(ctx);
	});
	pi.events.on("workflow-state:update", (event: WorkflowStateUpdateEvent) => {
		if (event.ctx) scheduleRefresh(event.ctx);
	});
}
