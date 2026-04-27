import { computed, watch } from 'vue'
import type { FilterState, IssueStatus, IssueType, IssuePriority } from '~/types/issue'
import { useProjectStorage } from '~/composables/useProjectStorage'
import { useStatuses } from '~/composables/useStatuses'
import { computeWorkflowStatuses, computeWipStatuses } from '~/utils/workflow-statuses'
import { isStatusSetEqual } from '~/utils/issue-helpers'

export function useFilters() {
  const { statuses } = useStatuses()

  // Derived computed — workflow = active+wip+frozen (всё кроме done)
  const workflowStatuses = computed(() => computeWorkflowStatuses(statuses.value))
  // Derived computed — WIP = только category='wip' (in_progress + review chain)
  const wipStatuses = computed(() => computeWipStatuses(statuses.value))
  // Derived computed — все известные статусы
  const allStatuses = computed(() => [...new Set(statuses.value.map(s => s.name as IssueStatus))])

  const defaults: FilterState = {
    status: [...workflowStatuses.value],
    type: [],
    priority: [],
    assignee: [],
    search: '',
    labels: [],
  }
  const filters = useProjectStorage<FilterState>('filters', defaults)

  // Watch workflowStatuses — если filter был «Workflow», переносим на новый список
  watch(workflowStatuses, (newW, oldW) => {
    if (!oldW || !isStatusSetEqual(filters.value.status, oldW)) return
    filters.value.status = [...newW]
  })

  // Watch allStatuses — если filter был «Total», переносим на новый список
  watch(allStatuses, (newAll, oldAll) => {
    if (!oldAll || !isStatusSetEqual(filters.value.status, oldAll)) return
    filters.value.status = [...newAll]
  })

  // Watch wipStatuses — если filter был «Only active», переносим на новый список
  watch(wipStatuses, (newW, oldW) => {
    if (!oldW || !isStatusSetEqual(filters.value.status, oldW)) return
    filters.value.status = [...newW]
  })

  const toggleStatus = (status: IssueStatus) => {
    const index = filters.value.status.indexOf(status)
    if (index === -1) {
      filters.value.status.push(status)
    } else {
      filters.value.status.splice(index, 1)
    }
  }

  const toggleType = (type: IssueType) => {
    const index = filters.value.type.indexOf(type)
    if (index === -1) {
      filters.value.type.push(type)
    } else {
      filters.value.type.splice(index, 1)
    }
  }

  const togglePriority = (priority: IssuePriority) => {
    const index = filters.value.priority.indexOf(priority)
    if (index === -1) {
      filters.value.priority.push(priority)
    } else {
      filters.value.priority.splice(index, 1)
    }
  }

  const toggleAssignee = (assignee: string) => {
    const index = filters.value.assignee.indexOf(assignee)
    if (index === -1) {
      filters.value.assignee.push(assignee)
    } else {
      filters.value.assignee.splice(index, 1)
    }
  }

  const setSearch = (search: string) => {
    filters.value.search = search
  }

  const toggleLabelFilter = (label: string) => {
    const index = filters.value.labels.indexOf(label)
    if (index === -1) {
      filters.value.labels.push(label)
    } else {
      filters.value.labels.splice(index, 1)
    }
  }

  const clearFilters = () => {
    filters.value.status = []
    filters.value.type = []
    filters.value.priority = []
    filters.value.assignee = []
    filters.value.search = ''
    filters.value.labels = []
  }

  const setStatusFilter = (statuses: IssueStatus[]) => {
    filters.value.status = [...statuses]
  }

  const allTypes: IssueType[] = ['bug', 'task', 'feature', 'epic', 'chore', 'spike', 'story', 'milestone']
  const allPriorities: IssuePriority[] = ['p0', 'p1', 'p2', 'p3', 'p4']

  const setAllFilters = () => {
    filters.value.status = [...allStatuses.value]
    filters.value.type = []
    filters.value.priority = []
    filters.value.assignee = []
    filters.value.search = ''
    filters.value.labels = []
  }

  const isOnlyActive = computed(() => isStatusSetEqual(filters.value.status, wipStatuses.value))

  const toggleOnlyActive = () => {
    filters.value.status = isOnlyActive.value
      ? [...workflowStatuses.value]
      : [...wipStatuses.value]
  }

  const hasActiveFilters = computed(() => {
    return (
      filters.value.status.length > 0 ||
      filters.value.type.length > 0 ||
      filters.value.priority.length > 0 ||
      filters.value.assignee.length > 0 ||
      filters.value.search !== '' ||
      filters.value.labels.length > 0
    )
  })

  return {
    filters,
    workflowStatuses,
    wipStatuses,
    allStatuses,
    isOnlyActive,
    toggleOnlyActive,
    toggleStatus,
    toggleType,
    togglePriority,
    toggleAssignee,
    setSearch,
    toggleLabelFilter,
    clearFilters,
    setStatusFilter,
    setAllFilters,
    hasActiveFilters,
    allTypes,
    allPriorities,
  }
}
