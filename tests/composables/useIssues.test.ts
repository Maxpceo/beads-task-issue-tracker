import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Issue } from '~/types/issue'
import { bdCreate, bdPollData, bdList, bdShow, bdSearch, logFrontend } from '~/utils/bd-api'
import type { PollData } from '~/utils/bd-api'

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

// Reactive beadsPath — allows mutating mid-promise to simulate project switch
const beadsPathRef = ref('/test/project')
vi.mock('~/composables/useBeadsPath', () => ({
  useBeadsPath: () => ({ beadsPath: beadsPathRef, hasStoredPath: ref(true) }),
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
const { notifyStatusTransitions, setLocalWriteNotifier, useIssues, resetForTests } = await import('~/composables/useIssues')

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
// useBeadsPath returns reactive beadsPathRef so race tests can mutate path mid-flight
;(globalThis as Record<string, unknown>).useBeadsPath = () => ({ beadsPath: beadsPathRef, hasStoredPath: ref(true) })
;(globalThis as Record<string, unknown>).useFilters ??= () => ({ filters: { value: {} }, workflowStatuses: { value: [] }, allStatuses: { value: [] }, toggleStatus: vi.fn(), toggleType: vi.fn(), togglePriority: vi.fn(), toggleAssignee: vi.fn(), clearFilters: vi.fn(), setStatusFilter: vi.fn(), setAllFilters: vi.fn(), setSearch: vi.fn(), toggleLabelFilter: vi.fn(), exclusions: { value: {} } })
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

// ─── Race condition guards ─────────────────────────────────────────────────

describe('fetchPollData — stale-path guard', () => {
  beforeEach(() => {
    beadsPathRef.value = '/proj/A'
    resetForTests()
    vi.mocked(bdPollData).mockReset()
    vi.mocked(logFrontend).mockClear()
  })

  // 8.3 — success-path bail: path changes after IPC resolves
  it('returns null and does not mutate issues when path changes mid-flight', async () => {
    let resolvePoll!: (data: PollData) => void
    vi.mocked(bdPollData).mockReturnValue(
      new Promise((r) => { resolvePoll = r }),
    )

    const { fetchPollData, issues } = useIssues()
    const promise = fetchPollData()

    // Simulate project switch while IPC is in-flight
    beadsPathRef.value = '/proj/B'

    resolvePoll({ openIssues: [makeIssue('a-1')], closedIssues: [], readyIssues: [] })
    const result = await promise

    expect(result).toBeNull()
    expect(issues.value).toEqual([])
  })

  // 8.4 — error-path bail: IPC rejects AFTER switch — error.value must stay null
  it('suppresses error and returns null when IPC rejects after path switch', async () => {
    let rejectPoll!: (e: Error) => void
    vi.mocked(bdPollData).mockReturnValue(
      new Promise((_, r) => { rejectPoll = r }),
    )

    const { fetchPollData, error } = useIssues()
    const promise = fetchPollData()

    beadsPathRef.value = '/proj/B'
    rejectPoll(new Error('network error'))
    const result = await promise

    expect(result).toBeNull()
    expect(error.value).toBeNull()
    expect(vi.mocked(logFrontend)).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('[fetchPollData] suppressed stale-path error'),
    )
  })

  // 8.5 — inverse: error correctly propagated when path did NOT change
  it('sets error.value when IPC rejects and path is unchanged', async () => {
    vi.mocked(bdPollData).mockRejectedValue(new Error('bd error'))

    const { fetchPollData, error } = useIssues()
    const result = await fetchPollData()

    expect(result).toBeNull()
    expect(error.value).toBe('bd error')
  })

  // 8.6 — selectedIssue sanctity: stale fetch must not overwrite selectedIssue from new project
  it('does not overwrite selectedIssue that was set for the new project', async () => {
    const newProjectIssue = makeIssue('B-1')
    let resolvePoll!: (data: PollData) => void
    vi.mocked(bdPollData).mockReturnValue(
      new Promise((r) => { resolvePoll = r }),
    )

    const { fetchPollData, selectedIssue } = useIssues()
    // Simulate that new project already set selectedIssue
    selectedIssue.value = newProjectIssue

    const promise = fetchPollData()
    beadsPathRef.value = '/proj/B'

    resolvePoll({ openIssues: [makeIssue('A-1')], closedIssues: [], readyIssues: [] })
    await promise

    expect(selectedIssue.value).toEqual(newProjectIssue)
  })

  // 8.7 — lastKnownCount/Updated sanctity
  it('does not overwrite lastKnownCount after path switch', async () => {
    let resolvePoll!: (data: PollData) => void
    vi.mocked(bdPollData).mockReturnValue(
      new Promise((r) => { resolvePoll = r }),
    )

    const { fetchPollData } = useIssues()

    // Pre-populate lastKnownCount by running a successful fetch first
    vi.mocked(bdPollData).mockResolvedValueOnce({
      openIssues: [makeIssue('B-1'), makeIssue('B-2')],
      closedIssues: [],
      readyIssues: [],
    })
    await fetchPollData()
    // lastKnownCount should now be 2

    // Now reset and set up stale flight
    vi.mocked(bdPollData).mockReturnValue(
      new Promise((r) => { resolvePoll = r }),
    )
    const promise = fetchPollData()
    beadsPathRef.value = '/proj/C'
    resolvePoll({ openIssues: [makeIssue('A-1')], closedIssues: [], readyIssues: [] })
    await promise

    // lastKnownCount must not be 1 (stale A's data)
    // It should stay at 2 (from B's fetch before the switch)
    const { issues } = useIssues()
    // issues.value is still 2 items from the B-fetch (not overwritten by stale A-fetch)
    expect(issues.value.length).toBe(2)
  })
})

describe('fetchIssues — stale-path guard', () => {
  beforeEach(() => {
    beadsPathRef.value = '/proj/A'
    resetForTests()
    vi.mocked(bdList).mockReset()
  })

  it('returns without mutating issues when path changes mid-flight', async () => {
    let resolveList!: (data: Issue[]) => void
    vi.mocked(bdList).mockReturnValue(
      new Promise((r) => { resolveList = r }),
    )

    const { fetchIssues, issues } = useIssues()
    const promise = fetchIssues()
    beadsPathRef.value = '/proj/B'

    resolveList([makeIssue('a-1')])
    await promise

    expect(issues.value).toEqual([])
  })

  // 8.8 — isLoading race: stale fetchIssues bail must not reset isLoading of the new fetch
  it('does not reset isLoading after stale bail in finally block', async () => {
    let resolveA!: (data: Issue[]) => void
    let resolveB!: (data: Issue[]) => void

    // First call (A): stays in-flight
    vi.mocked(bdList)
      .mockReturnValueOnce(new Promise((r) => { resolveA = r }))
      .mockReturnValueOnce(new Promise((r) => { resolveB = r }))

    const { fetchIssues, isLoading } = useIssues()

    // Start fetch A (path = /proj/A)
    const promiseA = fetchIssues()
    expect(isLoading.value).toBe(true)

    // Switch path — new fetch starts
    beadsPathRef.value = '/proj/B'
    const promiseB = fetchIssues()
    expect(isLoading.value).toBe(true)

    // A resolves — should bail without touching isLoading
    resolveA([makeIssue('a-1')])
    await promiseA

    // isLoading must still be true (B is still in-flight)
    expect(isLoading.value).toBe(true)

    // B resolves normally
    resolveB([makeIssue('b-1')])
    await promiseB

    expect(isLoading.value).toBe(false)
  })
})

describe('fetchIssue — stale-path guard', () => {
  beforeEach(() => {
    beadsPathRef.value = '/proj/A'
    resetForTests()
    vi.mocked(bdShow).mockReset()
  })

  it('returns null and does not write selectedIssue when path changes mid-flight', async () => {
    let resolveShow!: (data: Issue | null) => void
    vi.mocked(bdShow).mockReturnValue(
      new Promise((r) => { resolveShow = r }),
    )

    const { fetchIssue, selectedIssue } = useIssues()
    const promise = fetchIssue('a-1')
    beadsPathRef.value = '/proj/B'

    resolveShow(makeIssue('a-1'))
    const result = await promise

    expect(result).toBeNull()
    expect(selectedIssue.value).toBeNull()
  })
})

describe('searchIssues — stale-path guard', () => {
  beforeEach(() => {
    beadsPathRef.value = '/proj/A'
    resetForTests()
    vi.mocked(bdSearch).mockReset()
  })

  it('does not write issues when path changes during search', async () => {
    let resolveSearch!: (data: Issue[]) => void
    vi.mocked(bdSearch).mockReturnValue(
      new Promise((r) => { resolveSearch = r }),
    )

    const { searchIssues, issues } = useIssues()
    const promise = searchIssues('test query')
    beadsPathRef.value = '/proj/B'

    resolveSearch([makeIssue('a-1'), makeIssue('a-2')])
    await promise

    expect(issues.value).toEqual([])
  })
})
