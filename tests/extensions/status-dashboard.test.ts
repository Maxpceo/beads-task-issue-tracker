import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(__dirname, '../../.pi/extensions/status-dashboard.ts'), 'utf8')

describe('Pi status-dashboard worktree display', () => {
  it('does not render workflow-state worktreePath as a wt override', () => {
    expect(source).not.toContain('wf:${pathBasename(wf.worktreePath)}')
    expect(source).toContain('const worktree = formatWorktree(snapshot.worktree)')
  })

  it('does not fall back to wt:primary in extension status text', () => {
    expect(source).not.toContain('?? "primary"')
    expect(source).toContain('if (statusWorktree) statusParts.push(`wt:${statusWorktree}`)')
  })
})
