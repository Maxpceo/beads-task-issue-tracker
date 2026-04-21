/**
 * Pure helper functions for issue data manipulation.
 * Extracted from useIssues composable for testability.
 */
import type { Issue, DashboardStats, IssueType, IssuePriority, ChildIssue } from '~/types/issue'
import type { IssueGroup } from '~/composables/useIssues'

/**
 * Deduplicate issues by ID, keeping the most recently updated version.
 */
export function deduplicateIssues(issues: Issue[]): Issue[] {
  const issueMap = new Map<string, Issue>()

  for (const issue of issues) {
    const existing = issueMap.get(issue.id)

    if (!existing) {
      issueMap.set(issue.id, issue)
    } else {
      const existingDate = new Date(existing.updatedAt).getTime()
      const currentDate = new Date(issue.updatedAt).getTime()

      if (currentDate > existingDate) {
        issueMap.set(issue.id, issue)
      }
    }
  }

  return Array.from(issueMap.values())
}

/**
 * Populate `parent` (derived from explicit link or dot-notation ID) and
 * aggregate `children` lists on epics, using only the data in the given array.
 *
 * Mutates issues in place. Used by fetchIssues / fetchPollData / warmUpFromCache
 * to rebuild hierarchy without issuing extra `bd show` calls.
 */
export function linkParentsAndChildren(issues: Issue[]): void {
  const issueMap = new Map(issues.map(i => [i.id, i]))

  // Fill in parent details (derive from ID pattern if not explicitly set).
  for (const issue of issues) {
    const parentId = getParentIdFromIssue(issue)
    if (!parentId) continue
    const parentIssue = issueMap.get(parentId)
    if (!parentIssue) continue
    issue.parent = {
      id: parentIssue.id,
      title: parentIssue.title,
      status: parentIssue.status,
      priority: parentIssue.priority,
    }
  }

  // Aggregate children per epic.
  const childrenByParent = new Map<string, ChildIssue[]>()
  for (const issue of issues) {
    if (!issue.parent?.id) continue
    let list = childrenByParent.get(issue.parent.id)
    if (!list) {
      list = []
      childrenByParent.set(issue.parent.id, list)
    }
    list.push({ id: issue.id, title: issue.title, status: issue.status, priority: issue.priority })
  }
  for (const [epicId, children] of childrenByParent) {
    const epic = issueMap.get(epicId)
    if (epic) epic.children = children
  }
}

/**
 * Remove closed issue IDs from dependency references.
 *
 * `bd list/show` can return stale `blockedBy`/`blocks` links after a blocker is
 * closed. Pruning them here keeps status-column blocker indicators accurate.
 */
export function pruneClosedBlockers(issues: Issue[]): void {
  const closedIds = new Set(
    issues
      .filter(issue => issue.status === 'closed')
      .map(issue => issue.id),
  )

  if (closedIds.size === 0) return

  for (const issue of issues) {
    if (issue.blockedBy?.length) {
      const activeBlockers = issue.blockedBy.filter(id => !closedIds.has(id))
      issue.blockedBy = activeBlockers.length ? activeBlockers : undefined
    }

    if (issue.blocks?.length) {
      const activeBlockedIssues = issue.blocks.filter(id => !closedIds.has(id))
      issue.blocks = activeBlockedIssues.length ? activeBlockedIssues : undefined
    }
  }
}

/**
 * Determine whether an issue should appear in blocked views.
 *
 * Supports both explicit blocked status and dependency-based blockers
 * (`blockedBy`) while ignoring closed issues.
 */
export function isIssueBlocked(issue: Pick<Issue, 'status' | 'blockedBy'>): boolean {
  if (issue.status === 'blocked') return true
  if (!issue.blockedBy?.length) return false
  return issue.status !== 'closed'
}

/**
 * Determine whether an issue belongs in the WORKFLOW view.
 *
 * WORKFLOW includes everything except closed/deleted/tombstone — blocked
 * issues are part of the workflow (they remain in the work pipeline, just
 * currently waiting to be unblocked). Matches `computeWorkflowStatuses`
 * (categories active/wip/frozen), where `blocked` sits in `wip`.
 */
export function isIssueWorkflow(issue: Pick<Issue, 'status' | 'blockedBy'>): boolean {
  const status = issue.status as string
  return status !== 'closed' && status !== 'deleted' && status !== 'tombstone'
}

/**
 * Natural sort comparison for IDs (handles multi-digit numbers correctly).
 * e.g., "40b.2" < "40b.10" instead of "40b.10" < "40b.2"
 */
export function naturalCompare(a: string, b: string): number {
  const aParts = a.split(/(\d+)/)
  const bParts = b.split(/(\d+)/)

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || ''
    const bPart = bParts[i] || ''

    const aNum = parseInt(aPart, 10)
    const bNum = parseInt(bPart, 10)

    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum
    } else {
      if (aPart < bPart) return -1
      if (aPart > bPart) return 1
    }
  }
  return 0
}

/**
 * Get parent ID from an issue — uses explicit parent.id if available,
 * falls back to dot notation pattern (e.g., "abc.1" → "abc").
 */
export function getParentIdFromIssue(issue: Issue): string | null {
  if (issue.parent?.id) {
    return issue.parent.id
  }

  const lastDotIndex = issue.id.lastIndexOf('.')
  if (lastDotIndex === -1) return null

  const suffix = issue.id.slice(lastDotIndex + 1)
  if (/^\d+$/.test(suffix)) {
    return issue.id.slice(0, lastDotIndex)
  }
  return null
}

/**
 * Compare child issues by ID suffix (ascending), falling back to createdAt.
 */
export function compareChildIssues(a: Issue, b: Issue): number {
  const getSuffix = (id: string): number | null => {
    const lastDotIndex = id.lastIndexOf('.')
    if (lastDotIndex === -1) return null
    const suffix = id.slice(lastDotIndex + 1)
    return /^\d+$/.test(suffix) ? parseInt(suffix, 10) : null
  }

  const suffixA = getSuffix(a.id)
  const suffixB = getSuffix(b.id)

  if (suffixA !== null && suffixB !== null) return suffixA - suffixB
  if (suffixA !== null) return -1
  if (suffixB !== null) return 1

  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

/** Category rank for floating active tasks to top (wip first, done last) */
export const categoryRank: Record<string, number> = {
  wip: 0,
  active: 1,
  frozen: 2,
  done: 3,
}

/** Sort orders for status, priority, and type fields */
export const statusOrder: Record<string, number> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
  closed: 3,
}

export const priorityOrder: Record<string, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
}

export const typeOrder: Record<string, number> = {
  bug: 0,
  feature: 1,
  task: 2,
  epic: 3,
  chore: 4,
}

/**
 * Sort issues by a given field and direction.
 * Pinned issues always float to the top regardless of sort field/direction.
 * Within pinned and non-pinned partitions, the requested sort applies normally.
 * Returns a new sorted array (does not mutate input).
 */
export function sortIssues(
  issues: Issue[],
  field: string | null,
  direction: 'asc' | 'desc',
  pinnedIds?: string[],
  options?: { floatActive?: boolean; resolveCategory?: (status: string) => string | undefined }
): Issue[] {
  const pinnedSet = new Set(pinnedIds || [])
  const resolveCategory = options?.floatActive ? options.resolveCategory : undefined
  const rankOf = (issue: Issue): number =>
    categoryRank[resolveCategory!(issue.status) ?? 'active'] ?? 1

  // No sort field: just float pinned to top (and optionally by category), keep original order otherwise
  if (!field) {
    if (pinnedSet.size === 0 && !resolveCategory) return issues
    const pinned = issues.filter(i => pinnedSet.has(i.id))
    const rest = issues.filter(i => !pinnedSet.has(i.id))
    if (resolveCategory) {
      pinned.sort((a, b) => rankOf(a) - rankOf(b))
      rest.sort((a, b) => rankOf(a) - rankOf(b))
    }
    return [...pinned, ...rest]
  }
  const sorted = [...issues]
  const dir = direction === 'asc' ? 1 : -1

  sorted.sort((a, b) => {
    // Tier 1: pinned issues always on top
    const aPinned = pinnedSet.has(a.id) ? 0 : 1
    const bPinned = pinnedSet.has(b.id) ? 0 : 1
    if (aPinned !== bPinned) return aPinned - bPinned

    // Tier 2: category rank (when floatActive enabled)
    if (resolveCategory) {
      const catDelta = rankOf(a) - rankOf(b)
      if (catDelta !== 0) return catDelta
    }

    // Tier 3: sort by requested field within each partition
    let aVal: string | number | null = null
    let bVal: string | number | null = null

    switch (field) {
      case 'id':
        return naturalCompare(a.id.toLowerCase(), b.id.toLowerCase()) * dir
      case 'status':
        aVal = statusOrder[a.status] ?? 99
        bVal = statusOrder[b.status] ?? 99
        break
      case 'priority':
        aVal = priorityOrder[a.priority] ?? 99
        bVal = priorityOrder[b.priority] ?? 99
        break
      case 'type':
        aVal = typeOrder[a.type] ?? 99
        bVal = typeOrder[b.type] ?? 99
        break
      case 'pinned':
        // Already partitioned above — sort by updatedAt within each group
        aVal = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
        bVal = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
        break
      case 'labels':
        aVal = a.labels?.length ? a.labels[0]!.toLowerCase() : '\uffff'
        bVal = b.labels?.length ? b.labels[0]!.toLowerCase() : '\uffff'
        break
      case 'createdAt':
      case 'updatedAt':
        aVal = a[field] ? new Date(a[field]).getTime() : 0
        bVal = b[field] ? new Date(b[field]).getTime() : 0
        break
      default:
        aVal = String(a[field as keyof Issue] ?? '').toLowerCase()
        bVal = String(b[field as keyof Issue] ?? '').toLowerCase()
    }

    if (aVal < bVal) return -1 * dir
    if (aVal > bVal) return 1 * dir
    return naturalCompare(a.id.toLowerCase(), b.id.toLowerCase())
  })

  return sorted
}

/**
 * Check if an issue matches a search term across 8 fields.
 * @param issue - The issue to check.
 * @param term - Already lowercased and trimmed search term. Empty string → false.
 */
export function matchesSearch(issue: Issue, term: string): boolean {
  if (!term) return false
  return (
    issue.id.toLowerCase().includes(term) ||
    issue.title.toLowerCase().includes(term) ||
    (issue.description?.toLowerCase().includes(term) ?? false) ||
    (issue.labels?.some(l => l.toLowerCase().includes(term)) ?? false) ||
    (issue.workingNotes?.toLowerCase().includes(term) ?? false) ||
    (issue.acceptanceCriteria?.toLowerCase().includes(term) ?? false) ||
    (issue.designNotes?.toLowerCase().includes(term) ?? false) ||
    (issue.comments?.some(c => c.content?.toLowerCase().includes(term)) ?? false)
  )
}

/**
 * Filter issues based on inclusion filters, exclusion filters, and search.
 */
export function filterIssues(
  issues: Issue[],
  filters: { status: string[]; type: string[]; priority: string[]; assignee: string[]; search: string; labels: string[] },
  exclusions: { status: string[]; priority: string[]; type: string[]; labels: string[]; assignee: string[] },
): Issue[] {
  // Global-search semantics (Jira/Linear): active search bypasses all
  // filters/exclusions so the user can locate issues hidden by the current view.
  const searchTerm = filters.search?.trim()
  if (searchTerm) {
    const search = searchTerm.toLowerCase()
    return issues.filter(issue => matchesSearch(issue, search))
  }

  let result = issues

  // Status filter (default: WORKFLOW view)
  if (filters.status.length > 0) {
    const includeBlocked = filters.status.includes('blocked')
    result = result.filter((issue) => {
      if (includeBlocked && isIssueBlocked(issue)) return true
      // Exclude dependency-blocked issues when 'blocked' is not in the filter
      if (!includeBlocked && isIssueBlocked(issue)) return false
      return filters.status.includes(issue.status)
    })
  } else {
    result = result.filter((issue) => isIssueWorkflow(issue))
  }

  if (filters.type.length > 0) {
    result = result.filter((issue) => filters.type.includes(issue.type))
  }

  if (filters.priority.length > 0) {
    result = result.filter((issue) => filters.priority.includes(issue.priority))
  }

  if (filters.assignee.length > 0) {
    result = result.filter((issue) => issue.assignee && filters.assignee.includes(issue.assignee))
  }

  // Labels: OR logic (issue must have AT LEAST ONE selected label)
  if (filters.labels.length > 0) {
    result = result.filter((issue) =>
      filters.labels.some(filterLabel =>
        issue.labels?.some(l => l.toLowerCase() === filterLabel.toLowerCase()),
      ),
    )
  }

  // Exclusion filters
  if (exclusions.status.length > 0) {
    const excludeBlocked = exclusions.status.includes('blocked')
    result = result.filter((issue) => {
      if (excludeBlocked && isIssueBlocked(issue)) return false
      return !exclusions.status.includes(issue.status)
    })
  }
  if (exclusions.priority.length > 0) {
    result = result.filter(issue => !exclusions.priority.includes(issue.priority))
  }
  if (exclusions.type.length > 0) {
    result = result.filter(issue => !exclusions.type.includes(issue.type))
  }
  if (exclusions.labels.length > 0) {
    result = result.filter(issue =>
      !issue.labels?.some(l => exclusions.labels.includes(l.toLowerCase())),
    )
  }
  if (exclusions.assignee.length > 0) {
    result = result.filter(issue =>
      !exclusions.assignee.includes(issue.assignee || ''),
    )
  }

  return result
}

/**
 * Group issues into epic/children hierarchy.
 */
export function groupIssues(
  paginatedIssues: Issue[],
  allIssues: Issue[],
): IssueGroup[] {
  const groups: IssueGroup[] = []
  const processedIds = new Set<string>()

  // Pass 1: Identify epic IDs
  const allEpicIds = new Set<string>()
  for (const issue of allIssues) {
    if (issue.type === 'epic') allEpicIds.add(issue.id)
  }

  const visibleEpicIds = new Set<string>()
  for (const issue of paginatedIssues) {
    if (issue.type === 'epic') visibleEpicIds.add(issue.id)
  }

  // Pass 2: Build children maps
  const allEpicChildrenMap = new Map<string, Issue[]>()
  for (const issue of allIssues) {
    const parentId = getParentIdFromIssue(issue)
    if (parentId && allEpicIds.has(parentId)) {
      let children = allEpicChildrenMap.get(parentId)
      if (!children) { children = []; allEpicChildrenMap.set(parentId, children) }
      children.push(issue)
    }
  }

  const filteredEpicChildrenMap = new Map<string, Issue[]>()
  for (const issue of paginatedIssues) {
    const parentId = getParentIdFromIssue(issue)
    if (parentId && visibleEpicIds.has(parentId)) {
      let children = filteredEpicChildrenMap.get(parentId)
      if (!children) { children = []; filteredEpicChildrenMap.set(parentId, children) }
      children.push(issue)
    }
  }

  // Single pass: create groups in sort order (epics stay where the sort places them)
  for (const issue of paginatedIssues) {
    if (processedIds.has(issue.id)) continue

    if (issue.type === 'epic') {
      const filteredChildren = (filteredEpicChildrenMap.get(issue.id) || []).sort(compareChildIssues)
      const allChildren = (allEpicChildrenMap.get(issue.id) || []).sort(compareChildIssues)
      const closedCount = allChildren.filter(c => c.status === 'closed').length
      const inProgressChild = allChildren.find(c => c.status === 'in_progress')

      groups.push({
        epic: issue,
        children: filteredChildren,
        childCount: allChildren.length,
        closedChildCount: closedCount,
        inProgressChild: inProgressChild ? { id: inProgressChild.id, title: inProgressChild.title, priority: inProgressChild.priority } : undefined,
      })
      processedIds.add(issue.id)
      filteredChildren.forEach(c => processedIds.add(c.id))
    } else {
      // Skip children of visible epics (they'll be absorbed into the epic group)
      const parentId = getParentIdFromIssue(issue)
      if (parentId && visibleEpicIds.has(parentId)) continue

      groups.push({
        epic: null,
        children: [issue],
        childCount: 0,
        closedChildCount: 0,
      })
      processedIds.add(issue.id)
    }
  }

  return groups
}

/**
 * Compute dashboard stats from an issues array.
 * "open" counts only true open issues to match the Open KPI filter.
 */
export function computeStatsFromIssues(issues: Issue[]): DashboardStats {
  const stats: DashboardStats = {
    total: issues.length,
    open: 0,
    inProgress: 0,
    inReview: 0,
    blocked: 0,
    closed: 0,
    deferred: 0,
    workflow: 0,
    ready: 0,
    byType: { bug: 0, task: 0, feature: 0, epic: 0, chore: 0, spike: 0, story: 0, milestone: 0 },
    byPriority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 },
  }

  const REVIEW_STATUSES = new Set(['inreview', 'simplified', 'reviewed', 'accepted'])

  for (const issue of issues) {
    if (isIssueWorkflow(issue)) {
      stats.workflow++
    }

    if (isIssueBlocked(issue)) {
      stats.blocked++
    } else if (REVIEW_STATUSES.has(issue.status)) {
      stats.inReview++
    } else {
      switch (issue.status) {
        case 'open':
          stats.open++
          break
        case 'in_progress':
          stats.inProgress++
          break
        case 'closed':
          stats.closed++
          break
        case 'deferred':
          stats.deferred++
          break
      }
    }

    if (issue.type in stats.byType) {
      stats.byType[issue.type]++
    }

    if (issue.priority in stats.byPriority) {
      stats.byPriority[issue.priority]++
    }
  }

  stats.total = issues.length

  return stats
}

/**
 * Compute ready-to-work issues: open (not blocked) with no blockers.
 * Used client-side in probe mode where `bd ready` is not available.
 */
export function computeReadyIssues(issues: Issue[]): Issue[] {
  return issues.filter(i =>
    i.status === 'open' && (!i.blockedBy || i.blockedBy.length === 0),
  )
}
