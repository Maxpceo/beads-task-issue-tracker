import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LEGACY_WORKFLOW_CHAINS_RELATIVE,
  TRACKER_DEFAULTS,
  WORKFLOW_CHAINS_CONFIG_RELATIVE,
  expandHomePath,
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
      expect(chains.copyRoot).toBe('')
      expect(chains.readError).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
