import type { IssueStatus, IssueType, IssuePriority } from '~/types/issue'
import { useProjectStorage } from '~/composables/useProjectStorage'

export interface ExclusionFilters {
  status: IssueStatus[]
  priority: IssuePriority[]
  type: IssueType[]
  labels: string[]
  assignee: string[]
}

// System labels hidden from the issue list and dashboard stats by default.
// Users can re-enable visibility via the Exclusions dropdown (funnel icon).
const SYSTEM_LABELS = ['gt:slot']

const defaultExclusions: ExclusionFilters = {
  status: [],
  priority: [],
  type: [],
  labels: [...SYSTEM_LABELS],
  assignee: [],
}

const validStatuses: IssueStatus[] = ['open', 'in_progress', 'blocked', 'closed', 'deferred', 'pinned', 'hooked']

// One-time migration for existing users whose exclusionFilters were saved
// before SYSTEM_LABELS were introduced.
const SYSTEM_LABELS_MIGRATION_FLAG = 'beads:system-labels-exclusion-migrated'

export function useExclusionFilters() {
  const exclusions = useProjectStorage<ExclusionFilters>('exclusionFilters', defaultExclusions)

  if (import.meta.client) {
    exclusions.value.status = exclusions.value.status.filter(status => validStatuses.includes(status))

    if (!localStorage.getItem(SYSTEM_LABELS_MIGRATION_FLAG)) {
      for (const label of SYSTEM_LABELS) {
        if (!exclusions.value.labels.includes(label)) {
          exclusions.value.labels.push(label)
        }
      }
      localStorage.setItem(SYSTEM_LABELS_MIGRATION_FLAG, 'true')
    }
  }

  const toggleStatus = (status: IssueStatus) => {
    const index = exclusions.value.status.indexOf(status)
    if (index === -1) {
      exclusions.value.status.push(status)
    } else {
      exclusions.value.status.splice(index, 1)
    }
  }

  const togglePriority = (priority: IssuePriority) => {
    const index = exclusions.value.priority.indexOf(priority)
    if (index === -1) {
      exclusions.value.priority.push(priority)
    } else {
      exclusions.value.priority.splice(index, 1)
    }
  }

  const toggleType = (type: IssueType) => {
    const index = exclusions.value.type.indexOf(type)
    if (index === -1) {
      exclusions.value.type.push(type)
    } else {
      exclusions.value.type.splice(index, 1)
    }
  }

  const toggleLabel = (label: string) => {
    const lowerLabel = label.toLowerCase()
    const index = exclusions.value.labels.indexOf(lowerLabel)
    if (index === -1) {
      exclusions.value.labels.push(lowerLabel)
    } else {
      exclusions.value.labels.splice(index, 1)
    }
  }

  const toggleAssignee = (assignee: string) => {
    const index = exclusions.value.assignee.indexOf(assignee)
    if (index === -1) {
      exclusions.value.assignee.push(assignee)
    } else {
      exclusions.value.assignee.splice(index, 1)
    }
  }

  const clearAll = () => {
    exclusions.value.status = []
    exclusions.value.priority = []
    exclusions.value.type = []
    exclusions.value.labels = []
    exclusions.value.assignee = []
  }

  const activeCount = computed(() => {
    return (
      exclusions.value.status.length +
      exclusions.value.priority.length +
      exclusions.value.type.length +
      exclusions.value.labels.length +
      exclusions.value.assignee.length
    )
  })

  const hasActiveExclusions = computed(() => activeCount.value > 0)

  return {
    exclusions,
    toggleStatus,
    togglePriority,
    toggleType,
    toggleLabel,
    toggleAssignee,
    clearAll,
    activeCount,
    hasActiveExclusions,
  }
}
