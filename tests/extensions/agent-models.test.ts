import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  appendModelArg,
  appendThinkingArg,
  defaultAgentModelsConfig,
  handleAgentModelsCommand,
  handleAgentModelsInvocation,
  listProjectAgents,
  listStaleAgentKeys,
  loadAgentModels,
  normalizeConfig,
  pushModelArg,
  pushThinkingArg,
  resolveAgentModel,
  resolveAgentModelFromCwd,
  runAgentModelsMenu,
  saveAgentModels,
} from '../../.pi/extensions/agent-models/index'

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-models-'))
  fs.mkdirSync(path.join(root, '.pi', 'agents'), { recursive: true })
  return root
}

function writeAgentMd(root: string, name: string): void {
  fs.writeFileSync(path.join(root, '.pi', 'agents', `${name}.md`), `---\nname: ${name}\n---\nBody\n`)
}

const temps: string[] = []

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveAgentModel', () => {
  it('prefers role override over class', () => {
    const config = defaultAgentModelsConfig()
    config.roles['code-reviewer'] = { model: 'provider/role-model' }
    config.classes.strong = 'provider/class-model'
    const resolved = resolveAgentModel('code-reviewer', config)
    expect(resolved).toMatchObject({ model: 'provider/role-model', source: 'role' })
  })

  it('uses class model when no role override', () => {
    const config = defaultAgentModelsConfig()
    config.classes.standard = 'xai/grok-4.5'
    const resolved = resolveAgentModel('test-supervisor', config)
    expect(resolved).toMatchObject({ model: 'xai/grok-4.5', source: 'class', className: 'standard' })
  })

  it('inherits when class mapping missing', () => {
    const resolved = resolveAgentModel('unknown-agent', defaultAgentModelsConfig())
    expect(resolved.model).toBeUndefined()
    expect(resolved.source).toBe('inherit')
    expect(resolved.thinking).toBeUndefined()
    expect(resolved.thinkingSource).toBe('inherit')
  })

  it('inherits when class is unknown or empty', () => {
    const config = defaultAgentModelsConfig()
    config.agentClasses['ghost'] = 'missing-class'
    expect(resolveAgentModel('ghost', config).source).toBe('inherit')
    config.agentClasses['empty'] = 'strong'
    config.classes.strong = '  '
    expect(resolveAgentModel('empty', config).model).toBeUndefined()
  })

  it('treats empty role model as no override', () => {
    const config = defaultAgentModelsConfig()
    config.roles['code-reviewer'] = { model: '' }
    config.classes.strong = 'xai/grok-4.5'
    expect(resolveAgentModel('code-reviewer', config)).toMatchObject({
      model: 'xai/grok-4.5',
      source: 'class',
    })
  })

  it('resolves thinking role → class → inherit independently of model', () => {
    const config = defaultAgentModelsConfig()
    config.classThinking = { strong: 'high' }
    // model from class, thinking from class
    expect(resolveAgentModel('code-reviewer', config)).toMatchObject({
      model: 'xai/grok-4.5',
      source: 'class',
      thinking: 'high',
      thinkingSource: 'class',
    })
    // role thinking overrides class thinking; model still class
    config.roles['code-reviewer'] = { thinking: 'off' }
    expect(resolveAgentModel('code-reviewer', config)).toMatchObject({
      model: 'xai/grok-4.5',
      source: 'class',
      thinking: 'off',
      thinkingSource: 'role',
    })
    // role model + class thinking
    config.roles['code-reviewer'] = { model: 'provider/role' }
    expect(resolveAgentModel('code-reviewer', config)).toMatchObject({
      model: 'provider/role',
      source: 'role',
      thinking: 'high',
      thinkingSource: 'class',
    })
    // thinking-only class without model class entry still resolves thinking via agentClasses
    const orphan = defaultAgentModelsConfig()
    orphan.classes = {}
    orphan.classThinking = { strong: 'minimal' }
    orphan.agentClasses = { 'code-reviewer': 'strong' }
    expect(resolveAgentModel('code-reviewer', orphan)).toMatchObject({
      model: undefined,
      source: 'inherit',
      thinking: 'minimal',
      thinkingSource: 'class',
    })
  })
})

describe('appendModelArg / pushModelArg / thinking', () => {
  it('adds --model when resolved', () => {
    expect(appendModelArg(['pi'], 'xai/grok-4.5')).toEqual(['pi', '--model', 'xai/grok-4.5'])
    const args = ['--mode', 'json']
    pushModelArg(args, 'xai/grok-4.5')
    expect(args).toEqual(['--mode', 'json', '--model', 'xai/grok-4.5'])
  })

  it('omits --model on inherit/empty', () => {
    expect(appendModelArg(['pi'], undefined)).toEqual(['pi'])
    expect(appendModelArg(['pi'], '  ')).toEqual(['pi'])
    const args = ['pi']
    pushModelArg(args, undefined)
    expect(args).toEqual(['pi'])
  })

  it('thinking: inherit omits flag; off and high pass --thinking', () => {
    expect(appendThinkingArg(['pi'], undefined)).toEqual(['pi'])
    expect(appendThinkingArg(['pi'], 'off')).toEqual(['pi', '--thinking', 'off'])
    expect(appendThinkingArg(['pi'], 'high')).toEqual(['pi', '--thinking', 'high'])
    const args = ['pi']
    pushThinkingArg(args, 'off')
    expect(args).toEqual(['pi', '--thinking', 'off'])
    pushThinkingArg(args, undefined)
    expect(args).toEqual(['pi', '--thinking', 'off'])
  })
})

describe('normalize + persistence merge', () => {
  it('keeps thinking-only role and drops invalid thinking', () => {
    const { config } = normalizeConfig({
      classes: { strong: 'xai/a' },
      classThinking: { strong: 'high', bad: 'nope' },
      roles: {
        a: { thinking: 'low' },
        b: { model: 'x', thinking: 'bogus' },
        c: 'legacy-model',
      },
      agentClasses: {},
    })
    expect(config.classThinking).toEqual({ strong: 'high' })
    expect(config.roles.a).toEqual({ thinking: 'low' })
    expect(config.roles.b).toEqual({ model: 'x' })
    expect(config.roles.c).toEqual({ model: 'legacy-model' })
  })

  it('persistence: set class-thinking then set class model keeps both', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    expect(handleAgentModelsCommand('set class-thinking strong high', root).ok).toBe(true)
    expect(handleAgentModelsCommand('set class strong provider/new', root).ok).toBe(true)
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.classes.strong).toBe('provider/new')
    expect(raw.classThinking.strong).toBe('high')
    expect(raw.classes.standard).toBe('xai/grok-4.5')
  })

  it('merge: set role-thinking then set role model keeps both; unset one keeps the other', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    expect(handleAgentModelsCommand('set role-thinking detective high', root).ok).toBe(true)
    expect(handleAgentModelsCommand('set role detective provider/det', root).ok).toBe(true)
    let raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.roles.detective).toEqual({ model: 'provider/det', thinking: 'high' })
    expect(resolveAgentModelFromCwd(root, 'detective')).toMatchObject({
      model: 'provider/det',
      thinking: 'high',
      source: 'role',
      thinkingSource: 'role',
    })

    expect(handleAgentModelsCommand('unset role detective', root).ok).toBe(true)
    raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.roles.detective).toEqual({ thinking: 'high' })
    expect(resolveAgentModelFromCwd(root, 'detective')).toMatchObject({
      thinking: 'high',
      thinkingSource: 'role',
      source: 'class',
      model: 'xai/grok-4.5',
    })

    expect(handleAgentModelsCommand('set role detective provider/det2', root).ok).toBe(true)
    expect(handleAgentModelsCommand('unset role-thinking detective', root).ok).toBe(true)
    raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.roles.detective).toEqual({ model: 'provider/det2' })
  })

  it('rejects unknown class for class-thinking and agent-class', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const badThink = handleAgentModelsCommand('set class-thinking no-such high', root)
    expect(badThink.ok).toBe(false)
    expect(badThink.text).toMatch(/unknown class/i)
    const badClass = handleAgentModelsCommand('set agent-class detective no-such', root)
    expect(badClass.ok).toBe(false)
    expect(badClass.text).toMatch(/unknown class/i)
  })

  it('does not seed classThinking by default on save of defaults', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.classThinking).toBeUndefined()
  })
})

describe('discovery', () => {
  it('lists project agents from md scan and marks unmapped as inherit', () => {
    const root = tempProject()
    temps.push(root)
    writeAgentMd(root, 'code-reviewer')
    writeAgentMd(root, 'brand-new-agent')
    fs.writeFileSync(path.join(root, '.pi', 'agents', 'README.md'), '# skip\n')
    saveAgentModels(root, defaultAgentModelsConfig())

    expect(listProjectAgents(root)).toEqual(['brand-new-agent', 'code-reviewer'])
    const show = handleAgentModelsCommand('show', root)
    expect(show.ok).toBe(true)
    expect(show.text).toContain('brand-new-agent')
    expect(show.text).toMatch(/brand-new-agent: unmapped → inherit/)
    expect(resolveAgentModelFromCwd(root, 'brand-new-agent').source).toBe('inherit')

    expect(handleAgentModelsCommand('set agent-class brand-new-agent cheap', root).ok).toBe(true)
    expect(resolveAgentModelFromCwd(root, 'brand-new-agent')).toMatchObject({
      source: 'class',
      className: 'cheap',
      model: 'xai/grok-4.5',
    })
  })

  it('lists stale JSON keys without auto-writing agentClasses for new md', () => {
    const root = tempProject()
    temps.push(root)
    writeAgentMd(root, 'only-md')
    const config = defaultAgentModelsConfig()
    config.agentClasses['ghost-stale'] = 'standard'
    saveAgentModels(root, config)
    expect(listStaleAgentKeys(root, loadAgentModels(root).config)).toContain('ghost-stale')
    const before = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(before.agentClasses['only-md']).toBeUndefined()
    listProjectAgents(root)
    const after = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(after.agentClasses['only-md']).toBeUndefined()
  })
})

describe('load/save + command roundtrip', () => {
  it('loads defaults file from project .pi', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const loaded = loadAgentModels(root)
    expect(loaded.missing).toBe(false)
    expect(loaded.error).toBeUndefined()
    expect(loaded.config.classes.strong).toBe('xai/grok-4.5')
    expect(loaded.config.classes.standard).toBe('xai/grok-4.5')
    expect(loaded.config.classes.cheap).toBe('xai/grok-4.5')
    expect(resolveAgentModelFromCwd(root, 'code-reviewer').model).toBe('xai/grok-4.5')
  })

  it('inherits when file missing without throwing', () => {
    const root = tempProject()
    temps.push(root)
    const loaded = loadAgentModels(root)
    expect(loaded.missing).toBe(true)
    expect(resolveAgentModelFromCwd(root, 'test-supervisor').source).toBe('inherit')
  })

  it('inherits on broken JSON for spawn; set fails clearly', () => {
    const root = tempProject()
    temps.push(root)
    fs.writeFileSync(path.join(root, '.pi', 'agent-models.json'), '{not-json', 'utf8')
    const loaded = loadAgentModels(root)
    expect(loaded.error).toMatch(/invalid JSON/i)
    expect(resolveAgentModelFromCwd(root, 'architect').source).toBe('inherit')
    const setResult = handleAgentModelsCommand('set class cheap other-id', root)
    expect(setResult.ok).toBe(false)
    expect(setResult.text).toMatch(/broken|invalid/i)
  })

  it('command set class cheap other-id updates project file only', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const result = handleAgentModelsCommand('set class cheap other-id', root)
    expect(result.ok).toBe(true)
    expect(result.text).toContain(path.join(root, '.pi', 'agent-models.json'))
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.classes.cheap).toBe('other-id')
    expect(raw.classes.strong).toBe('xai/grok-4.5')
    expect(resolveAgentModelFromCwd(root, 'documentation-expert').model).toBe('other-id')
  })

  it('command set/unset role and agent-class roundtrip', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())

    expect(handleAgentModelsCommand('set role detective provider/detective', root).ok).toBe(true)
    expect(resolveAgentModelFromCwd(root, 'detective').model).toBe('provider/detective')

    expect(handleAgentModelsCommand('unset role detective', root).ok).toBe(true)
    expect(resolveAgentModelFromCwd(root, 'detective')).toMatchObject({ source: 'class', model: 'xai/grok-4.5' })

    expect(handleAgentModelsCommand('set agent-class detective cheap', root).ok).toBe(true)
    expect(resolveAgentModelFromCwd(root, 'detective')).toMatchObject({ className: 'cheap', source: 'class' })

    const badClass = handleAgentModelsCommand('set agent-class detective no-such', root)
    expect(badClass.ok).toBe(false)
    expect(badClass.text).toMatch(/unknown class/i)

    expect(handleAgentModelsCommand('unset agent-class detective', root).ok).toBe(true)
    const loaded = loadAgentModels(root)
    expect(loaded.config.agentClasses.detective).toBeUndefined()
  })

  it('show lists classes, thinking and resolved table', () => {
    const root = tempProject()
    temps.push(root)
    const config = defaultAgentModelsConfig()
    config.classThinking = { strong: 'high' }
    saveAgentModels(root, config)
    const show = handleAgentModelsCommand('show', root)
    expect(show.ok).toBe(true)
    expect(show.text).toContain('classes:')
    expect(show.text).toContain('strong')
    expect(show.text).toContain('thinking=high')
    expect(show.text).toContain('code-reviewer')
    expect(show.text).toContain('resolved:')
  })
})

describe('menu / hasUI', () => {
  it('empty args + !hasUI → show text, select not called', async () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    let selectCalls = 0
    const result = await handleAgentModelsInvocation('', {
      cwd: root,
      hasUI: false,
      ui: {
        select: async () => {
          selectCalls += 1
          return null
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('classes:')
    expect(selectCalls).toBe(0)
  })

  it('empty args + hasUI → select called', async () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    let selectCalls = 0
    const result = await handleAgentModelsInvocation('', {
      cwd: root,
      hasUI: true,
      ui: {
        select: async () => {
          selectCalls += 1
          return null
        },
        notify: () => undefined,
      },
    })
    expect(result.ok).toBe(true)
    expect(selectCalls).toBeGreaterThan(0)
  })

  it('cancel on first select → no file write', async () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const before = fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8')
    const result = await runAgentModelsMenu(root, {
      select: async () => null,
    })
    expect(result.cancelled).toBe(true)
    expect(result.wrote).toBe(false)
    const after = fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8')
    expect(after).toBe(before)
  })

  it('happy path assign agent-class via menu writes JSON', async () => {
    const root = tempProject()
    temps.push(root)
    writeAgentMd(root, 'brand-new-agent')
    saveAgentModels(root, defaultAgentModelsConfig())
    const queue = [
      'Назначить agent → class',
      'brand-new-agent — inherit (unmapped)',
      'cheap (Дешёвая)',
      null,
    ]
    const result = await runAgentModelsMenu(root, {
      select: async () => queue.shift() ?? null,
      notify: () => undefined,
    })
    expect(result.wrote).toBe(true)
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent-models.json'), 'utf8'))
    expect(raw.agentClasses['brand-new-agent']).toBe('cheap')
  })
})
