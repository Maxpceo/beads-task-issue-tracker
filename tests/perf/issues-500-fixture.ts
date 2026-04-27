import type { Issue, IssueType, IssueStatus, IssuePriority } from '~/types/issue'

const STATUSES: IssueStatus[] = ['open', 'in_progress', 'blocked', 'closed', 'inreview']
const PRIORITIES: IssuePriority[] = ['p0', 'p1', 'p2', 'p3', 'p4']
const LABELS = ['frontend', 'backend', 'dx', 'ui', 'ci', 'sync', 'data']
const CHILD_TYPES: IssueType[] = ['task', 'bug', 'feature', 'chore']

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!
}

function makeDate(offset: number): string {
  return new Date(1_700_000_000_000 + offset * 60_000).toISOString()
}

function buildEpic(epicIndex: number): Issue {
  return {
    id: `epic-${epicIndex}`,
    title: `Epic ${epicIndex}: some feature area`,
    description: `Description for epic ${epicIndex}`,
    type: 'epic',
    status: pick(STATUSES, epicIndex),
    priority: pick(PRIORITIES, epicIndex),
    labels: [pick(LABELS, epicIndex), pick(LABELS, epicIndex + 1)],
    createdAt: makeDate(epicIndex),
    updatedAt: makeDate(epicIndex + 1),
    comments: [],
  }
}

function buildChild(epicIndex: number, childIndex: number): Issue {
  const i = epicIndex * 10 + childIndex
  return {
    id: `child-${epicIndex}-${childIndex}`,
    title: `Child ${i}: task under epic ${epicIndex}`,
    description: `Description for child ${i}`,
    type: pick(CHILD_TYPES, i),
    status: pick(STATUSES, i + 2),
    priority: pick(PRIORITIES, i + 1),
    labels: [pick(LABELS, i)],
    createdAt: makeDate(i + 100),
    updatedAt: makeDate(i + 101),
    comments: [],
    parent: {
      id: `epic-${epicIndex}`,
      title: `Epic ${epicIndex}: some feature area`,
      status: pick(STATUSES, epicIndex),
      priority: pick(PRIORITIES, epicIndex),
    },
  }
}

export function build500IssueFixture(): Issue[] {
  const issues: Issue[] = []
  for (let e = 0; e < 50; e++) {
    issues.push(buildEpic(e))
    for (let c = 0; c < 10; c++) {
      issues.push(buildChild(e, c))
    }
  }
  return issues
}
