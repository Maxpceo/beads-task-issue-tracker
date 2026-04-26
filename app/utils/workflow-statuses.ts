import type { IssueStatus } from '~/types/issue'
import type { StatusMeta } from '~/composables/useStatuses'

const WORKFLOW_CATEGORIES: ReadonlySet<StatusMeta['category']> = new Set(['active', 'wip', 'frozen'])
const WIP_CATEGORIES: ReadonlySet<StatusMeta['category']> = new Set(['wip'])

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
