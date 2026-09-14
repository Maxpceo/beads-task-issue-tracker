import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  appendModelArg,
  defaultAgentModelsConfig,
  handleAgentModelsCommand,
  loadAgentModels,
  pushModelArg,
  resolveAgentModel,
  resolveAgentModelFromCwd,
  saveAgentModels,
} from '../../.pi/extensions/agent-models/index'

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-models-'))
  fs.mkdirSync(path.join(root, '.pi'), { recursive: true })
  return root
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
})

describe('appendModelArg / pushModelArg', () => {
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

  it('show lists classes and resolved table', () => {
    const root = tempProject()
    temps.push(root)
    saveAgentModels(root, defaultAgentModelsConfig())
    const show = handleAgentModelsCommand('show', root)
    expect(show.ok).toBe(true)
    expect(show.text).toContain('classes:')
    expect(show.text).toContain('strong: xai/grok-4.5')
    expect(show.text).toContain('code-reviewer')
    expect(show.text).toContain('resolved:')
  })
})
