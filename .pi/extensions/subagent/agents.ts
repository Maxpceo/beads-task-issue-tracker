/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface AgentTeam {
	name: string;
	description?: string;
	members: string[];
	warnings: string[];
}

export interface AgentTeamConfigResult {
	teams: AgentTeam[];
	filePath: string | null;
	warnings: string[];
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

function parseScalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseInlineList(value: string): string[] | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return [];
	return inner
		.split(",")
		.map((item) => parseScalar(item))
		.filter(Boolean);
}

export function loadProjectAgentTeams(cwd: string, knownAgents: AgentConfig[]): AgentTeamConfigResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const filePath = projectAgentsDir ? path.join(projectAgentsDir, "teams.yaml") : null;
	if (!filePath || !fs.existsSync(filePath)) {
		return { teams: [], filePath, warnings: ["No .pi/agents/teams.yaml found; showing individual agents only."] };
	}

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		return { teams: [], filePath, warnings: [`Could not read teams.yaml: ${(error as Error).message}`] };
	}

	const knownNames = new Set(knownAgents.map((agent) => agent.name));
	const teams: AgentTeam[] = [];
	const warnings: string[] = [];
	let current: AgentTeam | null = null;
	let readingMembers = false;

	const finishTeam = () => {
		if (!current) return;
		current.members = Array.from(new Set(current.members));
		for (const member of current.members) {
			if (!knownNames.has(member)) current.warnings.push(`Unknown agent: ${member}`);
		}
		if (current.members.length === 0) current.warnings.push("Team has no members.");
		teams.push(current);
	};

	for (const rawLine of content.split(/\r?\n/)) {
		const withoutComment = rawLine.replace(/\s+#.*$/, "");
		if (!withoutComment.trim()) continue;
		const line = withoutComment.trimEnd();
		const trimmed = line.trim();

		const teamMatch = /^-\s*name:\s*(.+)$/.exec(trimmed);
		if (teamMatch) {
			finishTeam();
			current = { name: parseScalar(teamMatch[1]), members: [], warnings: [] };
			readingMembers = false;
			continue;
		}

		if (!current) {
			if (trimmed !== "teams:") warnings.push(`Ignored line before first team: ${trimmed}`);
			continue;
		}

		const descriptionMatch = /^description:\s*(.+)$/.exec(trimmed);
		if (descriptionMatch) {
			current.description = parseScalar(descriptionMatch[1]);
			readingMembers = false;
			continue;
		}

		const membersInlineMatch = /^members:\s*(.*)$/.exec(trimmed);
		if (membersInlineMatch) {
			const inline = parseInlineList(membersInlineMatch[1]);
			if (inline) current.members.push(...inline);
			else if (membersInlineMatch[1].trim()) current.warnings.push(`Malformed members list: ${membersInlineMatch[1].trim()}`);
			readingMembers = true;
			continue;
		}

		const memberMatch = /^-\s*(.+)$/.exec(trimmed);
		if (readingMembers && memberMatch) {
			current.members.push(parseScalar(memberMatch[1]));
			continue;
		}

		current.warnings.push(`Ignored line: ${trimmed}`);
	}
	finishTeam();

	if (teams.length === 0) warnings.push("No teams were parsed from teams.yaml.");
	return { teams, filePath, warnings };
}
