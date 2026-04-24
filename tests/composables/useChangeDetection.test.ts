import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedHandler } from '~/composables/useChangeDetection'

describe('createQueuedHandler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(opts: { onChangedMs?: number; cooldown?: boolean } = {}) {
    const calls: number[] = []
    let callId = 0
    let resolvers: Array<() => void> = []

    const onChanged = vi.fn(() => {
      const id = ++callId
      calls.push(id)
      if (opts.onChangedMs != null) {
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      }
      return Promise.resolve()
    })

    let cooldownActive = opts.cooldown ?? false

    const handler = createQueuedHandler(
      onChanged,
      () => cooldownActive,
    )

    return {
      handler,
      onChanged,
      calls,
      setCooldown: (active: boolean) => { cooldownActive = active },
      resolveLatest: () => {
        const r = resolvers.shift()
        r?.()
        return vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  it('debounces rapid triggers into a single call', async () => {
    const { handler, onChanged } = setup()

    handler.trigger()
    handler.trigger()
    handler.trigger()

    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('at most one onChanged in flight', async () => {
    const { handler, onChanged, resolveLatest } = setup({ onChangedMs: 100 })

    handler.trigger()
    await vi.advanceTimersByTimeAsync(300) // debounce fires, onChanged starts
    expect(onChanged).toHaveBeenCalledTimes(1)

    // Trigger again while in-flight — should set pendingRerun, not start another
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1) // still just 1

    // Resolve the first call — triggers the pending rerun
    await resolveLatest()
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('collapses multiple events during processing into one follow-up', async () => {
    const { handler, onChanged, resolveLatest } = setup({ onChangedMs: 100 })

    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1)

    // Fire many events while in-flight
    for (let i = 0; i < 10; i++) {
      handler.trigger()
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1) // still 1

    // Resolve — exactly one follow-up
    await resolveLatest()
    expect(onChanged).toHaveBeenCalledTimes(2)

    // Resolve the follow-up — no more calls
    await resolveLatest()
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('respects self-write cooldown', async () => {
    const { handler, onChanged } = setup({ cooldown: true })

    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('delivers second external trigger after cooldown lifts', async () => {
    const { handler, onChanged, setCooldown } = setup({ cooldown: true })

    // First trigger arrives while cooldown is active — must be suppressed
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(0)

    // Cooldown expires (e.g. 500ms self-trigger window elapsed)
    setCooldown(false)

    // Second external trigger arrives — must reach onChanged
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('bounds consecutive reruns', async () => {
    // onChanged takes time, and events keep arriving, so pendingRerun is always set
    let resolvers: Array<() => void> = []
    const onChanged = vi.fn(() => new Promise<void>((resolve) => {
      resolvers.push(resolve)
    }))

    const handler = createQueuedHandler(onChanged, () => false)

    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(1)

    // Continuously fire events and resolve calls to test bounding
    for (let i = 0; i < 10; i++) {
      handler.trigger() // set pendingRerun
      const r = resolvers.shift()
      r?.()
      await vi.advanceTimersByTimeAsync(0)
    }

    // Should be bounded at MAX_CONSECUTIVE_RERUNS (5) + the initial = 6 max,
    // but since the initial counts as the first in the run loop, it's 5 total.
    expect(onChanged.mock.calls.length).toBeLessThanOrEqual(6)
    expect(onChanged.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('cancel stops pending debounce timer', async () => {
    const { handler, onChanged } = setup()

    handler.trigger()
    handler.cancel()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('handles onChanged errors gracefully and still reruns', async () => {
    let resolvers: Array<(err?: Error) => void> = []
    const onChanged = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolvers.push((err) => err ? reject(err) : resolve())
    }))

    const handler = createQueuedHandler(onChanged, () => false)

    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)

    // Set pending rerun, then reject the first call
    handler.trigger()
    const r = resolvers.shift()
    r?.(new Error('fail'))
    await vi.advanceTimersByTimeAsync(0)

    // Should have started the rerun despite the error
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('two external triggers within 200ms — both delivered (no spurious cooldown arm)', async () => {
    // Regression for bd-sh7: cooldown must NOT be armed by external triggers/polls.
    // Without a local write arming the cooldown, the second trigger must go through.
    const { handler, onChanged } = setup({ cooldown: false })

    // First external trigger
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300) // debounce fires
    expect(onChanged).toHaveBeenCalledTimes(1)

    // 200ms later — second external trigger (inside old 500ms unconditional window).
    // Cooldown is NOT armed, so this must reach onChanged.
    await vi.advanceTimersByTimeAsync(200)
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('cooldown armed via local-write notifier → watcher echo within 400ms → dropped', async () => {
    // When a local write arms the cooldown, a watcher echo arriving within
    // the cooldown window must be suppressed (original purpose of the cooldown).
    const { handler, onChanged, setCooldown } = setup({ cooldown: false })

    // Simulate local write arming the cooldown
    setCooldown(true)

    // Watcher echo arrives 400ms later — within the 500ms cooldown window
    await vi.advanceTimersByTimeAsync(400)
    handler.trigger()
    await vi.advanceTimersByTimeAsync(300)
    expect(onChanged).not.toHaveBeenCalled()
  })
})
