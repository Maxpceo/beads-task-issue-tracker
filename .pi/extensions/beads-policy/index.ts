import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireTaskToolTarget, taskScopeErrorToPolicyReason } from "../worktree-scope/index";
interface ExtensionAPI {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: any): void;
}

interface ExtensionContext {
	cwd: string;
	sessionManager: {
		getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | undefined;
		getLeafId?: () => string | undefined;
	};
	ui: {
		notify(message: string, level: string): void;
		setStatus(key: string, value: string): void;
		theme: { fg(style: string, value: string): string };
	};
}

type PolicyName =
	| "blockGitAddAll"
	| "requireMergeSlotForPush"
	| "protectPaths"
	| "blockDestructiveCommand"
	| "blockBdCloseWithoutReview"
	| "blockEpicCloseWithIncompleteChildren"
	| "requireEpicFinalizationSweep"
	| "blockUnmergedBranchCompletion"
	| "validateReviewChain"
	| "enforceBeadEnrichment"
	| "enforceBeadRussianLocale"
	| "blockMutationsInPlanning"
	| "blockRawBdClaim"
	| "blockSupervisorClose"
	| "blockWorktreeInsideRepo"
	| "enforceActiveWorktreeCwd"
	| "blockMainMutation"
	| "staleWorktreeGuard"
	| "fastPathDiscipline"
	| "enforceActiveBeadLifecycle";

interface PolicyDecision {
	policy: PolicyName;
	block: boolean;
	reason: string;
}

interface WorkflowStateSnapshot {
	state?: string;
	activeBead?: string;
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	endCommit?: string;
	sessionKey?: string;
	runtimeOwnerKey?: string;
	mergeSlotHeld?: boolean;
	planMode?: string;
	planApproved?: boolean | string;
	sessionMode?: string;
	bdStatus?: string;
}

interface BashPolicyOptions {
	cwd?: string;
	bdMergeSlotIssue?: BdMergeSlotIssue | null;
	currentActor?: string;
}

const PRIVATE_KEY_OR_CERT_PATTERN = /(^|[\/])[^\/]+\.(pem|key|p12|pfx|crt|cer)$/i;
const ENV_FILE_PATTERN = /(^|[\/])\.env(?:$|[.\/])/;
const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: ENV_FILE_PATTERN, reason: "env файлы могут содержать secrets" },
	{ pattern: /(^|[\/])\.ssh(?:$|[\/])|(^|[\/])id_(rsa|dsa|ecdsa|ed25519)(?:$|[.\/])/, reason: "SSH credentials защищены" },
	{ pattern: /(^|[\/])\.aws[\/]credentials(?:$|[\/])|(^|[\/])\.aws[\/]config(?:$|[\/])/, reason: "AWS credentials/config защищены" },
	{ pattern: /(^|[\/])\.config[\/]gcloud(?:$|[\/])|(^|[\/])\.azure(?:$|[\/])/, reason: "cloud credentials/config защищены" },
	{ pattern: /(^|[\/])\.kube[\/]config(?:$|[\/])/, reason: "Kubernetes config защищён" },
	{ pattern: /(^|[\/])terraform\.tfstate(?:\.backup)?$|\.tfstate(?:\.backup)?$/, reason: "Terraform state защищён" },
	{ pattern: PRIVATE_KEY_OR_CERT_PATTERN, reason: "private key/cert файлы защищены" },
];
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const WORKTREE_ROOT = path.join(os.homedir(), "Projects", "worktrees", "beads-task-issue-tracker");
const META_ONLY_PATTERN = /^(\.beads\/|\.pi\/plans\/|.*\.(md|json|jsonl)$)/;
const CODE_FILE_PATTERN = /^(app|src-tauri|tests|i18n|\.pi\/extensions|\.pi\/agents|\.pi\/skills|scripts)\/|\.(ts|tsx|vue|rs|js|mjs|cjs|css|scss|sh)$/;
const FAST_PATH_FILE_THRESHOLD = 3;
const FAST_PATH_ADDED_LINE_THRESHOLD = 80;
const TERMINAL_WORKFLOW_STATES = new Set(["closed", "blocked", "deferred", "merged"]);
const NON_TERMINAL_WORKFLOW_STATES = new Set(["claimed", "planning", "plan_approved", "implementing", "inreview", "reviewing", "accepted", "landing"]);
const TERMINAL_BD_STATUSES = new Set(["closed", "blocked", "deferred"]);
const NON_TERMINAL_BD_STATUSES = new Set(["open", "in_progress", "inreview", "simplified", "reviewed", "accepted"]);
const RISKY_FILE_PREFIXES = [
	".pi/extensions/beads-policy/",
	".pi/extensions/beads-dispatch/",
	".pi/extensions/review-workflow/",
	".pi/extensions/workflow-state/",
	".pi/skills/merge-to-main/",
	".pi/skills/release/",
	".pi/skills/dispatch-supervisor/",
	".pi/skills/review-bead/",
	".pi/agents/",
	"scripts/",
];

function getSkipPolicies(): Set<string> {
	return new Set(
		(process.env.PI_SKIP_POLICY ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

function isSkipped(policy: PolicyName): boolean {
	const skipped = getSkipPolicies();
	return skipped.has("all") || skipped.has(policy);
}

function applySkip(decision: PolicyDecision | undefined): PolicyDecision | undefined {
	if (!decision) return undefined;
	if (isSkipped(decision.policy)) return undefined;
	return decision;
}

function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function matchesToolName(actual: string | undefined, canonical: string): boolean {
	if (!actual) return false;
	return actual === canonical || actual === `functions.${canonical}` || actual.endsWith(`.${canonical}`);
}

function protectedPathReason(targetPath: string): string | undefined {
	const normalizedPath = targetPath.replace(/\\/g, "/");
	if (normalizedPath.includes(".git/")) return ".git internals защищены";
	if (normalizedPath.includes("node_modules/")) return "node_modules защищён от direct tool access";
	for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
		if (pattern.test(normalizedPath)) return reason;
	}
	return undefined;
}

function commandTouchesSensitivePath(command: string): string | undefined {
	const normalized = command.replace(/\\/g, "/");
	for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
		if (pattern.test(normalized)) return reason;
	}
	return undefined;
}

function commandHasRecursiveForceDelete(command: string): boolean {
	return /(^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f|-i?[^\s]*f[^\s]*r|--recursive\s+--force|--force\s+--recursive)\b/.test(command);
}

function commandHasHardReset(command: string): boolean {
	return /(^|[;&|]\s*)git\s+reset\s+(?:[^;&|]*\s)?--hard\b/.test(command);
}

function commandHasForcedClean(command: string): boolean {
	return /(^|[;&|]\s*)git\s+clean\b(?=[^;&|]*(?:\s-f|\s-[a-zA-Z]*f|--force\b))/.test(command);
}

function commandHasUnsafeForcePush(command: string): boolean {
	if (!/(^|[;&|]\s*)git\s+push\b/.test(command)) return false;
	const withoutLease = command.replace(/--force-with-lease(?:=\S+)?/g, "");
	return /(^|\s)(?:--force|-f)(?:\s|$)/.test(withoutLease);
}

function commandHasRemoteBranchDeletion(command: string): boolean {
	return splitShellSegments(command).some((segment) => {
		const tokens = shellTokens(segment);
		const pushIndex = tokens.findIndex((token, index) => token === "push" && tokens[index - 1] === "git");
		if (pushIndex < 1) return false;
		return tokens.slice(pushIndex + 1).some((token) => token === "--delete" || token === "-d" || token.startsWith(":") || token.startsWith("+:"));
	});
}


interface RemoteBranchDeletionPush {
	branch: string;
	leaseOid: string;
}

const GIT_OID_PATTERN = /^[0-9a-f]{40}$/i;
const CANONICAL_PI_BRANCH_PREFIXES = new Set(["feat", "fix", "docs", "refactor", "test", "chore", "ci", "task"]);

function isSafeCanonicalPiBranchName(branch: string): boolean {
	const slashIndex = branch.indexOf("/");
	const prefix = slashIndex === -1 ? "" : branch.slice(0, slashIndex);
	const suffix = slashIndex === -1 ? "" : branch.slice(slashIndex + 1);
	return Boolean(prefix && suffix)
		&& CANONICAL_PI_BRANCH_PREFIXES.has(prefix)
		&& /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(suffix)
		&& !branch.includes("..")
		&& !branch.endsWith("/")
		&& !branch.includes("//");
}

function normalizeDeletedBranchRef(value: string): string | undefined {
	const ref = stripQuotes(value).replace(/^refs\/heads\//, "");
	if (!ref || ref.startsWith("-") || ref.includes(":")) return undefined;
	return ref;
}

function parseRemoteDeletionPushSegment(segment: string): RemoteBranchDeletionPush | undefined {
	const tokens = shellTokens(segment);
	const pushIndex = tokens.findIndex((token, index) => token === "push" && tokens[index - 1] === "git");
	if (pushIndex !== 1 || tokens[0] !== "git") return undefined;

	let remote: string | undefined;
	let deleteMode = false;
	const deletionTargets: string[] = [];
	let leaseBranch: string | undefined;
	let leaseOid: string | undefined;

	for (let index = pushIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (token === "--") continue;
		if (token === "--delete" || token === "-d") {
			deleteMode = true;
			continue;
		}
		if (token === "--force-with-lease") return undefined;
		if (token.startsWith("--force-with-lease=")) {
			const lease = stripQuotes(token.slice("--force-with-lease=".length));
			const match = lease.match(/^refs\/heads\/(.+):([0-9a-f]{40})$/i);
			if (!match) return undefined;
			leaseBranch = match[1];
			leaseOid = match[2];
			continue;
		}
		if (token.startsWith("--")) return undefined;
		if (token.startsWith("-")) return undefined;
		if (!remote) {
			remote = token;
			continue;
		}
		if (deleteMode) {
			const branch = normalizeDeletedBranchRef(token);
			if (!branch) return undefined;
			deletionTargets.push(branch);
			continue;
		}
		if (token.startsWith(":")) {
			const branch = normalizeDeletedBranchRef(token.slice(1));
			if (!branch) return undefined;
			deletionTargets.push(branch);
			continue;
		}
		return undefined;
	}

	if (remote !== "origin" || deletionTargets.length !== 1 || !leaseBranch || !leaseOid) return undefined;
	const branch = deletionTargets[0];
	if (branch !== leaseBranch) return undefined;
	return { branch, leaseOid };
}

function parseSafeRemoteDeletionCommand(command: string): RemoteBranchDeletionPush | undefined {
	const segments = splitShellSegments(command);
	const deletionSegments = segments.filter(commandHasRemoteBranchDeletion);
	if (deletionSegments.length !== 1) return undefined;
	const segment = deletionSegments[0];
	if (!segment || segment.includes("|") || /[`$()]/.test(segment)) return undefined;
	return parseRemoteDeletionPushSegment(segment);
}

function remoteHeadOid(cwd: string, remote: string, branch: string): string | undefined {
	const output = runGit(cwd, ["ls-remote", "--heads", remote, branch]);
	const [oid, ref, extra] = output?.split(/\s+/) ?? [];
	if (!oid || !ref || extra || ref !== `refs/heads/${branch}` || !GIT_OID_PATTERN.test(oid)) return undefined;
	return oid;
}

function remoteOidAncestorOfMain(cwd: string, branchOid: string, mainOid: string): boolean {
	return commandSucceeds(cwd, "git", ["merge-base", "--is-ancestor", branchOid, mainOid]);
}

function hasObservableMergeSlotEvidence(workflowState: WorkflowStateSnapshot, options: BashPolicyOptions, cwd: string): boolean {
	return workflowState.mergeSlotHeld === true || currentActorHoldsBdMergeSlot(cwd, options);
}

function mergedRemoteBranchCleanupBlockReason(command: string, workflowState: WorkflowStateSnapshot, options: BashPolicyOptions, cwd: string): string | undefined {
	const parsed = parseSafeRemoteDeletionCommand(command);
	if (!parsed) {
		return "Заблокировано: remote branch deletion разрешён только для exact merge-to-main fallback формы `git push --force-with-lease=refs/heads/<branch>:<oid> origin :refs/heads/<branch>` для canonical Pi branch prefix.";
	}
	const branch = parsed.branch;
	const activeBranch = workflowState.branch;
	if (activeBranch && !PROTECTED_BRANCHES.has(activeBranch) && branch !== activeBranch) {
		return `Заблокировано: remote branch deletion target ${branch} не совпадает с active workflow branch ${activeBranch}.`;
	}
	if (!isSafeCanonicalPiBranchName(branch) || PROTECTED_BRANCHES.has(branch)) {
		return `Заблокировано: remote branch deletion разрешён только для canonical Pi branch prefix (feat|fix|docs|refactor|test|chore|ci|task); получен ${branch}.`;
	}
	if (!hasObservableMergeSlotEvidence(workflowState, options, cwd)) {
		return "Заблокировано: remote branch deletion fallback требует observable merge-slot evidence текущего actor/session.";
	}

	const branchOid = remoteHeadOid(cwd, "origin", branch);
	const mainOid = remoteHeadOid(cwd, "origin", "main");
	if (!branchOid) return `Заблокировано: remote branch deletion fallback не видит origin/${branch}; branch отсутствует или ls-remote вернул неоднозначный результат.`;
	if (!mainOid) return "Заблокировано: remote branch deletion fallback не видит origin/main; нельзя проверить merged ancestry.";
	if (branchOid !== parsed.leaseOid) {
		return `Заблокировано: remote branch deletion fallback lease stale/mismatched для ${branch}; expected ${branchOid}, got ${parsed.leaseOid}.`;
	}
	if (!remoteOidAncestorOfMain(cwd, branchOid, mainOid)) {
		return `Заблокировано: remote branch deletion fallback требует, чтобы ${branch}@${branchOid} был ancestor of origin/main@${mainOid}.`;
	}
	return undefined;
}

function isSafeMergedRemoteBranchCleanup(command: string, workflowState: WorkflowStateSnapshot, options: BashPolicyOptions, cwd: string): boolean {
	return mergedRemoteBranchCleanupBlockReason(command, workflowState, options, cwd) === undefined;
}

function commandHasStashDeletion(command: string): boolean {
	return /(^|[;&|]\s*)git\s+stash\s+(?:drop|clear)\b/.test(command);
}

function commandHasCloudResourceDeletion(command: string): boolean {
	return /(^|[;&|]\s*)(?:kubectl\s+delete\b|terraform\s+destroy\b|aws\s+\S+\s+delete-\S+\b|gcloud\s+[^;&|]*\sdelete\b|az\s+[^;&|]*\sdelete\b)/.test(command);
}

function commandHasDestructiveSql(command: string): boolean {
	return /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i.test(command) || /\bTRUNCATE\s+TABLE\b/i.test(command) || /\bDELETE\s+FROM\b(?![^;&|]*\bWHERE\b)/i.test(command);
}

function destructiveCommandReason(command: string, workflowState: WorkflowStateSnapshot = {}, options: BashPolicyOptions = {}, cwd = process.cwd()): string | undefined {
	const sensitivePathReason = commandTouchesSensitivePath(command);
	if (sensitivePathReason) return `Заблокировано: command ссылается на protected path (${sensitivePathReason}).`;
	if (commandHasRecursiveForceDelete(command)) return "Заблокировано: recursive force delete запрещён из Pi bash.";
	if (commandHasHardReset(command)) return "Заблокировано: git reset --hard является destructive. Используй explicit documented override только после approval.";
	if (commandHasForcedClean(command)) return "Заблокировано: forced git clean может удалить untracked work.";
	if (commandHasUnsafeForcePush(command)) return "Заблокировано: unsafe force push запрещён; --force-with-lease — более безопасная explicit form.";
	if (commandHasRemoteBranchDeletion(command)) {
		const cleanupReason = mergedRemoteBranchCleanupBlockReason(command, workflowState, options, cwd);
		if (cleanupReason) return cleanupReason;
	}
	if (commandHasStashDeletion(command)) return "Заблокировано: stash deletion может уничтожить recovery points.";
	if (commandHasCloudResourceDeletion(command)) return "Заблокировано: cloud/infrastructure resource deletion является destructive.";
	if (commandHasDestructiveSql(command)) return "Заблокировано: destructive SQL требует explicit human approval и rollback plan.";
	return undefined;
}

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function runCommand(cwd: string, command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function commandSucceeds(cwd: string, command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { cwd, encoding: "utf8", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
	return value;
}

function normalizeFsPath(value: string, cwd = process.cwd()): string {
	const expanded = expandHome(stripQuotes(value));
	return path.resolve(cwd, expanded);
}

function realpathExistingOrParent(targetPath: string): string {
	let cursor = targetPath;
	while (!fs.existsSync(cursor)) {
		const next = path.dirname(cursor);
		if (next === cursor) return path.resolve(targetPath);
		cursor = next;
	}
	try {
		const real = fs.realpathSync(cursor);
		return path.join(real, path.relative(cursor, targetPath));
	} catch {
		return path.resolve(targetPath);
	}
}

function nearestExistingDirectory(targetPath: string): string {
	let cursor = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
	while (!fs.existsSync(cursor)) {
		const next = path.dirname(cursor);
		if (next === cursor) return path.dirname(targetPath);
		cursor = next;
	}
	return cursor;
}

function getBranchForPath(filePath: string): string | undefined {
	return runGit(nearestExistingDirectory(filePath), ["branch", "--show-current"]);
}

function getRepoRoot(cwd: string): string | undefined {
	return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function isProtectedBranch(cwd: string): boolean {
	const branch = runGit(cwd, ["branch", "--show-current"]);
	return branch ? PROTECTED_BRANCHES.has(branch) : false;
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	const pattern = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(command)) && words.length < 24) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

type EnvPrefixParse = {
	commandIndex?: number;
	cwd?: string;
	unsupportedOption?: string;
};

function isEnvExecutableWord(word: string): boolean {
	return /(^|\/)env$/.test(word);
}

function parseEnvPrefix(words: string[], base?: string): EnvPrefixParse {
	const executable = words[0];
	if (!executable || !isEnvExecutableWord(executable)) return {};
	let cwd: string | undefined;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index];
		if (!word) continue;
		if (word === "-C" || word === "--chdir") {
			const chdirPath = words[index + 1];
			if (!chdirPath) return { cwd, unsupportedOption: word };
			cwd = base ? normalizeFsPath(chdirPath, base) : chdirPath;
			index += 1;
			continue;
		}
		if (word.startsWith("--chdir=")) {
			const chdirPath = word.slice("--chdir=".length);
			cwd = base ? normalizeFsPath(chdirPath, base) : chdirPath;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		if (word.startsWith("-")) return { cwd, unsupportedOption: word };
		return { commandIndex: index, cwd };
	}
	return { cwd };
}

function envWrappedCommandIndex(words: string[]): number | undefined {
	return parseEnvPrefix(words).commandIndex;
}

function envCommandCwd(words: string[], base: string): string | undefined {
	return parseEnvPrefix(words, base).cwd;
}

function hasUnsupportedEnvOption(command: string): boolean {
	return Boolean(parseEnvPrefix(shellWords(command)).unsupportedOption);
}

function isShellInterpreter(word: string): boolean {
	return /(^|\/)(?:bash|sh|zsh|dash|fish)$/.test(word);
}

function hasShellCommandOption(words: string[], commandIndex: number): boolean {
	return words.slice(commandIndex + 1).some((word) => word === "-c" || /^-[^-]*c/.test(word));
}

function hasUnquotedShellOperator(command: string): boolean {
	let singleQuoted = false;
	let doubleQuoted = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (!char) continue;
		if (char === "\\" && !singleQuoted) {
			index += 1;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			continue;
		}
		if (char === '"' && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			continue;
		}
		if (!singleQuoted && !doubleQuoted && /[;&|<>]/.test(char)) return true;
	}
	return false;
}

function hasShellCommandSubstitution(command: string): boolean {
	let singleQuoted = false;
	let doubleQuoted = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (!char) continue;
		if (char === "\\" && !singleQuoted) {
			index += 1;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			continue;
		}
		if (char === '"' && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			continue;
		}
		if (singleQuoted) continue;
		if (char === "`" || (char === "$" && command[index + 1] === "(")) return true;
	}
	return false;
}

function hasAmbiguousEnvShellCommand(command: string): boolean {
	const words = shellWords(command);
	if (hasUnsupportedEnvOption(command)) return true;
	const commandIndex = envWrappedCommandIndex(words);
	if (commandIndex === undefined) return false;
	if (hasUnquotedShellOperator(command) || hasShellCommandSubstitution(command)) return true;
	const commandWord = words[commandIndex];
	if (!commandWord) return false;
	return isShellInterpreter(commandWord) && hasShellCommandOption(words, commandIndex);
}

function hasDirectShellCommand(command: string): boolean {
	const words = shellWords(command);
	const commandWord = words[0];
	return Boolean(commandWord && isShellInterpreter(commandWord) && hasShellCommandOption(words, 0));
}

function leadingCdMatch(command: string): RegExpMatchArray | null {
	return command.match(/^\s*cd\s+([^;&|]+?)\s*&&\s*/);
}

function leadingCdSuffix(command: string): string | undefined {
	const match = leadingCdMatch(command);
	return match ? command.slice(match[0].length) : undefined;
}

function hasAmbiguousLeadingCdShellCommand(command: string): boolean {
	const suffix = leadingCdSuffix(command);
	if (suffix === undefined) return false;
	if (hasUnquotedShellOperator(suffix) || hasShellCommandSubstitution(suffix)) return true;
	const words = shellWords(suffix);
	const commandWord = words[0];
	if (!commandWord) return false;
	return isShellInterpreter(commandWord) && hasShellCommandOption(words, 0);
}

function inferCommandCwdInfo(command: string, defaultCwd?: string): { cwd: string; explicit: boolean } {
	const base = defaultCwd ?? process.cwd();
	const cdMatch = leadingCdMatch(command);
	const cdPath = cdMatch?.[1];
	if (cdPath) return { cwd: normalizeFsPath(cdPath.trim(), base), explicit: true };

	const words = shellWords(command);
	const envCwd = envCommandCwd(words, base);
	if (envCwd) return { cwd: envCwd, explicit: true };

	return { cwd: base, explicit: false };
}

function inferCommandCwd(command: string, defaultCwd?: string): string {
	return inferCommandCwdInfo(command, defaultCwd).cwd;
}

function isGitExecutableWord(word: string): boolean {
	return path.basename(word) === "git";
}

function isShellSeparatorWord(word: string): boolean {
	return word === "&&" || word === ";" || word === "||" || word === "|";
}

function findGitCommandIndex(words: string[]): number {
	if (words[0] && isGitExecutableWord(words[0])) return 0;

	const wrappedCommandIndex = envWrappedCommandIndex(words);
	const wrappedCommand = wrappedCommandIndex === undefined ? undefined : words[wrappedCommandIndex];
	if (wrappedCommand && isGitExecutableWord(wrappedCommand)) return wrappedCommandIndex ?? -1;

	const separatorCommandIndex = words.findIndex((word, index) => {
		const previousWord = words[index - 1];
		return Boolean(word && previousWord && index > 0 && isShellSeparatorWord(previousWord) && isGitExecutableWord(word));
	});
	return separatorCommandIndex;
}

function inferExplicitGitCwd(command: string, defaultCwd: string): string | undefined {
	const words = shellWords(command);
	const gitIndex = findGitCommandIndex(words);
	if (gitIndex === -1) return undefined;
	const cwdOptionIndex = words.findIndex((word, index) => index > gitIndex && word === "-C");
	const gitCwd = cwdOptionIndex === -1 ? undefined : words[cwdOptionIndex + 1];
	return gitCwd ? normalizeFsPath(gitCwd, defaultCwd) : undefined;
}

function isPathInsideOrEqual(targetPath: string, rootPath: string): boolean {
	const resolvedTarget = realpathExistingOrParent(targetPath);
	const resolvedRoot = realpathExistingOrParent(rootPath);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function isWorkflowStateNonTerminal(workflowState: WorkflowStateSnapshot): boolean {
	const bdStatus = workflowState.bdStatus;
	if (bdStatus) return !TERMINAL_BD_STATUSES.has(bdStatus);
	const state = workflowState.state ?? "idle";
	return NON_TERMINAL_WORKFLOW_STATES.has(state);
}

function hasWorktreeLockOwnershipEvidence(workflowState: WorkflowStateSnapshot): boolean {
	if (!workflowState.activeBead) return false;
	if (workflowState.runtimeOwnerKey && workflowState.runtimeOwnerKey === currentRuntimeOwnerKey()) return true;
	if (workflowState.sessionKey) return true;
	if (workflowState.planApproved === true || workflowState.planApproved === "true") return true;
	return false;
}

function hasActiveWorktreeLockRequirement(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(
		workflowState.activeBead &&
		isWorkflowStateNonTerminal(workflowState) &&
		hasWorktreeLockOwnershipEvidence(workflowState) &&
		(workflowState.worktreePath || workflowState.branch),
	);
}

function hasActiveWorktreeLock(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(workflowState.worktreePath && hasActiveWorktreeLockRequirement(workflowState));
}

function commandHasTestOrGateOperation(command: string): boolean {
	const shellWord = String.raw`(?:"[^"]+"|'[^']+'|\S+)`;
	const optionalPnpmPathOptions = String.raw`(?:(?:--dir|-C)(?:\s+|=)${shellWord}\s+)*`;
	const optionalNpxPathOptions = String.raw`(?:(?:--prefix)(?:\s+|=)${shellWord}\s+)*`;
	const gatePattern = new RegExp(
		String.raw`(^|[;&|]\s*)(?:pnpm\s+${optionalPnpmPathOptions}(?:test|exec\s+vitest|vitest|tauri:dev|build)|npm\s+(?:test|run\s+(?:test|build|typecheck))|npx\s+${optionalNpxPathOptions}vue-tsc\b|cargo\s+(?:check|test|build)|make\s+(?:test|check)|just\s+(?:test|check))\b`,
	);
	return gatePattern.test(command);
}

function commandRequiresActiveWorktreeCwd(command: string, processCwd: string): boolean {
	return (
		commandHasMutatingBd(command) ||
		commandHasMutatingGitOrFs(command) ||
		commandHasTestOrGateOperation(command) ||
		commandHasRepoContainedRedirection(command, processCwd) ||
		hasAmbiguousEnvShellCommand(command) ||
		hasAmbiguousLeadingCdShellCommand(command) ||
		hasDirectShellCommand(command)
	);
}

function activeWorktreeCwdDecision(command: string, processCwd: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	if (!commandRequiresActiveWorktreeCwd(command, processCwd)) return undefined;
	const required = workflowState.worktreePath;
	if (!required) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} имеет WORKTREE_LOCK, но recorded worktree path отсутствует. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover перед изменениями.`,
		};
	}
	if (!fs.existsSync(required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} привязан к отсутствующему worktree ${required}. Пересоздай worktree, используй workflow_reset для stale state или явно подтверди takeover перед изменениями.`,
		};
	}
	if (hasAmbiguousEnvShellCommand(command)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK. env -C with shell operators, command substitution, unsupported env options, or shell -c is ambiguous and remains fail-closed; run the command directly from cwd ${required} or use a supported single-command env -C form.`,
		};
	}
	if (hasAmbiguousLeadingCdShellCommand(command)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK. leading cd with shell operators, command substitution, or shell -c is ambiguous and remains fail-closed; run the command directly from cwd ${required} or use a supported single-command leading cd form.`,
		};
	}
	if (hasDirectShellCommand(command)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Blocked: active bead ${workflowState.activeBead} has WORKTREE_LOCK. shell -c is ambiguous and remains fail-closed; run the command directly from cwd ${required} or use supported env -C/leading cd single-command forms.`,
		};
	}
	const effectiveCwdInfo = inferCommandCwdInfo(command, processCwd);
	const effectiveCwd = effectiveCwdInfo.cwd;
	const explicitGitCwd = inferExplicitGitCwd(command, effectiveCwd);
	const cwdCandidates = effectiveCwdInfo.explicit ? [effectiveCwd, explicitGitCwd] : [processCwd, effectiveCwd, explicitGitCwd];
	const outsideCwd = cwdCandidates.filter(Boolean).find((cwd) => !isPathInsideOrEqual(String(cwd), required));
	if (outsideCwd) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} имеет WORKTREE_LOCK. Запускай изменяющие commands, tests, bd writes и git operations с cwd ${required} или внутри него; current/effective cwd: ${outsideCwd}. Проверка без изменений из main разрешена.`,
		};
	}
	const expectedBranch = workflowState.branch;
	const actualBranch = getCurrentBranch(required);
	if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} привязан к branch ${expectedBranch}, но worktree ${required} находится на ${actualBranch}. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover перед изменениями.`,
		};
	}
	return undefined;
}

function activeWorktreePathDecision(toolName: string, targetPath: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if ((toolName !== "edit" && toolName !== "write") || !hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	const required = workflowState.worktreePath;
	if (!required) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} имеет WORKTREE_LOCK, но recorded worktree path отсутствует. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover перед edit/write.`,
		};
	}
	if (!fs.existsSync(required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} привязан к отсутствующему worktree ${required}. Пересоздай worktree, используй workflow_reset для stale state или явно подтверди takeover перед edit/write.`,
		};
	}
	const resolvedTarget = normalizeFsPath(targetPath);
	if (!isPathInsideOrEqual(resolvedTarget, required)) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: edit/write для active bead ${workflowState.activeBead} должен указывать на ${required} или path внутри него; target: ${targetPath}.`,
		};
	}
	const expectedBranch = workflowState.branch;
	const actualBranch = getCurrentBranch(required);
	if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: `Заблокировано: активный bead ${workflowState.activeBead} привязан к branch ${expectedBranch}, но worktree ${required} находится на ${actualBranch}. Используй workflow_reset для stale state, пересоздай worktree или явно подтверди takeover перед edit/write.`,
		};
	}
	return undefined;
}

function requiredToolCwdDecision(toolName: string, input: Record<string, unknown>, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!hasActiveWorktreeLockRequirement(workflowState)) return undefined;
	const canonicalToolName = ["dispatch_supervisor", "dispatch_reviewer", "dispatch_docs_agent", "review_bead"].find((name) => matchesToolName(toolName, name));
	if (!canonicalToolName) return undefined;
	const target = requireTaskToolTarget(canonicalToolName, input, workflowState);
	if (!target.ok) {
		return {
			policy: "enforceActiveWorktreeCwd",
			block: true,
			reason: taskScopeErrorToPolicyReason(target.error, workflowState.activeBead, `запуском ${canonicalToolName}`),
		};
	}
	return undefined;
}

function commandHasGitPush(command: string): boolean {
	return /(^|[;&|]\s*)git\s+push\b/.test(command);
}

function commandAcquiresMergeSlotBeforePush(command: string): boolean {
	const acquireIndex = command.search(/\bbd\s+merge-slot\s+acquire\b/);
	const pushIndex = command.search(/\bgit\s+push\b/);
	return acquireIndex >= 0 && pushIndex >= 0 && acquireIndex < pushIndex;
}

function segmentHasMutatingBdCommand(segment: string): boolean {
	const tokens = shellTokens(segment);
	return tokens.some((token, index) => {
		if (token !== "bd") return false;
		const command = tokens[index + 1];
		const subcommand = tokens[index + 2];
		if (!command) return false;
		if (["create", "new", "update", "close", "reopen", "delete"].includes(command)) return true;
		if (command === "comments" && ["add", "delete", "rm"].includes(subcommand ?? "")) return true;
		if (command === "dep" && ["add", "remove", "rm"].includes(subcommand ?? "")) return true;
		if (command === "merge-slot" && ["acquire", "release"].includes(subcommand ?? "")) return true;
		if (command === "dolt" && ["commit", "push", "pull"].includes(subcommand ?? "")) return true;
		return false;
	});
}

function commandHasMutatingBd(command: string): boolean {
	return shellCommandInspectionParts(command).some((part) => splitShellSegments(part).some(segmentHasMutatingBdCommand));
}

function commandHasBdIssueCreate(command: string): boolean {
	return splitShellSegments(command).some((segment) => segmentHasBdCommand(segment, new Set(["create", "new"])));
}

function segmentHasNonCreateBdMutation(segment: string): boolean {
	const tokens = shellTokens(segment);
	return tokens.some((token, index) => {
		if (token !== "bd") return false;
		const command = tokens[index + 1];
		const subcommand = tokens[index + 2];
		if (!command || command === "create" || command === "new") return false;
		if (["update", "close", "reopen", "delete"].includes(command)) return true;
		if (command === "comments" && ["add", "delete", "rm"].includes(subcommand ?? "")) return true;
		if (command === "dep" && ["add", "remove", "rm"].includes(subcommand ?? "")) return true;
		if (command === "merge-slot" && ["acquire", "release"].includes(subcommand ?? "")) return true;
		if (command === "dolt" && ["commit", "push", "pull"].includes(subcommand ?? "")) return true;
		return false;
	});
}

function commandHasNonCreateBdMutation(command: string): boolean {
	return shellCommandInspectionParts(command).some((part) => splitShellSegments(part).some(segmentHasNonCreateBdMutation));
}

function commandIsTrackerOnlyBdCreate(command: string, cwd: string): boolean {
	return (
		commandHasBdIssueCreate(command) &&
		!commandHasNonCreateBdMutation(command) &&
		!commandHasMutatingGitOrFs(command) &&
		!commandHasRepoContainedRedirection(command, cwd)
	);
}

function segmentHasAnyMutatingBdCommand(segment: string): boolean {
	return /\bbd\s+(create|new|update|close|reopen|delete|comments\s+(add|delete|rm)|dep\s+(add|remove|rm)|merge-slot\s+(acquire|release)|dolt\s+(commit|push|pull))\b/.test(
		segment,
	);
}

function dependencyValueReferencesActiveBead(value: string | undefined, activeBead: string): boolean {
	if (!value) return false;
	return value
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => part === activeBead || part.endsWith(`:${activeBead}`));
}

function createRelationshipReferencesActiveBead(segment: string, activeBead: string): boolean {
	const tokens = shellTokens(segment);
	const createIndex = tokens.findIndex((token, index) => (token === "create" || token === "new") && tokens[index - 1] === "bd");
	if (createIndex < 0) return false;
	for (let index = createIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (token === "--deps" || token === "--parent") {
			if (dependencyValueReferencesActiveBead(tokens[index + 1], activeBead)) return true;
			index += 1;
			continue;
		}
		if (token.startsWith("--deps=") && dependencyValueReferencesActiveBead(token.slice("--deps=".length), activeBead)) return true;
		if (token.startsWith("--parent=") && dependencyValueReferencesActiveBead(token.slice("--parent=".length), activeBead)) return true;
	}
	return false;
}

function segmentHasSelfContainedCreateForActiveBead(segment: string, activeBead: string): boolean {
	if (!segmentHasBdCommand(segment, new Set(["create", "new"]))) return false;
	if (!hasLabel(segment)) return false;
	const hasDescription = /\s(?:--description|-d)(?:\s|=)|\s--body-file(?:\s|=)|\s--stdin\b/.test(segment);
	if (!hasDescription) return false;
	return createRelationshipReferencesActiveBead(segment, activeBead);
}

function segmentHasCommentAddForActiveBead(segment: string, activeBead: string): boolean {
	const tokens = shellTokens(segment);
	const addIndex = tokens.findIndex((token, index) => token === "add" && tokens[index - 1] === "comments" && tokens[index - 2] === "bd");
	return addIndex >= 0 && tokens[addIndex + 1] === activeBead;
}

function segmentHasDepAddInvolvingActiveBead(segment: string, activeBead: string): boolean {
	const tokens = shellTokens(segment);
	const addIndex = tokens.findIndex((token, index) => token === "add" && tokens[index - 1] === "dep" && tokens[index - 2] === "bd");
	if (addIndex >= 0) return tokens[addIndex + 1] === activeBead || tokens[addIndex + 2] === activeBead;
	const depIndex = tokens.findIndex((token, index) => token === "dep" && tokens[index - 1] === "bd");
	if (depIndex < 0) return false;
	const issueId = tokens[depIndex + 1];
	const blocksIndex = tokens.findIndex((token, index) => index > depIndex && (token === "--blocks" || token === "-b"));
	const blocksId = blocksIndex >= 0 ? tokens[blocksIndex + 1] : undefined;
	return issueId === activeBead || blocksId === activeBead;
}

function segmentHasActualMutatingGitOrFs(segment: string): boolean {
	const tokens = shellTokens(segment);
	if (tokens.length === 0) return false;
	const envIndex = envWrappedCommandIndex(tokens);
	const commandIndex = envIndex ?? 0;
	const command = tokens[commandIndex] ?? "";
	if (/^(?:bash|sh|zsh)$/.test(command) && hasShellCommandOption(tokens, commandIndex)) return true;
	if (command === "git" || /\/git$/.test(command)) {
		const subcommandIndex = tokens[commandIndex + 1] === "-C" ? commandIndex + 3 : commandIndex + 1;
		return /^(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)$/.test(tokens[subcommandIndex] ?? "");
	}
	return /^(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)$/.test(command);
}

function commandHasActualMutatingGitOrFs(command: string): boolean {
	return splitShellSegments(command).some(segmentHasActualMutatingGitOrFs);
}

function commandIsDirtySafeBdEvidenceMutation(command: string, workflowState: WorkflowStateSnapshot): boolean {
	const activeBead = workflowState.activeBead;
	if (!activeBead) return false;
	if (!commandHasMutatingBd(command)) return false;
	if (hasUnquotedShellOperator(command)) return false;
	if (hasShellCommandSubstitution(command)) return false;
	if (commandHasActualMutatingGitOrFs(command)) return false;
	const mutatingSegments = splitShellSegments(command).filter(segmentHasAnyMutatingBdCommand);
	if (mutatingSegments.length === 0) return false;
	return mutatingSegments.every(
		(segment) =>
			segmentHasSelfContainedCreateForActiveBead(segment, activeBead) ||
			segmentHasCommentAddForActiveBead(segment, activeBead) ||
			segmentHasDepAddInvolvingActiveBead(segment, activeBead),
	);
}

function commandHasMutatingGitOrFs(command: string): boolean {
	return shellExecutableInspectionParts(command).some((part) =>
		/\b(git\s+(?:-C\s+\S+\s+)?(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(
			part,
		),
	);
}

function maskQuotedShellContent(command: string): string {
	let result = "";
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			result += " ";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			result += " ";
			continue;
		}
		result += char;
	}
	return result;
}

function commandHasMainLocalMutation(command: string): boolean {
	return shellExecutableInspectionParts(command).some((part) => /(^|[;&|]\s*)git\s+(add|stage|commit)\b/.test(part));
}

function commandHasProtectedBranchFsMutation(command: string, cwd: string): boolean {
	return shellExecutableInspectionParts(command).some((part) => /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(part)) || commandHasRepoContainedRedirection(command, cwd);
}

function commandHasRepoContainedRedirection(command: string, cwd: string): boolean {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return false;
	const resolvedRepoRoot = realpathExistingOrParent(repoRoot);
	return shellRedirectionInspectionParts(command).some((part) =>
		extractShellRedirectionTargets(part).some((target) => {
			const resolvedTarget = realpathExistingOrParent(normalizeFsPath(target, cwd));
			return resolvedTarget === resolvedRepoRoot || resolvedTarget.startsWith(`${resolvedRepoRoot}${path.sep}`);
		}),
	);
}

function extractShellRedirectionTargets(command: string): string[] {
	const targets: string[] = [];
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char !== '>') continue;
		if (command[index - 1] === '<') continue;

		let cursor = command[index + 1] === '>' ? index + 2 : index + 1;
		while (/\s/.test(command[cursor] ?? '')) cursor += 1;
		if (command[cursor] === '&') continue;

		const { token, end } = readShellToken(command, cursor);
		if (token) targets.push(stripQuotes(token));
		index = Math.max(index, end - 1);
	}
	return targets;
}

function readShellToken(command: string, start: number): { token: string; end: number } {
	let token = '';
	let quote: '"' | "'" | undefined;
	let index = start;
	for (; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (quote) {
			token += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			token += char;
			continue;
		}
		if (/\s/.test(char) || char === ';' || char === '&' || char === '|') break;
		token += char;
	}
	return { token, end: index };
}

function commandHasCommitLikeOperation(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(commit|rebase|merge|cherry-pick|revert)\b/.test(command);
}

const REQUIRED_HANDOFF_SECTIONS = [
	"### Origin",
	"### Files",
	"### Current state",
	"### Target state",
	"### Investigation findings",
	"### Decisions",
	"### Rejected alternatives",
	"### Dependencies / blockers",
	"### Acceptance criteria",
	"### Verification / acceptance checks",
	"### Out of scope",
];

const VAGUE_ACCEPTANCE_PATTERN = /\b(done|works|fixed|complete|completed|ok|looks good|as expected|готово|работает|исправлено|завершено|нормально)\b/i;

function hasCreateExemption(command: string): boolean {
	return /--type[=\s]epic\b/.test(command) || /\s-t\s+epic\b/.test(command) || /--ephemeral\b|--from-markdown\b|--from-graph\b|--file\b|--body-file\b|--design-file\b/.test(command) || /SKIP_ENRICH_CHECK=1/.test(command);
}

function hasLabel(command: string): boolean {
	return /(?:--label|--labels|-l)(?:=|\s+)\S+/.test(command);
}

function extractSection(command: string, heading: string): string {
	const index = command.indexOf(heading);
	if (index < 0) return "";
	const after = command.slice(index + heading.length);
	const next = after.search(/\s###\s+[A-ZА-Я]/);
	return (next >= 0 ? after.slice(0, next) : after).trim();
}

function hasBullet(section: string): boolean {
	return /(^|\s)([-*]|\d+\.)\s+\S+/.test(section);
}

function isVagueOnly(section: string): boolean {
	const compact = section
		.replace(/(^|\s)([-*]|\d+\.)\s+/g, " ")
		.replace(/[`*_"']/g, "")
		.trim();
	return compact.length > 0 && compact.length < 80 && VAGUE_ACCEPTANCE_PATTERN.test(compact);
}

const COMMON_ENGLISH_PROSE_WORDS = new Set([
	"add",
	"allows",
	"alternative",
	"and",
	"ask",
	"be",
	"bug",
	"check",
	"checks",
	"child",
	"command",
	"complete",
	"completed",
	"concrete",
	"create",
	"current",
	"details",
	"discovered",
	"done",
	"expected",
	"feature",
	"fix",
	"found",
	"from",
	"how",
	"issue",
	"manual",
	"needed",
	"observable",
	"out",
	"reason",
	"request",
	"result",
	"source",
	"state",
	"target",
	"task",
	"the",
	"this",
	"with",
	"work",
	"works",
	"why",
]);

const TECHNICAL_ENGLISH_TOKENS = new Set([
	"api",
	"bd",
	"bead",
	"beads",
	"blocks",
	"cli",
	"ci",
	"css",
	"deps",
	"dolt",
	"dx",
	"epic",
	"frontend",
	"backend",
	"json",
	"jsonl",
	"md",
	"nuxt",
	"pi",
	"rust",
	"tauri",
	"ts",
	"tsx",
	"ui",
	"url",
	"vue",
]);

function stripLocaleExemptText(text: string): string {
	let stripped = text;
	for (const heading of REQUIRED_HANDOFF_SECTIONS) {
		stripped = stripped.replace(new RegExp(escapeRegExp(heading), "gi"), " ");
	}
	return stripped
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\b[a-z0-9_.\/-]+\.(ts|tsx|vue|rs|js|json|jsonl|md|sh|css)\b/gi, " ")
		.replace(/\b(parent-child|discovered-from|blocks):[\w.-]+\b/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/--?[\w-]+(?:=\S+)?/g, " ");
}

function localeEvidence(text: string): { cyrillic: number; latinProse: number; commonEnglish: number } {
	const stripped = stripLocaleExemptText(text);
	const cyrillic = stripped.match(/[А-Яа-яЁё]/g)?.length ?? 0;
	const latinWords = stripped.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
	const proseWords = latinWords
		.map((word) => word.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
		.filter((word) => word.length >= 3)
		.filter((word) => !TECHNICAL_ENGLISH_TOKENS.has(word))
		.filter((word) => !/^[a-z]+\d+$/.test(word));
	const commonEnglish = proseWords.filter((word) => COMMON_ENGLISH_PROSE_WORDS.has(word)).length;
	return { cyrillic, latinProse: proseWords.length, commonEnglish };
}

function isClearlyEnglishBeadText(text: string, field: "title" | "description"): boolean {
	const evidence = localeEvidence(text);
	if (field === "title") return evidence.cyrillic === 0 && (evidence.commonEnglish >= 1 || evidence.latinProse >= 2);
	return evidence.cyrillic < 10 && (evidence.commonEnglish >= 3 || evidence.latinProse >= 8);
}

function valueAfterFlag(segment: string, flags: string[]): string | undefined {
	for (const flag of flags) {
		const escaped = escapeRegExp(flag);
		const quoted = segment.match(new RegExp(`${escaped}(?:=|\\s+)(["'])([\\s\\S]*?)\\1`));
		if (quoted?.[2]) return quoted[2];
		const unquoted = segment.match(new RegExp(`${escaped}=([^\\s;&|]+)|${escaped}\\s+([^\\s;&|]+)`));
		const value = unquoted?.[1] ?? unquoted?.[2];
		if (value) return value;
	}
	return undefined;
}

function parseBdCreateTitle(segment: string): string | undefined {
	const explicit = valueAfterFlag(segment, ["--title"]);
	if (explicit) return explicit;
	const tokens = shellTokens(segment);
	const createIndex = tokens.findIndex((token, index) => (token === "create" || token === "new") && tokens[index - 1] === "bd");
	if (createIndex < 0) return undefined;
	const valueFlags = new Set(["--priority", "-p", "--description", "-d", "--type", "-t", "--label", "--labels", "-l", "--deps", "--parent"]);
	for (let index = createIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (valueFlags.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("--") && token.includes("=")) continue;
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function getBeadLocaleError(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const isCreate = segmentHasBdCommand(segment, new Set(["create", "new"]));
		const isUpdate = segmentHasBdCommand(segment, new Set(["update"]));
		if (!isCreate && !isUpdate) continue;

		const title = isCreate ? parseBdCreateTitle(segment) : valueAfterFlag(segment, ["--title"]);
		if (title && isClearlyEnglishBeadText(title, "title")) {
			return "Заблокировано: bead title явно на английском. Перепиши title на русском для Максима; technical identifiers (имена файлов, commands, labels, API names) оставляй без перевода. Перед повтором используй `.pi/skills/create-bead/SKILL.md`.";
		}

		const description = valueAfterFlag(segment, ["--description", "-d"]);
		if (description && isClearlyEnglishBeadText(description, "description")) {
			return "Заблокировано: bead description явно на английском. Пиши bead descriptions на русском для Максима, сохраняя required section headings и technical identifiers.";
		}
	}
	return undefined;
}

function hasHiddenBeadDescription(segment: string): boolean {
	const description = valueAfterFlag(segment, ["--description", "-d"]);
	if (!description) return false;
	const trimmed = description.trim();
	if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return true;
	if (/^`[\s\S]*`$/.test(trimmed)) return true;
	if (/\$\((?!cat\s+<<)[\s\S]*\)/.test(trimmed)) return true;
	if (/\$\(cat\s+(?:\/tmp\/|[^<][^)]*)\)/.test(trimmed)) return true;
	return false;
}

function getBeadEnrichmentError(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		if (!segmentHasBdCommand(segment, new Set(["create", "new"]))) continue;
		if (hasCreateExemption(segment)) continue;

		const missing = REQUIRED_HANDOFF_SECTIONS.filter((section) => !segment.includes(section));
		if (missing.length > 0) {
			if (hasHiddenBeadDescription(segment)) {
				return "Заблокировано: `bd create` description скрыт от guard (например `$BUG_DESC`, `$(cat /tmp/...)`, backticks или wrapper). Pi проверяет shell-команду до выполнения и не видит hidden content. Используй `.pi/skills/create-bead/SKILL.md` и inline heredoc прямо внутри `--description \"$(cat <<'EOF' ... EOF)\"`, чтобы все required `### ...` sections были видимы.";
			}
			return `Заблокировано: agent-created beads требуют self-contained handoff template. Отсутствует: ${missing.join(", ")}. Минимальное исправление: открой \`.pi/skills/create-bead/SKILL.md\`, повтори mandatory checklist и создай bead через inline heredoc внутри --description со всеми required ### sections, русским content, type/priority/label/deps и concrete acceptance/verification bullets. Если context или acceptance неясны, задай пользователю один вопрос с 2-4 вариантами перед созданием bead.`;
		}

		if (!hasLabel(segment)) {
			return "Заблокировано: agent-created beads требуют минимум один label через --label/--labels/-l, чтобы future sessions могли маршрутизировать work.";
		}

		const acceptance = extractSection(segment, "### Acceptance criteria");
		const verification = extractSection(segment, "### Verification / acceptance checks");
		if (!hasBullet(acceptance) || !hasBullet(verification)) {
			return "Заблокировано: Acceptance criteria и Verification / acceptance checks должны содержать конкретные bullet checks. Если неясно, спроси пользователя с 2-4 вариантами перед созданием bead.";
		}
		if (isVagueOnly(acceptance) || isVagueOnly(verification)) {
			return "Заблокировано: acceptance/verification слишком расплывчаты. Задай конкретный вопрос с 2-4 proposed acceptance options перед созданием bead.";
		}
	}

	return undefined;
}

function segmentHasBdCommand(segment: string, commands: Set<string>): boolean {
	const tokens = shellTokens(segment);
	return tokens.some((token, index) => token === "bd" && commands.has(tokens[index + 1] ?? ""));
}

function shellTokens(input: string): string[] {
	return input.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(stripQuotes) ?? [];
}

function shellCommandInspectionParts(command: string): string[] {
	const parts: string[] = [];
	const queue = [command];
	const seen = new Set<string>();
	while (queue.length > 0 && parts.length < 100) {
		const part = queue.shift() ?? "";
		if (!part || seen.has(part)) continue;
		seen.add(part);
		parts.push(part);
		const inspectablePart = maskHeredocBodies(part);
		for (const nested of [...extractCommandSubstitutions(inspectablePart), ...extractShellInterpreterCommandBodies(inspectablePart)]) {
			if (nested && !seen.has(nested)) queue.push(nested);
		}
	}
	return parts;
}

function extractShellInterpreterCommandBodies(command: string): string[] {
	const bodies: string[] = [];
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token || !isShellInterpreterWord(token)) continue;
			let cursor = index + 1;
			while (cursor < tokens.length) {
				const option = tokens[cursor];
				if (!option) break;
				if (option === "--") {
					cursor += 1;
					continue;
				}
				if (option.startsWith("-") && option !== "-") {
					const flags = option.replace(/^-+/, "");
					if (flags.includes("c")) {
						const body = tokens[cursor + 1];
						if (body) bodies.push(body);
						break;
					}
					cursor += shellInterpreterOptionConsumesArgument(option) ? 2 : 1;
					continue;
				}
				break;
			}
		}
	}
	return bodies;
}

function isShellInterpreterWord(word: string): boolean {
	const command = path.basename(word);
	return ["bash", "sh", "zsh", "fish", "dash", "ksh"].includes(command);
}

function shellInterpreterOptionConsumesArgument(option: string): boolean {
	return ["-o", "+o", "-O", "+O", "--init-file", "--rcfile"].includes(option);
}

function shellExecutableInspectionParts(command: string): string[] {
	return shellCommandInspectionParts(command).map(maskHeredocBodies).map(maskQuotedShellContent);
}

function shellRedirectionInspectionParts(command: string): string[] {
	return shellCommandInspectionParts(command).map(maskHeredocBodies);
}

function maskHeredocBodies(command: string): string {
	const lines = command.split(/(\n)/);
	let result = "";
	let heredocDelimiter: string | undefined;
	for (let index = 0; index < lines.length; index += 2) {
		const line = lines[index] ?? "";
		const newline = lines[index + 1] ?? "";
		if (heredocDelimiter) {
			if (line.trim() === heredocDelimiter) {
				heredocDelimiter = undefined;
				result += line + newline;
			} else {
				result += " ".repeat(line.length) + newline;
			}
			continue;
		}
		const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (match?.[2]) heredocDelimiter = match[2];
		result += line + newline;
	}
	return maskNormalizedQuotedHeredocBodies(result);
}

function maskNormalizedQuotedHeredocBodies(command: string): string {
	return command.replace(/(<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(\s+\3)(?=\s|["')]|$)/g, (_match, opener: string, _quote: string, _delimiter: string, body: string, closer: string) => {
		return `${opener}${" ".repeat(body.length)}${closer}`;
	});
}

function extractCommandSubstitutions(command: string): string[] {
	const parts: string[] = [];
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote === "'") {
			if (char === quote) quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (char === quote) {
				quote = undefined;
				continue;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "`") {
			const end = findBacktickCommandSubstitutionEnd(command, index + 1);
			if (end === undefined) continue;
			const body = command.slice(index + 1, end);
			const inspectableBody = maskHeredocBodies(body);
			parts.push(inspectableBody, ...extractCommandSubstitutions(inspectableBody));
			index = end;
			continue;
		}
		if (char !== "$" || command[index + 1] !== "(") continue;
		const end = findCommandSubstitutionEnd(command, index + 2);
		if (end === undefined) continue;
		const body = command.slice(index + 2, end);
		const inspectableBody = maskHeredocBodies(body);
		parts.push(inspectableBody, ...extractCommandSubstitutions(inspectableBody));
		index = end;
	}
	return parts;
}

function findCommandSubstitutionEnd(command: string, start: number): number | undefined {
	let quote: '"' | "'" | undefined;
	let depth = 1;
	for (let index = start; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") {
			depth += 1;
			index += 1;
			continue;
		}
		if (char !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
	}
	return undefined;
}

function findBacktickCommandSubstitutionEnd(command: string, start: number): number | undefined {
	for (let index = start; index < command.length; index += 1) {
		const char = command[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "`") return index;
	}
	return undefined;
}

function parseBdUpdateStatus(command: string): { id: string; status: string } | undefined {
	const valueFlags = new Set([
		"--priority",
		"-p",
		"--assignee",
		"-a",
		"--description",
		"-d",
		"--title",
		"--type",
		"-t",
		"--label",
		"--labels",
		"--add-label",
		"--remove-label",
		"--set-labels",
		"--deps",
		"--reason",
	]);
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		const updateIndex = tokens.findIndex((token, index) => token === "update" && tokens[index - 1] === "bd");
		if (updateIndex < 0) continue;
		let id: string | undefined;
		let status: string | undefined;
		for (let index = updateIndex + 1; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token === "--status" || token === "-s") {
				status = stripQuotes(tokens[index + 1] ?? "");
				index += 1;
				continue;
			}
			if (token.startsWith("--status=")) {
				status = stripQuotes(token.slice("--status=".length));
				continue;
			}
			if (token.startsWith("-s=")) {
				status = stripQuotes(token.slice("-s=".length));
				continue;
			}
			if (valueFlags.has(token)) {
				index += 1;
				continue;
			}
			if (token.startsWith("--") && token.includes("=")) continue;
			if (token.startsWith("-")) continue;
			id = id ?? token;
		}
		if (id && status) return { id, status };
	}
	return undefined;
}

function reviewCheckpointTransition(command: string): { id: string; status: string } | undefined {
	const parsed = parseBdUpdateStatus(command);
	return parsed && /^(simplified|reviewed|accepted)$/.test(parsed.status) ? parsed : undefined;
}

function normalizeStatusValue(value: string | undefined): string | undefined {
	return value ? stripQuotes(value).toLowerCase() : undefined;
}

function directTerminalTransition(command: string): { id: string; status: string } | undefined {
	const parsed = parseBdUpdateStatus(command);
	const status = normalizeStatusValue(parsed?.status);
	if (!parsed || !status || !TERMINAL_BD_STATUSES.has(status)) return undefined;
	return { ...parsed, status };
}

function directClosedTransition(command: string): { id: string; status: string } | undefined {
	const parsed = directTerminalTransition(command);
	if (!parsed || parsed.status !== "closed") return undefined;
	return parsed;
}

function closeCommandId(command: string): string | undefined {
	const valueFlags = new Set(["--reason", "--actor", "--db", "--dolt-auto-commit"]);
	for (const segment of splitShellSegments(command)) {
		const tokens = shellTokens(segment);
		const closeIndex = tokens.findIndex((token, index) => token === "close" && tokens[index - 1] === "bd");
		if (closeIndex < 0) continue;
		const ids: string[] = [];
		for (let index = closeIndex + 1; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (valueFlags.has(token)) { index += 1; continue; }
			if (token.startsWith("--") && token.includes("=")) continue;
			if (token.startsWith("-")) continue;
			ids.push(token);
		}
		if (ids.length === 1) return ids[0];
	}
	return undefined;
}

function commandHasReviewCheckpointTransition(command: string): boolean {
	return Boolean(reviewCheckpointTransition(command));
}

function parseBdClaimId(command: string): string | undefined {
	for (const part of shellCommandInspectionParts(command)) {
		for (const segment of splitShellSegments(part)) {
			const tokens = shellTokens(segment);
			const updateIndex = tokens.findIndex((token, index) => token === "update" && tokens[index - 1] === "bd");
			if (updateIndex < 0) continue;
			let id: string | undefined;
			let hasClaim = false;
			for (let index = updateIndex + 1; index < tokens.length; index += 1) {
				const token = tokens[index];
				if (!token) continue;
				if (token === "--claim") {
					hasClaim = true;
					continue;
				}
				if (token.startsWith("-")) continue;
				id = id ?? token;
			}
			if (id && hasClaim) return id;
		}
	}
	return undefined;
}

function parseWorkflowCommandBead(command: string): string | undefined {
	return command.match(/\/(?:workflow-claim|workflow-set-bead)\s+(\S+)/)?.[1] ?? command.match(/\/workflow-update\b[^;&|]*\bbead=(\S+)/)?.[1];
}

function commandStartsDifferentBead(command: string): string | undefined {
	return parseBdClaimId(command) ?? parseWorkflowCommandBead(command);
}

function commandDispatchesBead(command: string): string | undefined {
	return command.match(/\bdispatch_supervisor\s*\(\s*beadId\s*=\s*([^\s,)]+)/)?.[1] ?? command.match(/\bdispatch_supervisor\b[^;&|]*\bbeadId=(\S+)/)?.[1];
}

function commandReviewsBead(command: string): string | undefined {
	return command.match(/\breview_bead\s*\(\s*beadId\s*=\s*([^\s,)]+)/)?.[1] ?? command.match(/\/review-bead\s+(\S+)/)?.[1];
}

export function activeBeadLifecycleReason(targetBead: string | undefined, action: string, workflowState: WorkflowStateSnapshot): string | undefined {
	const activeBead = workflowState.activeBead;
	const bdStatus = workflowState.bdStatus;
	const legacyState = workflowState.state ?? "idle";
	if (!activeBead) return undefined;
	if (targetBead && targetBead === activeBead) return undefined;

	if (bdStatus) {
		if (TERMINAL_BD_STATUSES.has(bdStatus)) return undefined;
		const label = NON_TERMINAL_BD_STATUSES.has(bdStatus) ? bdStatus : `unknown bd status ${bdStatus}`;
		if (bdStatus === "inreview") return `Заблокировано: активный bead ${activeBead} имеет bd:${bdStatus}; после подтверждения current-session branch/worktree ownership следующее допустимое действие — review-bead / review_bead для ${activeBead}, а не ${action}${targetBead ? ` на ${targetBead}` : ""}. Если ownership stale или foreign, agents могут вызвать workflow_reset; /workflow-reset — только optional human UI shortcut.`;
		return `Заблокировано: активный bead ${activeBead} не terminal (bd:${label}). Доведи его до closed, переведи в blocked/deferred с explicit reason, передай handoff или вызови workflow_reset, если это stale/foreign state, перед ${action}${targetBead ? ` на ${targetBead}` : ""}. /workflow-reset — optional human UI shortcut.`;
	}

	if (TERMINAL_WORKFLOW_STATES.has(legacyState)) return undefined;
	if (!NON_TERMINAL_WORKFLOW_STATES.has(legacyState)) return undefined;
	if (legacyState === "inreview") return `Заблокировано: активный bead ${activeBead} имеет inreview; после подтверждения current-session branch/worktree ownership следующее допустимое действие — review-bead / review_bead для ${activeBead}, а не ${action}${targetBead ? ` на ${targetBead}` : ""}. Если ownership stale или foreign, agents могут вызвать workflow_reset; /workflow-reset — только optional human UI shortcut.`;
	return `Заблокировано: активный bead ${activeBead} не terminal (${legacyState}). Доведи его до closed, переведи в blocked/deferred с explicit reason, передай handoff или вызови workflow_reset, если это stale/foreign state, перед ${action}${targetBead ? ` на ${targetBead}` : ""}. /workflow-reset — optional human UI shortcut.`;
}

function activeBeadLifecycleDecision(targetBead: string | undefined, action: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	const reason = activeBeadLifecycleReason(targetBead, action, workflowState);
	return reason ? { policy: "enforceActiveBeadLifecycle", block: true, reason } : undefined;
}

function commandDirectlySetsClosed(command: string): boolean {
	return Boolean(directClosedTransition(command));
}

function commandClosesBead(command: string): boolean {
	return Boolean(closeCommandId(command));
}

interface BdIssueSummary {
	id?: string;
	status?: string;
	issue_type?: string;
	title?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

interface BdMergeSlotIssue extends BdIssueSummary {
	metadata?: {
		holder?: unknown;
		waiters?: unknown;
		[key: string]: unknown;
	};
}

function parseBdJson(raw: string): any {
	const parsed = JSON.parse(raw);
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

function getBdIssue(cwd: string, id: string): BdIssueSummary | undefined {
	try {
		const raw = execFileSync("bd", ["show", id, "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return parseBdJson(raw);
	} catch {
		return undefined;
	}
}

function getCurrentActor(cwd: string, override?: string): string | undefined {
	const actor = override ?? process.env.BEADS_ACTOR ?? runGit(cwd, ["config", "user.name"]) ?? process.env.USER;
	return actor?.trim() || undefined;
}

function getBdMergeSlotIssue(cwd: string): BdMergeSlotIssue | undefined {
	return getBdIssue(cwd, "beads-task-issue-tracker-merge-slot") as BdMergeSlotIssue | undefined;
}

function currentActorHoldsBdMergeSlot(cwd: string, options: BashPolicyOptions): boolean {
	const actor = getCurrentActor(cwd, options.currentActor);
	if (!actor) return false;
	const issue = options.bdMergeSlotIssue === undefined ? getBdMergeSlotIssue(cwd) : options.bdMergeSlotIssue;
	if (!issue || issue.status !== "in_progress") return false;
	return typeof issue.metadata?.holder === "string" && issue.metadata.holder.trim() === actor;
}

function getEpicChildren(cwd: string, id: string): BdIssueSummary[] | undefined {
	try {
		const raw = execFileSync("bd", ["list", "--parent", id, "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return undefined;
	}
}

function getBdCommentsText(cwd: string, id: string): string {
	try {
		return execFileSync("bd", ["comments", id], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function validateReviewTransitionForCommand(command: string, cwd: string): string | undefined {
	const transition = reviewCheckpointTransition(command);
	if (!transition) return undefined;
	const issue = getBdIssue(cwd, transition.id);
	const from = issue?.status;
	const comments = getBdCommentsText(cwd, transition.id);
	if (transition.status === "simplified" && from !== "inreview") return `simplified требует source status inreview, получен ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && from !== "simplified") return `reviewed требует source status simplified, получен ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && !/CODE REVIEW:\s*APPROVED|VERDICT:\s*APPROVED/i.test(comments)) return "reviewed требует evidence CODE REVIEW: APPROVED или VERDICT: APPROVED";
	if (transition.status === "accepted" && from !== "reviewed") return `accepted требует source status reviewed, получен ${from ?? "unknown"}`;
	if (transition.status === "accepted" && !/ACCEPTANCE|Acceptance evidence|human acceptance/i.test(comments)) return "accepted требует acceptance evidence";
	return undefined;
}

function terminalCloseId(command: string): string | undefined {
	return directClosedTransition(command)?.id ?? closeCommandId(command);
}

function incompleteEpicChildren(cwd: string, id: string): BdIssueSummary[] | undefined {
	const issue = getBdIssue(cwd, id);
	if (issue?.issue_type !== "epic") return undefined;
	const children = getEpicChildren(cwd, id);
	if (!children) return [];
	const incomplete = children.filter((child) => child.id !== id && child.status !== "closed");
	return incomplete.length > 0 ? incomplete : undefined;
}

function formatIncompleteChildren(children: BdIssueSummary[]): string {
	if (children.length === 0) return "unable to read child list";
	return children
		.slice(0, 5)
		.map((child) => `${child.id ?? "unknown"}:${child.status ?? "unknown"}`)
		.join(", ");
}

function getBdComments(cwd: string, id: string): Array<{ text?: string; created_at?: string }> | undefined {
	try {
		const raw = execFileSync("bd", ["comments", id, "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return undefined;
	}
}

function getParentChildDeps(cwd: string, id: string): Array<{ id?: string; dependency_id?: string; depends_on_id?: string; dependency_type?: string; type?: string }> | undefined {
	try {
		const raw = execFileSync("bd", ["dep", "list", id, "--type", "parent-child", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return undefined;
	}
}

function latestCommentMatching(comments: Array<{ text?: string; created_at?: string }>, predicate: (text: string) => boolean): string | undefined {
	return comments
		.map((comment, index) => ({ text: String(comment.text ?? ""), index, time: Date.parse(String(comment.created_at ?? "")) }))
		.filter((entry) => entry.text && predicate(entry.text))
		.sort((a, b) => {
			const at = Number.isFinite(a.time) ? a.time : Number.NEGATIVE_INFINITY;
			const bt = Number.isFinite(b.time) ? b.time : Number.NEGATIVE_INFINITY;
			return at - bt || a.index - b.index;
		})
		.at(-1)?.text;
}

function issueStatus(issue: BdIssueSummary): string | undefined {
	return typeof issue.status === "string" ? issue.status : undefined;
}

function isKnownBdStatus(status: string | undefined): boolean {
	return Boolean(status && (TERMINAL_BD_STATUSES.has(status) || NON_TERMINAL_BD_STATUSES.has(status)));
}

function statusSnapshot(children: BdIssueSummary[]): string | undefined {
	const pairs: string[] = [];
	for (const child of children) {
		if (!child.id || !isKnownBdStatus(child.status)) return undefined;
		pairs.push(`${child.id}=${child.status}`);
	}
	return pairs.sort().join(",");
}

function markerHasLine(text: string, key: string, value: string): boolean {
	return new RegExp(`^${key}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(text);
}

function hasValidParentHandoff(text: string, epicId: string, childId: string, targetStatus: string): boolean {
	return text.includes("EPIC HANDOFF")
		&& markerHasLine(text, "PARENT_EPIC", epicId)
		&& markerHasLine(text, "TERMINAL_CHILD", childId)
		&& markerHasLine(text, "TARGET_TERMINAL_STATUS", targetStatus)
		&& /^REASON:\s*\S+/m.test(text)
		&& /^NEXT_ACTION:\s*\S+/m.test(text);
}

function hasValidChildSweep(text: string, epicId: string, childId: string, targetStatus: string, snapshot: string): boolean {
	return text.includes("PARENT EPIC SWEEP")
		&& markerHasLine(text, "PARENT_EPIC", epicId)
		&& markerHasLine(text, "TERMINAL_CHILD", childId)
		&& markerHasLine(text, "TARGET_TERMINAL_STATUS", targetStatus)
		&& markerHasLine(text, "REQUIRED_CHILDREN_STATUS", snapshot)
		&& /^NEXT_ACTION:\s*(?:finalize-epic|epic-handoff)\s*$/m.test(text);
}

function hasValidEpicAcceptanceMatrix(text: string, epicId: string): boolean {
	if (!text.includes("EPIC ACCEPTANCE MATRIX") || !markerHasLine(text, "PARENT_EPIC", epicId)) return false;
	const results = Array.from(text.matchAll(/^\s*result:\s*(.+?)\s*$/gim), (match) => match[1]?.trim().toUpperCase());
	return results.length > 0 && results.every((result) => result === "PASS" || result === "N/A");
}

function parentIdsFromChild(cwd: string, childId: string): string[] | undefined {
	const deps = getParentChildDeps(cwd, childId);
	if (deps === undefined) return undefined;
	const ids = new Set<string>();
	for (const dep of deps) {
		const candidate = dep.dependency_id ?? dep.depends_on_id ?? dep.id;
		if (typeof candidate === "string" && candidate !== childId) ids.add(candidate);
	}
	if (ids.size === 0) {
		const child = getBdIssue(cwd, childId) as (BdIssueSummary & { dependencies?: Array<{ id?: string; dependency_type?: string }> }) | undefined;
		for (const dep of child?.dependencies ?? []) {
			if (dep.dependency_type === "parent-child" && dep.id) ids.add(dep.id);
		}
	}
	return Array.from(ids);
}

function validateLastChildEpicSweep(cwd: string, childId: string, targetStatus: string): string | undefined {
	const parentIds = parentIdsFromChild(cwd, childId);
	if (parentIds === undefined) return `Заблокировано: не удалось прочитать parent-child связи для ${childId}; нужен PARENT EPIC SWEEP / EPIC HANDOFF или исправление bd relationship lookup.`;
	for (const parentId of parentIds) {
		const parent = getBdIssue(cwd, parentId);
		if (!parent || parent.issue_type !== "epic" || !isKnownBdStatus(parent.status)) return `Заблокировано: не удалось подтвердить parent epic/status для ${parentId}.`;
		if (TERMINAL_BD_STATUSES.has(parent.status!)) continue;
		const children = getEpicChildren(cwd, parentId);
		if (!children) return `Заблокировано: не удалось прочитать children epic ${parentId}.`;
		const matching = children.filter((child) => child.id === childId);
		if (matching.length !== 1 || !isKnownBdStatus(matching[0]?.status)) return `Заблокировано: epic ${parentId} snapshot не содержит target child ${childId} ровно один раз с known status.`;
		const siblings = children.filter((child) => child.id !== childId);
		if (siblings.some((child) => !isKnownBdStatus(child.status))) return `Заблокировано: epic ${parentId} содержит child с unknown status; невозможно безопасно определить last-child.`;
		if (siblings.some((child) => !TERMINAL_BD_STATUSES.has(child.status!))) continue;
		const snapshot = statusSnapshot(children);
		if (!snapshot) return `Заблокировано: не удалось построить REQUIRED_CHILDREN_STATUS для epic ${parentId}.`;
		const childComments = getBdComments(cwd, childId);
		const parentComments = getBdComments(cwd, parentId);
		if (!childComments || !parentComments) return `Заблокировано: не удалось прочитать comments для parent epic sweep (${childId}, ${parentId}).`;
		const childMarker = latestCommentMatching(childComments, (text) => text.includes("PARENT EPIC SWEEP") && markerHasLine(text, "PARENT_EPIC", parentId));
		const parentMarker = latestCommentMatching(parentComments, (text) => text.includes("EPIC HANDOFF") && markerHasLine(text, "PARENT_EPIC", parentId));
		if (!childMarker || !hasValidChildSweep(childMarker, parentId, childId, targetStatus, snapshot) || !parentMarker || !hasValidParentHandoff(parentMarker, parentId, childId, targetStatus)) {
			return `Заблокировано: last child ${childId} для epic ${parentId} требует свежие PARENT EPIC SWEEP и EPIC HANDOFF перед terminalization.`;
		}
	}
	return undefined;
}

function validateEpicCloseMatrix(cwd: string, id: string): string | undefined {
	const issue = getBdIssue(cwd, id);
	if (issue?.issue_type !== "epic") return undefined;
	const children = getEpicChildren(cwd, id);
	if (!children) return `Заблокировано: не удалось прочитать children epic ${id} для EPIC ACCEPTANCE MATRIX.`;
	if (children.some((child) => child.id !== id && child.status !== "closed")) return undefined;
	const comments = getBdComments(cwd, id);
	if (!comments) return `Заблокировано: не удалось прочитать comments epic ${id} для EPIC ACCEPTANCE MATRIX.`;
	const matrix = latestCommentMatching(comments, (text) => text.includes("EPIC ACCEPTANCE MATRIX") && markerHasLine(text, "PARENT_EPIC", id));
	if (!matrix || !hasValidEpicAcceptanceMatrix(matrix, id)) return `Заблокировано: epic ${id} требует post-terminal EPIC ACCEPTANCE MATRIX перед close.`;
	return undefined;
}

function canCloseByReviewState(command: string, cwd: string, workflowState: WorkflowStateSnapshot): boolean {
	const id = terminalCloseId(command);
	if (!id) return false;
	const status = workflowState.activeBead === id && workflowState.bdStatus ? workflowState.bdStatus : getBdIssue(cwd, id)?.status;
	const comments = getBdCommentsText(cwd, id);
	return status === "accepted" || (status === "reviewed" && /NO_ACCEPTANCE_REQUIRED|no acceptance criteria/i.test(comments));
}

function descriptionAcceptanceChecks(description?: string): string[] {
	if (!description) return [];
	const sections = [extractSection(description, "### Acceptance criteria"), extractSection(description, "### Verification / acceptance checks")];
	return sections
		.flatMap((section) => section.split(/\r?\n/))
		.map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
		.filter((line) => line.length > 0 && !/^###\s+/.test(line));
}

function latestAcceptanceMatrix(commentsText: string): string | undefined {
	const upper = commentsText.toUpperCase();
	const standardIndex = upper.lastIndexOf("ACCEPTANCE MATRIX:");
	const epicIndex = upper.lastIndexOf("EPIC ACCEPTANCE MATRIX");
	const index = Math.max(standardIndex, epicIndex);
	if (index < 0) return undefined;
	return commentsText.slice(index).trim();
}

function hasValidHumanAcceptanceOverride(commentsText: string): boolean {
	const index = commentsText.toUpperCase().lastIndexOf("HUMAN ACCEPTANCE OVERRIDE");
	if (index < 0) return false;
	const override = commentsText.slice(index);
	return /(?:approver|approved[_ -]?by)\s*:\s*\S+/i.test(override) && /reason\s*:\s*\S+/i.test(override);
}

const ACCEPTANCE_MATRIX_COMMON_WORDS = new Set([
	"acceptance",
	"check",
	"checks",
	"criteria",
	"criterion",
	"evidence",
	"exit",
	"manual",
	"observed",
	"result",
	"should",
	"verification",
	"должен",
	"должна",
	"должно",
	"если",
	"критерий",
	"проверка",
	"результат",
]);

function acceptanceCoverageTokens(value: string): string[] {
	const normalized = value.toLowerCase().replace(/ё/g, "е");
	return Array.from(new Set(normalized.match(/[a-zа-я0-9]+/g) ?? [])).filter((token) => token.length >= 4 && !ACCEPTANCE_MATRIX_COMMON_WORDS.has(token));
}

function matrixCoversCheck(matrixText: string, check: string): boolean {
	const normalizedMatrix = matrixText.toLowerCase().replace(/ё/g, "е");
	const normalizedCheck = check.toLowerCase().replace(/ё/g, "е");
	const highSignalGroups = [
		/(?:runtime|smoke|reload|starts?\/reloads?|pi\s+starts?)/,
		/(?:settings\.json|stable\s+extensions|implemented\/stable)/,
		/(?:child\s+beads|children|дочерн)/,
	];
	for (const group of highSignalGroups) {
		if (group.test(normalizedCheck) && !group.test(normalizedMatrix)) return false;
	}
	const matrixTokens = new Set(acceptanceCoverageTokens(matrixText));
	const checkTokens = acceptanceCoverageTokens(check);
	if (checkTokens.length === 0) return true;
	const matches = checkTokens.filter((token) => matrixTokens.has(token)).length;
	return matches >= Math.min(2, checkTokens.length);
}

const ACCEPTANCE_BLOCKING_RESULTS = /^(?:FAIL|NOT\s+RUN|BLOCKED|SCOPE\s+GAP)\b/i;

function normalizeAcceptanceResultCell(value: string): string {
	return value
		.replace(/[`*_~]/g, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.trim();
}

function acceptanceMatrixStructuredResults(matrixText: string): string[] {
	const matrixWithoutOverride = matrixText.replace(/HUMAN ACCEPTANCE OVERRIDE[\s\S]*$/i, "");
	const results: string[] = [];
	for (const line of matrixWithoutOverride.split(/\r?\n/)) {
		const yamlLike = line.match(/^\s*(?:[-*]\s*)?(?:result|verdict|status)\s*:\s*(.+?)\s*$/i);
		if (yamlLike?.[1]) results.push(normalizeAcceptanceResultCell(yamlLike[1]));
	}
	const tableLines = matrixWithoutOverride.split(/\r?\n/).filter((line) => line.includes("|"));
	for (let index = 0; index < tableLines.length; index += 1) {
		const headerLine = tableLines[index];
		if (!headerLine) continue;
		const headerCells = headerLine.split("|").map((cell) => cell.trim().toLowerCase());
		const resultColumn = headerCells.findIndex((cell) => /^(?:result|verdict|status)$/.test(cell));
		if (resultColumn < 0) continue;
		let rowIndex = index + 1;
		const separatorLine = tableLines[rowIndex];
		if (separatorLine && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separatorLine)) rowIndex += 1;
		for (; rowIndex < tableLines.length; rowIndex += 1) {
			const rowLine = tableLines[rowIndex];
			if (!rowLine) break;
			const cells = rowLine.split("|").map((cell) => cell.trim());
			if (cells.length <= resultColumn) break;
			results.push(normalizeAcceptanceResultCell(cells[resultColumn] ?? ""));
		}
	}
	return results;
}

function acceptanceMatrixHasBlockingResult(matrixText: string): boolean {
	return acceptanceMatrixStructuredResults(matrixText).some((result) => ACCEPTANCE_BLOCKING_RESULTS.test(result));
}

function validateAcceptanceMatrixForClose(cwd: string, id: string): string | undefined {
	const issue = getBdIssue(cwd, id);
	const checks = descriptionAcceptanceChecks(issue?.description);
	if (checks.length === 0) return undefined;
	const comments = getBdCommentsText(cwd, id);
	if (hasValidHumanAcceptanceOverride(comments)) return undefined;
	const matrix = latestAcceptanceMatrix(comments);
	if (!matrix) return `Заблокировано: terminal close для ${id} требует ACCEPTANCE MATRIX в bd comments, потому что bead содержит acceptance criteria.`;
	if (acceptanceMatrixHasBlockingResult(matrix)) {
		return `Заблокировано: ACCEPTANCE MATRIX для ${id} содержит FAIL/NOT RUN/BLOCKED/SCOPE GAP. Исправь criteria или добавь HUMAN ACCEPTANCE OVERRIDE с approver и reason.`;
	}
	if (!/result\s*:\s*PASS\b|\bPASS\b/i.test(matrix)) {
		return `Заблокировано: ACCEPTANCE MATRIX для ${id} должна содержать PASS result evidence или valid HUMAN ACCEPTANCE OVERRIDE.`;
	}
	const uncovered = checks.filter((check) => !matrixCoversCheck(matrix, check));
	const firstUncovered = uncovered[0];
	if (firstUncovered) {
		return `Заблокировано: ACCEPTANCE MATRIX для ${id} не покрывает acceptance/verification item: ${firstUncovered.slice(0, 140)}.`;
	}
	return undefined;
}

function hasPrMergedException(command: string): boolean {
	return /PR_MERGED_EXCEPTION=\S+|NO_REMOTE_BRANCH_COMPLETION_REQUIRED|--pr-merged-exception\b|pr[-_ ]merged exception/i.test(command);
}

function getCurrentBranch(cwd: string): string | undefined {
	return runGit(cwd, ["branch", "--show-current"]);
}

function hasRemoteUpstream(cwd: string): boolean {
	const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	return Boolean(upstream && upstream !== "@{u}");
}

function branchHeadMergedIntoOriginMain(cwd: string): boolean | undefined {
	const originMain = runGit(cwd, ["rev-parse", "origin/main"]);
	if (!originMain) return undefined;
	return commandSucceeds(cwd, "git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
}

function githubPrMerged(cwd: string, branch: string): { merged: boolean; evidence?: string } | undefined {
	const raw = runCommand(cwd, "gh", ["pr", "view", branch, "--json", "state,mergedAt,url"]);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { state?: string; mergedAt?: string; url?: string };
		const merged = parsed.state === "MERGED" || Boolean(parsed.mergedAt);
		return { merged, evidence: parsed.url ?? `gh pr view ${branch}` };
	} catch {
		return undefined;
	}
}

function unmergedBranchCompletionReason(command: string, cwd: string): string | undefined {
	if (hasPrMergedException(command)) return undefined;
	if (!getRepoRoot(cwd)) return undefined;
	const branch = getCurrentBranch(cwd);
	if (!branch || PROTECTED_BRANCHES.has(branch)) return undefined;
	if (!hasRemoteUpstream(cwd)) return undefined;

	const ancestor = branchHeadMergedIntoOriginMain(cwd);
	if (ancestor === true) return undefined;
	const ghMerged = githubPrMerged(cwd, branch);
	if (ghMerged?.merged) return undefined;

	const originEvidence = ancestor === false ? "HEAD не является ancestor of origin/main" : "origin/main недоступен";
	const prEvidence = ghMerged ? `PR ${ghMerged.evidence} не merged` : `не удалось проверить merged PR через gh pr view ${branch}`;
	return `Заблокировано: remote branch completion для ${branch} требует merged PR или explicit documented exception (${originEvidence}; ${prEvidence}). Сначала используй merge-to-main или добавь PR_MERGED_EXCEPTION=<reason> / NO_REMOTE_BRANCH_COMPLETION_REQUIRED для local-only fast-path или spike work.`;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let quote: '"' | "'" | undefined;
	let start = 0;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (char !== ';' && two !== '&&' && two !== '||') continue;
		const segment = command.slice(start, index).trim();
		if (segment) segments.push(segment);
		index += two === '&&' || two === '||' ? 1 : 0;
		start = index + 1;
	}
	const finalSegment = command.slice(start).trim();
	if (finalSegment) segments.push(finalSegment);
	return segments;
}

interface WorktreeCreateCommand {
	kind: "bd" | "git";
	path?: string;
	branch?: string;
}

const TASK_WORKTREE_BRANCH_PREFIXES = CANONICAL_PI_BRANCH_PREFIXES;

function parseWorktreeCreateSegment(segment: string): WorktreeCreateCommand | undefined {
	const tokens = shellTokens(segment);
	const bdIndex = tokens.findIndex((token, index) => token === "bd" && tokens[index + 1] === "worktree" && tokens[index + 2] === "create");
	if (bdIndex !== -1) {
		let worktreePath: string | undefined;
		let branch: string | undefined;
		for (let index = bdIndex + 3; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token === "--branch") {
				branch = tokens[index + 1];
				index += 1;
				continue;
			}
			if (token.startsWith("--branch=")) {
				branch = token.slice("--branch=".length);
				continue;
			}
			if (["--orphan", "--reason"].includes(token)) {
				index += 1;
				continue;
			}
			if (token.startsWith("-")) continue;
			if (!worktreePath) worktreePath = token;
		}
		return { kind: "bd", path: worktreePath, branch };
	}

	const gitIndex = tokens.findIndex((token, index) => token === "git" && tokens[index + 1] === "worktree" && tokens[index + 2] === "add");
	if (gitIndex !== -1) {
		let worktreePath: string | undefined;
		let branch: string | undefined;
		let detached = false;
		const positional: string[] = [];
		for (let index = gitIndex + 3; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token === "-b" || token === "-B") {
				branch = tokens[index + 1];
				index += 1;
				continue;
			}
			if (token === "--detach") {
				detached = true;
				continue;
			}
			if (token === "--force" || token === "--guess-remote" || token === "--no-guess-remote") continue;
			if (token.startsWith("-")) continue;
			positional.push(token);
			if (!worktreePath) worktreePath = token;
		}
		const existingBranch = positional[1];
		const existingBranchPrefix = existingBranch?.split("/", 1)[0];
		if (!branch && !detached && existingBranchPrefix && TASK_WORKTREE_BRANCH_PREFIXES.has(existingBranchPrefix)) {
			branch = existingBranch;
		}
		return { kind: "git", path: worktreePath, branch };
	}

	return undefined;
}

function extractWorktreePathFromSegment(segment: string): string | undefined {
	return parseWorktreeCreateSegment(segment)?.path;
}

function invalidWorktreePath(command: string, cwd?: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		if (!/\b(?:bd\s+worktree\s+create|git\s+worktree\s+add)\b/.test(segment)) continue;
		const rawPath = extractWorktreePathFromSegment(segment);
		if (!rawPath) continue;
		const unquoted = stripQuotes(rawPath);
		if (!unquoted.startsWith("/") && !unquoted.startsWith("~/") && !unquoted.startsWith("$HOME/")) return unquoted;
		if (unquoted.includes("..")) return unquoted;
		const resolved = realpathExistingOrParent(normalizeFsPath(unquoted, cwd));
		const allowedRoot = realpathExistingOrParent(WORKTREE_ROOT);
		if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) return unquoted;
	}
	return undefined;
}


function worktreeNamingBlockReason(command: string, cwd?: string, workflowState: WorkflowStateSnapshot = {}): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const parsed = parseWorktreeCreateSegment(segment);
		if (!parsed?.path || !parsed.branch) continue;
		const [rawPrefix, ...suffixParts] = parsed.branch.split("/");
		const prefix = rawPrefix ?? "";
		const suffix = suffixParts.join("/");
		if (!TASK_WORKTREE_BRANCH_PREFIXES.has(prefix) || !suffix) continue;
		const resolvedPath = realpathExistingOrParent(normalizeFsPath(parsed.path, cwd));
		if (!isPathInsideOrEqual(resolvedPath, WORKTREE_ROOT)) continue;
		const basename = path.basename(resolvedPath);
		const expectedFormat = "<type>/<bead-suffix>-<domain-or-component>-<purpose> with worktree basename equal to branch suffix";
		if (basename !== suffix) return `Заблокировано: canonical worktree naming требует, чтобы worktree basename (${basename}) точно совпадал с branch suffix (${suffix}) для ${parsed.branch}. Формат: ${expectedFormat}.`;
		if (/^beads-task-issue-tracker-[a-z0-9]+(?:-|$)/i.test(suffix)) return `Заблокировано: branch/worktree suffix не должен использовать полный project bead id (${suffix}); используй короткий bead suffix, например lgok-branch-worktree-naming.`;
		if (!/^[a-z0-9]+-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$/.test(suffix)) return `Заблокировано: canonical branch naming требует suffix вида <bead-suffix>-<domain-or-component>-<purpose>; получен ${suffix}.`;
		if (workflowState.activeBead) {
			const activeSuffix = workflowState.activeBead.split("-").pop() ?? "";
			if (activeSuffix && !suffix.startsWith(`${activeSuffix}-`)) return `Заблокировано: active bead ${workflowState.activeBead} требует branch/worktree suffix с префиксом ${activeSuffix}-; получен ${suffix}.`;
		}
	}
	return undefined;
}

function getStagedFiles(cwd: string): string[] {
	return (runGit(cwd, ["diff", "--cached", "--name-only"]) ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function isCodeFile(file: string): boolean {
	return CODE_FILE_PATTERN.test(file) && !META_ONLY_PATTERN.test(file);
}

function getChangedFiles(cwd: string): string[] {
	const tracked = (runGit(cwd, ["diff", "--name-only", "HEAD"]) ?? "").split("\n");
	const untracked = (runGit(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n");
	return [...new Set([...tracked, ...untracked].map((file) => file.trim()).filter(Boolean))];
}

function countFileLines(cwd: string, file: string): number {
	try {
		return fs.readFileSync(path.join(cwd, file), "utf8").split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

function getUntrackedFiles(cwd: string): Set<string> {
	return new Set((runGit(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").map((file) => file.trim()).filter(Boolean));
}

function getAddedLines(cwd: string, files: string[]): number {
	let total = 0;
	const untracked = getUntrackedFiles(cwd);
	for (const file of files) {
		if (untracked.has(file)) {
			total += countFileLines(cwd, file);
			continue;
		}
		const stat = runGit(cwd, ["diff", "--numstat", "HEAD", "--", file]);
		if (!stat) continue;
		const added = Number(stat.split(/\s+/)[0]);
		if (Number.isFinite(added)) total += added;
	}
	return total;
}

function hasActiveBead(workflowState: WorkflowStateSnapshot): boolean {
	return Boolean(workflowState.activeBead);
}

function isSupervisorPathActive(workflowState: WorkflowStateSnapshot, cwd?: string): boolean {
	if (!hasActiveBead(workflowState)) return false;
	if (workflowState.planApproved) return true;
	return Boolean(cwd && workflowState.activeBead && hasScopedApprovedPlanComment(cwd, workflowState.activeBead, currentRecoveryScope(cwd, workflowState.sessionKey)));
}

interface RecoveryScope {
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
	sessionKey?: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactField(text: string, names: string[], value?: string): boolean {
	if (!value) return false;
	const escaped = escapeRegExp(value);
	return names.some((name) => new RegExp(`(^|\\n)\\s*${name}\\s*[:=]\\s*${escaped}(\\s|$)`, "im").test(text));
}

function readFieldValues(text: string, names: string[]): string[] {
	const namePattern = names.map(escapeRegExp).join("|");
	const values: string[] = [];
	const regex = new RegExp(`(^|\\n)\\s*(${namePattern})\\s*[:=]\\s*([^\\n]+)`, "gim");
	for (const match of text.matchAll(regex)) {
		const value = match[3]?.trim();
		if (value) values.push(value);
	}
	return values;
}

function latestFieldValue(text: string, names: string[]): string | undefined {
	return readFieldValues(text, names).at(-1);
}

function latestFieldMatches(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	return latestFieldValue(text, names) === current;
}

function latestFieldIsForeign(text: string, names: string[], current?: string): boolean {
	if (!current) return false;
	const latest = latestFieldValue(text, names);
	return Boolean(latest && latest !== current);
}

function hasForeignSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	const hasCurrentEvidence = latestFieldMatches(commentsText, branchNames, scope.branch) || latestFieldMatches(commentsText, worktreeNames, scope.worktreePath);
	if (hasCurrentEvidence) return false;
	return latestFieldIsForeign(commentsText, branchNames, scope.branch) || latestFieldIsForeign(commentsText, worktreeNames, scope.worktreePath);
}

export function hasSessionOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	if (!scope.sessionKey) return false;
	return hasExactField(commentsText, ["PI_SESSION_KEY", "SESSION_KEY", "sessionKey", "session"], scope.sessionKey);
}

function currentRecoveryScope(cwd: string, sessionKey?: string): RecoveryScope {
	return {
		branch: getCurrentBranch(cwd),
		worktreePath: getRepoRoot(cwd),
		startCommit: runGit(cwd, ["rev-parse", "HEAD"]),
		sessionKey,
	};
}

const RUNTIME_OWNER_GLOBAL_KEY = "__piWorkflowRuntimeOwnerKey";

function currentRuntimeOwnerKey(): string {
	const root = globalThis as typeof globalThis & { [RUNTIME_OWNER_GLOBAL_KEY]?: string };
	root[RUNTIME_OWNER_GLOBAL_KEY] ??= `runtime:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
	return root[RUNTIME_OWNER_GLOBAL_KEY];
}

function currentSessionKey(ctx?: ExtensionContext): string | undefined {
	const manager = ctx?.sessionManager;
	const sessionId = manager?.getSessionId?.();
	if (sessionId) return `id:${sessionId}`;
	const sessionFile = manager?.getSessionFile?.();
	if (sessionFile) return `file:${sessionFile}`;
	const leafId = manager?.getLeafId?.();
	if (leafId) return `leaf:${leafId}`;
	return undefined;
}

function hasCurrentSessionOwnership(state: WorkflowStateSnapshot, ctx?: ExtensionContext): boolean {
	const key = currentSessionKey(ctx);
	return Boolean(key && state.sessionKey === key);
}

function commentEvidenceBlocks(text: string): string[] {
	return text
		.split(/\n\s*\n+/)
		.map((block) => block.trim())
		.filter(Boolean);
}

function hasScopedApprovedPlanComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	return commentEvidenceBlocks(comments).some((block) => /PLAN APPROVED/i.test(block) && hasSessionOwnershipEvidence(block, scope));
}

function hasScopeOwnershipEvidence(commentsText: string, scope: RecoveryScope): boolean {
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	if (hasForeignSessionOwnershipEvidence(commentsText, scope)) return false;
	const branchMatches = latestFieldMatches(commentsText, branchNames, scope.branch);
	const worktreeMatches = latestFieldMatches(commentsText, worktreeNames, scope.worktreePath);
	const startMatches = hasExactField(commentsText, ["START_COMMIT", "START-COMMIT", "Start-commit", "start"], scope.startCommit);
	return branchMatches && worktreeMatches && startMatches;
}

function hasScopedApprovedSupervisorWorkflowComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	const blocks = commentEvidenceBlocks(comments);
	const hasScopedApprovedPlan = blocks.some((block) => /PLAN APPROVED/i.test(block) && hasScopeOwnershipEvidence(block, scope));
	const hasAnyApprovedPlan = /PLAN APPROVED/i.test(comments);
	const hasSupervisorDispatch = blocks.some((block) => /DISPATCH(?: RESULT)?/i.test(block) && hasScopeOwnershipEvidence(block, scope));
	return hasSupervisorDispatch && (hasScopedApprovedPlan || hasAnyApprovedPlan);
}

function hasScopedApprovedWorkflowComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	return /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(comments) && hasSessionOwnershipEvidence(comments, scope);
}

function normalizePostCloseMergeFixFiles(block: string): string[] | undefined {
	const rawValues = readFieldValues(block, ["FILES", "PATHS"]);
	if (rawValues.length === 0) return undefined;
	const files = rawValues.flatMap((value) => value.split(","));
	const normalized = new Set<string>();
	for (const rawFile of files) {
		const file = rawFile.trim();
		if (!file) continue;
		if (path.isAbsolute(file)) return undefined;
		const normalizedFile = path.posix.normalize(file.replace(/\\/g, "/"));
		if (normalizedFile === "." || normalizedFile.startsWith("../") || normalizedFile === ".." || normalizedFile.includes("/../")) {
			return undefined;
		}
		normalized.add(normalizedFile);
	}
	return normalized.size > 0 ? [...normalized] : undefined;
}

function hasScopedPostCloseMergeFixComment(cwd: string, beadId: string, scope: RecoveryScope, changedCodeFiles: string[]): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	const blocks = commentEvidenceBlocks(comments);
	return blocks.some((block) => {
		if (!/POST[- ]CLOSE MERGE FIX/i.test(block) || !hasScopeOwnershipEvidence(block, scope)) return false;
		const allowedFiles = normalizePostCloseMergeFixFiles(block);
		if (!allowedFiles) return false;
		return changedCodeFiles.every((file) => allowedFiles.includes(path.posix.normalize(file.replace(/\\/g, "/"))));
	});
}

function recoverableApprovedPlanBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	if (!scope.sessionKey) return undefined;
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedApprovedPlanComment(cwd, issue.id, scope));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverableApprovedSupervisorWorkflowBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	for (const status of ["inreview", "reviewed", "accepted", "in_progress", "simplified"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedApprovedSupervisorWorkflowComment(cwd, issue.id, scope));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverablePostCloseMergeFixBead(cwd: string, scope = currentRecoveryScope(cwd), changedCodeFiles: string[] = []): string | undefined {
	if (changedCodeFiles.length === 0) return undefined;
	for (const status of ["closed"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedPostCloseMergeFixComment(cwd, issue.id, scope, changedCodeFiles));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recoverableApprovedWorkflowBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	if (!scope.sessionKey) return recoverableApprovedSupervisorWorkflowBead(cwd, scope);
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && (hasScopedApprovedWorkflowComment(cwd, issue.id, scope) || hasScopedApprovedSupervisorWorkflowComment(cwd, issue.id, scope)));
			if (bead?.id) return bead.id;
		} catch {
			continue;
		}
	}
	return undefined;
}

function hasFastPathRationale(command: string): boolean {
	return /FAST_PATH_RATIONALE=\S+|fast[-_ ]path rationale|--fast-path-rationale\b/i.test(command);
}

function hasMechanicalBatchMarker(command: string): boolean {
	return /MECHANICAL_BATCH=1|mechanical batch|--label(?:=|\s+)mechanical|--labels(?:=|\s+)mechanical/i.test(command);
}

function hasRiskyScope(files: string[]): boolean {
	return files.some((file) => RISKY_FILE_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function hasCrossDomainScope(files: string[]): boolean {
	const frontend = files.some((file) => file.startsWith("app/") || file.startsWith("i18n/"));
	const backend = files.some((file) => file.startsWith("src-tauri/"));
	return frontend && backend;
}

function evaluateFastPathDiscipline(command: string, cwd: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	if (!getRepoRoot(cwd)) return undefined;
	const changedCodeFiles = getChangedFiles(cwd).filter(isCodeFile);
	if (changedCodeFiles.length === 0) return undefined;

	const addedLines = getAddedLines(cwd, changedCodeFiles);
	const thresholdExceeded = changedCodeFiles.length > FAST_PATH_FILE_THRESHOLD || addedLines > FAST_PATH_ADDED_LINE_THRESHOLD;
	const risky = hasRiskyScope(changedCodeFiles) || hasCrossDomainScope(changedCodeFiles);
	const supervisorPath = isSupervisorPathActive(workflowState, cwd);
	const activeBead = hasActiveBead(workflowState);
	const rationale = hasFastPathRationale(command) || hasMechanicalBatchMarker(command);

	if (risky && !supervisorPath) {
		if (!commandHasMutatingBd(command) && !commandHasMutatingGitOrFs(command)) return undefined;
		if (commandIsDirtySafeBdEvidenceMutation(command, workflowState)) return undefined;
		if (!activeBead && commandIsTrackerOnlyBdCreate(command, cwd)) return undefined;
		const scope = currentRecoveryScope(cwd, workflowState.sessionKey);
		const recoveredBead =
			recoverableApprovedPlanBead(cwd, scope) ??
			recoverableApprovedSupervisorWorkflowBead(cwd, scope) ??
			recoverablePostCloseMergeFixBead(cwd, scope, changedCodeFiles);
		if (recoveredBead) return undefined;
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Заблокировано: risky scope требует active bead с approved plan/supervisor path, valid POST-CLOSE MERGE FIX marker (closed scope) или другое scoped recoverable approval evidence. Changed code files: ${changedCodeFiles.slice(0, 5).join(", ")}.`,
		};
	}

	if (thresholdExceeded && !activeBead && commandHasCommitLikeOperation(command)) {
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Заблокировано: large code change без active bead (${changedCodeFiles.length} files, ${addedLines} added lines). Создай/claim self-contained bead с concrete acceptance или dispatch supervisor.`,
		};
	}

	if (thresholdExceeded && !supervisorPath && !rationale) {
		return {
			policy: "fastPathDiscipline",
			block: false,
			reason: `Превышен Fast Path threshold (${changedCodeFiles.length} code files, ${addedLines} added lines). Добавь explicit FAST_PATH_RATIONALE или используй supervisor path; mechanical batches должны оставаться narrow и быть marked mechanical.`,
		};
	}

	return undefined;
}

function evaluateStaleGuard(command: string, cwd: string): PolicyDecision | undefined {
	if (!commandHasCommitLikeOperation(command)) return undefined;
	if (!getRepoRoot(cwd)) return undefined;
	if (isProtectedBranch(cwd)) return undefined;

	const staged = getStagedFiles(cwd);
	const stagedCode = staged.filter(isCodeFile);
	const originMain = runGit(cwd, ["rev-parse", "origin/main"]);
	if (!originMain) {
		if (stagedCode.length === 0) {
			return {
				policy: "staleWorktreeGuard",
				block: false,
				reason: "Предупреждение: origin/main недоступен; docs/beads-only commit-like operation разрешена, но перед code changes запусти git fetch origin.",
			};
		}
		return {
			policy: "staleWorktreeGuard",
			block: true,
			reason: "Заблокировано: origin/main недоступен для code change; запусти git fetch origin перед commit-like operations.",
		};
	}

	const mergeBase = runGit(cwd, ["merge-base", "HEAD", "origin/main"]);
	if (!mergeBase || mergeBase === originMain) return undefined;
	if (stagedCode.length === 0) return undefined;

	const mainDiff = new Set((runGit(cwd, ["diff", "--name-only", mergeBase, "origin/main"]) ?? "").split("\n").filter(Boolean));
	const intersect = stagedCode.filter((file) => mainDiff.has(file));
	if (intersect.length === 0) return undefined;
	return {
		policy: "staleWorktreeGuard",
		block: true,
		reason: `Заблокировано: branch stale относительно origin/main, и staged code files пересекаются с main changes: ${intersect.slice(0, 5).join(", ")}. Запусти git fetch origin && git rebase origin/main.`,
	};
}

function isSupervisorContext(): boolean {
	return /supervisor/i.test(process.env.PI_AGENT_ROLE ?? "") || /supervisor/i.test(process.env.PI_SUBAGENT_ROLE ?? "");
}

export function reconcileWorkflowStateWithBdStatus(state: WorkflowStateSnapshot, bdStatus?: string): WorkflowStateSnapshot {
	if (!bdStatus) return state;
	if (TERMINAL_BD_STATUSES.has(bdStatus)) {
		return {
			...state,
			activeBead: undefined,
			state: "idle",
			bdStatus,
			endCommit: undefined,
		};
	}
	const next = { ...state, bdStatus };
	if (bdStatus === "inreview" && state.state === "implementing") {
		next.state = "inreview";
		next.sessionMode = "inreview";
	}
	if (bdStatus === "inreview" && state.sessionMode === "implementing") next.sessionMode = "inreview";
	return next;
}

function workflowStateHasCurrentScopeEvidence(state: WorkflowStateSnapshot, scope: RecoveryScope): boolean {
	const hasForeignWorktree = Boolean(state.worktreePath && scope.worktreePath && state.worktreePath !== scope.worktreePath);
	const hasForeignBranch = Boolean(state.branch && scope.branch && state.branch !== scope.branch);
	if (hasForeignWorktree || hasForeignBranch) return false;

	return Boolean(
		(state.worktreePath && scope.worktreePath && state.worktreePath === scope.worktreePath) ||
			(state.branch && scope.branch && state.branch === scope.branch) ||
			(state.startCommit && scope.startCommit && state.startCommit === scope.startCommit),
	);
}

function workflowStateHasValidRecordedTaskScope(state: WorkflowStateSnapshot): boolean {
	if (!state.worktreePath || !state.branch || PROTECTED_BRANCHES.has(state.branch)) return false;
	if (!fs.existsSync(state.worktreePath)) return false;
	const repoRoot = getRepoRoot(state.worktreePath);
	return Boolean(repoRoot && isPathInsideOrEqual(repoRoot, state.worktreePath) && isPathInsideOrEqual(state.worktreePath, repoRoot) && getCurrentBranch(state.worktreePath) === state.branch);
}

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const runtimeOwnerKey = currentRuntimeOwnerKey();
	const workflowEntries = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state") as Array<{ data?: WorkflowStateSnapshot }>;
	const last = workflowEntries
		.filter((entry: { data?: unknown }) => (entry.data as WorkflowStateSnapshot | undefined)?.runtimeOwnerKey === runtimeOwnerKey)
		.pop();
	const restoredLast = workflowEntries.at(-1);
	const state = last?.data ?? restoredLast?.data ?? {};
	const scope = currentRecoveryScope(ctx.cwd, currentSessionKey(ctx));
	if (state.activeBead && state.state && state.state !== "idle") {
		const stateScope = {
			branch: state.branch ?? scope.branch,
			worktreePath: state.worktreePath,
			startCommit: state.startCommit ?? scope.startCommit,
			sessionKey: state.sessionKey ?? scope.sessionKey,
		};
		const currentSessionState = hasCurrentSessionOwnership(state, ctx);
		const currentScopeState = workflowStateHasCurrentScopeEvidence(state, scope);
		const recordedTaskScopeState = workflowStateHasValidRecordedTaskScope(state);
		const missingWorktreeLock = currentSessionState && hasActiveWorktreeLockRequirement(state) && !state.worktreePath;
		const isCurrentSessionState = currentSessionState && (currentScopeState || recordedTaskScopeState || missingWorktreeLock);
		if (!isCurrentSessionState) {
			return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
		}
		const commentsText = getBdCommentsText(ctx.cwd, state.activeBead);
		const ownershipScope = recordedTaskScopeState && !currentScopeState ? scope : stateScope;
		if (hasForeignSessionOwnershipEvidence(commentsText, ownershipScope)) {
			return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
		}
		return reconcileWorkflowStateWithBdStatus(state, getBdIssue(ctx.cwd, state.activeBead)?.status);
	}
	const recoveredBead = recoverableApprovedWorkflowBead(ctx.cwd, scope);
	if (!recoveredBead) return { ...state, branch: scope.branch };
	const issue = getBdIssue(ctx.cwd, recoveredBead);
	return {
		...state,
		activeBead: recoveredBead,
		state: state.state ?? "idle",
		bdStatus: issue?.status,
		branch: scope.branch,
		worktreePath: scope.worktreePath,
		startCommit: scope.startCommit,
	};
}

export function evaluateBashPolicy(
	commandInput: string,
	workflowState: WorkflowStateSnapshot = {},
	options: BashPolicyOptions = {},
): PolicyDecision | undefined {
	const command = normalizeCommand(commandInput);
	const commandCwd = inferCommandCwd(command, options.cwd);

	const nextBead = commandStartsDifferentBead(command);
	const dispatchBead = commandDispatchesBead(command);
	const reviewBead = commandReviewsBead(command);
	const lifecycleDecision = nextBead
		? activeBeadLifecycleDecision(nextBead, "start/claim another bead", workflowState)
		: dispatchBead
			? activeBeadLifecycleDecision(dispatchBead, "dispatch supervisor", workflowState)
			: reviewBead
				? activeBeadLifecycleDecision(reviewBead, "review", workflowState)
				: undefined;
	if (lifecycleDecision) return lifecycleDecision;

	const rawClaimId = parseBdClaimId(command);
	if (rawClaimId) {
		return {
			policy: "blockRawBdClaim",
			block: true,
			reason: `Заблокировано: используй workflow_claim typed tool (или optional human UI shortcut /workflow-claim ${rawClaimId}) вместо raw bd update --claim, чтобы Pi footer/workflow-state оставались синхронизированы.`,
		};
	}

	if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(command)) {
		return {
			policy: "blockGitAddAll",
			block: true,
			reason: "Заблокировано: используй explicit file paths вместо git add . / -A / --all.",
		};
	}

	const destructiveReason = destructiveCommandReason(command, workflowState, options, commandCwd);
	if (destructiveReason) {
		return {
			policy: "blockDestructiveCommand",
			block: true,
			reason: destructiveReason,
		};
	}

	const isPlanning = workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (commandHasMutatingBd(command) || commandHasMutatingGitOrFs(command))) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Заблокировано: workflow находится в planning mode; разрешены только read-only commands.",
		};
	}

	const worktreeCwdDecision = activeWorktreeCwdDecision(command, options.cwd ?? process.cwd(), workflowState);
	if (worktreeCwdDecision) return worktreeCwdDecision;

	if ((commandHasMainLocalMutation(command) || commandHasProtectedBranchFsMutation(command, commandCwd)) && isProtectedBranch(commandCwd)) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: "Заблокировано: file mutations и git add/stage/commit на main/master запрещены. Используй feature branch или approved merge/release workflow.",
		};
	}

	const invalidWorktree = invalidWorktreePath(command, commandCwd);
	if (invalidWorktree) {
		return {
			policy: "blockWorktreeInsideRepo",
			block: true,
			reason: `Заблокировано: worktree path должен находиться внутри ${WORKTREE_ROOT}; получен ${invalidWorktree}.`,
		};
	}

	const worktreeNamingReason = worktreeNamingBlockReason(command, commandCwd, workflowState);
	if (worktreeNamingReason) {
		return {
			policy: "blockWorktreeInsideRepo",
			block: true,
			reason: worktreeNamingReason,
		};
	}

	const staleDecision = evaluateStaleGuard(command, commandCwd);
	if (staleDecision) return staleDecision;

	if (
		commandHasGitPush(command) &&
		!workflowState.mergeSlotHeld &&
		!commandAcquiresMergeSlotBeforePush(command) &&
		!currentActorHoldsBdMergeSlot(commandCwd, options)
	) {
		return {
			policy: "requireMergeSlotForPush",
			block: true,
			reason: "Заблокировано: git push сначала требует bd merge-slot acquire (или workflow state mergeSlotHeld=true, или current bd merge-slot holder evidence).",
		};
	}

	const fastPathDecision = evaluateFastPathDiscipline(command, commandCwd, workflowState);
	if (fastPathDecision) return fastPathDecision;

	const beadLocaleError = getBeadLocaleError(command);
	if (beadLocaleError) {
		return {
			policy: "enforceBeadRussianLocale",
			block: true,
			reason: beadLocaleError,
		};
	}

	const beadEnrichmentError = getBeadEnrichmentError(command);
	if (beadEnrichmentError) {
		return {
			policy: "enforceBeadEnrichment",
			block: true,
			reason: beadEnrichmentError,
		};
	}

	if (isSupervisorContext() && (commandClosesBead(command) || commandDirectlySetsClosed(command) || commandHasReviewCheckpointTransition(command) || commandHasGitPush(command))) {
		return {
			policy: "blockSupervisorClose",
			block: true,
			reason: "Заблокировано: supervisor contexts не могут закрывать beads, выставлять orchestrator statuses или выполнять push.",
		};
	}

	const closeId = terminalCloseId(command);
	const incompleteChildren = closeId ? incompleteEpicChildren(commandCwd, closeId) : undefined;
	if (incompleteChildren) {
		return {
			policy: "blockEpicCloseWithIncompleteChildren",
			block: true,
			reason: `Заблокировано: epic ${closeId} нельзя завершить, пока child beads не closed (${formatIncompleteChildren(incompleteChildren)}). Сначала закрой children или используй explicit documented policy override.`,
		};
	}

	// Per-task bead closure is allowed before merge-to-main in multi-task sessions.
	// Session-final merge evidence is enforced by merge-to-main/final verdict workflows,
	// not by blocking every accepted bead close on a feature branch.
	const nonClosedTerminalTransition = directTerminalTransition(command);
	if (nonClosedTerminalTransition && nonClosedTerminalTransition.status !== "closed") {
		const sweepError = validateLastChildEpicSweep(commandCwd, nonClosedTerminalTransition.id, nonClosedTerminalTransition.status);
		if (sweepError) {
			return { policy: "requireEpicFinalizationSweep", block: true, reason: sweepError };
		}
	}

	if (commandClosesBead(command) || commandDirectlySetsClosed(command)) {
		const latestMatrix = closeId ? latestAcceptanceMatrix(getBdCommentsText(commandCwd, closeId)) : undefined;
		const earlyEpicMatrixError = closeId ? validateEpicCloseMatrix(commandCwd, closeId) : undefined;
		if (earlyEpicMatrixError && (!latestMatrix || latestMatrix.toUpperCase().startsWith("EPIC ACCEPTANCE MATRIX"))) {
			return { policy: "requireEpicFinalizationSweep", block: true, reason: earlyEpicMatrixError };
		}
		const matrixError = closeId ? validateAcceptanceMatrixForClose(commandCwd, closeId) : undefined;
		if (matrixError) {
			return {
				policy: "blockBdCloseWithoutReview",
				block: true,
				reason: matrixError,
			};
		}
		if (!canCloseByReviewState(command, commandCwd, workflowState)) {
			return {
				policy: "blockBdCloseWithoutReview",
				block: true,
				reason: "Заблокировано: terminal close требует bd status accepted, либо bd status reviewed с documented no-acceptance shortcut, либо explicit policy override.",
			};
		}
		const terminalTransition = directTerminalTransition(command) ?? (closeCommandId(command) ? { id: closeCommandId(command)!, status: "closed" } : undefined);
		const sweepError = terminalTransition ? validateLastChildEpicSweep(commandCwd, terminalTransition.id, terminalTransition.status) : undefined;
		if (sweepError) {
			return { policy: "requireEpicFinalizationSweep", block: true, reason: sweepError };
		}
		const epicMatrixError = closeId ? validateEpicCloseMatrix(commandCwd, closeId) : undefined;
		if (epicMatrixError) {
			return { policy: "requireEpicFinalizationSweep", block: true, reason: epicMatrixError };
		}
	}

	const invalidReviewTransition = validateReviewTransitionForCommand(command, commandCwd);
	if (commandHasReviewCheckpointTransition(command) && invalidReviewTransition) {
		return {
			policy: "validateReviewChain",
			block: true,
			reason: invalidReviewTransition,
		};
	}

	return undefined;
}

export function evaluateToolPolicy(toolName: string, input: Record<string, unknown>, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const worktreeDecision = requiredToolCwdDecision(toolName, input, workflowState);
	if (worktreeDecision) return worktreeDecision;
	if (matchesToolName(toolName, "dispatch_supervisor")) return activeBeadLifecycleDecision(String(input.beadId ?? ""), "dispatch supervisor", workflowState);
	if (matchesToolName(toolName, "review_bead")) return activeBeadLifecycleDecision(String(input.beadId ?? ""), "review", workflowState);
	if (matchesToolName(toolName, "workflow_complete") && workflowState.activeBead && workflowState.bdStatus === "inreview") {
		const targetState = String(input.state ?? "");
		if (targetState !== "blocked" && targetState !== "deferred") {
			return {
				policy: "enforceActiveBeadLifecycle",
				block: true,
				reason: `Заблокировано: активный bead ${workflowState.activeBead} имеет bd:inreview; workflow_complete ${targetState || "без blocker"} остановит workflow до review. Запусти review-bead / review_bead для ${workflowState.activeBead} или используй workflow_complete state=blocked|deferred с explicit blocker и next action, если review невозможно запустить.`,
			};
		}
	}
	return undefined;
}

export function evaluatePathPolicy(toolName: string, targetPath: string, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const pathReason = protectedPathReason(targetPath);
	if (pathReason) {
		return {
			policy: "protectPaths",
			block: true,
			reason: `Заблокировано: ${targetPath} защищён (${pathReason}).`,
		};
	}

	const worktreeDecision = activeWorktreePathDecision(toolName, targetPath, workflowState);
	if (worktreeDecision) return worktreeDecision;

	const isPlanning = workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (toolName === "edit" || toolName === "write")) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Заблокировано: workflow находится в planning mode; edit/write отключены.",
		};
	}

	if ((toolName === "edit" || toolName === "write") && PROTECTED_BRANCHES.has(getBranchForPath(targetPath) ?? "")) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: `Заблокировано: edit/write на main/master запрещён для ${targetPath}. Используй feature branch или external worktree.`,
		};
	}

	return undefined;
}

function toToolBlock(decision: PolicyDecision): { block: true; reason: string } {
	return { block: true, reason: `[${decision.policy}] ${decision.reason}` };
}

export default function beadsPolicyExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		const workflowState = latestWorkflowState(ctx);

		if (matchesToolName(event.toolName, "bash")) {
			const command = String(event.input.command ?? "");
			const decision = applySkip(evaluateBashPolicy(command, workflowState, { cwd: ctx.cwd }));
			if (decision?.block) return toToolBlock(decision);
			if (decision) ctx.ui.notify(`[${decision.policy}] ${decision.reason}`, "warning");
			return undefined;
		}

		const toolDecision = applySkip(evaluateToolPolicy(event.toolName, event.input as Record<string, unknown>, workflowState));
		if (toolDecision?.block) return toToolBlock(toolDecision);

		const pathToolName = ["read", "edit", "write"].find((name) => matchesToolName(event.toolName, name));
		if (pathToolName) {
			const targetPath = String(event.input.path ?? "");
			const decision = applySkip(evaluatePathPolicy(pathToolName, targetPath, workflowState));
			if (decision?.block) return toToolBlock(decision);
		}

		return undefined;
	});

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		ctx.ui.setStatus("beads-policy", ctx.ui.theme.fg("dim", "policy:on"));
	});

	pi.registerCommand("policy-status", {
		description: "Показать status и overrides активного Pi beads policy engine",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skipped = [...getSkipPolicies()].join(", ") || "none";
			ctx.ui.notify(`Beads policy engine active. Overrides: ${skipped}`, "info");
		},
	});
}
