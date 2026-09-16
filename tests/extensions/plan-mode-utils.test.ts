import { describe, expect, it } from 'vitest'

import { isAllowedBdWorktreeCreateCommand, isSafeCommand } from '../../.pi/extensions/plan-mode/utils'

describe('plan-mode isSafeCommand bd worktree create recovery exception', () => {
  it('allows a single canonical bd worktree create with absolute path and task branch', () => {
    const command = 'bd worktree create /Users/maksim/Projects/worktrees/beads-task-issue-tracker/llvr-plan-approve-main-worktree-deadlock --branch fix/llvr-plan-approve-main-worktree-deadlock'
    expect(isAllowedBdWorktreeCreateCommand(command)).toBe(true)
    expect(isSafeCommand(command)).toBe(true)
  })

  it('allows quoted absolute path and branch forms', () => {
    expect(isSafeCommand('bd worktree create \'/tmp/task-wt\' --branch task/suffix-purpose')).toBe(true)
    expect(isSafeCommand('bd worktree create "/tmp/task-wt" --branch "feat/suffix-purpose"')).toBe(true)
  })

  it('rejects remove/prune/list/info and git worktree add', () => {
    for (const command of [
      'bd worktree remove /tmp/task-wt',
      'bd worktree prune',
      'bd worktree list',
      'bd worktree info',
      'git worktree add /tmp/task-wt -b fix/suffix-purpose',
      'git worktree add /tmp/task-wt fix/suffix-purpose',
    ]) {
      expect(isAllowedBdWorktreeCreateCommand(command)).toBe(false)
      expect(isSafeCommand(command)).toBe(false)
    }
  })

  it('rejects protected main/master branches and non-canonical branches', () => {
    for (const command of [
      'bd worktree create /tmp/task-wt --branch main',
      'bd worktree create /tmp/task-wt --branch master',
      'bd worktree create /tmp/task-wt --branch main/feature',
      'bd worktree create /tmp/task-wt --branch random-branch',
      'bd worktree create /tmp/task-wt --branch develop',
    ]) {
      expect(isAllowedBdWorktreeCreateCommand(command)).toBe(false)
      expect(isSafeCommand(command)).toBe(false)
    }
  })

  it('rejects shell control, substitution, pipes, second --branch, and extra flags', () => {
    for (const command of [
      'bd worktree create /tmp/a --branch fix/a && echo ok',
      'bd worktree create /tmp/a --branch fix/a || true',
      'bd worktree create /tmp/a --branch fix/a; echo x',
      'bd worktree create /tmp/a --branch fix/a | cat',
      'bd worktree create /tmp/$(echo a) --branch fix/a',
      'bd worktree create /tmp/`echo a` --branch fix/a',
      'bd worktree create /tmp/a --branch fix/a --branch fix/b',
      'bd worktree create /tmp/a --branch fix/a --orphan',
      'bd worktree create /tmp/a --orphan --branch fix/a',
      'bd worktree create relative/path --branch fix/a',
      'bd worktree create /tmp/a',
    ]) {
      expect(isAllowedBdWorktreeCreateCommand(command)).toBe(false)
      expect(isSafeCommand(command)).toBe(false)
    }
  })

  it('does not weaken ordinary read-only allowlist or destructive blocks', () => {
    expect(isSafeCommand('bd show bead-1')).toBe(true)
    expect(isSafeCommand('bd comments add bead-1 note')).toBe(false)
    expect(isSafeCommand('bd update bead-1 --priority 1')).toBe(false)
    expect(isSafeCommand('rm -rf /tmp/task')).toBe(false)
  })
})
