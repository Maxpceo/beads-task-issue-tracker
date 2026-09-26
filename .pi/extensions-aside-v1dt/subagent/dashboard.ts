import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface DashboardAgentConfig {
	name: string;
	description: string;
	source: "user" | "project";
}

export interface DashboardAgentTeamConfigResult {
	teams: Array<{ name: string; members: string[]; warnings: string[] }>;
	warnings: string[];
}

export type AgentDashboardStatus = "idle" | "queued" | "running" | "completed" | "failed" | "aborted";

export interface AgentDashboardCard {
	agent: string;
	description?: string;
	source: "project" | "user" | "unknown";
	status: AgentDashboardStatus;
	task?: string;
	startedAt?: number;
	completedAt?: number;
	toolCount: number;
	contextText?: string;
	lastPreview?: string;
	errorMessage?: string;
}

export type AgentDashboardMode = "active" | "all";
export type AgentDashboardOrigin = "user" | "auto";

export interface AgentDashboardState {
	visible: boolean;
	mode: AgentDashboardMode;
	/** user = /agents-dashboard; auto = first headless running card. Default user. */
	origin: AgentDashboardOrigin;
	teamName?: string;
	selectedAgents: DashboardAgentConfig[];
	cards: Map<string, AgentDashboardCard>;
	warnings: string[];
	updatedAt: number;
}

export interface DashboardWidgetHost {
	hasUI?: boolean;
	ui?: {
		setWidget?: (id: string, value: unknown) => void;
	};
}

export interface DashboardTeamSelection {
	teamName?: string;
	agents: DashboardAgentConfig[];
	warnings: string[];
}

export interface DashboardTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

const CARD_PADDING_X = 2;

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function padRight(text: string, width: number): string {
	const clipped = truncate(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusIcon(status: AgentDashboardStatus): string {
	switch (status) {
		case "running":
			return "⏳";
		case "queued":
			return "…";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "aborted":
			return "■";
		default:
			return "○";
	}
}

function statusColor(status: AgentDashboardStatus): string {
	switch (status) {
		case "running":
		case "queued":
			return "warning";
		case "completed":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		default:
			return "muted";
	}
}

export function selectDashboardAgents(
	agents: DashboardAgentConfig[],
	teams: DashboardAgentTeamConfigResult,
	requestedTeam?: string,
): DashboardTeamSelection {
	const sortedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
	const warnings = [...teams.warnings];
	const knownByName = new Map(sortedAgents.map((agent) => [agent.name, agent]));
	const selectedTeam = requestedTeam
		? teams.teams.find((team) => team.name === requestedTeam)
		: teams.teams.find((team) => team.members.length > 0);

	if (requestedTeam && !selectedTeam) {
		warnings.push(`No team named "${requestedTeam}" found; showing all project-local agents.`);
	}

	if (!selectedTeam) return { agents: sortedAgents, warnings };

	const selectedAgents = selectedTeam.members
		.map((member) => knownByName.get(member))
		.filter((agent): agent is DashboardAgentConfig => Boolean(agent));

	return {
		teamName: selectedTeam.name,
		agents: selectedAgents,
		warnings: [...warnings, ...selectedTeam.warnings],
	};
}

export interface DashboardRenderer {
	requestRender?: () => void;
}

const observedCards = new Map<string, AgentDashboardCard>();
let sharedDashboardState: AgentDashboardState | null = null;
let currentDashboardRenderer: DashboardRenderer | null = null;

export function registerDashboardRenderer(renderer: DashboardRenderer | null | undefined): () => void {
	currentDashboardRenderer = renderer ?? null;
	return () => {
		if (currentDashboardRenderer === renderer) currentDashboardRenderer = null;
	};
}

function requestDashboardRender(): void {
	try {
		currentDashboardRenderer?.requestRender?.();
	} catch {
		// Rendering invalidation is best-effort; dashboard state is already updated.
	}
}

function idleCard(agent: DashboardAgentConfig): AgentDashboardCard {
	return {
		agent: agent.name,
		description: agent.description,
		source: agent.source,
		status: "idle",
		toolCount: 0,
	};
}

function rebuildCards(selection: DashboardTeamSelection, mode: AgentDashboardMode): Map<string, AgentDashboardCard> {
	const cards = new Map<string, AgentDashboardCard>();
	if (mode === "all") {
		for (const agent of selection.agents) cards.set(agent.name, idleCard(agent));
	}
	for (const card of observedCards.values()) {
		const selected = selection.agents.find((agent) => agent.name === card.agent);
		cards.set(card.agent, {
			...(selected ? idleCard(selected) : undefined),
			...card,
			description: card.description ?? selected?.description,
			source: card.source === "unknown" && selected ? selected.source : card.source,
		});
	}
	return cards;
}

export function createDashboardState(
	selection: DashboardTeamSelection,
	mode: AgentDashboardMode = "all",
	origin: AgentDashboardOrigin = "user",
): AgentDashboardState {
	return {
		visible: true,
		mode,
		origin,
		teamName: selection.teamName,
		selectedAgents: selection.agents,
		cards: rebuildCards(selection, mode),
		warnings: selection.warnings,
		updatedAt: Date.now(),
	};
}

export function setSharedDashboardState(state: AgentDashboardState | null): void {
	sharedDashboardState = state;
}

export function getSharedDashboardState(): AgentDashboardState | null {
	return sharedDashboardState;
}

let dashboardWidgetHost: DashboardWidgetHost | null = null;

export function registerDashboardWidgetHost(host: DashboardWidgetHost | null | undefined): void {
	dashboardWidgetHost = host ?? null;
}

export function resetDashboardWidgetHost(): void {
	dashboardWidgetHost = null;
}

export function getDashboardWidgetHost(): DashboardWidgetHost | null {
	return dashboardWidgetHost;
}

/** Install/repaint the TUI widget when a host with UI is registered. Store-only otherwise. */
export function ensureDashboardWidget(): void {
	const state = sharedDashboardState;
	if (!state?.visible) return;
	const host = dashboardWidgetHost;
	if (!host?.hasUI || !host.ui?.setWidget) return;
	try {
		host.ui.setWidget("subagent-dashboard", (tui: { requestRender?: () => void } | undefined, theme: DashboardTheme) => {
			registerDashboardRenderer(tui);
			return new AgentDashboardComponent(() => getSharedDashboardState()!, theme);
		});
	} catch {
		// Widget install is best-effort; store already holds the cards.
	}
}

function hideDashboardWidget(): void {
	const host = dashboardWidgetHost;
	if (!host?.ui?.setWidget) return;
	try {
		host.ui.setWidget("subagent-dashboard", undefined);
	} catch {
		// Best-effort hide.
	}
}

function hasActiveWork(state: AgentDashboardState): boolean {
	for (const card of state.cards.values()) {
		if (card.status === "running" || card.status === "queued") return true;
	}
	return false;
}

/**
 * Auto-hide only for origin=auto dashboards with no running/queued work.
 * Call from turn_end — never from publish (terminal cards must stay visible until turn ends).
 */
export function maybeAutoHideDashboard(): boolean {
	const state = sharedDashboardState;
	if (!state?.visible || state.origin !== "auto") return false;
	if (hasActiveWork(state)) return false;
	sharedDashboardState = null;
	hideDashboardWidget();
	return true;
}

export function upsertDashboardCard(state: AgentDashboardState, card: AgentDashboardCard): void {
	const previous = state.cards.get(card.agent);
	state.cards.set(card.agent, { ...previous, ...card });
	state.updatedAt = Date.now();
}

function ensureAutoVisibleStore(card: AgentDashboardCard): AgentDashboardState {
	const existing = sharedDashboardState;
	if (existing?.visible) {
		upsertDashboardCard(existing, card);
		return existing;
	}
	const state = createDashboardState(
		{ agents: [], warnings: [] },
		"active",
		"auto",
	);
	upsertDashboardCard(state, card);
	sharedDashboardState = state;
	return state;
}

/**
 * Always writes the observed store. Running cards auto-show an active origin=auto
 * dashboard when none is visible. Never hides from publish.
 */
export function publishDashboardCard(card: AgentDashboardCard): AgentDashboardState | null {
	const previousObserved = observedCards.get(card.agent);
	const merged = { ...previousObserved, ...card } as AgentDashboardCard;
	observedCards.set(card.agent, merged);

	const isActiveStatus = merged.status === "running" || merged.status === "queued";
	let state = sharedDashboardState;

	if (isActiveStatus && (!state || !state.visible)) {
		state = ensureAutoVisibleStore(merged);
		ensureDashboardWidget();
		requestDashboardRender();
		return state;
	}

	if (!state?.visible) {
		// Terminal/idle without a visible widget: keep observed only (no auto-show).
		return state;
	}

	upsertDashboardCard(state, merged);
	ensureDashboardWidget();
	requestDashboardRender();
	return state;
}

export function clearObservedDashboardCards(): void {
	observedCards.clear();
}

function elapsedText(card: AgentDashboardCard, now: number): string {
	if (!card.startedAt) return "elapsed:—";
	const end = card.completedAt ?? now;
	const seconds = Math.max(0, Math.round((end - card.startedAt) / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `elapsed:${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`;
}

function renderCard(card: AgentDashboardCard, width: number, theme: DashboardTheme, now: number): string[] {
	const inner = Math.max(8, width - 2);
	const contentWidth = Math.max(4, inner - CARD_PADDING_X * 2);
	const color = statusColor(card.status);
	const bold = theme.bold ?? ((text: string) => text);
	const borderColor = card.status === "idle" ? "borderMuted" : color;
	const border = (text: string) => theme.fg(borderColor, text);
	const title = `${theme.fg(color, statusIcon(card.status))} ${theme.fg(color, bold(card.agent))} ${theme.fg("muted", `[${card.status}]`)}`;
	const source = card.source !== "unknown" ? `src:${card.source}` : "src:?";
	const task = card.task || card.description || "No active task";
	const stats = [elapsedText(card, now), `tools:${card.toolCount}`, card.contextText].filter(Boolean).join(" · ");
	const preview = card.errorMessage ? `Error: ${card.errorMessage}` : card.lastPreview || "Last activity: idle";
	const previewColor = card.errorMessage ? "error" : "dim";
	const row = (content: string) =>
		`${border("│")}${" ".repeat(CARD_PADDING_X)}${padRight(content, contentWidth)}${" ".repeat(CARD_PADDING_X)}${border("│")}`;
	return [
		border(`┌${"─".repeat(inner)}┐`),
		row(title),
		row(theme.fg("dim", source)),
		row(theme.fg("muted", truncate(task.replace(/\s+/g, " "), contentWidth))),
		row(theme.fg("dim", stats)),
		row(theme.fg(previewColor, truncate(preview.replace(/\s+/g, " "), contentWidth))),
		border(`└${"─".repeat(inner)}┘`),
	];
}

export function renderDashboardLines(
	state: AgentDashboardState,
	width: number,
	theme: DashboardTheme,
	now = Date.now(),
): string[] {
	const safeWidth = Math.max(20, width);
	const cards = Array.from(state.cards.values()).sort((a, b) => a.agent.localeCompare(b.agent));
	const running = cards.filter((card) => card.status === "running" || card.status === "queued").length;
	const failed = cards.filter((card) => card.status === "failed" || card.status === "aborted").length;
	const done = cards.filter((card) => card.status === "completed").length;
	const title = state.teamName ? `Pi agent-team dashboard: ${state.teamName}` : "Pi agent-team dashboard";
	const closeHint = safeWidth >= 72 ? "Modes: active/all/refresh · Close: hide or clear" : "Modes: active/all · hide";
	const lines = [
		truncate(theme.fg("accent", (theme.bold ?? ((text: string) => text))(`${title} [${state.mode}]`)), safeWidth),
		truncate(theme.fg("dim", `${cards.length} agents · ${running} running · ${done} done · ${failed} error`), safeWidth),
		truncate(theme.fg("dim", closeHint), safeWidth),
	];
	for (const warning of state.warnings) lines.push(truncate(theme.fg("warning", `! ${warning}`), safeWidth));
	if (cards.length === 0) {
		lines.push(theme.fg("muted", state.mode === "active" ? "No active agents observed in this Pi session." : "No project-local agents selected."));
		return lines.map((line) => truncate(line, safeWidth));
	}

	const columns = safeWidth >= 96 && cards.length > 1 ? 2 : 1;
	const gap = columns === 2 ? 2 : 0;
	const cardWidth = columns === 2 ? Math.floor((safeWidth - gap) / 2) : safeWidth;
	for (let i = 0; i < cards.length; i += columns) {
		const leftCard = cards[i];
		if (!leftCard) continue;
		const left = renderCard(leftCard, cardWidth, theme, now);
		if (columns === 1 || !cards[i + 1]) {
			lines.push(...left);
			continue;
		}
		const rightCard = cards[i + 1];
		if (!rightCard) {
			lines.push(...left);
			continue;
		}
		const right = renderCard(rightCard, cardWidth, theme, now);
		for (let row = 0; row < left.length; row++) lines.push(`${left[row]}${" ".repeat(gap)}${right[row]}`);
	}
	return lines.map((line) => truncate(line, safeWidth));
}

export class AgentDashboardComponent {
	constructor(
		private readonly getState: () => AgentDashboardState,
		private readonly theme: DashboardTheme,
	) {}

	render(width: number): string[] {
		return renderDashboardLines(this.getState(), width, this.theme);
	}

	invalidate(): void {
		// Stateless render: theme is supplied by the widget factory on each install.
	}
}
