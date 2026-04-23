import type { Issue } from '~/types/issue'

export type NotifyToastKey = 'closed' | 'reopened' | 'inreview' | 'blocked' | 'inProgress'

export type NotifyEvent =
  | { kind: 'created'; id: string; title: string }
  | { kind: 'deleted'; id: string; title: string }
  | { kind: 'statusTransition'; id: string; title: string; from: string; to: string; toastKey: NotifyToastKey | null }

/**
 * Compute notification events by diffing two issue snapshots.
 *
 * Rules:
 * - id in newIssues but not in oldIssues → created
 * - id in oldIssues but not in newIssues → deleted
 * - same id, status changed → statusTransition (toastKey may be null if transition is not noteworthy)
 *
 * Noteworthy status transitions:
 * - any → closed      → toastKey='closed'
 * - closed → any      → toastKey='reopened'
 * - any → inreview    → toastKey='inreview'
 * - any → blocked     → toastKey='blocked'
 * - any → in_progress → toastKey='inProgress'
 *
 * Field-only changes (title/priority/etc. without status change) produce no events.
 */
export function computeNotifyEvents(oldIssues: Issue[], newIssues: Issue[]): NotifyEvent[] {
  const events: NotifyEvent[] = []

  const oldMap = new Map(oldIssues.map(i => [i.id, i]))
  const newMap = new Map(newIssues.map(i => [i.id, i]))

  // Created: present in new, absent in old
  for (const issue of newIssues) {
    if (!oldMap.has(issue.id)) {
      events.push({ kind: 'created', id: issue.id, title: issue.title })
    }
  }

  // Deleted: present in old, absent in new
  for (const issue of oldIssues) {
    if (!newMap.has(issue.id)) {
      events.push({ kind: 'deleted', id: issue.id, title: issue.title })
    }
  }

  // Status transitions: same id, different status
  for (const issue of newIssues) {
    const old = oldMap.get(issue.id)
    if (!old || old.status === issue.status) continue

    const toastKey = resolveToastKey(old.status, issue.status)
    events.push({
      kind: 'statusTransition',
      id: issue.id,
      title: issue.title,
      from: old.status,
      to: issue.status,
      toastKey,
    })
  }

  return events
}

function resolveToastKey(from: string, to: string): NotifyToastKey | null {
  if (to === 'closed') return 'closed'
  if (from === 'closed') return 'reopened'
  if (to === 'inreview') return 'inreview'
  if (to === 'blocked') return 'blocked'
  if (to === 'in_progress') return 'inProgress'
  return null
}
