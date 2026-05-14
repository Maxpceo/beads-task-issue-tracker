import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { inferTargetFilesFromText, loadPathRules, renderPathRulesLoaded } from '../../.pi/extensions/path-rules/index'

describe('path-rules loader', () => {
  it('loads global rules and src-tauri/CLAUDE.md for src-tauri targets', async () => {
    const result = await loadPathRules(process.cwd(), ['src-tauri/src/lib.rs'])

    expect(result.rules.map((rule) => rule.path)).toContain('AGENTS.md')
    expect(result.rules.map((rule) => rule.path)).toContain('.pi/rules/domain.md')
    expect(result.rules.map((rule) => rule.path)).toContain('.pi/rules/codebase.md')
    expect(result.rules.map((rule) => rule.path)).toContain('src-tauri/CLAUDE.md')

    const rendered = await renderPathRulesLoaded(process.cwd(), ['src-tauri/src/lib.rs'])
    expect(rendered).toContain('PATH_RULES_LOADED:')
    expect(rendered).toContain('--- .pi/rules/codebase.md')
    expect(rendered).toContain('# Pi Codebase Rules')
    expect(rendered).toContain('--- src-tauri/CLAUDE.md')
    expect(rendered).toContain('# src-tauri/ — Rust backend')
  })

  it('discovers target files from bead markdown text', () => {
    expect(inferTargetFilesFromText('Files:\n- .pi/extensions/beads-dispatch/index.ts\n- src-tauri/src/lib.rs')).toEqual(
      expect.arrayContaining(['.pi/extensions/beads-dispatch/index.ts', 'src-tauri/src/lib.rs']),
    )
  })

  it('loads a temporary real-codebase PI_RULES.md sentinel and cleanup removes probe files', async () => {
    const probeDir = `.tmp-path-rules-probe-${Date.now()}`
    const sentinel = `PI_RULES_SENTINEL_${Date.now()}`
    const absoluteDir = path.join(process.cwd(), probeDir)
    const probeFile = path.join(absoluteDir, 'feature.ts')
    const probeRule = path.join(absoluteDir, 'PI_RULES.md')

    await fs.mkdir(absoluteDir)
    try {
      await fs.writeFile(probeFile, 'export const probe = true\n')
      await fs.writeFile(probeRule, `# Probe rule\n${sentinel}\n`)

      const rendered = await renderPathRulesLoaded(process.cwd(), [`${probeDir}/feature.ts`])
      expect(rendered).toContain('PATH_RULES_LOADED:')
      expect(rendered).toContain(`--- ${probeDir}/PI_RULES.md`)
      expect(rendered).toContain(sentinel)
    } finally {
      await fs.rm(absoluteDir, { recursive: true, force: true })
    }

    await expect(fs.stat(absoluteDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
