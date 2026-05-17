import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ExtensionAPI {}
export interface ExtensionCommandContext {}
export interface Theme {}

export function getAgentDir(): string {
  return join(tmpdir(), 'pi-e2e-user-agent-dir')
}

export function parseFrontmatter<T extends Record<string, string>>(markdown: string): { frontmatter: T; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown)
  if (!match) return { frontmatter: {} as T, body: markdown }
  const frontmatter: Record<string, string> = {}
  const frontmatterSource = match[1] ?? ''
  for (const line of frontmatterSource.split(/\r?\n/)) {
    const parsed = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim())
    const key = parsed?.[1]
    const value = parsed?.[2]
    if (key && value !== undefined) frontmatter[key] = value.replace(/^['"]|['"]$/g, '')
  }
  return { frontmatter: frontmatter as T, body: match[2] ?? '' }
}

export function getMarkdownTheme(): Record<string, unknown> {
  return {}
}

export async function withFileMutationQueue<T>(_filePath: string, fn: () => Promise<T>): Promise<T> {
  return fn()
}
