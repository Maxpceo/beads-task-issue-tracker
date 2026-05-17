const ANSI_RE = /\x1b\[[0-9;]*m/g
const WIDE_RE = /[⏳]/u

export interface Component {
  render(width: number): string[]
  handleInput?: (data: string) => void
  invalidate?: () => void
}

export const Key = {
  escape: '\x1b',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  home: '\x1b[H',
  end: '\x1b[F',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  ctrl: (char: string) => String.fromCharCode(char.toLowerCase().charCodeAt(0) - 96),
}

export function matchesKey(data: string, key: string): boolean {
  return data === key
}

export function visibleWidth(text: string): number {
  const plain = text.replace(ANSI_RE, '')
  return Array.from(plain).reduce((width, char) => width + (WIDE_RE.test(char) ? 2 : 1), 0)
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return ''
  if (visibleWidth(text) <= maxWidth) return text
  const ellipsisWidth = visibleWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) return ellipsis

  let output = ''
  let width = 0
  const target = maxWidth - ellipsisWidth
  for (const char of Array.from(text.replace(ANSI_RE, ''))) {
    const charWidth = visibleWidth(char)
    if (width + charWidth > target) break
    output += char
    width += charWidth
  }
  return `${output}${ellipsis}`
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const words = text.split(/(\s+)/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (visibleWidth(current + word) > width && current) {
      lines.push(current.trimEnd())
      current = word.trimStart()
    } else {
      current += word
    }
  }
  lines.push(current || '')
  return lines
}

export class Text implements Component {
  constructor(private readonly text: string) {}
  render(width: number): string[] { return [truncateToWidth(this.text, width, '')] }
}

export class Spacer implements Component {
  constructor(private readonly lines = 1) {}
  render(): string[] { return Array.from({ length: this.lines }, () => '') }
}

export class Markdown extends Text {}

export class Container implements Component {
  private readonly children: Component[] = []
  addChild(child: Component): void { this.children.push(child) }
  render(width: number): string[] { return this.children.flatMap(child => child.render(width)) }
}
