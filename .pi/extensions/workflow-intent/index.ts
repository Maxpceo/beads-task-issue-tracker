interface ExtensionAPI {
	log?: { debug?: (message: string) => void };
}

export default function workflowIntentExtension(_pi: ExtensionAPI): { name: string } {
	return { name: "workflow-intent" };
}

export interface WorkflowIntent {
	beadId?: string;
	beadIds: string[];
	wantsClaim: boolean;
	wantsPlan: boolean;
	blockedReason?: "question" | "multiple-beads" | "negated";
}

const BEAD_ID_PATTERN = /\bbeads-task-issue-tracker-[a-z0-9][a-z0-9.-]*\b/giu;

function stripFencedCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ");
}

function normalizeIntentText(text: string): string {
	return stripFencedCodeBlocks(text)
		.toLocaleLowerCase("ru-RU")
		.replace(/ё/g, "е")
		.replace(/[“”«»]/g, '"')
		.replace(/[.,!…:;()[\]{}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

const WORD_LEFT = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_RIGHT = String.raw`(?![\p{L}\p{N}_])`;

function hasClaimIntent(normalized: string): boolean {
	return new RegExp(`${WORD_LEFT}(?:возьми|взять|бери|забери|начни|стартуй|делай|выполняй|работай|заклейми|клейми|claim|start|begin|take|work\\s+on)${WORD_RIGHT}`, "u").test(normalized);
}

function hasPlanIntent(normalized: string): boolean {
	return new RegExp(`(?:${WORD_LEFT}режим(?:е)?\\s+планирования${WORD_RIGHT}|${WORD_LEFT}в\\s+планировании${WORD_RIGHT}|${WORD_LEFT}планируй${WORD_RIGHT}|${WORD_LEFT}сначала\\s+план${WORD_RIGHT}|${WORD_LEFT}план\\s+сначала${WORD_RIGHT}|${WORD_LEFT}plan\\s+mode${WORD_RIGHT}|${WORD_LEFT}planning\\s+mode${WORD_RIGHT}|${WORD_LEFT}plan\\s+first${WORD_RIGHT})`, "u").test(normalized);
}

function hasNegatedClaimIntent(normalized: string): boolean {
	return new RegExp(`${WORD_LEFT}не\\s+(?:возьми|бери|забери|начинай|начни|стартуй|делай|выполняй|работай|заклейми|клейми)${WORD_RIGHT}`, "u").test(normalized) || new RegExp(`${WORD_LEFT}(?:do\\s+not|don't|dont)\\s+(?:claim|start|begin|take|work\\s+on)${WORD_RIGHT}`, "u").test(normalized);
}

function isQuestionLike(text: string, normalized: string): boolean {
	return /[?？]/u.test(text) || new RegExp(`${WORD_LEFT}(?:можно\\s+ли|надо\\s+ли|стоит\\s+ли|как\\s+бы|should\\s+i|can\\s+you|could\\s+you)${WORD_RIGHT}`, "u").test(normalized);
}

export function parseWorkflowIntent(text: string): WorkflowIntent {
	const searchable = stripFencedCodeBlocks(text);
	const beadIds = unique([...searchable.matchAll(BEAD_ID_PATTERN)].map((match) => match[0]));
	const normalized = normalizeIntentText(text);
	const wantsClaim = hasClaimIntent(normalized);
	const wantsPlan = hasPlanIntent(normalized);

	if (isQuestionLike(text, normalized)) return { beadIds, beadId: beadIds[0], wantsClaim, wantsPlan, blockedReason: "question" };
	if (beadIds.length > 1) return { beadIds, wantsClaim, wantsPlan, blockedReason: "multiple-beads" };
	if (wantsClaim && hasNegatedClaimIntent(normalized)) return { beadIds, beadId: beadIds[0], wantsClaim, wantsPlan, blockedReason: "negated" };

	return { beadIds, beadId: beadIds[0], wantsClaim, wantsPlan };
}

export function shouldAutoClaim(intent: WorkflowIntent): intent is WorkflowIntent & { beadId: string } {
	return Boolean(intent.beadId && intent.wantsClaim && !intent.blockedReason);
}

export function shouldAutoClaimAndPlan(intent: WorkflowIntent): intent is WorkflowIntent & { beadId: string } {
	return shouldAutoClaim(intent) && intent.wantsPlan;
}
