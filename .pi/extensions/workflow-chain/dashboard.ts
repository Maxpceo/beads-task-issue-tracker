import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type WorkflowDashboardStatus = "pending" | "running" | "done" | "error" | "blocked" | "info";

export interface WorkflowDashboardStep {
	index: number;
	id: string;
	title: string;
	type: string;
	status: WorkflowDashboardStatus;
	operation?: string;
	requiredState?: string;
	policy?: string;
	handoff?: string;
	elapsedMs?: number;
	preview?: string;
	error?: string;
}

export interface WorkflowDashboardModel {
	mode: "list" | "dry-run" | "run" | "error";
	chainId?: string;
	title: string;
	description?: string;
	source?: string;
	state?: string;
	branch?: string;
	activeBead?: string;
	status: WorkflowDashboardStatus;
	statusText: string;
	steps: WorkflowDashboardStep[];
	warnings?: string[];
	usage?: string[];
	handoff?: string;
}

export interface WorkflowDashboardTheme {
	fg?(style: string, text: string): string;
	bold?(text: string): string;
}

const CARD_WIDTH = 30;
const CARD_HEIGHT = 8;
const GAP = " → ";
const MAX_PREVIEW_WIDTH = CARD_WIDTH - 4;

function fg(theme: WorkflowDashboardTheme | undefined, style: string, text: string): string {
	return theme?.fg ? theme.fg(style, text) : text;
}

function bold(theme: WorkflowDashboardTheme | undefined, text: string): string {
	return theme?.bold ? theme.bold(text) : text;
}

function truncate(text: string | undefined, width: number): string {
	return truncateToWidth((text ?? "").replace(/\s+/g, " ").trim(), Math.max(0, width), "…");
}

function padRight(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function icon(status: WorkflowDashboardStatus): string {
	switch (status) {
		case "running": return "●";
		case "done": return "✓";
		case "error": return "✗";
		case "blocked": return "■";
		case "info": return "◆";
		default: return "○";
	}
}

function color(status: WorkflowDashboardStatus): string {
	switch (status) {
		case "running": return "warning";
		case "done": return "success";
		case "error": return "error";
		case "blocked": return "warning";
		case "info": return "accent";
		default: return "muted";
	}
}

export function truncateWorkflowPreview(value: string | undefined, maxWidth = MAX_PREVIEW_WIDTH): string {
	return truncate(value, maxWidth);
}

function elapsedText(step: WorkflowDashboardStep): string {
	if (step.elapsedMs === undefined) return "elapsed: —";
	if (step.elapsedMs < 1000) return `elapsed: ${step.elapsedMs}ms`;
	const seconds = Math.round(step.elapsedMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `elapsed: ${minutes ? `${minutes}m ${rest}s` : `${rest}s`}`;
}

function renderStepCard(step: WorkflowDashboardStep, theme?: WorkflowDashboardTheme): string[] {
	const inner = CARD_WIDTH - 2;
	const content = inner - 2;
	const stepColor = color(step.status);
	const border = (text: string) => fg(theme, step.status === "pending" ? "borderMuted" : stepColor, text);
	const row = (text: string) => `${border("│")} ${padRight(text, content)} ${border("│")}`;
	const title = `${fg(theme, stepColor, icon(step.status))} ${bold(theme, truncate(step.title, content - 4))}`;
	const preview = step.error ? `error: ${step.error}` : step.preview || step.handoff || step.policy || "waiting for chain runner";
	return [
		border(`┌${"─".repeat(inner)}┐`),
		row(title),
		row(fg(theme, "muted", `[${step.status}] ${step.type}`)),
		row(fg(theme, "dim", truncate(step.operation ?? step.id, content))),
		row(fg(theme, "dim", step.requiredState ? `guard: ${step.requiredState}` : elapsedText(step))),
		row(fg(theme, step.error ? "error" : "dim", truncate(preview, content))),
		row(fg(theme, "muted", step.policy ? truncate(step.policy, content) : elapsedText(step))),
		border(`└${"─".repeat(inner)}┘`),
	];
}

function renderFlowCards(steps: WorkflowDashboardStep[], width: number, theme?: WorkflowDashboardTheme): string[] {
	if (steps.length === 0) return [fg(theme, "muted", "No steps to display.")];
	const cardsPerRow = Math.max(1, Math.floor((Math.max(width, CARD_WIDTH) + visibleWidth(GAP)) / (CARD_WIDTH + visibleWidth(GAP))));
	const lines: string[] = [];
	for (let i = 0; i < steps.length; i += cardsPerRow) {
		const rowSteps = steps.slice(i, i + cardsPerRow);
		const rendered = rowSteps.map((step) => renderStepCard(step, theme));
		for (let lineIndex = 0; lineIndex < CARD_HEIGHT; lineIndex++) {
			lines.push(rendered.map((card) => card[lineIndex] ?? "" ).join(fg(theme, "dim", GAP)));
		}
	}
	return lines;
}

export function renderWorkflowDashboard(model: WorkflowDashboardModel, width = 120, theme?: WorkflowDashboardTheme): string[] {
	const safeWidth = Math.max(40, width);
	const headerTitle = model.chainId ? `${model.chainId} — ${model.title}` : model.title;
	const context = [model.source && `src:${model.source}`, model.state && `state:${model.state}`, model.branch && `branch:${model.branch}`, model.activeBead && `bead:${model.activeBead}`].filter(Boolean).join(" · ");
	const lines = [
		fg(theme, "accent", `╭─ ${bold(theme, "workflow-chain")} ${"─".repeat(Math.max(0, Math.min(24, safeWidth - 20)))}`),
		fg(theme, color(model.status), `${icon(model.status)} ${model.statusText}`),
		fg(theme, "muted", truncate(headerTitle, safeWidth)),
	];
	if (model.description) lines.push(fg(theme, "dim", truncate(model.description, safeWidth)));
	if (context) lines.push(fg(theme, "dim", truncate(context, safeWidth)));
	for (const warning of model.warnings ?? []) lines.push(fg(theme, "warning", truncate(`! ${warning}`, safeWidth)));
	lines.push("");
	lines.push(...renderFlowCards(model.steps, safeWidth, theme));
	if (model.handoff) lines.push("", fg(theme, "warning", truncate(`Handoff: ${model.handoff}`, safeWidth)));
	if (model.usage?.length) lines.push("", ...model.usage.map((item, index) => fg(theme, "dim", truncate(`${index === 0 ? "Usage: " : ""}${item}`, safeWidth))));
	return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}
