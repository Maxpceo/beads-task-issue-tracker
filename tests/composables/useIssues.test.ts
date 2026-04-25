import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Issue } from '~/types/issue'
import { bdCreate } from '~/utils/bd-api'

// Мокируем все composable-зависимости useIssues до импорта
const notifySuccessMock = vi.fn()
vi.mock('~/composables/useNotification', () => ({
  useNotification: () => ({
    success: notifySuccessMock,
    error: vi.fn(),
    warning: vi.fn(),
    notify: vi.fn(),
    dismiss: vi.fn(),
    notifications: { value: [] },
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('~/utils/bd-api', () => ({
  bdList: vi.fn().mockResolvedValue([]),
  bdCount: vi.fn().mockResolvedValue({ count: 0, lastUpdated: null }),
  bdShow: vi.fn().mockResolvedValue(null),
  bdCreate: vi.fn().mockResolvedValue(null),
  bdUpdate: vi.fn().mockResolvedValue(null),
  bdClose: vi.fn().mockResolvedValue(false),
  bdDelete: vi.fn().mockResolvedValue(undefined),
  bdAddComment: vi.fn().mockResolvedValue(undefined),
  bdAddDependency: vi.fn().mockResolvedValue(undefined),
  bdRemoveDependency: vi.fn().mockResolvedValue(undefined),
  bdAddRelation: vi.fn().mockResolvedValue(undefined),
  bdRemoveRelation: vi.fn().mockResolvedValue(undefined),
  bdPurgeOrphanAttachments: vi.fn().mockResolvedValue(undefined),
  bdPollData: vi.fn().mockResolvedValue({ openIssues: [], closedIssues: [], readyIssues: [] }),
  bdPollDataCached: vi.fn().mockResolvedValue(null),
  bdSearch: vi.fn().mockResolvedValue([]),
  bdLabelAdd: vi.fn().mockResolvedValue(undefined),
  bdLabelRemove: vi.fn().mockResolvedValue(undefined),
  logFrontend: vi.fn().mockReturnValue(Promise.resolve()),
}))

vi.mock('~/composables/useProjectStorage', () => ({
  useProjectStorage: (_key: string, defaultValue: unknown) => ({ value: defaultValue }),
}))

vi.mock('~/composables/useFilters', () => ({
  useFilters: () => ({
    filters: { value: {} },
    workflowStatuses: { value: [] },
    allStatuses: { value: [] },
    toggleStatus: vi.fn(),
    toggleType: vi.fn(),
    togglePriority: vi.fn(),
    toggleAssignee: vi.fn(),
    clearFilters: vi.fn(),
    setStatusFilter: vi.fn(),
    setAllFilters: vi.fn(),
    setSearch: vi.fn(),
    toggleLabelFilter: vi.fn(),
    exclusions: { value: {} },
  }),
}))

vi.mock('~/composables/useBeadsPath', () => ({
  useBeadsPath: () => ({ beadsPath: { value: '/test/project' }, hasStoredPath: { value: true } }),
}))

vi.mock('~/composables/useRepairDatabase', () => ({
  useRepairDatabase: () => ({
    checkError: vi.fn().mockReturnValue(false),
    needsRepair: { value: false },
  }),
}))

vi.mock('~/composables/useMigrateToDolt', () => ({
  useMigrateToDolt: () => ({
    checkError: vi.fn().mockReturnValue(false),
    needsMigration: { value: false },
  }),
}))

vi.mock('~/composables/useStatuses', () => ({
  useStatuses: () => ({
    getMeta: vi.fn().mockReturnValue(null),
    workflowStatuses: { value: [] },
    allStatuses: { value: [] },
  }),
}))

vi.mock('~/composables/usePinnedIssues', () => ({
  usePinnedIssues: () => ({ pinnedIssueIds: { value: new Set() } }),
}))

vi.mock('~/composables/useExclusionFilters', () => ({
  useExclusionFilters: () => ({ exclusions: { value: {} } }),
}))

// Импортируем после мокирования
const { notifyStatusTransitions, setLocalWriteNotifier, useIssues } = await import('~/composables/useIssues')

// Вспомогательная функция для создания Issue-заглушки
function makeIssue(id: string, status = 'open'): Issue {
  return {
    id,
    title: `Issue ${id}`,
    description: '',
    status,
    priority: 'p2',
    type: 'task',
    labels: [],
    comments: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  }
}

// Заглушка для функции перевода
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('notifyStatusTransitions — skipNotifications guard', () => {
  beforeEach(() => {
    notifySuccessMock.mockClear()
  })

  it('skipNotifications=true — не вызывает notify при удалении задач', () => {
    const oldIssues = [makeIssue('a-1'), makeIssue('a-2'), makeIssue('a-3')]
    const newIssues: Issue[] = [] // все «удалены»

    notifyStatusTransitions(oldIssues, newIssues, t, { skipNotifications: true })

    expect(notifySuccessMock).not.toHaveBeenCalled()
  })

  it('skipNotifications=true — не вызывает notify при смене статуса', () => {
    const oldIssues = [makeIssue('a-1', 'open')]
    const newIssues = [makeIssue('a-1', 'closed')]

    notifyStatusTransitions(oldIssues, newIssues, t, { skipNotifications: true })

    expect(notifySuccessMock).not.toHaveBeenCalled()
  })

  it('skipNotifications=false — вызывает notify при удалении задач', () => {
    const oldIssues = [makeIssue('a-1'), makeIssue('a-2')]
    const newIssues: Issue[] = [] // оба «удалены»

    notifyStatusTransitions(oldIssues, newIssues, t, { skipNotifications: false })

    expect(notifySuccessMock).toHaveBeenCalledTimes(2)
  })

  it('skipNotifications=false — вызывает notify при закрытии задачи', () => {
    const oldIssues = [makeIssue('a-1', 'open')]
    const newIssues = [makeIssue('a-1', 'closed')]

    notifyStatusTransitions(oldIssues, newIssues, t, { skipNotifications: false })

    expect(notifySuccessMock).toHaveBeenCalledTimes(1)
    expect(notifySuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('notifications.issue.closed'),
      'Issue a-1',
      expect.objectContaining({ issueId: 'a-1' }),
    )
  })

  it('без изменений — notify не вызывается', () => {
    const issues = [makeIssue('a-1', 'open'), makeIssue('a-2', 'in_progress')]

    notifyStatusTransitions(issues, [...issues], t, { skipNotifications: false })

    expect(notifySuccessMock).not.toHaveBeenCalled()
  })

  it('skipNotifications по умолчанию (undefined) — notify вызывается (легитимный сценарий)', () => {
    const oldIssues = [makeIssue('b-1')]
    const newIssues: Issue[] = []

    // Вызов без 4-го аргумента — должен работать как false (notify включены)
    notifyStatusTransitions(oldIssues, newIssues, t)

    expect(notifySuccessMock).toHaveBeenCalledTimes(1)
  })
})

// Nuxt auto-imports required by useIssues() — not available in vitest without polyfill
// Define them as globalThis stubs so useIssues() can call them
;(globalThis as Record<string, unknown>).useFilters ??= () => ({ filters: { value: {} }, workflowStatuses: { value: [] }, allStatuses: { value: [] }, toggleStatus: vi.fn(), toggleType: vi.fn(), togglePriority: vi.fn(), toggleAssignee: vi.fn(), clearFilters: vi.fn(), setStatusFilter: vi.fn(), setAllFilters: vi.fn(), setSearch: vi.fn(), toggleLabelFilter: vi.fn(), exclusions: { value: {} } })
;(globalThis as Record<string, unknown>).useBeadsPath ??= () => ({ beadsPath: { value: '/test/project' }, hasStoredPath: { value: true } })
;(globalThis as Record<string, unknown>).useRepairDatabase ??= () => ({ checkError: vi.fn().mockReturnValue(false), needsRepair: { value: false } })
;(globalThis as Record<string, unknown>).useMigrateToDolt ??= () => ({ checkError: vi.fn().mockReturnValue(false), needsMigration: { value: false } })
;(globalThis as Record<string, unknown>).useExclusionFilters ??= () => ({ exclusions: { value: {} } })
;(globalThis as Record<string, unknown>).usePinnedIssues ??= () => ({ pinnedIssueIds: { value: new Set() } })
;(globalThis as Record<string, unknown>).useStatuses ??= () => ({ getMeta: vi.fn().mockReturnValue(null), workflowStatuses: { value: [] }, allStatuses: { value: [] } })

describe('setLocalWriteNotifier — localWriteNotifier integration', () => {
  beforeEach(() => {
    vi.mocked(bdCreate).mockReset()
    setLocalWriteNotifier(null)
  })

  it('createIssue calls registered localWriteNotifier on success', async () => {
    vi.mocked(bdCreate).mockResolvedValue({ id: 'test-1', title: 'Test', status: 'open' } as never)

    const notifier = vi.fn()
    setLocalWriteNotifier(notifier)

    const { createIssue } = useIssues()
    await createIssue({ title: 'Test', type: 'task', priority: 'p2' } as Parameters<typeof createIssue>[0])

    expect(notifier).toHaveBeenCalledTimes(1)
  })

  it('createIssue does NOT call notifier on failure', async () => {
    vi.mocked(bdCreate).mockRejectedValue(new Error('bd create failed'))

    const notifier = vi.fn()
    setLocalWriteNotifier(notifier)

    const { createIssue } = useIssues()
    await createIssue({ title: 'Test', type: 'task', priority: 'p2' } as Parameters<typeof createIssue>[0])

    expect(notifier).not.toHaveBeenCalled()
  })
})
