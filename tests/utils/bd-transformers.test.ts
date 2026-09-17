import { describe, it, expect } from 'vitest'
import { transformIssue } from '../../server/utils/bd-transformers'

function makeRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-a',
    title: 'Test',
    status: 'in_progress',
    priority: 2,
    issue_type: 'task',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('transformIssue blockedBy/blocks malformed filter', () => {
  it('drops discovered-from and empty depends_on_id from blockedBy, keeps valid id', () => {
    const issue = transformIssue(
      makeRaw({
        dependencies: [
          {
            issue_id: 'issue-a',
            depends_on_id: 'discovered-from:beads-task-issue-tracker-garn',
            type: 'blocks',
          },
          {
            issue_id: 'issue-a',
            depends_on_id: '',
            type: 'blocks',
          },
          {
            issue_id: 'issue-a',
            depends_on_id: 'open-blocker-1',
            type: 'blocks',
          },
        ],
      }) as any,
    )

    expect(issue.blockedBy).toEqual(['open-blocker-1'])
  })

  it('drops malformed id from bd show format dependencies', () => {
    const issue = transformIssue(
      makeRaw({
        dependencies: [
          { id: 'discovered-from:x', dependency_type: 'blocks' },
          { id: 'valid-blocker', dependency_type: 'blocks' },
        ],
      }) as any,
    )

    expect(issue.blockedBy).toEqual(['valid-blocker'])
  })

  it('filters malformed ids from raw blocked_by and blocks passthrough', () => {
    const issue = transformIssue(
      makeRaw({
        blocked_by: ['discovered-from:garn', '', 'open-2'],
        blocks: ['discovered-from:x', 'child-1'],
      }) as any,
    )

    expect(issue.blockedBy).toEqual(['open-2'])
    expect(issue.blocks).toEqual(['child-1'])
  })

  it('omits blockedBy when only malformed ids remain', () => {
    const issue = transformIssue(
      makeRaw({
        blocked_by: ['discovered-from:garn'],
      }) as any,
    )

    expect(issue.blockedBy).toBeUndefined()
  })

  it('keeps child-style ids with dots as well-formed', () => {
    const issue = transformIssue(
      makeRaw({
        blocked_by: ['epic.1'],
        blocks: ['epic.2'],
      }) as any,
    )

    expect(issue.blockedBy).toEqual(['epic.1'])
    expect(issue.blocks).toEqual(['epic.2'])
  })
})
