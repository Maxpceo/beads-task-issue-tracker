import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import beadsPolicyExtension, { activeBeadLifecycleReason, evaluateBashPolicy, evaluatePathPolicy, evaluateToolPolicy, hasSessionOwnershipEvidence, reconcileWorkflowStateWithBdStatus } from '../../.pi/extensions/beads-policy/index'

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

describe('Pi destructive command and sensitive path policy', () => {
  it.each([
    ['rm -rf /tmp/example', 'recursive force delete'],
    ['git reset --hard HEAD~1', 'reset --hard'],
    ['git clean -fdx', 'git clean'],
    ['git push origin main --force', 'force push'],
    ['git push origin --delete old-branch', 'branch deletion'],
    ['git stash drop stash@{0}', 'stash deletion'],
    ['kubectl delete namespace prod', 'resource deletion'],
    ['psql -c "DROP TABLE issues"', 'destructive SQL'],
    ['cat ~/.ssh/id_ed25519', 'protected path'],
  ])('blocks %s as %s', (command) => {
    const decision = evaluateBashPolicy(command, {
      activeBead: 'bead-a',
      state: 'implementing',
      mergeSlotHeld: true,
    })

    expect(decision?.policy).toBe('blockDestructiveCommand')
    expect(decision?.block).toBe(true)
  })

  it('does not block force-with-lease solely as an unsafe force push', () => {
    const decision = evaluateBashPolicy('git push --force-with-lease', {
      activeBead: 'bead-a',
      state: 'implementing',
      mergeSlotHeld: true,
    })

    expect(decision?.policy).not.toBe('blockDestructiveCommand')
  })

  it.each([
    ['read', '/repo/.env'],
    ['edit', '/Users/test/.aws/credentials'],
    ['write', '/repo/terraform.tfstate'],
    ['read', '/Users/test/.kube/config'],
    ['read', '/Users/test/.ssh/id_rsa'],
    ['read', '/repo/private.pem'],
  ])('blocks %s access to protected path %s', (toolName, targetPath) => {
    const decision = evaluatePathPolicy(toolName, targetPath)

    expect(decision?.policy).toBe('protectPaths')
    expect(decision?.block).toBe(true)
  })

  it('allows ordinary source file reads', () => {
    const decision = evaluatePathPolicy('read', '/repo/app/pages/index.vue')

    expect(decision).toBeUndefined()
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
    expect(reason).toContain('confirming current-session branch/worktree ownership')
    expect(reason).toContain('/workflow-reset')
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

  it('clears active bead when bd status is terminal before lifecycle decisions', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'reviewing',
      branch: 'fix/current',
      worktreePath: '/repo/current',
      startCommit: 'start-sha',
      endCommit: 'end-sha',
    }, 'closed')

    const decision = evaluateBashPolicy('bd update bead-b --claim --json', reconciled)

    expect(reconciled.state).toBe('idle')
    expect(reconciled.activeBead).toBeUndefined()
    expect(reconciled.endCommit).toBeUndefined()
    expect(decision?.policy).not.toBe('enforceActiveBeadLifecycle')
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

  it('prefers later current ownership evidence over old foreign workflow comments', () => {
    const comments = [
      'DISPATCH (test-supervisor)',
      'BRANCH: fix/other',
      'WORKTREE: /repo/other',
      'REDISPATCH (test-supervisor)',
      'BRANCH: fix/current',
      'WORKTREE: /repo/current',
    ].join('\n')

    expect(hasSessionOwnershipEvidence(comments, { branch: 'fix/current', worktreePath: '/repo/current' })).toBe(true)
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
        { toolName: 'bash', input: { command: 'bd update bead-next --claim --json' } },
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
        { toolName: 'bash', input: { command: 'bd update bead-current --claim --json' } },
        ctx,
      )

      expect(result).toBeUndefined()
      expect(notifications).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
