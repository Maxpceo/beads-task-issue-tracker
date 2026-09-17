/**
 * Live smoke fixture for beads-task-issue-tracker-x2ap.
 *
 * Purpose: prove a spawned supervisor child can commit more than 80 added
 * lines under the 3o7e spawned-supervisor fast-path exemption.
 *
 * This file is intentionally large enough to cross the Fast Path threshold
 * while remaining inert TypeScript that is never imported by production code.
 */

/** Smoke marker identifying this fixture in git history and review evidence. */
export const X2AP_LIVE_SMOKE_MARKER = 'beads-task-issue-tracker-x2ap' as const

/** Human-readable smoke title used only in comments and type docs. */
export const X2AP_LIVE_SMOKE_TITLE =
  'Live smoke: supervisor child commit >80 lines' as const

/** Minimum added-line target required by the approved plan. */
export const X2AP_MIN_ADDED_LINES = 100 as const

/** Fast Path discipline threshold that this fixture is designed to exceed. */
export const X2AP_FAST_PATH_LINE_THRESHOLD = 80 as const

/**
 * Structured metadata for the live smoke run.
 * Keep fields stable so reviewers can grep the fixture by name.
 */
export interface X2apLiveSmokeMeta {
  /** Bead id under test. */
  beadId: typeof X2AP_LIVE_SMOKE_MARKER
  /** Short title for logs and digest text. */
  title: typeof X2AP_LIVE_SMOKE_TITLE
  /** Required minimum insertions for acceptance. */
  minAddedLines: typeof X2AP_MIN_ADDED_LINES
  /** Policy threshold the commit must exceed. */
  fastPathLineThreshold: typeof X2AP_FAST_PATH_LINE_THRESHOLD
  /** Fixture path relative to repo root. */
  relativePath: 'tests/fixtures/x2ap-live-smoke-fixture.ts'
  /** Role expected to author the commit. */
  authorRole: 'test-supervisor'
  /** Transport used for the visible spawn. */
  transport: 'cmux'
}

/** Default metadata object for the smoke fixture. */
export const x2apLiveSmokeMeta: X2apLiveSmokeMeta = {
  beadId: X2AP_LIVE_SMOKE_MARKER,
  title: X2AP_LIVE_SMOKE_TITLE,
  minAddedLines: X2AP_MIN_ADDED_LINES,
  fastPathLineThreshold: X2AP_FAST_PATH_LINE_THRESHOLD,
  relativePath: 'tests/fixtures/x2ap-live-smoke-fixture.ts',
  authorRole: 'test-supervisor',
  transport: 'cmux',
}

/** Phase labels used only to bulk out the fixture with typed constants. */
export type X2apSmokePhase =
  | 'plan-approved'
  | 'dispatch'
  | 'fixture-write'
  | 'commit'
  | 'artifact'
  | 'ping'
  | 'review'

/** Ordered smoke phases for documentation-only iteration. */
export const X2AP_SMOKE_PHASES: readonly X2apSmokePhase[] = [
  'plan-approved',
  'dispatch',
  'fixture-write',
  'commit',
  'artifact',
  'ping',
  'review',
] as const

/** Returns true when the given phase is part of the smoke sequence. */
export function isX2apSmokePhase(value: string): value is X2apSmokePhase {
  return (X2AP_SMOKE_PHASES as readonly string[]).includes(value)
}

/** Pad lines: describe acceptance bullets as typed string constants. */
export const X2AP_ACCEPTANCE_BULLET_01 = 'commit insertions exceed 80'
export const X2AP_ACCEPTANCE_BULLET_02 = 'explicit path only staged'
export const X2AP_ACCEPTANCE_BULLET_03 = 'no fast-path skip env set'
export const X2AP_ACCEPTANCE_BULLET_04 = 'no .pi/ files modified'
export const X2AP_ACCEPTANCE_BULLET_05 = 'no git push performed'
export const X2AP_ACCEPTANCE_BULLET_06 = 'no bd write from supervisor'
export const X2AP_ACCEPTANCE_BULLET_07 = 'supervisor artifact includes SHA'
export const X2AP_ACCEPTANCE_BULLET_08 = 'git show --stat evidence recorded'
export const X2AP_ACCEPTANCE_BULLET_09 = 'fixture remains valid TypeScript'
export const X2AP_ACCEPTANCE_BULLET_10 = 'write zone limited to this file'

/** Bundle acceptance bullets for greppable evidence. */
export const X2AP_ACCEPTANCE_BULLETS: readonly string[] = [
  X2AP_ACCEPTANCE_BULLET_01,
  X2AP_ACCEPTANCE_BULLET_02,
  X2AP_ACCEPTANCE_BULLET_03,
  X2AP_ACCEPTANCE_BULLET_04,
  X2AP_ACCEPTANCE_BULLET_05,
  X2AP_ACCEPTANCE_BULLET_06,
  X2AP_ACCEPTANCE_BULLET_07,
  X2AP_ACCEPTANCE_BULLET_08,
  X2AP_ACCEPTANCE_BULLET_09,
  X2AP_ACCEPTANCE_BULLET_10,
] as const

/** Additional inert string rows to guarantee line count > 100. */
export const X2AP_PAD_ROW_001 = 'pad-row-001-supervisor-live-smoke'
export const X2AP_PAD_ROW_002 = 'pad-row-002-supervisor-live-smoke'
export const X2AP_PAD_ROW_003 = 'pad-row-003-supervisor-live-smoke'
export const X2AP_PAD_ROW_004 = 'pad-row-004-supervisor-live-smoke'
export const X2AP_PAD_ROW_005 = 'pad-row-005-supervisor-live-smoke'
export const X2AP_PAD_ROW_006 = 'pad-row-006-supervisor-live-smoke'
export const X2AP_PAD_ROW_007 = 'pad-row-007-supervisor-live-smoke'
export const X2AP_PAD_ROW_008 = 'pad-row-008-supervisor-live-smoke'
export const X2AP_PAD_ROW_009 = 'pad-row-009-supervisor-live-smoke'
export const X2AP_PAD_ROW_010 = 'pad-row-010-supervisor-live-smoke'
export const X2AP_PAD_ROW_011 = 'pad-row-011-supervisor-live-smoke'
export const X2AP_PAD_ROW_012 = 'pad-row-012-supervisor-live-smoke'
export const X2AP_PAD_ROW_013 = 'pad-row-013-supervisor-live-smoke'
export const X2AP_PAD_ROW_014 = 'pad-row-014-supervisor-live-smoke'
export const X2AP_PAD_ROW_015 = 'pad-row-015-supervisor-live-smoke'
export const X2AP_PAD_ROW_016 = 'pad-row-016-supervisor-live-smoke'
export const X2AP_PAD_ROW_017 = 'pad-row-017-supervisor-live-smoke'
export const X2AP_PAD_ROW_018 = 'pad-row-018-supervisor-live-smoke'
export const X2AP_PAD_ROW_019 = 'pad-row-019-supervisor-live-smoke'
export const X2AP_PAD_ROW_020 = 'pad-row-020-supervisor-live-smoke'
export const X2AP_PAD_ROW_021 = 'pad-row-021-supervisor-live-smoke'
export const X2AP_PAD_ROW_022 = 'pad-row-022-supervisor-live-smoke'
export const X2AP_PAD_ROW_023 = 'pad-row-023-supervisor-live-smoke'
export const X2AP_PAD_ROW_024 = 'pad-row-024-supervisor-live-smoke'
export const X2AP_PAD_ROW_025 = 'pad-row-025-supervisor-live-smoke'
export const X2AP_PAD_ROW_026 = 'pad-row-026-supervisor-live-smoke'
export const X2AP_PAD_ROW_027 = 'pad-row-027-supervisor-live-smoke'
export const X2AP_PAD_ROW_028 = 'pad-row-028-supervisor-live-smoke'
export const X2AP_PAD_ROW_029 = 'pad-row-029-supervisor-live-smoke'
export const X2AP_PAD_ROW_030 = 'pad-row-030-supervisor-live-smoke'
export const X2AP_PAD_ROW_031 = 'pad-row-031-supervisor-live-smoke'
export const X2AP_PAD_ROW_032 = 'pad-row-032-supervisor-live-smoke'
export const X2AP_PAD_ROW_033 = 'pad-row-033-supervisor-live-smoke'
export const X2AP_PAD_ROW_034 = 'pad-row-034-supervisor-live-smoke'
export const X2AP_PAD_ROW_035 = 'pad-row-035-supervisor-live-smoke'
export const X2AP_PAD_ROW_036 = 'pad-row-036-supervisor-live-smoke'
export const X2AP_PAD_ROW_037 = 'pad-row-037-supervisor-live-smoke'
export const X2AP_PAD_ROW_038 = 'pad-row-038-supervisor-live-smoke'
export const X2AP_PAD_ROW_039 = 'pad-row-039-supervisor-live-smoke'
export const X2AP_PAD_ROW_040 = 'pad-row-040-supervisor-live-smoke'

/** Collect pad rows so the module exports a usable array. */
export const X2AP_PAD_ROWS: readonly string[] = [
  X2AP_PAD_ROW_001,
  X2AP_PAD_ROW_002,
  X2AP_PAD_ROW_003,
  X2AP_PAD_ROW_004,
  X2AP_PAD_ROW_005,
  X2AP_PAD_ROW_006,
  X2AP_PAD_ROW_007,
  X2AP_PAD_ROW_008,
  X2AP_PAD_ROW_009,
  X2AP_PAD_ROW_010,
  X2AP_PAD_ROW_011,
  X2AP_PAD_ROW_012,
  X2AP_PAD_ROW_013,
  X2AP_PAD_ROW_014,
  X2AP_PAD_ROW_015,
  X2AP_PAD_ROW_016,
  X2AP_PAD_ROW_017,
  X2AP_PAD_ROW_018,
  X2AP_PAD_ROW_019,
  X2AP_PAD_ROW_020,
  X2AP_PAD_ROW_021,
  X2AP_PAD_ROW_022,
  X2AP_PAD_ROW_023,
  X2AP_PAD_ROW_024,
  X2AP_PAD_ROW_025,
  X2AP_PAD_ROW_026,
  X2AP_PAD_ROW_027,
  X2AP_PAD_ROW_028,
  X2AP_PAD_ROW_029,
  X2AP_PAD_ROW_030,
  X2AP_PAD_ROW_031,
  X2AP_PAD_ROW_032,
  X2AP_PAD_ROW_033,
  X2AP_PAD_ROW_034,
  X2AP_PAD_ROW_035,
  X2AP_PAD_ROW_036,
  X2AP_PAD_ROW_037,
  X2AP_PAD_ROW_038,
  X2AP_PAD_ROW_039,
  X2AP_PAD_ROW_040,
] as const

/** Count helper used only to keep the fixture self-describing. */
export function countX2apPadRows(): number {
  return X2AP_PAD_ROWS.length
}

/** Returns fixture relative path for artifact text. */
export function x2apFixtureRelativePath(): X2apLiveSmokeMeta['relativePath'] {
  return x2apLiveSmokeMeta.relativePath
}

/** Returns true when pad volume alone already exceeds the Fast Path threshold. */
export function x2apPadExceedsFastPathThreshold(): boolean {
  return countX2apPadRows() > X2AP_FAST_PATH_LINE_THRESHOLD
}

/** Final exported summary object for optional import in future smoke helpers. */
export const x2apLiveSmokeSummary = {
  marker: X2AP_LIVE_SMOKE_MARKER,
  title: X2AP_LIVE_SMOKE_TITLE,
  minAddedLines: X2AP_MIN_ADDED_LINES,
  fastPathLineThreshold: X2AP_FAST_PATH_LINE_THRESHOLD,
  phaseCount: X2AP_SMOKE_PHASES.length,
  acceptanceCount: X2AP_ACCEPTANCE_BULLETS.length,
  padRowCount: X2AP_PAD_ROWS.length,
  relativePath: x2apFixtureRelativePath(),
} as const
