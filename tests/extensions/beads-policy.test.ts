import { describe, expect, it } from 'vitest'

import { activeBeadLifecycleReason, evaluateBashPolicy, evaluateToolPolicy, reconcileWorkflowStateWithBdStatus } from '../../.pi/extensions/beads-policy/index'

describe('Pi merge-slot push policy', () => {
  const workflowState = {
    activeBead: 'bead-a',
    state: 'implementing',
    mergeSlotHeld: false,
  }

  it('allows git push when current bd merge-slot holder evidence matches the actor', () => {
    const decision = evaluateBashPolicy('git push', workflowState, {
      currentActor: 'Maxpceo',
      bdMergeSlotIssue: {
        id: 'beads-task-issue-tracker-merge-slot',
        status: 'in_progress',
        metadata: { holder: 'Maxpceo' },
      },
    })

    expect(decision?.policy).not.toBe('requireMergeSlotForPush')
  })

  it('blocks git push without workflow-state slot or current bd holder evidence', () => {
    const decision = evaluateBashPolicy('git push', workflowState, {
      currentActor: 'Maxpceo',
      bdMergeSlotIssue: null,
    })

    expect(decision?.policy).toBe('requireMergeSlotForPush')
    expect(decision?.block).toBe(true)
  })

  it('blocks git push after release/free slot evidence', () => {
    const decision = evaluateBashPolicy('git push', workflowState, {
      currentActor: 'Maxpceo',
      bdMergeSlotIssue: {
        id: 'beads-task-issue-tracker-merge-slot',
        status: 'open',
        metadata: { waiters: [] },
      },
    })

    expect(decision?.policy).toBe('requireMergeSlotForPush')
    expect(decision?.block).toBe(true)
  })

  it('blocks git push when bd merge-slot is held by another actor', () => {
    const decision = evaluateBashPolicy('git push', workflowState, {
      currentActor: 'Maxpceo',
      bdMergeSlotIssue: {
        id: 'beads-task-issue-tracker-merge-slot',
        status: 'in_progress',
        metadata: { holder: 'other-agent' },
      },
    })

    expect(decision?.policy).toBe('requireMergeSlotForPush')
    expect(decision?.block).toBe(true)
  })
})

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


  it('reconciles stale implementing state to bd inreview for redirect decisions', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'implementing',
    }, 'inreview')

    const decision = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-b' }, reconciled)

    expect(reconciled.state).toBe('inreview')
    expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
    expect(decision?.reason).toContain('review-bead / review_bead')
    expect(decision?.reason).not.toContain('implementing')
  })

  it('does not let broad bd in_progress clobber local planning state', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'planning',
    }, 'in_progress')

    expect(reconciled.state).toBe('planning')
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

  it('allows accepted bead close before explicit merge-to-main', () => {
    const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
      activeBead: 'bead-a',
      state: 'accepted',
    })

    expect(decision?.policy).not.toBe('blockUnmergedBranchCompletion')
    expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
  })
})
