import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(decision?.reason).toContain('bead title явно на английском')
    expect(decision?.reason).not.toContain('title is clearly English')
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
    expect(decision?.reason).toContain('bead description явно на английском')
    expect(decision?.reason).not.toContain('description is clearly English')
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

  it('allows self-contained bd create from main even when a risky code file is dirty', () => {
    const repo = createMainRepo()
    mkdirSync(join(repo, '.pi/extensions/review-workflow'), { recursive: true })
    writeFileSync(join(repo, '.pi/extensions/review-workflow/index.ts'), 'export const dirty = true\n')

    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "${russianHandoffDescription}" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).not.toBe('blockMainMutation')
    expect(decision?.policy).not.toBe('fastPathDiscipline')
    expect(decision?.policy).not.toBe('enforceBeadEnrichment')
  })

  it('allows the create-bead skill inline heredoc description pattern from main', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).not.toBe('blockMainMutation')
    expect(decision?.policy).not.toBe('fastPathDiscipline')
    expect(decision?.policy).not.toBe('enforceBeadEnrichment')
  })

  it('allows inline heredoc bd create descriptions that mention git commands as text', () => {
    const repo = createMainRepo()
    mkdirSync(join(repo, '.pi/extensions/review-workflow'), { recursive: true })
    writeFileSync(join(repo, '.pi/extensions/review-workflow/index.ts'), 'export const dirty = true\n')
    const description = `${russianHandoffDescription}\n- Текст \`git commit\` в description не является repo mutation.`
    expect(description).toContain('`git commit`')
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(cat <<'HEREDOC_EOF'
${description}
HEREDOC_EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).not.toBe('blockMainMutation')
    expect(decision?.policy).not.toBe('fastPathDiscipline')
    expect(decision?.policy).not.toBe('enforceBeadEnrichment')
  })

  it('blocks raw bd claim hidden inside the create-bead inline heredoc command substitution', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(bd update bead-b --claim; cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).toBe('blockRawBdClaim')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('/workflow-claim bead-b')
  })

  it('blocks git commit hidden inside the create-bead inline heredoc command substitution', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(git commit -m x; cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it('blocks bash -c git commit hidden inside the create-bead inline heredoc command substitution', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(bash -c 'git commit -m x'; cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it('blocks backtick git commit hidden inside the create-bead inline heredoc pattern', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "\`git commit -m x\`$(cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it.each(['bash -lc', 'bash -ec', 'bash -o pipefail -c'])(
    'blocks %s git commit hidden inside the create-bead inline heredoc pattern',
    (shellPrefix) => {
      const repo = createMainRepo()
      const command = `bd create "Добавить проверку workflow" -t task --label pi --description "$(${shellPrefix} 'git commit -m x'; cat <<'EOF'
${russianHandoffDescription}
EOF
)" --json`
      const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

      expect(decision?.policy).toBe('blockMainMutation')
      expect(decision?.block).toBe(true)
    },
  )

  it('does not classify quoted test filters that mention bd create as tracker mutations', () => {
    const repo = createMainRepo()
    mkdirSync(join(repo, '.pi/extensions/review-workflow'), { recursive: true })
    writeFileSync(join(repo, '.pi/extensions/review-workflow/index.ts'), 'export const dirty = true\n')

    const command = 'pnpm exec vitest run tests/extensions/beads-policy.test.ts -t "bd create|blockMainMutation|raw bd claim|enforceBeadEnrichment"'
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).not.toBe('fastPathDiscipline')
    expect(decision?.policy).not.toBe('blockMutationsInPlanning')
  })

  it('still blocks repo filesystem mutation on main when chained with bd create', () => {
    const repo = createMainRepo()
    const command = `bd create "Добавить проверку workflow" -t task --label pi --description "${russianHandoffDescription}" --json && printf evidence > AGENTS.md`
    const decision = evaluateBashPolicy(command, { state: 'idle' }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
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
      cwd: tmpdir(),
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

describe('Pi safe merged remote branch cleanup policy', () => {
  function createMergedRemoteFixture() {
    const remote = mkdtempSync(join(tmpdir(), 'beads-policy-remote-'))
    const repo = createMainRepo()
    execFileSync('git', ['init', '--bare'], { cwd: remote, stdio: 'ignore' })
    writeFileSync(join(repo, 'README.md'), 'main\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', 'task/safe-cleanup'], { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'feature.txt'), 'feature\n')
    execFileSync('git', ['add', 'feature.txt'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: repo, stdio: 'ignore' })
    const branchOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    execFileSync('git', ['push', 'origin', 'task/safe-cleanup'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['merge', '--no-ff', 'task/safe-cleanup', '-m', 'merge feature'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, stdio: 'ignore' })
    const mainOid = execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim()
    return { repo, remote, branch: 'task/safe-cleanup', branchOid, mainOid }
  }

  function cleanupFixture(fixture: { repo: string; remote: string }) {
    rmSync(fixture.repo, { recursive: true, force: true })
    rmSync(fixture.remote, { recursive: true, force: true })
  }

  it('allows safe merged remote task branch deletion with matching lease and merge-slot evidence', () => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(
        `git push --force-with-lease="refs/heads/${fixture.branch}:${fixture.branchOid}" origin ":refs/heads/${fixture.branch}"`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).not.toBe('blockDestructiveCommand')
      expect(decision?.policy).not.toBe('requireMergeSlotForPush')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('allows documented literal fallback deletion shape without shell variables', () => {
    const docs = readFileSync('.pi/skills/merge-to-main/SKILL.md', 'utf8')
    const documentedDeletionLines = docs
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('git push --force-with-lease=') && line.includes(':refs/heads/'))

    expect(documentedDeletionLines).toContain(
      'git push --force-with-lease=refs/heads/task/example-branch:0123456789abcdef0123456789abcdef01234567 origin :refs/heads/task/example-branch',
    )
    expect(documentedDeletionLines.every((line) => !line.includes('$'))).toBe(true)

    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.branchOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).not.toBe('blockDestructiveCommand')
      expect(decision?.policy).not.toBe('requireMergeSlotForPush')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('allows safe merged remote task branch cleanup after merge flow returns to main', () => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.branchOid} origin :refs/heads/${fixture.branch}`,
        { branch: 'main', mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).not.toBe('blockDestructiveCommand')
      expect(decision?.policy).not.toBe('requireMergeSlotForPush')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it.each([
    ['wrong remote', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/${f.branch}:${f.branchOid} upstream :refs/heads/${f.branch}`],
    ['other branch', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/task/other:${f.branchOid} origin :refs/heads/task/other`],
    ['missing lease', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push origin :refs/heads/${f.branch}`],
    ['mismatched lease', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/${f.branch}:${f.mainOid} origin :refs/heads/${f.branch}`],
    ['multiple targets', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/${f.branch}:${f.branchOid} origin :refs/heads/${f.branch} :refs/heads/task/other`],
    ['quoted other branch', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/task/other:${f.branchOid} origin ":refs/heads/task/other"`],
    ['unsafe name', (f: ReturnType<typeof createMergedRemoteFixture>) => `git push --force-with-lease=refs/heads/main:${f.branchOid} origin :refs/heads/main`],
    ['quoted protected name without lease', () => 'git push origin ":refs/heads/main"'],
  ])('blocks unsafe remote deletion variant: %s', (_name, commandFor) => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(commandFor(fixture), { branch: fixture.branch, mergeSlotHeld: true }, { cwd: fixture.repo })

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
    } finally {
      cleanupFixture(fixture)
    }
  })

  it.each([
    'git push origin +:refs/heads/main',
    'git push origin +:refs/heads/task/other',
  ])('blocks forced remote deletion refspec with merge-slot evidence: %s', (command) => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(command, { branch: fixture.branch, mergeSlotHeld: true }, { cwd: fixture.repo })

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('blocks safe-shaped deletion without observable merge-slot evidence', () => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.branchOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: false },
        { cwd: fixture.repo, bdMergeSlotIssue: null, currentActor: 'Maxpceo' },
      )

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain('merge-slot evidence')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('reports stale lease for safe-shaped remote task branch deletion', () => {
    const fixture = createMergedRemoteFixture()
    try {
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.mainOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain('lease stale/mismatched')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('reports missing remote task branch for safe-shaped deletion', () => {
    const fixture = createMergedRemoteFixture()
    try {
      execFileSync('git', ['push', 'origin', `:refs/heads/${fixture.branch}`], { cwd: fixture.repo, stdio: 'ignore' })
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.branchOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain(`не видит origin/${fixture.branch}`)
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('reports missing origin/main for safe-shaped deletion', () => {
    const fixture = createMergedRemoteFixture()
    try {
      execFileSync('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: fixture.remote, stdio: 'ignore' })
      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${fixture.branchOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain('не видит origin/main')
    } finally {
      cleanupFixture(fixture)
    }
  })

  it('blocks unmerged remote task branch deletion', () => {
    const fixture = createMergedRemoteFixture()
    try {
      execFileSync('git', ['checkout', fixture.branch], { cwd: fixture.repo, stdio: 'ignore' })
      writeFileSync(join(fixture.repo, 'unmerged.txt'), 'unmerged\n')
      execFileSync('git', ['add', 'unmerged.txt'], { cwd: fixture.repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'unmerged'], { cwd: fixture.repo, stdio: 'ignore' })
      execFileSync('git', ['push', 'origin', fixture.branch], { cwd: fixture.repo, stdio: 'ignore' })
      const unmergedOid = execFileSync('git', ['rev-parse', fixture.branch], { cwd: fixture.repo, encoding: 'utf8' }).trim()

      const decision = evaluateBashPolicy(
        `git push --force-with-lease=refs/heads/${fixture.branch}:${unmergedOid} origin :refs/heads/${fixture.branch}`,
        { branch: fixture.branch, mergeSlotHeld: true },
        { cwd: fixture.repo },
      )

      expect(decision?.policy).toBe('blockDestructiveCommand')
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain('ancestor of origin/main')
    } finally {
      cleanupFixture(fixture)
    }
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
      expect(decision?.reason).toContain('требует ACCEPTANCE MATRIX')
      expect(decision?.reason).not.toContain('requires ACCEPTANCE MATRIX')
    })
  })

  it.each(['FAIL', 'NOT RUN', 'BLOCKED', 'SCOPE GAP'])('blocks accepted close when ACCEPTANCE MATRIX contains result: %s', (result) => {
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
      expect(decision?.reason).toContain('FAIL/NOT RUN/BLOCKED/SCOPE GAP')
    })
  })

  it.each(['FAIL', 'NOT RUN', 'BLOCKED', 'SCOPE GAP'])('blocks accepted close when markdown table result contains %s', (result) => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
| criterion | evidence | result |
| --- | --- | --- |
| Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled. | Manual /reload in Pi exits with observed selected extensions active. | ${result} |
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain('FAIL/NOT RUN/BLOCKED/SCOPE GAP')
    })
  })

  it.each(['verdict', 'status'])('blocks accepted close when markdown table %s column contains BLOCKED', (column) => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
| criterion | evidence | ${column} |
| --- | --- | --- |
| Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled. | Manual /reload in Pi exits with observed selected extensions active. | BLOCKED |
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).toBe('blockBdCloseWithoutReview')
      expect(decision?.reason).toContain('FAIL/NOT RUN/BLOCKED/SCOPE GAP')
    })
  })

  it('allows accepted close when forbidden words are only mentioned as absent in evidence text', () => {
    withFakeBd(issueWithAcceptance, `ACCEPTANCE MATRIX:
| criterion | evidence | result |
| --- | --- | --- |
| Runtime smoke checks confirm Pi starts/reloads with selected extensions enabled. | Manual /reload in Pi exits with observed selected extensions active; no FAIL, NOT RUN, BLOCKED, or SCOPE GAP results were observed. | PASS |
| Manual /reload in Pi exits with observed selected extensions active. | Covered by the same runtime smoke check. | N/A |
`, (cwd) => {
      const decision = evaluateBashPolicy('bd close bead-a --reason accepted', {
        activeBead: 'bead-a',
        bdStatus: 'accepted',
      }, { cwd })

      expect(decision?.policy).not.toBe('blockBdCloseWithoutReview')
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
      expect(decision?.reason).toContain('POST-CLOSE MERGE FIX')
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

  it('allows risky mutation when a closed bead has matching POST-CLOSE MERGE FIX marker for the changed file', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `POST-CLOSE MERGE FIX
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${head}
FILES: .pi/extensions/beads-policy/index.ts
REASON: Recovery fix for merge quality gate
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).not.toBe('fastPathDiscipline')
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when matching POST-CLOSE MERGE FIX marker does not cover all changed files', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(join(repo, 'scripts/predev.sh'), '#!/usr/bin/env bash\necho unrelated\n')
    try {
      installFakeBd(binDir, `POST-CLOSE MERGE FIX
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${head}
FILES: .pi/extensions/beads-policy/index.ts
REASON: Recovery fix for merge quality gate
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts scripts/predev.sh', {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when POST-CLOSE MERGE FIX marker has no file allowlist', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `POST-CLOSE MERGE FIX
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${head}
REASON: Recovery fix for merge quality gate
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation when POST-CLOSE MERGE FIX file allowlist is unsafe', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `POST-CLOSE MERGE FIX
BRANCH: fix/current
WORKTREE: ${repoRoot}
START_COMMIT: ${head}
FILES: ../.pi/extensions/beads-policy/index.ts
REASON: Recovery fix for merge quality gate
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('blocks risky mutation for closed bead when POST-CLOSE MERGE FIX marker belongs to another branch', () => {
    const repo = createRepoWithRiskyPolicyDiff()
    const binDir = mkdtempSync(join(tmpdir(), 'beads-policy-bin-'))
    const oldPath = process.env.PATH
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    try {
      installFakeBd(binDir, `POST-CLOSE MERGE FIX
BRANCH: fix/other
WORKTREE: ${repoRoot}
START_COMMIT: ${head}
FILES: .pi/extensions/beads-policy/index.ts
REASON: Recovery fix for merge quality gate
`)
      process.env.PATH = `${binDir}:${oldPath ?? ''}`

      const decision = evaluateBashPolicy('git add .pi/extensions/beads-policy/index.ts', {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).toBe('fastPathDiscipline')
      expect(decision?.block).toBe(true)
    } finally {
      process.env.PATH = oldPath
      rmSync(repo, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })


  function createRepoWithLargeNonRiskyDiff(): string {
    const repo = mkdtempSync(join(tmpdir(), 'beads-policy-active-large-'))
    execFileSync('git', ['init', '-b', 'task/current-active'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' })
    mkdirSync(join(repo, 'tests/utils'), { recursive: true })
    for (let i = 0; i < 4; i += 1) writeFileSync(join(repo, `tests/utils/active-${i}.test.ts`), `export const before${i} = true\n`)
    execFileSync('git', ['add', 'tests/utils/active-0.test.ts', 'tests/utils/active-1.test.ts', 'tests/utils/active-2.test.ts', 'tests/utils/active-3.test.ts'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo, stdio: 'ignore' })
    for (let i = 0; i < 4; i += 1) writeFileSync(join(repo, `tests/utils/active-${i}.test.ts`), `export const after${i} = true\n`)
    execFileSync('git', ['add', 'tests/utils/active-0.test.ts', 'tests/utils/active-1.test.ts', 'tests/utils/active-2.test.ts', 'tests/utils/active-3.test.ts'], { cwd: repo, stdio: 'ignore' })
    return repo
  }

  async function evaluateCommitWithEntries(repo: string, entries: Array<Record<string, unknown>>) {
    let handler: any
    const pi = { on: (event: string, h: any) => { if (event === 'tool_call') handler = h }, registerCommand() {} }
    const ctx = {
      cwd: repo,
      sessionManager: { getSessionId: () => 'session-current', getEntries: () => entries },
      ui: { notify() {}, setStatus() {}, theme: { fg: (_style: string, value: string) => value } },
    }
    beadsPolicyExtension(pi as any)
    return handler({ toolName: 'bash', input: { command: 'git commit -m "test"' } }, ctx)
  }

  it('allows fastPathDiscipline commit-like command with current-session active bead typed workflow-state', async () => {
    const repo = createRepoWithLargeNonRiskyDiff()
    const startCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    try {
      const result = await evaluateCommitWithEntries(repo, [{ type: 'custom', customType: 'workflow-state', data: {
        activeBead: 'bead-active', state: 'implementing', branch: 'task/current-active', worktreePath: repo,
        startCommit, sessionKey: 'id:session-current', runtimeOwnerKey, planApproved: true, bdStatus: 'in_progress',
      } }])

      expect(result?.reason ?? '').not.toContain('fastPathDiscipline')
      expect(result?.reason ?? '').not.toContain('large code change без active bead')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it.each([
    ['without active bead', { state: 'idle', runtimeOwnerKey }],
    ['stale active bead', { activeBead: 'bead-active', state: 'implementing', startCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sessionKey: 'id:session-current', runtimeOwnerKey, planApproved: true, bdStatus: 'in_progress' }],
    ['foreign active bead', { activeBead: 'bead-active', state: 'implementing', branch: 'task/foreign-active', worktreePath: '/repo/foreign', sessionKey: 'id:foreign-session', runtimeOwnerKey: 'runtime:foreign', planApproved: true, bdStatus: 'in_progress' }],
  ])('blocks fastPathDiscipline commit-like command for %s typed workflow-state', async (_name, data) => {
    const repo = createRepoWithLargeNonRiskyDiff()
    try {
      const result = await evaluateCommitWithEntries(repo, [{ type: 'custom', customType: 'workflow-state', data }])
      expect(result?.reason).toContain('fastPathDiscipline')
      expect(result?.reason).toContain('large code change без active bead')
    } finally {
      rmSync(repo, { recursive: true, force: true })
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
    }, { cwd: tmpdir() })

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
    expect(reason).toContain('после подтверждения current-session branch/worktree ownership')
    expect(reason).toContain('/workflow-reset')
    expect(reason).not.toContain('next valid action')
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
    expect(decision?.reason).toContain('остановит workflow до review')
    expect(decision?.reason).not.toContain('would stop before review')

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

  it('blocks raw bd claim hidden inside shell command substitution', () => {
    const decision = evaluateBashPolicy('echo "$(bd update bead-b --claim --json)"', {
      state: 'idle',
    })

    expect(decision?.policy).toBe('blockRawBdClaim')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('/workflow-claim bead-b')
  })

  it('blocks raw bd claim even when workflow-claim appears elsewhere in the shell command', () => {
    const decision = evaluateBashPolicy('/workflow-claim bead-a && bd update bead-b --claim', {
      state: 'idle',
    })

    expect(decision?.policy).toBe('blockRawBdClaim')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('/workflow-claim bead-b')
  })

  it.each([
    '/workflow-claim bead-a && echo "$(bd update bead-b --claim)"',
    'echo "$(/workflow-claim bead-a; bd update bead-b --claim)"',
  ])('blocks raw bd claim hidden with workflow-claim in shell command: %s', (command) => {
    const decision = evaluateBashPolicy(command, {
      state: 'idle',
    })

    expect(decision?.policy).toBe('blockRawBdClaim')
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('/workflow-claim bead-b')
  })

  it('blocks git commit hidden inside shell command substitution', () => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy('echo "$(git commit -m x)"', {
      state: 'idle',
    }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it('blocks bash -c git commit on protected branches', () => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy("bash -c 'git commit -m x'", {
      state: 'idle',
    }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it('blocks backtick git commit hidden inside shell command substitution', () => {
    const repo = createMainRepo()
    const decision = evaluateBashPolicy('echo "`git commit -m x`"', {
      state: 'idle',
    }, { cwd: repo })

    expect(decision?.policy).toBe('blockMainMutation')
    expect(decision?.block).toBe(true)
  })

  it.each(['bash -lc', 'bash -ec', 'bash -o pipefail -c'])(
    'blocks %s git commit on protected branches',
    (shellPrefix) => {
      const repo = createMainRepo()
      const decision = evaluateBashPolicy(`${shellPrefix} 'git commit -m x'`, {
        state: 'idle',
      }, { cwd: repo })

      expect(decision?.policy).toBe('blockMainMutation')
      expect(decision?.block).toBe(true)
    },
  )

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
    }, { cwd: tmpdir() })

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

  it('allows review_bead from the locked inreview task worktree and routes missing review cwd through structured scope', () => {
    const worktree = createRepo('task/current')
    try {
      const state = lockedState(worktree, { state: 'inreview', bdStatus: 'inreview' })
      const matching = evaluateToolPolicy('review_bead', { beadId: 'bead-a', worktreePath: worktree }, state)
      const omitted = evaluateToolPolicy('review_bead', { beadId: 'bead-a' }, state)

      expect(matching).toBeUndefined()
      expect(omitted).toBeUndefined()
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

  it('allows supported env -C and path-qualified env bd writes when explicit cwd is the active worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const decision = evaluateBashPolicy(`env -C ${worktree} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const longOptionDecision = evaluateBashPolicy(`env --chdir=${worktree} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const assignmentDecision = evaluateBashPolicy(`env FOO=bar -C ${worktree} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const pathQualifiedDecision = evaluateBashPolicy(`/usr/bin/env -C ${worktree} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })

      expect(decision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(decision?.policy).not.toBe('blockMainMutation')
      expect(longOptionDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(longOptionDecision?.policy).not.toBe('blockMainMutation')
      expect(assignmentDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(assignmentDecision?.policy).not.toBe('blockMainMutation')
      expect(pathQualifiedDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedDecision?.policy).not.toBe('blockMainMutation')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('blocks supported env -C and path-qualified env bd writes when explicit cwd is outside the active worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const mainDecision = evaluateBashPolicy(`env -C ${main} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: worktree })
      const otherDecision = evaluateBashPolicy(`env -C ${other} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const assignmentMainDecision = evaluateBashPolicy(`env FOO=bar -C ${main} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: worktree })
      const pathQualifiedMainDecision = evaluateBashPolicy(`/usr/bin/env -C ${main} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: worktree })
      const pathQualifiedOtherDecision = evaluateBashPolicy(`/opt/homebrew/bin/env -C ${other} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: worktree })

      expect(mainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(otherDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(assignmentMainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedMainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedOtherDecision?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })


  it('keeps unsupported env option forms fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const unsetActiveDecision = evaluateBashPolicy(`env -u FOO -C ${worktree} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const unsetMainDecision = evaluateBashPolicy(`env -u FOO -C ${main} bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: worktree })
      const splitStringDecision = evaluateBashPolicy(`env -S 'git -C ${main} add tracked.txt'`, lockedState(worktree), { cwd: worktree })
      const longSplitStringDecision = evaluateBashPolicy(`env --split-string='git -C ${other} add tracked.txt'`, lockedState(worktree), { cwd: worktree })
      const unknownOptionDecision = evaluateBashPolicy(`env --unknown-option -C ${main} git add tracked.txt`, lockedState(worktree), { cwd: worktree })

      expect(unsetActiveDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(unsetActiveDecision?.reason).toContain('unsupported env options')
      expect(unsetMainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(splitStringDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(longSplitStringDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(unknownOptionDecision?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })


  it('allows supported leading cd bd writes but keeps nested bash -c cd fail-closed', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const leadingCdDecision = evaluateBashPolicy(`cd ${worktree} && bd comments add bead-a smoke --json`, lockedState(worktree), { cwd: main })
      const quotedShellOperatorDecision = evaluateBashPolicy(`cd ${worktree} && echo "literal ; && | >"`, lockedState(worktree), { cwd: main })
      const nestedShellDecision = evaluateBashPolicy(`bash -c 'cd ${worktree} && bd comments add bead-a smoke --json'`, lockedState(worktree), { cwd: main })

      expect(leadingCdDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(leadingCdDecision?.policy).not.toBe('blockMainMutation')
      expect(quotedShellOperatorDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(nestedShellDecision?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('keeps leading cd shell operators and shell -c fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const semicolonDecision = evaluateBashPolicy(`cd ${worktree} && bd comments add bead-a smoke;git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })
      const andDecision = evaluateBashPolicy(`cd ${worktree} && bd comments add bead-a smoke&&git -C ${other} add tracked.txt`, lockedState(worktree), { cwd: main })
      const pipeDecision = evaluateBashPolicy(`cd ${worktree} && printf smoke|tee evidence.txt`, lockedState(worktree), { cwd: main })
      const redirectDecision = evaluateBashPolicy(`cd ${worktree} && printf smoke > evidence.txt`, lockedState(worktree), { cwd: main })
      const shellCommandDecision = evaluateBashPolicy(`cd ${worktree} && sh -c 'git -C ${main} add tracked.txt'`, lockedState(worktree), { cwd: main })

      expect(semicolonDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(semicolonDecision?.reason).toContain('leading cd')
      expect(semicolonDecision?.reason).toContain('shell operators')
      expect(andDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pipeDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(redirectDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(shellCommandDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(shellCommandDecision?.reason).toContain('shell -c')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps leading cd command substitution fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const dollarDecision = evaluateBashPolicy(`cd ${worktree} && echo $(git -C ${main} add tracked.txt)`, lockedState(worktree), { cwd: main })
      const backtickDecision = evaluateBashPolicy(`cd ${worktree} && echo \`git -C ${other} add tracked.txt\``, lockedState(worktree), { cwd: main })
      const arithmeticDecision = evaluateBashPolicy(`cd ${worktree} && touch $((1 + 2))`, lockedState(worktree), { cwd: main })
      const singleQuotedLiteralDecision = evaluateBashPolicy(`cd ${worktree} && touch 'literal $(git -C ${main} add tracked.txt)'`, lockedState(worktree), { cwd: main })
      const escapedDollarLiteralDecision = evaluateBashPolicy(`cd ${worktree} && touch "\\$(git -C ${main} add tracked.txt)"`, lockedState(worktree), { cwd: main })
      const escapedBacktickLiteralDecision = evaluateBashPolicy('cd ' + worktree + ' && touch "\\`git -C ' + main + ' add tracked.txt\\`"', lockedState(worktree), { cwd: main })

      expect(dollarDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(dollarDecision?.reason).toContain('command substitution')
      expect(backtickDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(arithmeticDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(singleQuotedLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(singleQuotedLiteralDecision?.policy).not.toBe('blockMainMutation')
      expect(escapedDollarLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(escapedDollarLiteralDecision?.policy).not.toBe('blockMainMutation')
      expect(escapedBacktickLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(escapedBacktickLiteralDecision?.policy).not.toBe('blockMainMutation')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('blocks env -C commands that redirect git -C outside the active worktree', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const mainDecision = evaluateBashPolicy(`env -C ${worktree} git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })
      const otherDecision = evaluateBashPolicy(`env -C ${worktree} git -C ${other} add tracked.txt`, lockedState(worktree), { cwd: main })
      const insideDecision = evaluateBashPolicy(`env -C ${worktree} git -C ${worktree} add tracked.txt`, lockedState(worktree), { cwd: main })
      const pathQualifiedMainDecision = evaluateBashPolicy(`env -C ${worktree} /usr/bin/git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })
      const pathQualifiedOtherDecision = evaluateBashPolicy(`env -C ${worktree} /opt/homebrew/bin/git -C ${other} add tracked.txt`, lockedState(worktree), { cwd: main })
      const pathQualifiedInsideDecision = evaluateBashPolicy(`env -C ${worktree} /usr/bin/git -C ${worktree} add tracked.txt`, lockedState(worktree), { cwd: main })
      const echoDecision = evaluateBashPolicy(`env -C ${worktree} echo /usr/bin/git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })

      expect(mainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(otherDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(insideDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(insideDecision?.policy).not.toBe('blockMainMutation')
      expect(pathQualifiedMainDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedOtherDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedInsideDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(pathQualifiedInsideDecision?.policy).not.toBe('blockMainMutation')
      expect(echoDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps env -C shell -c commands fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const nestedGitDecision = evaluateBashPolicy(`env -C ${worktree} bash -c 'git -C ${main} add tracked.txt'`, lockedState(worktree), { cwd: main })
      const nestedBdDecision = evaluateBashPolicy(`env -C ${worktree} sh -c 'bd comments add bead-a smoke --json'`, lockedState(worktree), { cwd: main })

      expect(nestedGitDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(nestedGitDecision?.reason).toContain('shell -c')
      expect(nestedBdDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(nestedBdDecision?.reason).toContain('shell -c')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('keeps env -C shell operators fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    try {
      const semicolonDecision = evaluateBashPolicy(`env -C ${worktree} bd comments add bead-a smoke;git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })
      const andDecision = evaluateBashPolicy(`env -C ${worktree} bd comments add bead-a smoke&&git -C ${main} add tracked.txt`, lockedState(worktree), { cwd: main })
      const pipeDecision = evaluateBashPolicy(`env -C ${worktree} printf smoke|tee evidence.txt`, lockedState(worktree), { cwd: main })
      const redirectDecision = evaluateBashPolicy(`env -C ${worktree} printf smoke > evidence.txt`, lockedState(worktree), { cwd: main })
      const quotedDecision = evaluateBashPolicy(`env -C ${worktree} echo \"literal ; && | >\"`, lockedState(worktree), { cwd: main })

      expect(semicolonDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(semicolonDecision?.reason).toContain('shell operators')
      expect(andDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(pipeDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(redirectDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(quotedDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('keeps env -C command substitution fail-closed under the active worktree lock', () => {
    const main = createRepo('main')
    const worktree = createRepo('task/current')
    const other = createRepo('task/other')
    try {
      const dollarDecision = evaluateBashPolicy(`env -C ${worktree} echo $(git -C ${main} add tracked.txt)`, lockedState(worktree), { cwd: main })
      const backtickDecision = evaluateBashPolicy(`env -C ${worktree} echo \`git -C ${other} add tracked.txt\``, lockedState(worktree), { cwd: main })
      const arithmeticDecision = evaluateBashPolicy(`env -C ${worktree} touch $((1 + 2))`, lockedState(worktree), { cwd: main })
      const singleQuotedLiteralDecision = evaluateBashPolicy(`env -C ${worktree} touch 'literal $(git -C ${main} add tracked.txt)'`, lockedState(worktree), { cwd: main })
      const escapedDollarLiteralDecision = evaluateBashPolicy(`env -C ${worktree} touch "\\$(git -C ${main} add tracked.txt)"`, lockedState(worktree), { cwd: main })
      const escapedBacktickLiteralDecision = evaluateBashPolicy('env -C ' + worktree + ' touch "\\`git -C ' + main + ' add tracked.txt\\`"', lockedState(worktree), { cwd: main })

      expect(dollarDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(dollarDecision?.reason).toContain('command substitution')
      expect(backtickDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(arithmeticDecision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(singleQuotedLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(singleQuotedLiteralDecision?.policy).not.toBe('blockMainMutation')
      expect(escapedDollarLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(escapedDollarLiteralDecision?.policy).not.toBe('blockMainMutation')
      expect(escapedBacktickLiteralDecision?.policy).not.toBe('enforceActiveWorktreeCwd')
      expect(escapedBacktickLiteralDecision?.policy).not.toBe('blockMainMutation')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
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
      expect(missingDecision?.reason).toContain('отсутствующему worktree')
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
    expect(bashDecision?.reason).toContain('recorded worktree path отсутствует')
    expect(bashDecision?.reason).toContain('workflow_reset')
    expect(bashDecision?.reason).not.toContain('no recorded worktree path')
    expect(editDecision?.policy).toBe('enforceActiveWorktreeCwd')
    expect(editDecision?.reason).toContain('recorded worktree path отсутствует')
    expect(writeDecision?.policy).toBe('enforceActiveWorktreeCwd')
    expect(writeDecision?.reason).toContain('recorded worktree path отсутствует')
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

  it('allows typed dispatch/review/docs tools to omit cwd because structured task scope routes to the active worktree', () => {
    const worktree = createRepo('task/current')
    const main = createRepo('main')
    try {
      const omitted = evaluateToolPolicy('dispatch_supervisor', { beadId: 'bead-a' }, lockedState(worktree))
      const matching = evaluateToolPolicy('dispatch_docs_agent', { beadId: 'bead-a', cwd: worktree }, lockedState(worktree))
      const outside = evaluateToolPolicy('review_bead', { beadId: 'bead-a', worktreePath: main }, lockedState(worktree))

      expect(omitted).toBeUndefined()
      expect(matching).toBeUndefined()
      expect(outside?.policy).toBe('enforceActiveWorktreeCwd')
    } finally {
      rmSync(main, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it.each(['dispatch_supervisor', 'dispatch_reviewer', 'dispatch_docs_agent', 'review_bead'])(
    'blocks %s when active lock has no recorded worktree path',
    (toolName) => {
      const decision = evaluateToolPolicy(toolName, { beadId: 'bead-a', cwd: tmpdir() }, lockedState('', { worktreePath: undefined }))

      expect(decision?.policy).toBe('enforceActiveWorktreeCwd')
      expect(decision?.reason).toContain('recorded worktree path отсутствует')
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
      expect(bashDecision.reason).toContain('recorded worktree path отсутствует')
      expect(bashDecision.reason).toContain('workflow_reset')
      expect(bashDecision.reason).not.toContain('blockMainMutation')
      expect(writeDecision.reason).toContain('enforceActiveWorktreeCwd')
      expect(writeDecision.reason).toContain('recorded worktree path отсутствует')
      expect(writeDecision.reason).toContain('workflow_reset')
    } finally {
      rmSync(main, { recursive: true, force: true })
    }
  })
})
