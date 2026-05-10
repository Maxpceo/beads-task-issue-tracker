import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KNOWLEDGE_MARKER = /\b(INVESTIGATION|LEARNED|DECISION|FACT|PATTERN):\s*([\s\S]+)/i;
const COMMENT_COMMAND = /\bbd\s+comments\s+add\s+([A-Za-z0-9._-]+)\s+([\s\S]+)/;

function stripShellQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
	return trimmed;
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
		const comment = command.match(COMMENT_COMMAND);
		if (!comment) return undefined;
		const marker = stripShellQuotes(comment[2]).match(KNOWLEDGE_MARKER);
		if (!marker) return undefined;
		const type = marker[1].toLowerCase();
		const content = marker[2].trim().slice(0, 2048);
		if (!content) return undefined;
		try {
			const key = appendKnowledge(ctx.cwd, comment[1], type, content);
			if (key) ctx.ui.notify(`Captured bd knowledge: ${key}`, "info");
		} catch (error) {
			ctx.ui.notify(`Memory capture failed: ${(error as Error).message}`, "warning");
		}
		return undefined;
	});
}
