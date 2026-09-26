import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const WORKFLOW_CHAINS_CONFIG_RELATIVE = path.join(".pi", "config", "workflow-chains.json");
export const LEGACY_WORKFLOW_CHAINS_RELATIVE = path.join(".pi", "workflow-chains.json");

export interface WorkflowChainsNaming {
	types: string[];
	basenameEqualsBranchSuffix: boolean;
	suffixMustNotStartWith: string;
	suffixPattern: string;
	requireActiveBeadSuffixPrefix: boolean;
}

export interface WorkflowChains {
	copyRequired: boolean;
	copyRoot: string;
	copyRootRaw: string;
	handoffFromCopy: boolean;
	reviewRequired: boolean;
	matrixRequired: boolean;
	/** Exact true plus copyRequired false is required before writing on main/master. Missing/non-boolean fail closed to false. */
	mainWriteAllowed: boolean;
	/** Exact false turns off the Russian bead locale guard. Missing, non-boolean, and broken JSON stay true and do not reset other fields. */
	requireRussian: boolean;
	/** Command strings. Tracker defaults when checks is absent or not an array of non-empty strings. */
	checks: string[];
	/** True only when checks is an explicit array of non-empty strings, including []. */
	checksExplicit: boolean;
	naming: WorkflowChainsNaming;
	configPath?: string;
	readError: string;
}

export const TRACKER_DEFAULT_NAMING: WorkflowChainsNaming = {
	types: ["feat", "fix", "docs", "refactor", "test", "chore", "ci", "task"],
	basenameEqualsBranchSuffix: true,
	suffixMustNotStartWith: "beads-task-issue-tracker-",
	suffixPattern: "^[a-z0-9]+-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$",
	requireActiveBeadSuffixPrefix: true,
};

export const TRACKER_DEFAULT_CHECKS = [
	"pnpm test",
	"npx vue-tsc --noEmit",
	"cargo check --manifest-path src-tauri/Cargo.toml",
];

export const TRACKER_DEFAULTS = {
	copyRequired: true as const,
	copyRootRaw: "~/Projects/worktrees/beads-task-issue-tracker",
	handoffFromCopy: true as const,
	reviewRequired: true as const,
	matrixRequired: true as const,
	mainWriteAllowed: false as const,
	requireRussian: true as const,
	checks: TRACKER_DEFAULT_CHECKS,
	naming: TRACKER_DEFAULT_NAMING,
};

/** Main/master writes are allowed only when both flags are exact booleans: mainWriteAllowed true and copyRequired false. */
export function isMainWriteAllowed(chains: WorkflowChains): boolean {
	return chains.mainWriteAllowed === true && chains.copyRequired === false;
}

export function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (value === "$HOME") return os.homedir();
	if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
	return value;
}

export function trackerDefaultChains(readError = "", configPath?: string): WorkflowChains {
	return {
		copyRequired: true,
		copyRoot: expandHomePath(TRACKER_DEFAULTS.copyRootRaw),
		copyRootRaw: TRACKER_DEFAULTS.copyRootRaw,
		handoffFromCopy: true,
		reviewRequired: true,
		matrixRequired: true,
		mainWriteAllowed: false,
		requireRussian: true,
		checks: [...TRACKER_DEFAULT_CHECKS],
		checksExplicit: false,
		naming: { ...TRACKER_DEFAULT_NAMING, types: [...TRACKER_DEFAULT_NAMING.types] },
		configPath,
		readError,
	};
}

function findGitRoot(start: string): string | undefined {
	let cursor = path.resolve(start);
	while (true) {
		try {
			if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
		} catch {
			return undefined;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
}

export function findWorkflowChainsConfigPath(cwd: string): string | undefined {
	const start = path.resolve(cwd);
	const gitRoot = findGitRoot(start);
	if (!gitRoot) return undefined;
	let cursor = start;
	while (true) {
		const candidate = path.join(cursor, WORKFLOW_CHAINS_CONFIG_RELATIVE);
		try {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// keep walking
		}
		if (cursor === gitRoot) break;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return undefined;
}

function readErrorMessage(configPath: string, reason: string): string {
	return `Не удалось прочитать ${configPath}: ${reason}. Оставляю ритуал трекера (copyRequired=true).`;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseNaming(raw: unknown, configPath: string): { naming?: WorkflowChainsNaming; error?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: readErrorMessage(configPath, "поле naming обязательно и должно быть объектом") };
	}
	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.types) || record.types.length === 0 || record.types.some((item) => typeof item !== "string" || item.trim() === "")) {
		return { error: readErrorMessage(configPath, "naming.types должен быть непустым массивом строк") };
	}
	if (typeof record.basenameEqualsBranchSuffix !== "boolean") {
		return { error: readErrorMessage(configPath, "naming.basenameEqualsBranchSuffix должен быть boolean") };
	}
	if (typeof record.suffixMustNotStartWith !== "string") {
		return { error: readErrorMessage(configPath, "naming.suffixMustNotStartWith должен быть строкой") };
	}
	if (typeof record.suffixPattern !== "string" || record.suffixPattern.trim() === "") {
		return { error: readErrorMessage(configPath, "naming.suffixPattern должен быть непустой строкой") };
	}
	try {
		new RegExp(record.suffixPattern);
	} catch {
		return { error: readErrorMessage(configPath, `naming.suffixPattern не является регулярным выражением: ${record.suffixPattern}`) };
	}
	if (typeof record.requireActiveBeadSuffixPrefix !== "boolean") {
		return { error: readErrorMessage(configPath, "naming.requireActiveBeadSuffixPrefix должен быть boolean") };
	}
	return {
		naming: {
			types: record.types.map((item) => String(item)),
			basenameEqualsBranchSuffix: record.basenameEqualsBranchSuffix,
			suffixMustNotStartWith: record.suffixMustNotStartWith,
			suffixPattern: record.suffixPattern,
			requireActiveBeadSuffixPrefix: record.requireActiveBeadSuffixPrefix,
		},
	};
}

function parseChecks(raw: unknown): { checks: string[]; checksExplicit: boolean } {
	if (!Array.isArray(raw)) return { checks: [...TRACKER_DEFAULT_CHECKS], checksExplicit: false };
	if (raw.length === 0) return { checks: [], checksExplicit: true };
	const checks: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string" || item.trim() === "") {
			return { checks: [...TRACKER_DEFAULT_CHECKS], checksExplicit: false };
		}
		checks.push(item);
	}
	return { checks, checksExplicit: true };
}

function parseWorkflowChainsFile(configPath: string, rawText: string): WorkflowChains {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "невалидный JSON";
		return trackerDefaultChains(readErrorMessage(configPath, reason), configPath);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return trackerDefaultChains(readErrorMessage(configPath, "корень JSON должен быть объектом"), configPath);
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.copyRequired !== "boolean") {
		return trackerDefaultChains(readErrorMessage(configPath, "copyRequired должен быть boolean"), configPath);
	}
	if (typeof record.handoffFromCopy !== "boolean") {
		return trackerDefaultChains(readErrorMessage(configPath, "handoffFromCopy должен быть boolean"), configPath);
	}
	if (record.copyRequired) {
		if (typeof record.copyRoot !== "string" || record.copyRoot.trim() === "") {
			return trackerDefaultChains(readErrorMessage(configPath, "copyRoot обязателен, когда copyRequired true"), configPath);
		}
	} else if (record.copyRoot !== undefined && typeof record.copyRoot !== "string") {
		return trackerDefaultChains(readErrorMessage(configPath, "copyRoot должен быть строкой"), configPath);
	}
	const namingResult = parseNaming(record.naming, configPath);
	if (namingResult.error || !namingResult.naming) {
		return trackerDefaultChains(namingResult.error ?? readErrorMessage(configPath, "naming не прочитан"), configPath);
	}
	const copyRootRaw = asNonEmptyString(record.copyRoot) ?? "";
	return {
		copyRequired: record.copyRequired,
		copyRoot: copyRootRaw ? expandHomePath(copyRootRaw) : "",
		copyRootRaw,
		handoffFromCopy: record.handoffFromCopy,
		reviewRequired: record.reviewRequired === false ? false : true,
		matrixRequired: record.matrixRequired === false ? false : true,
		mainWriteAllowed: record.mainWriteAllowed === true,
		requireRussian: record.requireRussian === false ? false : true,
		...parseChecks(record.checks),
		naming: namingResult.naming,
		configPath,
		readError: "",
	};
}

export function loadWorkflowChains(cwd: string = process.cwd()): WorkflowChains {
	const configPath = findWorkflowChainsConfigPath(cwd);
	if (!configPath) return trackerDefaultChains();
	let rawText: string;
	try {
		rawText = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : "файл нельзя прочитать";
		return trackerDefaultChains(readErrorMessage(configPath, reason), configPath);
	}
	if (rawText.trim() === "") {
		return trackerDefaultChains(readErrorMessage(configPath, "файл пустой"), configPath);
	}
	return parseWorkflowChainsFile(configPath, rawText);
}

export default function workflowChainsConfigExtension(_pi: unknown): void {
	// Shared helper entrypoint: Pi requires default factories for .pi/extensions/*/index.ts.
}
