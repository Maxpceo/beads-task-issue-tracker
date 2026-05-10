import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import beadsDispatchExtension from '../../.pi/extensions/beads-dispatch/index'

const plan = `PLAN APPROVED
Approved-by: Test
Approved-at: 2026-05-10T00:00:00Z
Start-commit: 68241c7309542b76eff49c3360514fb4110f0a83
Problem:
- Need deterministic path rules.
Approach:
- Load path rules.
Rejected alternatives:
- Mock-only tests.
Files to change:
- src-tauri/src/lib.rs
Acceptance:
- PATH_RULES_LOADED includes matching rules.
Verification / acceptance checks:
- Vitest dry run verifies sentinel.`

function description(files: string[]) {
  return `### Origin
- Test fixture.
### Files
${files.map((file) => `- ${file}`).join('\n')}
### Current state
- Rules are not injected.
### Target state
- Rules are injected.
### Investigation findings
- src-tauri/CLAUDE.md exists.
### Decisions
- Use path-rule loader.
### Rejected alternatives
- Agent-only loading.
### Dependencies / blockers
- none.
### Acceptance criteria
- PATH_RULES_LOADED contains the sentinel or src-tauri rule.
### Verification / acceptance checks
- dispatch dryRun output contains inline rule content.
### Out of scope
- Running a real subagent.`
}

describe('beads-dispatch path rules integration', () => {
  it('includes src-tauri/CLAUDE.md in supervisor dryRun prompts for src-tauri targets', async () => {
    let registeredTool: any
    const pi = {
      events: { emit() {} },
      registerTool(tool: any) {
        if (tool.name === 'dispatch_supervisor') registeredTool = tool
      },
      exec: async (command: string, args: string[]) => {
        if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-a', status: 'in_progress', labels: ['dx'], description: description(['src-tauri/src/lib.rs']) }), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: plan }]), stderr: '', code: 0 }
        if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
        if (command === 'git' && args.includes('branch')) return { stdout: 'feature/path-rules\n', stderr: '', code: 0 }
        if (command === 'git' && args.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    }

    beadsDispatchExtension(pi as any)
    const result = await registeredTool.execute('call-1', { beadId: 'bead-a', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })

    expect(result.details.output).toContain('PATH_RULES_LOADED:')
    expect(result.details.output).toContain('--- src-tauri/CLAUDE.md')
    expect(result.details.output).toContain('# src-tauri/ — Rust backend')
  })

  it('passes a temporary real-codebase PI_RULES.md sentinel through dispatch dryRun and removes probes', async () => {
    let registeredTool: any
    const probeDir = `.tmp-dispatch-rules-probe-${Date.now()}`
    const sentinel = `DISPATCH_SENTINEL_${Date.now()}`
    const absoluteDir = path.join(process.cwd(), probeDir)
    await fs.mkdir(absoluteDir)

    try {
      await fs.writeFile(path.join(absoluteDir, 'PI_RULES.md'), `# Dispatch probe\n${sentinel}\n`)
      await fs.writeFile(path.join(absoluteDir, 'feature.ts'), 'export const feature = true\n')
      const pi = {
        events: { emit() {} },
        registerTool(tool: any) {
          if (tool.name === 'dispatch_supervisor') registeredTool = tool
        },
        exec: async (command: string, args: string[]) => {
          if (command === 'bd' && args[0] === 'show') return { stdout: JSON.stringify({ id: 'bead-probe', status: 'in_progress', labels: ['dx'], description: description([`${probeDir}/feature.ts`]) }), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] !== 'add') return { stdout: JSON.stringify([{ text: plan }]), stderr: '', code: 0 }
          if (command === 'bd' && args[0] === 'comments' && args[1] === 'add') return { stdout: '', stderr: '', code: 0 }
          if (command === 'git' && args.includes('branch')) return { stdout: 'feature/path-rules\n', stderr: '', code: 0 }
          if (command === 'git' && args.includes('rev-parse')) return { stdout: 'abc1234\n', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 0 }
        },
      }

      beadsDispatchExtension(pi as any)
      const result = await registeredTool.execute('call-1', { beadId: 'bead-probe', dryRun: true, agent: 'test-supervisor' }, undefined, undefined, { cwd: process.cwd() })

      expect(result.details.output).toContain('PATH_RULES_LOADED:')
      expect(result.details.output).toContain(`--- ${probeDir}/PI_RULES.md`)
      expect(result.details.output).toContain(sentinel)
    } finally {
      await fs.rm(absoluteDir, { recursive: true, force: true })
    }

    await expect(fs.stat(absoluteDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
