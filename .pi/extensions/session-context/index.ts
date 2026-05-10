import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Snapshot {
	branch: string;
	gitStatus: string;
	inProgress: string;
	inReview: string;
	worktrees: string;
	createdAt: string;
}

async function run(pi: ExtensionAPI, command: string, args: string[]): Promise<string> {
	const { stdout, stderr, code } = await pi.exec(command, args);
	if (code !== 0) return `(exit ${code}) ${stderr || stdout}`.trim();
	return stdout.trim() || "-";
}

function truncate(text: string, maxLines = 40): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return [...lines.slice(0, maxLines), `... truncated ${lines.length - maxLines} lines`].join("\n");
}

function renderSnapshot(snapshot: Snapshot): string {
	return `[PI SESSION START CONTEXT]
Created: ${snapshot.createdAt}

Branch:
${snapshot.branch}

Git status --short:
${truncate(snapshot.gitStatus, 30)}

bd in_progress:
${truncate(snapshot.inProgress, 30)}

bd inreview:
${truncate(snapshot.inReview, 30)}

Git worktrees:
${truncate(snapshot.worktrees, 30)}

Use this context to resume interrupted Pi workflow. For details, read .pi/plans/pi-native-workflow-migration.md and inspect active beads.`;
}

export default function sessionContextExtension(pi: ExtensionAPI): void {
	let snapshot: Snapshot | undefined;

	pi.on("session_start", async (_event, ctx) => {
		snapshot = {
			branch: await run(pi, "git", ["branch", "--show-current"]),
			gitStatus: await run(pi, "git", ["status", "--short"]),
			inProgress: await run(pi, "bd", ["list", "--status=in_progress"]),
			inReview: await run(pi, "bd", ["list", "--status=inreview"]),
			worktrees: await run(pi, "git", ["worktree", "list", "--porcelain"]),
			createdAt: new Date().toISOString(),
		};
		ctx.ui.notify("Pi session context captured", "info");
	});

	pi.on("before_agent_start", async () => {
		if (!snapshot) return undefined;
		return {
			message: {
				customType: "pi-session-context",
				content: renderSnapshot(snapshot),
				display: false,
			},
		};
	});

	pi.registerCommand("session-context", {
		description: "Show captured Pi session-start context",
		handler: async (_args, ctx) => {
			if (!snapshot) {
				ctx.ui.notify("No session context captured yet", "warning");
				return;
			}
			ctx.ui.notify(renderSnapshot(snapshot), "info");
		},
	});
}
