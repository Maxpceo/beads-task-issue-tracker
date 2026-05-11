import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
type ExtensionAPI = {
	on(eventName: "tool_call", handler: (event: { toolName: string; input: { command?: unknown } }, ctx: { cwd: string; hasUI?: boolean; ui: { confirm(title: string, message: string): Promise<boolean>; notify(message: string, level?: string): void } }) => unknown): void;
};

const KNOWLEDGE_MARKER = /\b(INVESTIGATION|LEARNED|DECISION|FACT|PATTERN):\s*([\s\S]+)/i;
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "\n"]);

export type MemoryCapture = {
	bead: string;
	type: string;
	content: string;
};

function shellWordsUntilOperator(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < command.length; i++) {
		const char = command.charAt(i);
		const next = i + 1 < command.length ? command.charAt(i + 1) : undefined;

		if (!quote) {
			const two = `${char}${next ?? ""}`;
			if (SHELL_OPERATORS.has(two)) break;
			if (SHELL_OPERATORS.has(char)) break;
			if (/\s/.test(char)) {
				if (word) {
					words.push(word);
					word = "";
				}
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
		} else if (char === quote) {
			quote = undefined;
			continue;
		}

		if (char === "\\" && quote !== "'" && next) {
			word += next;
			i++;
			continue;
		}
		word += char;
	}

	if (word) words.push(word);
	return words;
}

export function parseMemoryCapture(command: string): MemoryCapture | undefined {
	const words = shellWordsUntilOperator(command);
	for (let i = 0; i <= words.length - 5; i++) {
		if (words[i] !== "bd" || words[i + 1] !== "comments" || words[i + 2] !== "add") continue;
		const bead = words[i + 3];
		if (!bead) return undefined;
		const commentWords: string[] = [];
		for (const word of words.slice(i + 4)) {
			if (word.startsWith("--")) break;
			commentWords.push(word);
		}
		const marker = commentWords.join(" ").match(KNOWLEDGE_MARKER);
		if (!marker) return undefined;
		const markerType = marker[1];
		const markerContent = marker[2];
		if (!markerType || !markerContent) return undefined;
		const type = markerType.toLowerCase();
		const content = markerContent.trim().slice(0, 2048);
		if (!content) return undefined;
		return { bead, type, content };
	}
	return undefined;
}

function slug(value: string): string {
	const basic = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
	return basic || createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function tagsFor(type: string, content: string): string[] {
	const tags = new Set([type]);
	for (const tag of ["api", "security", "test", "database", "networking", "ui", "layout", "performance", "crash", "bug", "fix", "workaround", "gotcha", "pattern", "convention", "architecture", "auth", "middleware", "async", "concurrency", "model", "protocol", "adapter"]) {
		if (new RegExp(`\\b${tag}\\b`, "i").test(content)) tags.add(tag);
	}
	return [...tags];
}

function appendKnowledge(cwd: string, bead: string, type: string, content: string): string | undefined {
	const memoryDir = path.join(cwd, ".beads", "memory");
	fs.mkdirSync(memoryDir, { recursive: true });
	const file = path.join(memoryDir, "knowledge.jsonl");
	const key = `${type}-${slug(content)}`;
	if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(`"key":"${key}"`)) return undefined;
	const entry = { key, type, content: content.slice(0, 2048), source: "pi", tags: tagsFor(type, content), ts: Math.floor(Date.now() / 1000), bead };
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
	if (lines.length > 1000) {
		fs.appendFileSync(path.join(memoryDir, "knowledge.archive.jsonl"), `${lines.slice(0, 500).join("\n")}\n`);
		fs.writeFileSync(file, `${lines.slice(500).join("\n")}\n`);
	}
	return key;
}

export default function memoryCaptureExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		const capture = parseMemoryCapture(command);
		if (!capture) return undefined;
		if (!ctx.hasUI) return undefined;
		const approved = await ctx.ui.confirm(
			"Approve memory capture?",
			`Pi detected a ${capture.type.toUpperCase()} marker in a bd comment and proposes recording it as durable project memory.\n\nBead: ${capture.bead}\nType: ${capture.type}\nContent:\n${capture.content}\n\nApprove only if this should be persisted to .beads/memory/knowledge.jsonl.`,
		);
		if (!approved) {
			ctx.ui.notify("Memory capture skipped: proposal was not approved", "info");
			return undefined;
		}
		try {
			const key = appendKnowledge(ctx.cwd, capture.bead, capture.type, capture.content);
			if (key) ctx.ui.notify(`Captured bd knowledge: ${key}`, "info");
		} catch (error) {
			ctx.ui.notify(`Memory capture failed: ${(error as Error).message}`, "warning");
		}
		return undefined;
	});
}
