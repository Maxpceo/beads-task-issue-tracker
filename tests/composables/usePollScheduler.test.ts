import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePollScheduler } from '~/composables/usePollScheduler'

describe('usePollScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(opts: { minInterval?: number; pollMs?: number } = {}) {
    let resolvers: Array<() => void> = []
    const pollFn = vi.fn(() => {
      if (opts.pollMs) {
        return new Promise<void>((resolve) => { resolvers.push(resolve) })
      }
      return Promise.resolve()
    })

    const scheduler = usePollScheduler(pollFn, {
      minInterval: opts.minInterval ?? 100,
    })

    const resolveOnePoll = () => {
      const r = resolvers.shift()
      r?.()
    }

    return { pollFn, scheduler, resolveOnePoll }
  }

  it('executes first poll immediately', async () => {
    const { pollFn, scheduler } = setup()
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)
    expect(scheduler.stats.executed).toBe(1)
  })

  it('enforces min interval between polls', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Request again immediately — should defer
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)
    expect(scheduler.stats.deferred).toBe(1)

    // Advance past min interval — deferred poll should fire
    await vi.advanceTimersByTimeAsync(100)
    expect(pollFn).toHaveBeenCalledTimes(2)
    expect(scheduler.stats.executed).toBe(2)
  })

  it('skips when a poll is already inflight', async () => {
    const { pollFn, scheduler, resolveOnePoll } = setup({ pollMs: 50 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Request while inflight — should skip
    scheduler.requestPoll()
    expect(scheduler.stats.skipped).toBe(1)

    // Finish inflight poll
    resolveOnePoll()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('deduplicates rapid triggers into one deferred poll', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Three rapid triggers — first defers, rest skip
    scheduler.requestPoll()
    scheduler.requestPoll()
    scheduler.requestPoll()
    expect(scheduler.stats.deferred).toBe(1)
    expect(scheduler.stats.skipped).toBe(2)

    await vi.advanceTimersByTimeAsync(100)
    expect(pollFn).toHaveBeenCalledTimes(2)
  })

  it('requestImmediatePoll bypasses min interval', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Immediate poll right after — should bypass
    scheduler.requestImmediatePoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(2)
  })

  it('cancel clears pending deferred poll', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    scheduler.requestPoll() // deferred
    scheduler.cancel()

    await vi.advanceTimersByTimeAsync(200)
    expect(pollFn).toHaveBeenCalledTimes(1) // no deferred poll ran
  })

  it('stop() cancels deferred poll and blocks new polls', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Запланировать deferred, потом остановить
    scheduler.requestPoll() // deferred — слишком рано
    scheduler.stop()

    await vi.advanceTimersByTimeAsync(200)
    // Deferred не должен сработать после stop()
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Новые requestPoll тоже должны быть заблокированы
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(200)
    expect(pollFn).toHaveBeenCalledTimes(1)
  })

  it('resume() после stop() разрешает новые poll', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    scheduler.stop()
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(200)
    expect(pollFn).toHaveBeenCalledTimes(0) // заблокировано

    scheduler.resume()
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1) // разблокировано
  })

  it('requestImmediatePoll does NOT launch second poll when already inflight', async () => {
    const { pollFn, scheduler, resolveOnePoll } = setup({ minInterval: 100, pollMs: 50 })

    scheduler.requestImmediatePoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Second immediate while inflight — should be skipped
    scheduler.requestImmediatePoll()
    expect(pollFn).toHaveBeenCalledTimes(1)

    resolveOnePoll()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('requestImmediatePoll cancels pending deferred timer', async () => {
    const { pollFn, scheduler } = setup({ minInterval: 100 })

    // First poll to arm lastPollEnd
    scheduler.requestPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(1)

    // Deferred poll scheduled (too soon)
    scheduler.requestPoll()
    expect(scheduler.stats.deferred).toBe(1)

    // Immediate poll — should cancel the deferred and run now
    scheduler.requestImmediatePoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollFn).toHaveBeenCalledTimes(2)

    // Wait out what would have been the deferred window — no extra poll
    await vi.advanceTimersByTimeAsync(200)
    expect(pollFn).toHaveBeenCalledTimes(2)
  })
})
