import type { IssueStatus } from '~/types/issue'
import type { StatusMeta } from '~/composables/useStatuses'

const WORKFLOW_CATEGORIES: ReadonlySet<StatusMeta['category']> = new Set(['active', 'wip', 'frozen'])

export function computeWorkflowStatuses(statuses: StatusMeta[]): IssueStatus[] {
  const out = new Set<IssueStatus>()
  for (const s of statuses) {
    if (WORKFLOW_CATEGORIES.has(s.category)) out.add(s.name as IssueStatus)
  }
  return [...out]
}
