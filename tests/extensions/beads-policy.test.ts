import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import beadsPolicyExtension, { activeBeadLifecycleReason, evaluateBashPolicy, evaluateToolPolicy, hasSessionOwnershipEvidence, reconcileWorkflowStateWithBdStatus } from '../../.pi/extensions/beads-policy/index'

const runtimeOwnerKey = 'runtime:test-beads-policy'
;(globalThis as typeof globalThis & { __piWorkflowRuntimeOwnerKey?: string }).__piWorkflowRuntimeOwnerKey = runtimeOwnerKey

const russianHandoffDescription = [
  '### Origin',
  '- Запрос пользователя требует проверки политики.',
  '### Files',
  '- .pi/extensions/beads-policy/index.ts',
  '### Current state',
  '- Сейчас проверяется тестовый сценарий.',
  '### Target state',
  '- Политика принимает русское описание с техническими identifiers.',
  '### Investigation findings',
  '- Проверка выполняется через evaluateBashPolicy.',
  '### Decisions',
  '- Используем ручной policy invocation.',
  '### Rejected alternatives',
  '- Не создаём лишние реальные данные для unit-теста.',
  '### Dependencies / blockers',
  '- Нет.',
  '### Acceptance criteria',
  '- Русскоязычный bead content не блокируется locale guard.',
  '### Verification / acceptance checks',
  '- pnpm test -- tests/extensions/beads-policy.test.ts завершается с exit code 0.',
  '### Out of scope',
  '- Изменение bd CLI.',
].join('\n')

describe('Pi bead Russian locale policy', () => {
  it('blocks clearly English bead create title before writing to bd', () => {
    const decision = evaluateBashPolicy('bd create "Fix Dolt badge" -t task --label dx --description "Краткое русское описание" --json', {}, { cwd: tmpdir() })

    expect(decision?.policy).toBe('enforceBeadRussianLocale')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('title is clearly English')
  })

  it('blocks clearly English bead update title', () => {
    const decision = evaluateBashPolicy('bd update bead-a --title "Add CI workflow" --json', {}, { cwd: tmpdir() })

    expect(decision?.policy).toBe('enforceBeadRussianLocale')
    expect(decision?.block).toBe(true)
  })

  it('blocks clearly English bead update description', () => {
    const decision = evaluateBashPolicy('bd update bead-a --description "Details about the current behavior and expected result" --json', {}, { cwd: tmpdir() })

    expect(decision?.policy).toBe('enforceBeadRussianLocale')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('description is clearly English')
  })

  it('allows Russian bead content with technical identifiers and required English headings', () => {
    const command = `bd create "Проверить bd-api sync" -t task --label dx --description "${russianHandoffDescription}" --json`
    const decision = evaluateBashPolicy(command, {}, { cwd: tmpdir() })

    expect(decision?.policy).not.toBe('enforceBeadRussianLocale')
    expect(decision?.policy).not.toBe('enforceBeadEnrichment')
  })
})

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

describe('Pi terminal close policy', () => {
  const policyOnlyOptions = { cwd: tmpdir() }

  it('blocks standard bd close when workflow state is idle', () => {
    const decision = evaluateBashPolicy('bd close bead-a --reason done', {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })

  it.each([
    'bd update bead-a --status closed --json',
    'bd update bead-a --status=closed --json',
    'bd update bead-a -s=closed --json',
    'bd update bead-a --status "closed" --json',
  ])('blocks direct terminal status update without accepted workflow state: %s', (command) => {
    const decision = evaluateBashPolicy(command, {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })

  it('does not treat non-terminal status updates as terminal close attempts', () => {
    const decision = evaluateBashPolicy('bd update bead-a --status inreview --json', {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
  })

  it('does not block comments that mention the standard close command as documentation text', () => {
    const decision = evaluateBashPolicy('bd comments add bead-a "use bd close after acceptance"', {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
  })

  it('allows active bead terminal close when live bd status is accepted', () => {
    const decision = evaluateBashPolicy('bd update bead-a --status closed --json', {
      activeBead: 'bead-a',
      state: 'reviewing',
      bdStatus: 'accepted',
    }, policyOnlyOptions)

    expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
  })

  it.each(['accepted', 'reviewing'])('does not allow terminal close from stale workflow state %s without bd evidence', (state) => {
    const decision = evaluateBashPolicy('bd update bead-a --status closed --json', {
      activeBead: 'bead-a',
      state,
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })

  it('blocks terminal close when accepted workflow state belongs to a different active bead', () => {
    const decision = evaluateBashPolicy('bd update bead-b --status closed --json', {
      activeBead: 'bead-a',
      state: 'accepted',
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })
})

describe('Pi Fast Path bd-first supervisor readiness policy', () => {
  function createRepoWithRiskyPolicyDiff(): string {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-fastpath-'))
    execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
    mkdirSync(join(repo, '.pi/extensions/beads-policy'), { recursive: true })
    writeFileSync(join(repo, '.pi/extensions/beads-policy/index.ts'), 'export const before = true\n')
    execFileSync('git', ['add', '.pi/extensions/beads-policy/index.ts'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, '.pi/extensions/beads-policy/index.ts'), 'export const after = true\n')
    return repo
  }

  it('blocks risky mutation when only bd in_progress exists without approved plan evidence', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    try {
      const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('allows risky mutation when session state has approved plan evidence', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    try {
      const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: true,
      }, { cwd: repo })

      expect(decision?.policy).not.toBe('fastPathDiscipline')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('allows risky mutation when bd comments have same-session approved plan evidence', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      writeFileSync(join(binDir, 'bd'), '#!/usr/bin/env bash\nif [[ "$1" == "comments" ]]; then printf "PLAN APPROVED\\nPI_SESSION_KEY: id:session-current\\n"; exit 0; fi\nexit 1\n')
      chmodSync(join(binDir, 'bd'), 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus: 'in_progress',
        sessionKey: 'id:session-current',
      }, { cwd: repo })

      expect(decision?.policy).not.toBe('fastPathDiscipline')
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('preserves planning and merge-slot session-field guards', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    try {
      const planningDecision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        bdStatus: 'in_progress',
        planApproved: true,
        planMode: 'strict',
      }, { cwd: repo })
      const pushDecision = evaluateBashPolicy('git push', {
        activeBead: 'bead-a',
        bdStatus: 'in_progress',
        planApproved: true,
        mergeSlotHeld: false,
      }, { cwd: repo, bdMergeSlotIssue: null })

      expect(planningDecision?.policy).toBe('blockMutationsInPlanning')
      expect(pushDecision?.policy).toBe('requireMergeSlotForPush')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('Pi active bead lifecycle policy', () => {
  it.each(['in_progress', 'inreview', 'simplified', 'reviewed', 'accepted'])(
    'blocks claiming another bead while active bead bd status is %s',
    (bdStatus) => {
      const decision = evaluateBashPolicy('bd update bead-b --claim --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus,
      })

      expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain(`bd:${bdStatus}`)
    },
  )

  it('treats unknown active bd status as non-terminal for lifecycle-sensitive actions', () => {
    const decision = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-b' }, {
      activeBead: 'bead-a',
      state: 'idle',
      bdStatus: 'custom_review_hold',
    })

    expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
    expect(decision?.reason).toContain('unknown bd status custom_review_hold')
  })

  it('redirects active inreview bead to review-bead next action', () => {
    const reason = activeBeadLifecycleReason('bead-b', 'start/claim another bead', {
      activeBead: 'bead-a',
      state: 'inreview',
    })

    expect(reason).toContain('review-bead / review_bead')
    expect(reason).toContain('confirming current-session branch/worktree ownership')
    expect(reason).toContain('/workflow-reset')
    expect(reason).toContain('bead-a')
  })


  it('records bd inreview without coercing session state for redirect decisions', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'implementing',
    }, 'inreview')

    const decision = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-b' }, reconciled)

    expect(reconciled.state).toBe('implementing')
    expect(reconciled.bdStatus).toBe('inreview')
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

  it('clears active bead when bd status is terminal before lifecycle decisions', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'reviewing',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'start-sha',
      endCommit: 'end-sha',
    }, 'closed')

    const decision = evaluateBashPolicy('/workflow-claim bead-b', reconciled)

    expect(reconciled.state).toBe('idle')
    expect(reconciled.activeBead).toBeUndefined()
    expect(reconciled.endCommit).toBeUndefined()
    expect(decision?.policy).not.toBe('enforceActiveBeadLifecycle')
  })

  it('allows next workflow claim after active bead reaches closed terminal bd status', () => {
    const decision = evaluateBashPolicy('/workflow-claim bead-b', {
      activeBead: 'bead-a',
      state: 'implementing',
      bdStatus: 'closed',
    })

    expect(decision?.policy).not.toBe('enforceActiveBeadLifecycle')
  })

  it('blocks raw bd claim so workflow-state and footer stay synchronized', () => {
    const decision = evaluateBashPolicy('bd update bead-b --claim --json', {
      state: 'idle',
    })

    expect(decision?.policy).toBe('blockRawBdClaim')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('/workflow-claim bead-b')
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

  it('allows accepted bead close before explicit merge-to-main when bd evidence is accepted', () => {
    const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
      activeBead: 'bead-a',
      state: 'implementing',
      bdStatus: 'accepted',
    })

    expect(decision?.policy).not.toBe('blockUnmergedBranchCompletion')
    expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
  })

  it('requires current-session marker instead of branch/worktree comments for ownership evidence', () => {
    const comments = [
      'DISPATCH (test-supervisor)',
      'BRANCH: fix/current',
      'WORKTREE: /repo/current',
      'PI_SESSION_KEY: id:session-current',
    ].join('\n')

    expect(hasSessionOwnershipEvidence(comments, { branch: 'fix/current', worktreePath: '/repo/current' })).toBe(false)
    expect(hasSessionOwnershipEvidence(comments, { sessionKey: 'id:session-current' })).toBe(true)
    expect(hasSessionOwnershipEvidence(comments, { sessionKey: 'id:other' })).toBe(false)
  })

  it('blocks another claim for a same-session active workflow-state', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-'))
    try {
      execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
      const startCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const ctx = {
        cwd: repo,
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                activeBead: 'bead-active',
                state: 'inreview',
                branch: 'fix/current',
                startCommit,
                sessionKey: 'id:session-current',
                runtimeOwnerKey,
              },
            },
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                state: 'idle',
                runtimeOwnerKey: 'runtime:other-live-pane',
              },
            },
          ],
        },
        ui: {
          notify() {},
          setStatus() {},
          theme: { fg: (_style: string, value: string) => value },
        },
      }

      beadsPolicyExtension(pi as any)
      const result = await toolCallHandler(
        { toolName: 'bash', input: { command: 'bd update bead-next --claim --json' } },
        ctx,
      )

      expect(result.reason).toContain('enforceActiveBeadLifecycle')
      expect(result.reason).toContain('bead-active')
      expect(result.reason).toContain('review-bead')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not block allowed bd mutation after current-runtime plan changes from strict to off', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-'))
    try {
      execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const ctx = {
        cwd: repo,
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            { type: 'custom', customType: 'workflow-state', data: { state: 'planning', planMode: 'strict', mergeSlotHeld: true, runtimeOwnerKey } },
            { type: 'custom', customType: 'workflow-state', data: { state: 'planning', planMode: 'off', mergeSlotHeld: true, runtimeOwnerKey } },
            { type: 'custom', customType: 'workflow-state', data: { state: 'planning', planMode: 'strict', mergeSlotHeld: true, runtimeOwnerKey: 'runtime:foreign' } },
          ],
        },
        ui: {
          notify() {},
          setStatus() {},
          theme: { fg: (_style: string, value: string) => value },
        },
      }

      beadsPolicyExtension(pi as any)
      const result = await toolCallHandler(
        { toolName: 'bash', input: { command: 'bd update bead-current --priority 2 --json' } },
        ctx,
      )

      expect(result?.reason ?? '').not.toContain('blockMutationsInPlanning')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not confirm active workflow-state when later bd comments show foreign ownership', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-'))
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
      const startCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const fakeBd = join(binDir, 'bd')
      writeFileSync(fakeBd, `#!/bin/sh
if [ "$1" = "comments" ]; then
  cat <<'EOF'
DISPATCH (test-supervisor)
BRANCH: fix/current
WORKTREE: ${repo}
REDISPATCH (test-supervisor)
BRANCH: fix/foreign
WORKTREE: /repo/foreign
EOF
  exit 0
fi
exit 1
`)
      chmodSync(fakeBd, 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const ctx = {
        cwd: repo,
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                activeBead: 'bead-active',
                state: 'inreview',
                branch: 'fix/current',
                worktreePath: repo,
                startCommit,
              },
            },
          ],
        },
        ui: {
          notify() {},
          setStatus() {},
          theme: { fg: (_style: string, value: string) => value },
        },
      }

      beadsPolicyExtension(pi as any)
      const result = await toolCallHandler(
        { toolName: 'bash', input: { command: 'bd update bead-next --priority 2 --json' } },
        ctx,
      )

      expect(result).toBeUndefined()
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('ignores restored foreign workflow-state even when start commit matches current HEAD', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-'))
    try {
      execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
      const startCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const notifications: Array<{ message: string; level: string }> = []
      const ctx = {
        cwd: repo,
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                activeBead: 'bead-foreign',
                state: 'inreview',
                branch: 'fix/foreign',
                worktreePath: '/repo/foreign',
                startCommit,
              },
            },
          ],
        },
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level })
          },
          setStatus() {},
          theme: { fg: (_style: string, value: string) => value },
        },
      }

      beadsPolicyExtension(pi as any)
      const result = await toolCallHandler(
        { toolName: 'bash', input: { command: 'bd update bead-current --priority 2 --json' } },
        ctx,
      )

      expect(result).toBeUndefined()
      expect(notifications).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
