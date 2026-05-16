import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import beadsPolicyExtension, { activeBeadLifecycleReason, evaluateBashPolicy, evaluatePathPolicy, evaluateToolPolicy, hasSessionOwnershipEvidence, reconcileWorkflowStateWithBdStatus } from '../../.pi/extensions/beads-policy/index'

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

function createMainRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'beads-policy-main-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
  return repo
}

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

describe('Pi bead enrichment policy', () => {
  const policyOnlyOptions = { cwd: tmpdir() }

  it('does not inspect quoted bd comment text as a bead create command', () => {
    const decision = evaluateBashPolicy(`bd comments add bead-a 'postmortem: the example bd create "Fix bug" --description "short" would be rejected'`, {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).not.toBe('enforceBeadEnrichment')
    expect(decision?.policy).not.toBe('enforceBeadRussianLocale')
  })

  it('still blocks actual incomplete bead create commands', () => {
    const decision = evaluateBashPolicy('bd create "Исправить тест" -t task --label dx --description "Краткое описание" --json', {
      state: 'idle',
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('enforceBeadEnrichment')
    expect(decision?.block).toBe(true)
  })
})

describe('Pi protected branch mutation policy', () => {
  it('allows redirection to a tmp file outside the repo on main', () => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy('printf evidence > /tmp/beads-policy-evidence.txt', {}, { cwd: repo })

    expect(decision?.policy).not.toBe('blockMainMutation')
  })

  it.each([
    'printf evidence > tmp-output.txt',
    'printf evidence >> .pi/plans/x.md',
    'printf evidence > AGENTS.md',
  ])('blocks redirection to repo-contained paths on main: %s', (command) => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy(command, {}, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it('does not treat redirection-like quoted bd comment text as a repo mutation on main', () => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy(`bd comments add bead-a 'postmortem: command example printf evidence > tmp-output.txt was discussed'`, {}, { cwd: repo })

    expect(decision?.policy).not.toBe('blockMainMutation')
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

  function withFakeBd(issue: Record<string, unknown>, comments: string, run: (cwd: string) => void, children: Array<Record<string, unknown>> = []): void {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-close-'))
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const issueJson = JSON.stringify([issue]).replace(/'/g, `'\\''`)
    const childrenJson = JSON.stringify(children).replace(/'/g, `'\\''`)
    const escapedComments = comments.replace(/'/g, `'\\''`)
    try {
      writeFileSync(join(binDir, 'bd'), `#!/usr/bin/env bash
if [[ "$1" == "show" ]]; then printf '%s' '${issueJson}'; exit 0; fi
if [[ "$1" == "comments" ]]; then printf '%s' '${escapedComments}'; exit 0; fi
if [[ "$1" == "list" ]]; then printf '%s' '${childrenJson}'; exit 0; fi
exit 1
`)
      chmodSync(join(binDir, 'bd'), 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`
      run(repo)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }

  const issueWithAcceptance = {
    id: 'bead-a',
    status: 'accepted',
    issue_type: 'bug',
    description: [
      '### Acceptance criteria',
      '- Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled.',
      '### Verification / acceptance checks',
      '- Manual /reload in Pi exits with observed selected extensions active.',
    ].join('\n'),
  }

  it('blocks standard bd close when session context is idle and bd evidence is missing', () => {
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
  ])('blocks direct terminal status update without accepted session/review evidence: %s', (command) => {
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

  it.each(['accepted', 'reviewing'])('does not allow terminal close from stale session context %s without bd evidence', (state) => {
    const decision = evaluateBashPolicy('bd update bead-a --status closed --json', {
      activeBead: 'bead-a',
      state,
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })

  it('blocks terminal close when accepted session context belongs to a different active bead', () => {
    const decision = evaluateBashPolicy('bd update bead-b --status closed --json', {
      activeBead: 'bead-a',
      state: 'accepted',
    }, policyOnlyOptions)

    expect(decision?.policy).toBe('blockBdCloseWithoutReview')
    expect(decision?.block).toBe(true)
  })

  it('blocks accepted close when bead has acceptance criteria but no ACCEPTANCE MATRIX', () => {
    withFakeBd(issueWithAcceptance, 'ACCEPTANCE: tests passed', (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain('requires ACCEPTANCE MATRIX')
    })
  })

  it.each(['FAIL', 'NOT RUN'])('blocks accepted close when ACCEPTANCE MATRIX contains %s', (result) => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
- criterion: Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled.
  evidence: Manual /reload in Pi exits with observed selected extensions active.
  result: ${result}
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain(result === 'FAIL' ? 'FAIL' : 'NOT RUN')
    })
  })

  it('allows accepted close with PASS matrix covering acceptance and verification checks', () => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
- criterion: Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled.
  evidence: Manual /reload in Pi exits with observed selected extensions active.
  exit code: n/a
  result: PASS
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
    })
  })

  it('requires approver and reason for HUMAN ACCEPTANCE OVERRIDE', () => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
- criterion: Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled.
  evidence: not executed
  result: NOT RUN
HUMAN ACCEPTANCE OVERRIDE
approver: Максим
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain('NOT RUN')
    })
  })

  it('allows valid HUMAN ACCEPTANCE OVERRIDE with approver and reason', () => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
- criterion: Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled.
  evidence: not executed
  result: NOT RUN
HUMAN ACCEPTANCE OVERRIDE
approver: Максим
reason: runtime smoke accepted manually outside this agent session
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
    })
  })

  it('blocks gdgf-style epic close when children are closed but runtime smoke criterion is not covered by matrix', () => {
    const epic = {
      id: 'epic-a',
      status: 'accepted',
      issue_type: 'epic',
      description: [
        '### Acceptance criteria',
        '- All child beads are closed or explicitly deferred with recorded reason.',
        '- .pi/settings.json loads only implemented/stable extensions.',
        '- Runtime smoke checks confirm Pi starts/reloads with the selected extensions enabled.',
      ].join('\n'),
    }
    withFakeBd(epic, `ACCEPTANCE MATRIX:
- criterion: All child beads are closed or explicitly deferred with recorded reason.
  evidence: bd list --parent epic-a
  result: PASS
- criterion: .pi/settings.json loads only implemented/stable extensions.
  evidence: file existence check plus pnpm exec vitest run tests/extensions
  result: PASS
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close epic-a --reason accepted', {
        activeBead: 'epic-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain('Runtime smoke')
    })
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

  function installFakeBd(binDir: string, comments: string): void {
    const escapedComments = comments.replace(/'/g, `'\\''`)
    writeFileSync(join(binDir, 'bd'), `#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then printf '[{"id":"bead-a"}]'; exit 0; fi
if [[ "$1" == "comments" ]]; then printf '%s' '${escapedComments}'; exit 0; fi
exit 1
`)
    chmodSync(join(binDir, 'bd'), 0o755)
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

  it('allows explicit-path risky mutation when bd has approved supervisor evidence for this worktree', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `PLAN APPROVED
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}

DISPATCH RESULT (supervisor)
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}
END_COMMIT: HEAD
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).not.toBe('fastPathDiscipline')
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when approved supervisor evidence belongs to another worktree', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      installFakeBd(binDir, `PLAN APPROVED
BRANCH: fix/other
WORKTREE: ${repo}-other
START_COMMIT: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}

DISPATCH RESULT (supervisor)
BRANCH: fix/other
WORKTREE: ${repo}-other
START_COMMIT: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}
END_COMMIT: HEAD
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain('PLAN APPROVED plus DISPATCH evidence')
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when approved supervisor evidence has a stale start commit', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `PLAN APPROVED
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef

DISPATCH RESULT (supervisor)
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
END_COMMIT: HEAD
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('keeps broad staging blocked even with approved supervisor evidence', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `PLAN APPROVED
BRANCH: fix/current
WORKTREE: ${repoRoot}

DISPATCH RESULT (supervisor)
BRANCH: fix/current
WORKTREE: ${repoRoot}
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .', {
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).toBe('blockGitAddAll')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('allows risky mutation when a scoped dispatch comment carries approved plan context from the prompt', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `DISPATCH (test-supervisor)
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()}

APPROVED PLAN:
PLAN APPROVED
Approved-by: Максим
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
        bdStatus: 'in_progress',
        planApproved: false,
      }, { cwd: repo })

      expect(decision?.policy).not.toBe('fastPathDiscipline')
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when same-session comments only have dispatch evidence', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      writeFileSync(join(binDir, 'bd'), '#!/usr/bin/env bash\nif [[ "$1" == "comments" ]]; then printf "DISPATCH supervisor\\nPI_SESSION_KEY: id:session-current\\n"; exit 0; fi\nexit 1\n')
      chmodSync(join(binDir, 'bd'), 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus: 'in_progress',
        sessionKey: 'id:session-current',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when plan approval and session evidence are split across comments', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      writeFileSync(join(binDir, 'bd'), '#!/usr/bin/env bash\nif [[ "$1" == "comments" ]]; then printf "PLAN APPROVED\\n\\nDISPATCH supervisor\\nPI_SESSION_KEY: id:session-current\\n"; exit 0; fi\nexit 1\n')
      chmodSync(join(binDir, 'bd'), 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
        activeBead: 'bead-a',
        state: 'idle',
        bdStatus: 'in_progress',
        sessionKey: 'id:session-current',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
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

  it.each(['plan_approved', 'implementing', 'accepted'])(
    'blocks risky mutation when only legacy session state %s exists without approved plan evidence',
    (state) => {
      const repo = createRepoWithRiskyPolicyDiff()
      try {
        const decision = evaluateBashPolicy('bd update bead-a --priority 2 --json', {
          activeBead: 'bead-a',
          state,
          bdStatus: 'in_progress',
        }, { cwd: repo })

        expect(decision?.policy).toBe('fastPathDiscipline')
        expect(decision?.block).toBe(true)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
  )

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

describe('Pi bd-first active bead policy', () => {
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


  it('coerces implementing session to inreview when live bd status is inreview', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'implementing',
      sessionMode: 'implementing',
    }, 'inreview')

    const decision = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-b' }, reconciled)

    expect(reconciled.state).toBe('inreview')
    expect(reconciled.sessionMode).toBe('inreview')
    expect(reconciled.bdStatus).toBe('inreview')
    expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
    expect(decision?.reason).toContain('review-bead / review_bead')
    expect(decision?.reason).not.toContain('implementing')
  })

  it('blocks workflow_complete on active inreview bead unless it is an explicit blocker or deferral', () => {
    const decision = evaluateToolPolicy('workflow_complete', { state: 'closed' }, {
      activeBead: 'bead-a',
      state: 'inreview',
      bdStatus: 'inreview',
    })

    expect(decision?.policy).toBe('enforceActiveBeadLifecycle')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('review-bead / review_bead')

    const blockerDecision = evaluateToolPolicy('workflow_complete', { state: 'blocked', reason: 'review_bead unavailable' }, {
      activeBead: 'bead-a',
      state: 'inreview',
      bdStatus: 'inreview',
    })

    expect(blockerDecision).toBeUndefined()
  })

  it('does not let broad bd in_progress clobber local planning state', () => {
    const reconciled = reconcileWorkflowStateWithBdStatus({
      activeBead: 'bead-a',
      state: 'planning',
    }, 'in_progress')

    expect(reconciled.state).toBe('planning')
  })

  it('clears active bead when bd status is terminal before session decisions', () => {
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
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const bdCalledMarker = join(repo, 'bd-called')
    try {
      execFileSync('git', ['init', '-b', 'fix/current'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
      const startCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const fakeBd = join(binDir, 'bd')
      writeFileSync(fakeBd, `#!/bin/sh\ntouch "${bdCalledMarker}"\nexit 1\n`)
      chmodSync(fakeBd, 0o755)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

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
      expect(existsSync(bdCalledMarker)).toBe(false)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})


describe('Pi active worktree cwd lock policy', () => {
  function createRepo(branch: string): string {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-wt-'))
    execFileSync('git', ['init', '-b', branch], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'initial\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
    return repo
  }

  function lockedState(worktreePath: string, extra: Record<string, unknown> = {}) {
    return {
      activeBead: 'bead-a',
      state: 'implementing',
      bdStatus: 'in_progress',
      branch: 'task/current',
      worktreePath,
      runtimeOwnerKey,
      planApproved: true,
      ...extra,
    }
  }

  it('recovers stale main lock when the tool cwd is the task worktree', async () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    try {
      const fakeBd = join(binDir, 'bd')
      writeFileSync(fakeBd, `#!/bin/sh
if [ "$1" = "comments" ]; then
  cat <<'EOF'
WORKFLOW CLAIM
BRANCH: main
WORKTREE: ${main}
PI_SESSION_KEY: id:session-current
EOF
  exit 0
fi
if [ "$1" = "show" ]; then
  printf '[{"id":"bead-a","status":"in_progress"}]'
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
        cwd: worktree,
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [{
            type: 'custom',
            customType: 'workflow-state',
            data: {
              activeBead: 'bead-a',
              state: 'implementing',
              bdStatus: 'in_progress',
              branch: 'main',
              worktreePath: main,
              sessionKey: 'id:session-current',
              planMode: 'off',
              mergeSlotHeld: false,
            },
          }],
        },
        ui: { notify() {}, setStatus() {}, theme: { fg: (_style: string, value: string) => value } },
      }

      beadsPolicyExtension(pi as any)
      const taskDecision = await toolCallHandler({ toolName: 'bash', input: { command: 'touch smoke.txt' } }, ctx)
      const mainDecision = evaluateBashPolicy('git add tracked.txt', {}, { cwd: main })

      expect(taskDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(mainDecision?.policy).toBe('blockMainMutation')
    } finally {
      process.env.PATH = oldPath
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('allows review_bead from the locked inreview task worktree and blocks missing review cwd', () => {
    const worktree = createRepo('task/current')
    try {
      const state = lockedState(worktree, { state: 'inreview', bdStatus: 'inreview' })
      const matching = evaluateToolPolicy('review_bead', { beadId: 'bead-a', worktreePath: worktree }, state)
      const missing = evaluateToolPolicy('review_bead', { beadId: 'bead-a' }, state)

      expect(matching).toBeUndefined()
      expect(missing?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks mutating bash from main before blockMainMutation when active bead has a worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const decision = evaluateBashPolicy('git add tracked.txt', lockedState(worktree), { cwd: main })

      expect(decision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(decision?.reason).toContain(worktree)
      expect(decision?.reason).not.toContain('main/master')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks bd writes and repo filesystem redirection from main under the lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const bdDecision = evaluateBashPolicy('bd comments add bead-a smoke', lockedState(worktree), { cwd: main })
      const redirectDecision = evaluateBashPolicy('printf smoke > lock-smoke.txt', lockedState(worktree), { cwd: main })

      expect(bdDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(redirectDecision?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('allows read-only inspection from main while mutating work is locked to the task worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      for (const command of ['bd show bead-a --json', 'bd comments bead-a', 'git status --short', 'git worktree list']) {
        const decision = evaluateBashPolicy(command, lockedState(worktree), { cwd: main })
        expect(decision?.policy).not.toBe('enforceActiveWorktreeCwd')
        expect(decision?.policy).not.toBe('blockMainMutation')
      }
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks path-option gate commands from main and allows the same commands from the locked worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      for (const command of [
        `pnpm --dir ${worktree} test`,
        `pnpm --dir ${worktree} exec vitest`,
        `pnpm --dir ${worktree} build`,
        `npx --prefix ${worktree} vue-tsc --noEmit`,
      ]) {
        const fromMain = evaluateBashPolicy(command, lockedState(worktree), { cwd: main })
        const fromWorktree = evaluateBashPolicy(command, lockedState(worktree), { cwd: worktree })

        expect(fromMain?.policy).toBe('enforceActiveWorktreeCwd')
        expect(fromMain?.reason).toContain('tests')
        expect(fromWorktree?.policy).not.toBe('enforceActiveWorktreeCwd')
        expect(fromWorktree?.policy).not.toBe('blockMainMutation')
      }
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks cd/git -C attempts that redirect mutating work outside the locked worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const cdDecision = evaluateBashPolicy(`cd ${main} && touch smoke.txt`, lockedState(worktree), { cwd: worktree })
      const gitDecision = evaluateBashPolicy(`git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: worktree })

      expect(cdDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(gitDecision?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('allows mutating bash from the worktree root, subdirectory, and symlink path', () => {
    const worktree = createRepo('task/current')
    const subdir = join(worktree, 'subdir')
    const link = join(tmpdir(), `beads-policy-link-${Date.now()}`)
    mkdirSync(subdir)
    symlinkSync(worktree, link, 'dir')
    try {
      for (const cwd of [worktree, subdir, link]) {
        const decision = evaluateBashPolicy('touch smoke.txt', lockedState(worktree), { cwd })
        expect(decision?.policy).not.toBe('enforceActiveWorktreeCwd')
        expect(decision?.policy).not.toBe('blockMainMutation')
      }
    } finally {
      rmSync(link, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks missing worktree path and branch mismatch with actionable enforceActiveWorktreeCwd errors', () => {
    const missing = join(tmpdir(), `missing-worktree-${Date.now()}`)
    const wrongBranch = createRepo('task/other')
    try {
      const missingDecision = evaluateBashPolicy('touch smoke.txt', lockedState(missing), { cwd: tmpdir() })
      const branchDecision = evaluateBashPolicy('touch smoke.txt', lockedState(wrongBranch), { cwd: wrongBranch })

      expect(missingDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(missingDecision?.reason).toContain('missing worktree')
      expect(missingDecision?.reason).toContain('workflow_reset')
      expect(branchDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(branchDecision?.reason).toContain('branch task/current')
      expect(branchDecision?.reason).toContain('task/other')
    } finally {
      rmSync(wrongBranch, { recursive: true, force: true })
    }
  })

  it('blocks mutating bash and edit/write when active lock has no recorded worktree path', () => {
    const stateWithoutWorktree = lockedState('', { worktreePath: undefined })

    const bashDecision = evaluateBashPolicy('touch smoke.txt', stateWithoutWorktree, { cwd: tmpdir() })
    const editDecision = evaluatePathPolicy('edit', join(tmpdir(), 'outside.txt'), stateWithoutWorktree)
    const writeDecision = evaluatePathPolicy('write', join(tmpdir(), 'outside.txt'), stateWithoutWorktree)
    const readOnlyDecision = evaluateBashPolicy('bd show bead-a --json', stateWithoutWorktree, { cwd: tmpdir() })

    expect(bashDecision?.policy).toBe('enforceActiveWorktreeCwd')
    expect(bashDecision?.reason).toContain('no recorded worktree path')
    expect(bashDecision?.reason).toContain('workflow_reset')
    expect(editDecision?.policy).toBe('enforceActiveWorktreeCwd')
    expect(editDecision?.reason).toContain('no recorded worktree path')
    expect(writeDecision?.policy).toBe('enforceActiveWorktreeCwd')
    expect(writeDecision?.reason).toContain('no recorded worktree path')
    expect(readOnlyDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
  })

  it('does not enable the worktree lock for terminal states, absent active bead, or foreign stale state', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const terminalDecision = evaluateBashPolicy('git add tracked.txt', lockedState(worktree, { bdStatus: 'closed' }), { cwd: main })
      const absentDecision = evaluateBashPolicy('git add tracked.txt', { worktreePath: worktree, branch: 'task/current', runtimeOwnerKey }, { cwd: main })
      const foreignDecision = evaluateBashPolicy('git add tracked.txt', lockedState(worktree, { runtimeOwnerKey: 'runtime:foreign', sessionKey: undefined, planApproved: false }), { cwd: main })

      expect(terminalDecision?.policy).toBe('blockMainMutation')
      expect(absentDecision?.policy).toBe('blockMainMutation')
      expect(foreignDecision?.policy).toBe('blockMainMutation')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks edit/write outside the active worktree and allows targets inside it', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const outside = evaluatePathPolicy('write', join(main, 'outside.txt'), lockedState(worktree))
      const inside = evaluatePathPolicy('write', join(worktree, 'inside.txt'), lockedState(worktree))

      expect(outside?.policy).toBe('enforceActiveWorktreeCwd')
      expect(inside).toBeUndefined()
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('requires typed dispatch/review/docs tools to carry the active worktree cwd', () => {
    const worktree = createRepo('task/current')
    try {
      const missing = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-a' }, lockedState(worktree))
      const matching = evaluateToolPolicy('dispatch_docs_agent', { beadId: 'bead-a', cwd: worktree }, lockedState(worktree))

      expect(missing?.policy).toBe('enforceActiveWorktreeCwd')
      expect(matching).toBeUndefined()
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it.each(['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead'])(
    'blocks %s when active lock has no recorded worktree path',
    (toolName) => {
      const decision = evaluateToolPolicy(toolName, { beadId: 'bead-a', cwd: tmpdir() }, lockedState('', { worktreePath: undefined }))

      expect(decision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(decision?.reason).toContain('no recorded worktree path')
      expect(decision?.reason).toContain('workflow_reset')
      expect(decision?.reason).toContain(toolName)
    },
  )

  it.each(['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead'])(
    'blocks %s when active lock branch mismatches the recorded worktree',
    (toolName) => {
      const wrongBranch = createRepo('task/other')
      try {
        const decision = evaluateToolPolicy(toolName, { beadId: 'bead-a', cwd: wrongBranch }, lockedState(wrongBranch))

        expect(decision?.policy).toBe('enforceActiveWorktreeCwd')
        expect(decision?.reason).toContain('branch task/current')
        expect(decision?.reason).toContain('task/other')
        expect(decision?.reason).toContain('workflow_reset')
        expect(decision?.reason).toContain(toolName)
      } finally {
        rmSync(wrongBranch, { recursive: true, force: true })
      }
    },
  )

  it('runtime-smoke: extension tool_call blocks main cwd and allows worktree cwd for the same harmless mutation', async () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const baseCtx = {
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                ...lockedState(worktree),
                sessionKey: 'id:session-current',
                startCommit: execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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
      const fromMain = await toolCallHandler({ toolName: 'bash', input: { command: 'touch smoke.txt' } }, { ...baseCtx, cwd: main })
      const fromWorktree = await toolCallHandler({ toolName: 'bash', input: { command: 'touch smoke.txt' } }, { ...baseCtx, cwd: worktree })

      expect(fromMain.reason).toContain('enforceActiveWorktreeCwd')
      expect(fromMain.reason).not.toContain('blockMainMutation')
      expect(fromWorktree).toBeUndefined()
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })


  it('runtime-smoke: missing worktreePath keeps current-session lock for bash and write tools from main', async () => {
    const main = createRepo('main')
    try {
      let toolCallHandler: any
      const pi = {
        on(event: string, handler: any) {
          if (event === 'tool_call') toolCallHandler = handler
        },
        registerCommand() {},
      }
      const baseCtx = {
        sessionManager: {
          getSessionId: () => 'session-current',
          getEntries: () => [
            {
              type: 'custom',
              customType: 'workflow-state',
              data: {
                ...lockedState('', { worktreePath: undefined }),
                sessionKey: 'id:session-current',
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
      const bashDecision = await toolCallHandler({ toolName: 'bash', input: { command: 'touch smoke.txt' } }, { ...baseCtx, cwd: main })
      const writeDecision = await toolCallHandler({ toolName: 'write', input: { path: join(main, 'smoke.txt') } }, { ...baseCtx, cwd: main })

      expect(bashDecision.reason).toContain('enforceActiveWorktreeCwd')
      expect(bashDecision.reason).toContain('no recorded worktree path')
      expect(bashDecision.reason).toContain('workflow_reset')
      expect(bashDecision.reason).not.toContain('blockMainMutation')
      expect(writeDecision.reason).toContain('enforceActiveWorktreeCwd')
      expect(writeDecision.reason).toContain('no recorded worktree path')
      expect(writeDecision.reason).toContain('workflow_reset')
    } finally {
      rmSync(main, { recursive: true, force: true })
    }
  })
})
