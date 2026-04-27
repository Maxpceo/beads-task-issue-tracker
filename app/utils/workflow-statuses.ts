import type { IssueStatus } from '~/types/issue'
import type { StatusMeta } from '~/composables/useStatuses'

const WORKFLOW_CATEGORIES: ReadonlySet<StatusMeta['category']> = new Set(['active', 'wip', 'frozen'])
const WIP_CATEGORIES: ReadonlySet<StatusMeta['category']> = new Set(['wip'])

/**
 * Built-in review-chain statuses. Used as a guard in KPI helpers to prevent
 * review statuses from appearing in Open/In Progress counts even if bd
 * unexpectedly assigns them to the wrong category in the future.
 */
export const REVIEW_CHAIN_STATUSES = ['inreview', 'simplified', 'reviewed', 'accepted'] as const
export const REVIEW_SET: ReadonlySet<string> = new Set(REVIEW_CHAIN_STATUSES)

export function computeWorkflowStatuses(statuses: StatusMeta[]): IssueStatus[] {
  const out = new Set<IssueStatus>()
  for (const s of statuses) {
    if (WORKFLOW_CATEGORIES.has(s.category)) out.add(s.name as IssueStatus)
  }
  return [...out]
}

export function computeWipStatuses(statuses: StatusMeta[]): IssueStatus[] {
  const out = new Set<IssueStatus>()
  for (const s of statuses) {
    if (WIP_CATEGORIES.has(s.category)) out.add(s.name as IssueStatus)
  }
  return [...out]
}

/**
 * Statuses that map to the "Open" KPI card (category=active, excluding review-chain).
 */
export function computeActiveStatuses(statuses: StatusMeta[]): IssueStatus[] {
  return statuses
    .filter(s => s.category === 'active' && !REVIEW_SET.has(s.name))
    .map(s => s.name as IssueStatus)
}

/**
 * Statuses that map to the "In Progress" KPI card (category=wip, excluding blocked and review-chain).
 */
export function computeInProgressKpiStatuses(statuses: StatusMeta[]): IssueStatus[] {
  return statuses
    .filter(s => s.category === 'wip' && s.name !== 'blocked' && !REVIEW_SET.has(s.name))
    .map(s => s.name as IssueStatus)
}

/**
 * Statuses that map to the "Deferred" KPI card (category=frozen, excluding pinned).
 */
export function computeFrozenKpiStatuses(statuses: StatusMeta[]): IssueStatus[] {
  return statuses
    .filter(s => s.category === 'frozen' && s.name !== 'pinned')
    .map(s => s.name as IssueStatus)
}

/**
 * Statuses that map to the "Done" KPI card (category=done).
 */
export function computeDoneStatuses(statuses: StatusMeta[]): IssueStatus[] {
  return statuses
    .filter(s => s.category === 'done')
    .map(s => s.name as IssueStatus)
}
