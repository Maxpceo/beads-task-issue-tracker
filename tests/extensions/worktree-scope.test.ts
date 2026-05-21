import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isPathInsideOrEqual, requireTaskToolTarget, resolveActiveTaskScope, taskScopeErrorToPolicyReason, validateTaskScopePath } from '../../.pi/extensions/worktree-scope/index'

function createRepo(branch = 'task/scope') {
  const repo = mkdtempSync(join(tmpdir(), 'worktree-scope-'))
  execFileSync('git', ['init', '-b', branch], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  return repo
}

describe('worktree-scope structured routing helper', () => {
  it('resolves canonical active task scope and accepts symlinked targets inside it', () => {
    const repo = createRepo()
    const link = join(tmpdir(), `worktree-scope-link-${Date.now()}`)
    symlinkSync(repo, link, 'dir')
    try {
      const scope = resolveActiveTaskScope({ activeBead: 'bead-a', branch: 'task/scope', worktreePath: repo, startCommit: 'aaa1111', sessionKey: 'session:test' })

      expect(scope).toMatchObject({ ok: true, scope: { activeBead: 'bead-a', branch: 'task/scope', worktreePath: repo, startCommit: 'aaa1111', ownership: 'session' } })
      expect(isPathInsideOrEqual(join(link, 'tracked.txt'), repo)).toBe(true)
    } finally {
      rmSync(link, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects protected or mismatched task scope before typed workflow routing', () => {
    const repo = createRepo('task/current')
    try {
      expect(validateTaskScopePath(repo, { expectedBranch: 'task/other' })).toMatchObject({ ok: false, error: { code: 'BRANCH_MISMATCH' } })
      expect(validateTaskScopePath(repo, { expectedBranch: 'main', getBranch: () => 'main' })).toMatchObject({ ok: false, error: { code: 'PROTECTED_BRANCH' } })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('lets typed workflow tools omit cwd because the structured task worktree is the target', () => {
    const repo = createRepo()
    try {
      const result = requireTaskToolTarget('dispatch_supervisor', { beadId: 'bead-a' }, { activeBead: 'bead-a', branch: 'task/scope', worktreePath: repo, planApproved: true })
      expect(result).toMatchObject({ ok: true, scope: { worktreePath: repo } })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('rejects typed workflow targets outside the active task worktree with a policy-ready reason', () => {
    const repo = createRepo()
    const outside = createRepo('task/outside')
    try {
      const result = requireTaskToolTarget('review_bead', { beadId: 'bead-a', worktreePath: outside }, { activeBead: 'bead-a', branch: 'task/scope', worktreePath: repo, planApproved: true })
      expect(result).toMatchObject({ ok: false, error: { code: 'OUTSIDE_SCOPE' } })
      if (!result.ok) expect(taskScopeErrorToPolicyReason(result.error, 'bead-a', 'review_bead')).toContain('task worktree')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails closed without ownership evidence or for terminal statuses', () => {
    const repo = createRepo()
    try {
      expect(resolveActiveTaskScope({ activeBead: 'bead-a', branch: 'task/scope', worktreePath: repo })).toMatchObject({ ok: false, error: { code: 'MISSING_OWNERSHIP' } })
      expect(resolveActiveTaskScope({ activeBead: 'bead-a', bdStatus: 'closed', branch: 'task/scope', worktreePath: repo, sessionKey: 'session:test' })).toMatchObject({ ok: false, error: { code: 'TERMINAL_STATUS' } })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fails closed for deleted task worktrees', () => {
    const missing = join(tmpdir(), `worktree-scope-missing-${Date.now()}`)
    expect(resolveActiveTaskScope({ activeBead: 'bead-a', branch: 'task/missing', worktreePath: missing, sessionKey: 'session:test' })).toMatchObject({ ok: false, error: { code: 'WORKTREE_NOT_FOUND' } })
  })
})
