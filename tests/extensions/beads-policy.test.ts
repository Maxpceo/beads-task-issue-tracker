import { describe, expect, it } from 'vitest'

import { activeBeadLifecycleReason, evaluateBashPolicy, evaluateToolPolicy } from '../../.pi/extensions/beads-policy/index'

describe('Pi active bead lifecycle policy', () => {
  it.each(['claimed', 'planning', 'implementing', 'inreview', 'reviewing'])(
    'blocks claiming another bead while active bead is %s',
    (state) => {
      const decision = evaluateBashPolicy('bd update bead-b --claim --json', {
        activeBead: 'bead-a',
        state,
      })

      expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
      expect(decision?.block).toBe(true)
    },
  )

  it('redirects active inreview bead to review-bead next action', () => {
    const reason = activeBeadLifecycleReason('bead-b', 'start/claim another bead', {
      activeBead: 'bead-a',
      state: 'inreview',
    })

    expect(reason).toContain('review-bead / review_bead')
    expect(reason).toContain('bead-a')
  })

  it('allows next claim after active bead reaches closed terminal state', () => {
    const decision = evaluateBashPolicy('bd update bead-b --claim --json', {
      activeBead: 'bead-a',
      state: 'closed',
    })

    expect(decision?.policy).not.toBe('enforceActiveBeadLifecycle')
  })

  it('keeps merge-to-main explicit by not treating land as terminal workflow requirement', () => {
    const decision = evaluateBashPolicy('/workflow-claim bead-b', {
      activeBead: 'bead-a',
      state: 'closed',
      mergeSlotHeld: false,
    })

    expect(decision?.policy).not.toBe('enforceActiveBeadLifecycle')
  })

  it('blocks unrelated dispatch_supervisor tool calls while another bead is active', () => {
    const decision = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-b' }, {
      activeBead: 'bead-a',
      state: 'implementing',
    })

    expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
    expect(decision?.block).toBe(true)
  })
})
