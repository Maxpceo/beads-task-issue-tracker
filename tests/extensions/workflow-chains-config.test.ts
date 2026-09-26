import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LEGACY_WORKFLOW_CHAINS_RELATIVE,
  TRACKER_DEFAULT_CHECKS,
  TRACKER_DEFAULTS,
  WORKFLOW_CHAINS_CONFIG_RELATIVE,
  expandHomePath,
  isMainWriteAllowed,
  loadWorkflowChains,
} from '../../.pi/extensions/workflow-chains-config/index'

const NAMING = {
  types: ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'ci', 'task'],
  basenameEqualsBranchSuffix: true,
  suffixMustNotStartWith: 'beads-task-issue-tracker-',
  suffixPattern: '^[a-z0-9]+-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$',
  requireActiveBeadSuffixPrefix: true,
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'wf-chains-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  return repo
}

function writeConfig(repo: string, data: unknown, relative = WORKFLOW_CHAINS_CONFIG_RELATIVE) {
  mkdirSync(join(repo, relative, '..'), { recursive: true })
  writeFileSync(join(repo, relative), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}

describe('workflow-chains-config', () => {
  it('returns tracker defaults with empty readError when no file exists', () => {
    const repo = initRepo()
    try {
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(true)
      expect(chains.handoffFromCopy).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(chains.requireRussian).toBe(true)
      expect(isMainWriteAllowed(chains)).toBe(false)
      expect(chains.readError).toBe('')
      expect(chains.copyRootRaw).toBe(TRACKER_DEFAULTS.copyRootRaw)
      expect(chains.copyRoot).toBe(join(homedir(), 'Projects', 'worktrees', 'beads-task-issue-tracker'))
      expect(chains.naming).toEqual(NAMING)
      expect(chains.configPath).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not skip copy when cwd is a tmpdir without git or config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-chains-nogit-'))
    try {
      const chains = loadWorkflowChains(dir)
      expect(chains.copyRequired).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(chains.requireRussian).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores legacy .pi/workflow-chains.json', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, { copyRequired: false, handoffFromCopy: false, naming: NAMING }, LEGACY_WORKFLOW_CHAINS_RELATIVE)
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(true)
      expect(chains.readError).toBe('')
      expect(chains.configPath).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('loads committed tracker ritual and expands ~/ and $HOME in copyRoot', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '~/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        naming: NAMING,
      })
      const tilde = loadWorkflowChains(repo)
      expect(tilde.copyRequired).toBe(true)
      expect(tilde.copyRoot).toBe(expandHomePath('~/Projects/worktrees/beads-task-issue-tracker'))
      expect(tilde.readError).toBe('')

      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '$HOME/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        naming: NAMING,
      })
      const home = loadWorkflowChains(join(repo, 'nested-missing'))
      expect(home.copyRoot).toBe(join(homedir(), 'Projects', 'worktrees', 'beads-task-issue-tracker'))
      expect(home.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('walks from nested cwd up to git root to find .pi/config/workflow-chains.json', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, { copyRequired: false, handoffFromCopy: false, naming: NAMING })
      const nested = join(repo, 'app', 'components')
      mkdirSync(nested, { recursive: true })
      const chains = loadWorkflowChains(nested)
      expect(chains.copyRequired).toBe(false)
      expect(chains.handoffFromCopy).toBe(false)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.copyRoot).toBe('')
      expect(chains.readError).toBe('')
      expect(chains.configPath).toBe(join(repo, WORKFLOW_CHAINS_CONFIG_RELATIVE))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('keeps tracker ritual and reports readError for broken JSON, empty file, string copyRequired, and missing copyRoot', () => {
    const cases: Array<{ label: string; body: string | Record<string, unknown> }> = [
      { label: 'broken', body: '{ not json' },
      { label: 'empty', body: '   \n' },
      { label: 'string-flag', body: { copyRequired: 'false', handoffFromCopy: false, naming: NAMING } },
      { label: 'missing-root', body: { copyRequired: true, handoffFromCopy: true, naming: NAMING } },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        writeConfig(repo, item.body)
        const chains = loadWorkflowChains(repo)
        expect(chains.copyRequired, item.label).toBe(true)
        expect(chains.handoffFromCopy, item.label).toBe(true)
        expect(chains.reviewRequired, item.label).toBe(true)
        expect(chains.matrixRequired, item.label).toBe(true)
        expect(chains.mainWriteAllowed, item.label).toBe(false)
        expect(chains.requireRussian, item.label).toBe(true)
        expect(chains.checks, item.label).toEqual([...TRACKER_DEFAULT_CHECKS])
        expect(isMainWriteAllowed(chains), item.label).toBe(false)
        expect(chains.readError, item.label).toContain(join(repo, WORKFLOW_CHAINS_CONFIG_RELATIVE))
        expect(chains.readError, item.label).not.toBe('')
        expect(chains.copyRoot, item.label).toBe(join(homedir(), 'Projects', 'worktrees', 'beads-task-issue-tracker'))
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('accepts copyRequired false without copyRoot', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, { copyRequired: false, handoffFromCopy: false, naming: NAMING })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(false)
      expect(chains.handoffFromCopy).toBe(false)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(isMainWriteAllowed(chains)).toBe(false)
      expect(chains.copyRoot).toBe('')
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads exact reviewRequired false without resetting copyRequired', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, { copyRequired: false, handoffFromCopy: false, reviewRequired: false, naming: NAMING })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(false)
      expect(chains.reviewRequired).toBe(false)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('keeps copyRequired and fail-closes reviewRequired when the field is missing or not boolean', () => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'missing', body: { copyRequired: false, handoffFromCopy: false, naming: NAMING } },
      { label: 'string-false', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: 'false', naming: NAMING } },
      { label: 'null', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: null, naming: NAMING } },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        writeConfig(repo, item.body)
        const chains = loadWorkflowChains(repo)
        expect(chains.copyRequired, item.label).toBe(false)
        expect(chains.reviewRequired, item.label).toBe(true)
        expect(chains.matrixRequired, item.label).toBe(true)
        expect(chains.readError, item.label).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('reads committed reviewRequired true with tracker copy ritual', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '~/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        reviewRequired: true,
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads exact matrixRequired false without resetting reviewRequired', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, { copyRequired: false, handoffFromCopy: false, reviewRequired: true, matrixRequired: false, naming: NAMING })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(false)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(false)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fail-closes matrixRequired when the field is missing or not boolean', () => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'missing', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, naming: NAMING } },
      { label: 'string-false', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: 'false', naming: NAMING } },
      { label: 'null', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: null, naming: NAMING } },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        writeConfig(repo, item.body)
        const chains = loadWorkflowChains(repo)
        expect(chains.reviewRequired, item.label).toBe(false)
        expect(chains.matrixRequired, item.label).toBe(true)
        expect(chains.readError, item.label).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('reads committed matrixRequired true with tracker copy ritual', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '~/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        reviewRequired: true,
        matrixRequired: true,
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(isMainWriteAllowed(chains)).toBe(false)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads exact mainWriteAllowed true without resetting copyRequired or reviewRequired', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: false,
        handoffFromCopy: false,
        reviewRequired: true,
        matrixRequired: true,
        mainWriteAllowed: true,
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(false)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(true)
      expect(isMainWriteAllowed(chains)).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not treat mainWriteAllowed true as permission when copyRequired is true', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '~/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        reviewRequired: true,
        matrixRequired: true,
        mainWriteAllowed: true,
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.copyRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(true)
      expect(isMainWriteAllowed(chains)).toBe(false)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fail-closes mainWriteAllowed without resetting other fields when missing or not boolean', () => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'missing', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, naming: NAMING } },
      { label: 'string-true', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: 'true', naming: NAMING } },
      { label: 'null', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: null, naming: NAMING } },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        writeConfig(repo, item.body)
        const chains = loadWorkflowChains(repo)
        expect(chains.copyRequired, item.label).toBe(false)
        expect(chains.reviewRequired, item.label).toBe(false)
        expect(chains.matrixRequired, item.label).toBe(false)
        expect(chains.mainWriteAllowed, item.label).toBe(false)
        expect(isMainWriteAllowed(chains), item.label).toBe(false)
        expect(chains.readError, item.label).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('committed tracker file keeps ritual flags and the three checks', () => {
    const chains = loadWorkflowChains(process.cwd())
    expect(chains.readError).toBe('')
    expect(chains.copyRequired).toBe(true)
    expect(chains.handoffFromCopy).toBe(true)
    expect(chains.reviewRequired).toBe(true)
    expect(chains.matrixRequired).toBe(true)
    expect(chains.mainWriteAllowed).toBe(false)
    expect(chains.requireRussian).toBe(true)
    expect(isMainWriteAllowed(chains)).toBe(false)
    expect(chains.checksExplicit).toBe(true)
    expect(chains.checks).toEqual([...TRACKER_DEFAULT_CHECKS])
    expect(chains.naming).toEqual(NAMING)
    expect(chains.copyRootRaw).toBe(TRACKER_DEFAULTS.copyRootRaw)
  })

  it('uses tracker checks and checksExplicit false when the file is missing', () => {
    const repo = initRepo()
    try {
      const chains = loadWorkflowChains(repo)
      expect(chains.checks).toEqual([...TRACKER_DEFAULT_CHECKS])
      expect(chains.checksExplicit).toBe(false)
      expect(chains.copyRequired).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('keeps tracker checks, not an empty list, for broken JSON and an empty file', () => {
    for (const body of ['{ not json', '   \n']) {
      const repo = initRepo()
      try {
        writeConfig(repo, body)
        const chains = loadWorkflowChains(repo)
        expect(chains.checks).toEqual([...TRACKER_DEFAULT_CHECKS])
        expect(chains.checksExplicit).toBe(false)
        expect(chains.copyRequired).toBe(true)
        expect(chains.reviewRequired).toBe(true)
        expect(chains.matrixRequired).toBe(true)
        expect(chains.mainWriteAllowed).toBe(false)
        expect(chains.requireRussian).toBe(true)
        expect(chains.checks).toEqual([...TRACKER_DEFAULT_CHECKS])
        expect(chains.readError).not.toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('does not reset other flags when checks is missing or the wrong type', () => {
    const cases: Array<{ label: string; checks?: unknown }> = [
      { label: 'missing' },
      { label: 'null', checks: null },
      { label: 'string', checks: 'pnpm test' },
      { label: 'empty-string', checks: '' },
      { label: 'object', checks: { command: 'pnpm test' } },
      { label: 'number', checks: 0 },
      { label: 'blank-item', checks: ['pnpm test', ' '] },
      { label: 'non-string-item', checks: ['pnpm test', 1] },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        const body: Record<string, unknown> = {
          copyRequired: false,
          handoffFromCopy: false,
          reviewRequired: false,
          matrixRequired: false,
          mainWriteAllowed: true,
          naming: NAMING,
        }
        if (item.label !== 'missing') body.checks = item.checks
        writeConfig(repo, body)
        const chains = loadWorkflowChains(repo)
        expect(chains.checks, item.label).toEqual([...TRACKER_DEFAULT_CHECKS])
        expect(chains.checksExplicit, item.label).toBe(false)
        expect(chains.copyRequired, item.label).toBe(false)
        expect(chains.handoffFromCopy, item.label).toBe(false)
        expect(chains.reviewRequired, item.label).toBe(false)
        expect(chains.matrixRequired, item.label).toBe(false)
        expect(chains.mainWriteAllowed, item.label).toBe(true)
        expect(chains.naming, item.label).toEqual(NAMING)
        expect(chains.readError, item.label).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('treats an explicit empty checks array as no commands without resetting flags', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: true,
        copyRoot: '~/Projects/worktrees/beads-task-issue-tracker',
        handoffFromCopy: true,
        reviewRequired: true,
        matrixRequired: true,
        mainWriteAllowed: false,
        checks: [],
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.checks).toEqual([])
      expect(chains.checksExplicit).toBe(true)
      expect(chains.copyRequired).toBe(true)
      expect(chains.reviewRequired).toBe(true)
      expect(chains.matrixRequired).toBe(true)
      expect(chains.mainWriteAllowed).toBe(false)
      expect(chains.requireRussian).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads exact requireRussian false without resetting other flags or checks', () => {
    const repo = initRepo()
    try {
      writeConfig(repo, {
        copyRequired: false,
        handoffFromCopy: false,
        reviewRequired: false,
        matrixRequired: false,
        mainWriteAllowed: true,
        requireRussian: false,
        checks: ['echo hi'],
        naming: NAMING,
      })
      const chains = loadWorkflowChains(repo)
      expect(chains.requireRussian).toBe(false)
      expect(chains.copyRequired).toBe(false)
      expect(chains.reviewRequired).toBe(false)
      expect(chains.matrixRequired).toBe(false)
      expect(chains.mainWriteAllowed).toBe(true)
      expect(chains.checks).toEqual(['echo hi'])
      expect(chains.checksExplicit).toBe(true)
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fail-closes requireRussian without resetting other fields when missing or not boolean', () => {
    const cases: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'missing', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: true, checks: ['echo hi'], naming: NAMING } },
      { label: 'string-false', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: true, requireRussian: 'false', checks: ['echo hi'], naming: NAMING } },
      { label: 'zero', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: true, requireRussian: 0, checks: ['echo hi'], naming: NAMING } },
      { label: 'null', body: { copyRequired: false, handoffFromCopy: false, reviewRequired: false, matrixRequired: false, mainWriteAllowed: true, requireRussian: null, checks: ['echo hi'], naming: NAMING } },
    ]
    for (const item of cases) {
      const repo = initRepo()
      try {
        writeConfig(repo, item.body)
        const chains = loadWorkflowChains(repo)
        expect(chains.requireRussian, item.label).toBe(true)
        expect(chains.copyRequired, item.label).toBe(false)
        expect(chains.reviewRequired, item.label).toBe(false)
        expect(chains.matrixRequired, item.label).toBe(false)
        expect(chains.mainWriteAllowed, item.label).toBe(true)
        expect(chains.checks, item.label).toEqual(['echo hi'])
        expect(chains.readError, item.label).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })
})
