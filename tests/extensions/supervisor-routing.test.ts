import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  chooseSupervisor,
  loadSupervisorRouting,
  resolveSupervisorFromRouting,
  textForSupervisorRouting,
  type SupervisorRoutingLoadResult,
} from '../../.pi/extensions/beads-dispatch/supervisor-routing'

const temps: string[] = []

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempCwd(withPiDir = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-routing-'))
  temps.push(root)
  if (withPiDir) fs.mkdirSync(path.join(root, '.pi'), { recursive: true })
  return root
}

function writeRouting(cwd: string, value: unknown): string {
  const filePath = path.join(cwd, '.pi', 'supervisor-routing.json')
  const body = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  fs.writeFileSync(filePath, body)
  return filePath
}

function routingResult(partial: Partial<SupervisorRoutingLoadResult> & Pick<SupervisorRoutingLoadResult, 'rules' | 'default'>): SupervisorRoutingLoadResult {
  return { path: null, ...partial }
}

function hy3zLikeDescription(): string {
  return `### Origin
- Prose mentions vue/tauri/test-supervisor role names only.
### Files
- .pi/extensions/beads-dispatch/index.ts
### Current state
- chooseSupervisor misroutes on bare tauri in role words.
### Target state
- Role words vue-supervisor / tauri-supervisor / test-supervisor do not select tauri-supervisor.
### Investigation findings
- Bare tauri substring in prose selected tauri-supervisor for pi+workflow beads.
### Decisions
- Drop bare tauri from first regex; keep backend/tracker labels and real backend path/tooling signals.
### Rejected alternatives
- Labels-only routing without text signals.
### Dependencies / blockers
- none.
### Acceptance criteria
- dryRun without agent= returns test-supervisor for this fixture.
### Verification / acceptance checks
- pnpm exec vitest run tests/extensions/beads-dispatch.test.ts
### Out of scope
- src-tauri
- app/`
}

describe('loadSupervisorRouting', () => {
  it('N1: missing file outside the repo tree is implementer with missing: true', () => {
    const cwd = tempCwd(true)
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.missing).toBe(true)
    expect(loaded.rules).toEqual([])
    expect(loaded.default).toBe('implementer')
    expect(chooseSupervisor({
      title: 'Edit src-tauri/src/lib.rs',
      description: 'rust cargo backend',
      labels: ['backend', 'tracker'],
    }, cwd)).toBe('implementer')
  })

  it('N2: broken JSON is implementer with error on the load result', () => {
    const cwd = tempCwd()
    writeRouting(cwd, '{ not-json')
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.default).toBe('implementer')
    expect(loaded.missing).toBeFalsy()
    expect(loaded.error).toMatch(/invalid JSON/)
    expect(chooseSupervisor({ title: 'neutral', description: '', labels: [] }, cwd)).toBe('implementer')
  })

  it('N3: valid empty rules keep configured default', () => {
    const cwd = tempCwd()
    writeRouting(cwd, { rules: [], default: 'custom-empty-default' })
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.missing).toBeFalsy()
    expect(loaded.error).toBeUndefined()
    expect(loaded.default).toBe('custom-empty-default')
    expect(chooseSupervisor({ title: 'anything rust vue', labels: ['backend'] }, cwd)).toBe('custom-empty-default')
  })

  it('N4: valid empty rules without default fall back to implementer', () => {
    const cwd = tempCwd()
    writeRouting(cwd, { rules: [] })
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.missing).toBeFalsy()
    expect(loaded.error).toBeUndefined()
    expect(loaded.default).toBe('implementer')
    expect(chooseSupervisor({ title: 'neutral', labels: [] }, cwd)).toBe('implementer')
  })

  it('N14: invalid labels/textPatterns types skip the rule and record an error note', () => {
    const cwd = tempCwd()
    writeRouting(cwd, {
      default: 'ok-default',
      rules: [
        { agent: 'bad-labels', labels: 'backend', textPatterns: ['alpha'] },
        { agent: 'bad-patterns', labels: ['ok-label'], textPatterns: 'not-array' },
        { agent: 'mixed-elements', labels: ['ok-label', 1], textPatterns: ['alpha'] },
        { agent: 'good-agent', labels: ['ok-label'] },
      ],
    })
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.error).toBeTruthy()
    expect(loaded.error).toMatch(/labels is not an array/)
    expect(loaded.error).toMatch(/textPatterns is not an array/)
    expect(loaded.error).toMatch(/non-string/)
    expect(loaded.rules).toEqual([{ agent: 'good-agent', labels: ['ok-label'], textPatterns: [] }])
    expect(resolveSupervisorFromRouting({ title: 'x', labels: ['ok-label'] }, loaded)).toBe('good-agent')
    expect(resolveSupervisorFromRouting({ title: 'alpha', labels: [] }, loaded)).toBe('ok-default')
  })
})

describe('resolveSupervisorFromRouting', () => {
  it('N5: first matching rule wins when tokens compete', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [
        { agent: 'tauri-supervisor', labels: ['backend'], textPatterns: ['src-tauri'] },
        { agent: 'test-supervisor', labels: ['dx'], textPatterns: ['workflow'] },
      ],
    })
    expect(resolveSupervisorFromRouting({
      title: 'src-tauri and workflow together',
      description: 'workflow docs',
      labels: ['dx'],
    }, routing)).toBe('tauri-supervisor')
  })

  it('N6: label-only rule matches without textPatterns', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [{ agent: 'label-only-agent', labels: ['special-label'], textPatterns: [] }],
    })
    expect(resolveSupervisorFromRouting({ title: 'neutral', description: '', labels: ['special-label'] }, routing)).toBe('label-only-agent')
    expect(resolveSupervisorFromRouting({ title: 'neutral', description: '', labels: ['other'] }, routing)).toBe('fallback-agent')
  })

  it('N7: text-only rule matches when labels field is absent/empty', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [{ agent: 'text-only-agent', labels: [], textPatterns: ['unique-token'] }],
    })
    expect(resolveSupervisorFromRouting({ title: 'has unique-token here', description: '', labels: [] }, routing)).toBe('text-only-agent')
  })

  it('N8: a rule with no labels and no patterns does not match everything', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [{ agent: 'should-not-match', labels: [], textPatterns: [] }],
    })
    expect(resolveSupervisorFromRouting({ title: 'any title', description: 'any body', labels: ['any'] }, routing)).toBe('fallback-agent')
  })

  it('N9: empty textPatterns are filtered and do not match', () => {
    const cwd = tempCwd()
    writeRouting(cwd, {
      default: 'fallback-agent',
      rules: [
        { agent: 'empty-pattern-agent', labels: [], textPatterns: ['', '   '] },
        { agent: 'kept-pattern-agent', labels: [], textPatterns: ['', 'kept-token'] },
      ],
    })
    const loaded = loadSupervisorRouting(cwd)
    expect(loaded.rules.map((rule) => rule.agent)).toEqual(['kept-pattern-agent'])
    expect(resolveSupervisorFromRouting({ title: 'no tokens', description: '', labels: [] }, loaded)).toBe('fallback-agent')
    expect(resolveSupervisorFromRouting({ title: 'has kept-token', description: '', labels: [] }, loaded)).toBe('kept-pattern-agent')
  })

  it('N10: a foreign stack routes from a synthetic table without kernel edits', () => {
    const routing = routingResult({
      default: 'generic-agent',
      rules: [
        { agent: 'python-supervisor', labels: ['python'], textPatterns: ['.py', 'django'] },
        { agent: 'react-supervisor', labels: ['react'], textPatterns: ['jsx', 'tsx'] },
      ],
    })
    expect(resolveSupervisorFromRouting({ title: 'Add view', description: '', labels: ['python'] }, routing)).toBe('python-supervisor')
    expect(resolveSupervisorFromRouting({ title: 'Widget', description: 'touch app.tsx', labels: [] }, routing)).toBe('react-supervisor')
    expect(resolveSupervisorFromRouting({ title: 'Docs only', description: '', labels: [] }, routing)).toBe('generic-agent')
  })

  it('N11: hy3z-like route changes when only the routing object changes', () => {
    const bead = {
      title: 'hy3z-like pi workflow routing',
      description: hy3zLikeDescription(),
      labels: ['pi', 'workflow'],
    }
    const shippedLike = routingResult({
      default: 'test-supervisor',
      rules: [
        { agent: 'tauri-supervisor', labels: ['backend', 'tracker'], textPatterns: ['rust', 'cargo', 'src-tauri'] },
        { agent: 'test-supervisor', labels: ['ci', 'dx'], textPatterns: ['test', 'vitest', 'ci', 'workflow'] },
        { agent: 'vue-supervisor', labels: ['frontend', 'ui', 'data'], textPatterns: ['vue', 'component', 'composable', 'page', 'app/'] },
      ],
    })
    expect(resolveSupervisorFromRouting(bead, shippedLike)).toBe('test-supervisor')

    const relabeled = routingResult({
      default: 'test-supervisor',
      rules: [
        { agent: 'python-supervisor', labels: ['pi', 'workflow'], textPatterns: [] },
        { agent: 'tauri-supervisor', labels: ['backend', 'tracker'], textPatterns: ['rust', 'cargo', 'src-tauri'] },
      ],
    })
    expect(resolveSupervisorFromRouting(bead, relabeled)).toBe('python-supervisor')
  })

  it('N12: title is not stripped; negated description tokens are', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [{ agent: 'token-agent', labels: [], textPatterns: ['secret-token'] }],
    })
    const description = 'Keep going.\n\n### Out of scope\n- secret-token\n\nНе трогать:\n- secret-token\n'
    expect(textForSupervisorRouting(description)).not.toMatch(/secret-token/)
    expect(resolveSupervisorFromRouting({ title: 'plain title', description, labels: [] }, routing)).toBe('fallback-agent')
    expect(resolveSupervisorFromRouting({ title: 'secret-token in title', description, labels: [] }, routing)).toBe('token-agent')
  })

  it('N13: text matching is case-insensitive', () => {
    const routing = routingResult({
      default: 'fallback-agent',
      rules: [{ agent: 'case-agent', labels: ['CamelLabel'], textPatterns: ['CamelToken'] }],
    })
    expect(resolveSupervisorFromRouting({ title: 'CAMELTOKEN present', description: '', labels: [] }, routing)).toBe('case-agent')
    expect(resolveSupervisorFromRouting({ title: 'plain', description: '', labels: ['camellabel'] }, routing)).toBe('case-agent')
  })
})
