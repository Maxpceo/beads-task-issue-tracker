import * as fs from "node:fs";
import * as path from "node:path";

export interface LoadedPathRule {
	path: string;
	content: string;
	size: number;
	scope: "global" | "path";
}

export interface PathRulesResult {
	rules: LoadedPathRule[];
	skipped: string[];
	targets: string[];
}

export const ALLOWED_RULE_FILENAMES = ["AGENTS.md", "PI_RULES.md", "CLAUDE.md"] as const;
const GLOBAL_RULE_PATHS = ["AGENTS.md", path.join(".pi", "rules", "domain.md")];
const IGNORE_DIRS = new Set([".git", ".claude", "node_modules", ".nuxt", ".output", "dist", "target", "coverage"]);
const DEFAULT_MAX_RULE_BYTES = 64 * 1024;

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function normalizeTarget(cwd: string, filePath: string): string | undefined {
	if (!filePath || filePath.includes("\0")) return undefined;
	const absolute = path.resolve(cwd, filePath);
	const relative = path.relative(cwd, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const parts = relative.split(path.sep);
	if (parts.some((part) => IGNORE_DIRS.has(part))) return undefined;
	return toPosix(relative);
}

function ancestorDirs(target: string): string[] {
	const dir = path.posix.dirname(target);
	if (!dir || dir === ".") return [""];
	const parts = dir.split("/");
	const dirs = [""];
	for (let i = 0; i < parts.length; i += 1) dirs.push(parts.slice(0, i + 1).join("/"));
	return dirs;
}

async function maybeReadRule(cwd: string, relativePath: string, scope: LoadedPathRule["scope"], maxBytes: number): Promise<{ rule?: LoadedPathRule; skipped?: string }> {
	const absolute = path.join(cwd, relativePath);
	try {
		const stat = await fs.promises.stat(absolute);
		if (!stat.isFile()) return {};
		if (stat.size > maxBytes) return { skipped: `${toPosix(relativePath)} (${stat.size} bytes > ${maxBytes})` };
		const content = await fs.promises.readFile(absolute, "utf8");
		return { rule: { path: toPosix(relativePath), content, size: stat.size, scope } };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function loadPathRules(cwd: string, targetFiles: string[], options: { maxBytes?: number } = {}): Promise<PathRulesResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_RULE_BYTES;
	const targets = [...new Set(targetFiles.map((file) => normalizeTarget(cwd, file)).filter((file): file is string => Boolean(file)))];
	const candidates: Array<{ relativePath: string; scope: LoadedPathRule["scope"] }> = GLOBAL_RULE_PATHS.map((relativePath) => ({ relativePath, scope: "global" as const }));

	for (const target of targets) {
		for (const dir of ancestorDirs(target)) {
			for (const filename of ALLOWED_RULE_FILENAMES) {
				candidates.push({ relativePath: dir ? path.posix.join(dir, filename) : filename, scope: "path" });
			}
		}
	}

	const rules: LoadedPathRule[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const normalized = toPosix(candidate.relativePath);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		const result = await maybeReadRule(cwd, normalized, candidate.scope, maxBytes);
		if (result.rule) rules.push(result.rule);
		if (result.skipped) skipped.push(result.skipped);
	}

	return { rules, skipped, targets };
}

export function inferTargetFilesFromText(text: string): string[] {
	const matches = text.matchAll(/(?:^|[\s`'"(])((?:(?:\.pi|app|components|composables|i18n|pages|scripts|src|src-tauri|tests|utils)\/[A-Za-z0-9._/@+:-]+|\.tmp-[A-Za-z0-9._/-]+|[A-Za-z0-9._/-]+\/[A-Za-z0-9._-]+\.(?:ts|tsx|vue|rs|md|json|toml)|[A-Za-z0-9._-]+\.(?:ts|tsx|vue|rs|md|json|toml)))(?:$|[\s`'"),:])/gm);
	return [...new Set([...matches].map((match) => match[1]).filter((value): value is string => Boolean(value)))];
}

export async function renderPathRulesLoaded(cwd: string, targetFiles: string[]): Promise<string> {
	const result = await loadPathRules(cwd, targetFiles);
	const lines = ["PATH_RULES_LOADED:", `Targets: ${result.targets.join(", ") || "-"}`];
	if (result.rules.length === 0) lines.push("No path rules found.");
	for (const rule of result.rules) {
		lines.push(`\n--- ${rule.path} (${rule.scope}, ${rule.size} bytes) ---`);
		lines.push(rule.content.trimEnd());
	}
	if (result.skipped.length > 0) {
		lines.push("\nSkipped path rules:");
		for (const item of result.skipped) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}
