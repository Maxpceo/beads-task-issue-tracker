import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
interface ExtensionAPI {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, config: any): void;
}

interface ExtensionContext {
	cwd: string;
	sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
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
	| "blockBdCloseWithoutReview"
	| "blockEpicCloseWithIncompleteChildren"
	| "blockUnmergedBranchCompletion"
	| "validateReviewChain"
	| "enforceBeadEnrichment"
	| "blockMutationsInPlanning"
	| "blockSupervisorClose"
	| "blockWorktreeInsideRepo"
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
	mergeSlotHeld?: boolean;
	planMode?: string;
}

interface BashPolicyOptions {
	cwd?: string;
	bdMergeSlotIssue?: BdMergeSlotIssue | null;
	currentActor?: string;
}

const PROTECTED_PATHS = [".env", ".git/", "node_modules/"];
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const WORKTREE_ROOT = path.join(os.homedir(), "Projects", "worktrees", "beads-task-issue-tracker");
const META_ONLY_PATTERN = /^(\.beads\/|\.pi\/plans\/|.*\.(md|json|jsonl)$)/;
const CODE_FILE_PATTERN = /^(app|src-tauri|tests|i18n|\.pi\/extensions|\.pi\/agents|\.pi\/skills|scripts)\/|\.(ts|tsx|vue|rs|js|mjs|cjs|css|scss|sh)$/;
const FAST_PATH_FILE_THRESHOLD = 3;
const FAST_PATH_ADDED_LINE_THRESHOLD = 80;
const SUPERVISOR_READY_STATES = new Set(["plan_approved", "implementing", "inreview", "reviewing", "accepted"]);
const TERMINAL_WORKFLOW_STATES = new Set(["closed", "blocked", "deferred", "merged"]);
const NON_TERMINAL_WORKFLOW_STATES = new Set(["claimed", "planning", "plan_approved", "implementing", "inreview", "reviewing", "accepted", "landing"]);
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

function inferCommandCwd(command: string, defaultCwd?: string): string {
	const base = defaultCwd ?? process.cwd();
	const match = command.match(/^\s*cd\s+([^;&|]+?)\s*&&/);
	const cdPath = match?.[1];
	if (!cdPath) return base;
	return normalizeFsPath(cdPath.trim(), base);
}

function commandHasGitPush(command: string): boolean {
	return /(^|[;&|]\s*)git\s+push\b/.test(command);
}

function commandAcquiresMergeSlotBeforePush(command: string): boolean {
	const acquireIndex = command.search(/\bbd\s+merge-slot\s+acquire\b/);
	const pushIndex = command.search(/\bgit\s+push\b/);
	return acquireIndex >= 0 && pushIndex >= 0 && acquireIndex < pushIndex;
}

function commandHasMutatingBd(command: string): boolean {
	return /\bbd\s+(create|new|update|close|reopen|delete|comments\s+(add|delete|rm)|dep\s+(add|remove|rm)|merge-slot\s+(acquire|release)|dolt\s+(commit|push|pull))\b/.test(
		command,
	);
}

function commandHasMutatingGitOrFs(command: string): boolean {
	return /\b(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(
		command,
	);
}

function commandHasMainLocalMutation(command: string): boolean {
	return /(^|[;&|]\s*)git\s+(add|stage|commit)\b/.test(command);
}

function commandHasProtectedBranchFsMutation(command: string): boolean {
	return /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate)\b/.test(command) || /(^|[^<])>(?!>)/.test(command) || />>/.test(command);
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

function getBeadEnrichmentError(command: string): string | undefined {
	if (!/\bbd\s+(create|new)\b/.test(command)) return undefined;
	if (hasCreateExemption(command)) return undefined;

	const missing = REQUIRED_HANDOFF_SECTIONS.filter((section) => !command.includes(section));
	if (missing.length > 0) {
		return `Blocked: agent-created beads require a self-contained handoff template. Missing: ${missing.join(", ")}. Ask the user or create a spike if context/acceptance is unclear.`;
	}

	if (!hasLabel(command)) {
		return "Blocked: agent-created beads require at least one label via --label/--labels/-l so future sessions can route work.";
	}

	const acceptance = extractSection(command, "### Acceptance criteria");
	const verification = extractSection(command, "### Verification / acceptance checks");
	if (!hasBullet(acceptance) || !hasBullet(verification)) {
		return "Blocked: Acceptance criteria and Verification / acceptance checks must contain concrete bullet checks. If unclear, ask the user with 2-4 options before creating the bead.";
	}
	if (isVagueOnly(acceptance) || isVagueOnly(verification)) {
		return "Blocked: acceptance/verification is too vague. Ask a concrete question with 2-4 proposed acceptance options before creating the bead.";
	}

	return undefined;
}

function shellTokens(input: string): string[] {
	return input.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(stripQuotes) ?? [];
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
				status = tokens[index + 1];
				index += 1;
				continue;
			}
			if (token.startsWith("--status=")) {
				status = token.slice("--status=".length);
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

function directClosedTransition(command: string): { id: string; status: string } | undefined {
	const parsed = parseBdUpdateStatus(command);
	return parsed?.status === "closed" ? parsed : undefined;
}

function closeCommandId(command: string): string | undefined {
	return command.match(/\bbd\s+close\s+(\S+)/)?.[1];
}

function commandHasReviewCheckpointTransition(command: string): boolean {
	return Boolean(reviewCheckpointTransition(command));
}

function parseBdClaimId(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
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
	const state = workflowState.state ?? "idle";
	if (!activeBead || TERMINAL_WORKFLOW_STATES.has(state)) return undefined;
	if (!NON_TERMINAL_WORKFLOW_STATES.has(state)) return undefined;
	if (targetBead && targetBead === activeBead) return undefined;
	if (state === "inreview") return `Blocked: active bead ${activeBead} is inreview; after confirming current-session branch/worktree ownership, next valid action is review-bead / review_bead for ${activeBead}, not ${action}${targetBead ? ` on ${targetBead}` : ""}. If ownership is stale or foreign, run /workflow-reset or explicitly confirm takeover before acting.`;
	return `Blocked: active bead ${activeBead} is non-terminal (${state}). Finish it to closed, block/defer it with an explicit reason, hand it off, or run /workflow-reset if this is stale/foreign state before ${action}${targetBead ? ` on ${targetBead}` : ""}.`;
}

function activeBeadLifecycleDecision(targetBead: string | undefined, action: string, workflowState: WorkflowStateSnapshot): PolicyDecision | undefined {
	const reason = activeBeadLifecycleReason(targetBead, action, workflowState);
	return reason ? { policy: "enforceActiveBeadLifecycle", block: true, reason } : undefined;
}

function commandDirectlySetsClosed(command: string): boolean {
	return Boolean(directClosedTransition(command));
}

function commandClosesBead(command: string): boolean {
	return /\bbd\s+close\b/.test(command);
}

interface BdIssueSummary {
	id?: string;
	status?: string;
	issue_type?: string;
	title?: string;
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
	if (transition.status === "simplified" && from !== "inreview") return `simplified requires source status inreview, got ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && from !== "simplified") return `reviewed requires source status simplified, got ${from ?? "unknown"}`;
	if (transition.status === "reviewed" && !/CODE REVIEW:\s*APPROVED|VERDICT:\s*APPROVED/i.test(comments)) return "reviewed requires CODE REVIEW APPROVED evidence";
	if (transition.status === "accepted" && from !== "reviewed") return `accepted requires source status reviewed, got ${from ?? "unknown"}`;
	if (transition.status === "accepted" && !/ACCEPTANCE|Acceptance evidence|human acceptance/i.test(comments)) return "accepted requires acceptance evidence";
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

function canCloseByReviewState(command: string, cwd: string, workflowState: WorkflowStateSnapshot): boolean {
	const id = terminalCloseId(command);
	if (workflowState.state === "accepted" && workflowState.activeBead && id === workflowState.activeBead) {
		return true;
	}
	if (!id) return false;
	const status = getBdIssue(cwd, id)?.status;
	const comments = getBdCommentsText(cwd, id);
	return status === "accepted" || (status === "reviewed" && /NO_ACCEPTANCE_REQUIRED|no acceptance criteria/i.test(comments));
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

	const originEvidence = ancestor === false ? "HEAD is not an ancestor of origin/main" : "origin/main unavailable";
	const prEvidence = ghMerged ? `PR ${ghMerged.evidence} is not merged` : `could not verify merged PR with gh pr view ${branch}`;
	return `Blocked: remote branch completion for ${branch} requires a merged PR or explicit documented exception (${originEvidence}; ${prEvidence}). Use merge-to-main first, or add PR_MERGED_EXCEPTION=<reason> / NO_REMOTE_BRANCH_COMPLETION_REQUIRED for local-only fast-path or spike work.`;
}

function splitShellSegments(command: string): string[] {
	return command.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
}

function extractWorktreePathFromSegment(segment: string): string | undefined {
	const match = segment.match(/\b(?:bd\s+worktree\s+create|git\s+worktree\s+add)\s+(.+)$/);
	const args = match?.[1];
	if (!args) return undefined;
	const tokens = args.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (["--branch", "-b", "-B", "--orphan", "--reason"].includes(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
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

function isSupervisorPathActive(workflowState: WorkflowStateSnapshot): boolean {
	return hasActiveBead(workflowState) && SUPERVISOR_READY_STATES.has(workflowState.state ?? "");
}

interface RecoveryScope {
	branch?: string;
	worktreePath?: string;
	startCommit?: string;
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
	const branchNames = ["BRANCH", "Branch", "branch"];
	const worktreeNames = ["WORKTREE", "Worktree", "worktree", "worktreePath"];
	if (hasForeignSessionOwnershipEvidence(commentsText, scope)) return false;
	const branchMatches = latestFieldMatches(commentsText, branchNames, scope.branch);
	const worktreeMatches = latestFieldMatches(commentsText, worktreeNames, scope.worktreePath);
	const startMatches = hasExactField(commentsText, ["START_COMMIT", "START-COMMIT", "Start-commit", "start"], scope.startCommit);
	const hasBranchOrWorktreeField = new RegExp(`(^|\\n)\\s*(${[...branchNames, ...worktreeNames].join("|")})\\s*[:=]`, "im").test(commentsText);
	return branchMatches || worktreeMatches || (!hasBranchOrWorktreeField && startMatches && /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(commentsText));
}

function currentRecoveryScope(cwd: string): RecoveryScope {
	return {
		branch: getCurrentBranch(cwd),
		worktreePath: getRepoRoot(cwd),
		startCommit: runGit(cwd, ["rev-parse", "HEAD"]),
	};
}

function hasScopedApprovedWorkflowComment(cwd: string, beadId: string, scope: RecoveryScope): boolean {
	const comments = getBdCommentsText(cwd, beadId);
	return /PLAN APPROVED|DISPATCH|review_bead|PI WORKFLOW/i.test(comments) && hasSessionOwnershipEvidence(comments, scope);
}

function recoverableApprovedWorkflowBead(cwd: string, scope = currentRecoveryScope(cwd)): string | undefined {
	for (const status of ["inreview", "reviewed", "accepted", "in_progress"]) {
		const raw = runCommand(cwd, "bd", ["list", `--status=${status}`, "--json"]);
		if (!raw) continue;
		try {
			const issues = JSON.parse(raw) as BdIssueSummary[];
			const bead = issues.find((issue) => issue.id && hasScopedApprovedWorkflowComment(cwd, issue.id, scope));
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
	const supervisorPath = isSupervisorPathActive(workflowState);
	const activeBead = hasActiveBead(workflowState);
	const rationale = hasFastPathRationale(command) || hasMechanicalBatchMarker(command);

	if (risky && !supervisorPath) {
		if (!commandHasMutatingBd(command) && !commandHasMutatingGitOrFs(command)) return undefined;
		const recoveredBead = recoverableApprovedWorkflowBead(cwd);
		if (recoveredBead) return undefined;
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Blocked: risky scope requires an active bead with approved plan/supervisor path. Changed code files: ${changedCodeFiles.slice(0, 5).join(", ")}.`,
		};
	}

	if (thresholdExceeded && !activeBead && commandHasCommitLikeOperation(command)) {
		return {
			policy: "fastPathDiscipline",
			block: true,
			reason: `Blocked: large code change without active bead (${changedCodeFiles.length} files, ${addedLines} added lines). Create/claim a self-contained bead with concrete acceptance or dispatch supervisor.`,
		};
	}

	if (thresholdExceeded && !supervisorPath && !rationale) {
		return {
			policy: "fastPathDiscipline",
			block: false,
			reason: `Fast Path threshold exceeded (${changedCodeFiles.length} code files, ${addedLines} added lines). Add explicit FAST_PATH_RATIONALE or use supervisor path; mechanical batches must stay narrow and be marked mechanical.`,
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
				reason: "Warning: origin/main is unavailable; docs/beads-only commit-like operation is allowed, but run git fetch origin before code changes.",
			};
		}
		return {
			policy: "staleWorktreeGuard",
			block: true,
			reason: "Blocked: origin/main is unavailable for a code change; run git fetch origin before commit-like operations.",
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
		reason: `Blocked: branch is stale vs origin/main and staged code files intersect main changes: ${intersect.slice(0, 5).join(", ")}. Run git fetch origin && git rebase origin/main.`,
	};
}

function isSupervisorContext(): boolean {
	return /supervisor/i.test(process.env.PI_AGENT_ROLE ?? "") || /supervisor/i.test(process.env.PI_SUBAGENT_ROLE ?? "");
}

function workflowStateFromBdStatus(status?: string): string | undefined {
	if (status === "in_progress") return "implementing";
	if (status === "inreview") return "inreview";
	if (status === "reviewed" || status === "accepted") return "accepted";
	if (status === "closed") return "closed";
	if (status === "blocked") return "blocked";
	if (status === "deferred") return "deferred";
	return undefined;
}

function bdStatusIsActiveReviewCheckpoint(status?: string): boolean {
	return status === "inreview" || status === "simplified" || status === "reviewed";
}

export function reconcileWorkflowStateWithBdStatus(state: WorkflowStateSnapshot, bdStatus?: string): WorkflowStateSnapshot {
	if (state.state === "reviewing" && bdStatusIsActiveReviewCheckpoint(bdStatus)) return state;
	const bdState = workflowStateFromBdStatus(bdStatus);
	if (!bdState || bdState === state.state) return state;

	// `in_progress` is bd's broad worker status and can coexist with Pi-local
	// planning/plan_approved state.  Later review/terminal statuses are
	// authoritative for lifecycle guards because they may be written by raw bd
	// commands or typed review tools during the same Pi session.  While Pi is in
	// the local `reviewing` phase, bd review checkpoint statuses are source-order
	// evidence and must not hide the active review-chain state from bash policy.
	if (bdState === "implementing") return state;

	return { ...state, state: bdState };
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

function latestWorkflowState(ctx: ExtensionContext): WorkflowStateSnapshot {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "workflow-state")
		.pop() as { data?: WorkflowStateSnapshot } | undefined;
	const state = last?.data ?? {};
	const scope = currentRecoveryScope(ctx.cwd);
	if (state.activeBead && state.state && state.state !== "idle") {
		const commentsText = getBdCommentsText(ctx.cwd, state.activeBead);
		if (hasForeignSessionOwnershipEvidence(commentsText, scope)) {
			return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
		}
		const hasCommentEvidence = hasSessionOwnershipEvidence(commentsText, scope);
		if (hasCommentEvidence || workflowStateHasCurrentScopeEvidence(state, scope)) {
			return reconcileWorkflowStateWithBdStatus(state, getBdIssue(ctx.cwd, state.activeBead)?.status);
		}
		return { ...state, activeBead: undefined, state: "idle", branch: scope.branch, worktreePath: scope.worktreePath, startCommit: scope.startCommit };
	}
	const recoveredBead = recoverableApprovedWorkflowBead(ctx.cwd, scope);
	if (!recoveredBead) return { ...state, branch: scope.branch };
	const issue = getBdIssue(ctx.cwd, recoveredBead);
	return {
		...state,
		activeBead: recoveredBead,
		state: workflowStateFromBdStatus(issue?.status) ?? "implementing",
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

	if (/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/.test(command)) {
		return {
			policy: "blockGitAddAll",
			block: true,
			reason: "Blocked: use explicit file paths instead of git add . / -A / --all.",
		};
	}

	const isPlanning = workflowState.state === "planning" || workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (commandHasMutatingBd(command) || commandHasMutatingGitOrFs(command))) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; only read-only commands are allowed.",
		};
	}

	if ((commandHasMainLocalMutation(command) || commandHasProtectedBranchFsMutation(command)) && isProtectedBranch(commandCwd)) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: "Blocked: file mutations and git add/stage/commit on main/master are not allowed. Use a feature branch or approved merge/release workflow.",
		};
	}

	const invalidWorktree = invalidWorktreePath(command, commandCwd);
	if (invalidWorktree) {
		return {
			policy: "blockWorktreeInsideRepo",
			block: true,
			reason: `Blocked: worktree path must be under ${WORKTREE_ROOT}; got ${invalidWorktree}.`,
		};
	}

	const staleDecision = evaluateStaleGuard(command, commandCwd);
	if (staleDecision) return staleDecision;

	const fastPathDecision = evaluateFastPathDiscipline(command, commandCwd, workflowState);
	if (fastPathDecision) return fastPathDecision;

	if (
		commandHasGitPush(command) &&
		!workflowState.mergeSlotHeld &&
		!commandAcquiresMergeSlotBeforePush(command) &&
		!currentActorHoldsBdMergeSlot(commandCwd, options)
	) {
		return {
			policy: "requireMergeSlotForPush",
			block: true,
			reason: "Blocked: git push requires bd merge-slot acquire first (or workflow state mergeSlotHeld=true or current bd merge-slot holder evidence).",
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
			reason: "Blocked: supervisor contexts cannot close beads, set orchestrator statuses, or push.",
		};
	}

	const closeId = terminalCloseId(command);
	const incompleteChildren = closeId ? incompleteEpicChildren(commandCwd, closeId) : undefined;
	if (incompleteChildren) {
		return {
			policy: "blockEpicCloseWithIncompleteChildren",
			block: true,
			reason: `Blocked: epic ${closeId} cannot be completed while child beads are not closed (${formatIncompleteChildren(incompleteChildren)}). Close children first or use an explicit documented policy override.`,
		};
	}

	// Per-task bead closure is allowed before merge-to-main in multi-task sessions.
	// Session-final merge evidence is enforced by merge-to-main/final verdict workflows,
	// not by blocking every accepted bead close on a feature branch.
	if ((commandClosesBead(command) || commandDirectlySetsClosed(command)) && !canCloseByReviewState(command, commandCwd, workflowState)) {
		return {
			policy: "blockBdCloseWithoutReview",
			block: true,
			reason: "Blocked: terminal close requires accepted status/workflow state, or reviewed with documented no-acceptance shortcut, or an explicit policy override.",
		};
	}

	const transition = reviewCheckpointTransition(command);
	const invalidReviewTransition = validateReviewTransitionForCommand(command, commandCwd);
	const hasReviewWorkflowState = Boolean(
		transition &&
			workflowState.activeBead === transition.id &&
			workflowState.state === "reviewing"
	);
	if (transition && (!hasReviewWorkflowState || invalidReviewTransition)) {
		return {
			policy: "validateReviewChain",
			block: true,
			reason: invalidReviewTransition ?? "Blocked: orchestrator review statuses require current same-bead reviewing workflow state.",
		};
	}

	return undefined;
}

export function evaluateToolPolicy(toolName: string, input: Record<string, unknown>, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	if (toolName === "dispatch_supervisor") return activeBeadLifecycleDecision(String(input.beadId ?? ""), "dispatch supervisor", workflowState);
	if (toolName === "review_bead") return activeBeadLifecycleDecision(String(input.beadId ?? ""), "review", workflowState);
	return undefined;
}

export function evaluatePathPolicy(toolName: string, targetPath: string, workflowState: WorkflowStateSnapshot = {}): PolicyDecision | undefined {
	const normalizedPath = targetPath.replace(/\\/g, "/");
	if (PROTECTED_PATHS.some((protectedPath) => normalizedPath.includes(protectedPath))) {
		return {
			policy: "protectPaths",
			block: true,
			reason: `Blocked: ${targetPath} is protected.`,
		};
	}

	const isPlanning = workflowState.state === "planning" || workflowState.planMode === "strict" || workflowState.planMode === "auto";
	if (isPlanning && (toolName === "edit" || toolName === "write")) {
		return {
			policy: "blockMutationsInPlanning",
			block: true,
			reason: "Blocked: workflow is in planning mode; edit/write are disabled.",
		};
	}

	if ((toolName === "edit" || toolName === "write") && PROTECTED_BRANCHES.has(getBranchForPath(targetPath) ?? "")) {
		return {
			policy: "blockMainMutation",
			block: true,
			reason: `Blocked: edit/write on main/master is not allowed for ${targetPath}. Use a feature branch or external worktree.`,
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

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const decision = applySkip(evaluateBashPolicy(command, workflowState, { cwd: ctx.cwd }));
			if (decision?.block) return toToolBlock(decision);
			if (decision) ctx.ui.notify(`[${decision.policy}] ${decision.reason}`, "warning");
			return undefined;
		}

		const toolDecision = applySkip(evaluateToolPolicy(event.toolName, event.input as Record<string, unknown>, workflowState));
		if (toolDecision?.block) return toToolBlock(toolDecision);

		if (event.toolName === "edit" || event.toolName === "write") {
			const targetPath = String(event.input.path ?? "");
			const decision = applySkip(evaluatePathPolicy(event.toolName, targetPath, workflowState));
			if (decision?.block) return toToolBlock(decision);
		}

		return undefined;
	});

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		ctx.ui.setStatus("beads-policy", ctx.ui.theme.fg("dim", "policy:on"));
	});

	pi.registerCommand("policy-status", {
		description: "Show active Pi beads policy engine status and overrides",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const skipped = [...getSkipPolicies()].join(", ") || "none";
			ctx.ui.notify(`Beads policy engine active. Overrides: ${skipped}`, "info");
		},
	});
}
