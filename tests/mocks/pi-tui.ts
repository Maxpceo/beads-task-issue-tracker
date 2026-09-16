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
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\t',
  home: '\x1b[H',
  end: '\x1b[F',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  ctrl: (char: string) => String.fromCharCode(char.toLowerCase().charCodeAt(0) - 96),
  ctrlAlt: (key: string) => `ctrlAlt:${key}`,
  shift: (key: string) => `shift:${key}`,
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
  children: Component[] = []
  addChild(child: Component): void { this.children.push(child) }
  removeChild(child: Component): void {
    this.children = this.children.filter(c => c !== child)
  }
  clear(): void { this.children = [] }
  invalidate(): void {}
  render(width: number): string[] { return this.children.flatMap(child => child.render(width)) }
}

export class Input implements Component {
  focused = false
  onSubmit?: (value: string) => void
  onEscape?: () => void
  private value = ''
  constructor(_opts?: unknown) {}
  getValue(): string { return this.value }
  setValue(next: string): void { this.value = next }
  handleInput(data: string): void {
    if (data === '\x7f' || data === '\b') {
      this.value = this.value.slice(0, -1)
      return
    }
    if (data && data.length === 1 && data >= ' ') this.value += data
  }
  invalidate(): void {}
  render(width: number): string[] { return [truncateToWidth(`> ${this.value}`, width, '')] }
}

export class SelectList implements Component {
  items: Array<{ value?: string; label?: string }>
  maxVisible: number
  theme?: unknown
  selectedIndex = 0
  /** Instance callbacks (not ctor) — matches real @earendil-works/pi-tui SelectList. */
  onSelect?: (item: { value?: string; label?: string }) => void
  onCancel?: () => void
  onSelectionChange?: (item: { value?: string; label?: string }) => void
  constructor(items: Array<{ value?: string; label?: string }>, maxVisible: number, theme?: unknown) {
    this.items = items
    this.maxVisible = maxVisible
    this.theme = theme
  }
  setSelectedIndex(index: number): void {
    const max = Math.max(0, this.items.length - 1)
    this.selectedIndex = Math.min(Math.max(0, index), max)
  }
  getSelectedItem(): { value?: string; label?: string } | undefined {
    return this.items[this.selectedIndex]
  }
  handleInput(data: string): void {
    const len = this.items.length
    if (data === Key.up) {
      if (len === 0) return
      this.selectedIndex = (this.selectedIndex - 1 + len) % len
      const item = this.getSelectedItem()
      if (item) this.onSelectionChange?.(item)
      return
    }
    if (data === Key.down) {
      if (len === 0) return
      this.selectedIndex = (this.selectedIndex + 1) % len
      const item = this.getSelectedItem()
      if (item) this.onSelectionChange?.(item)
      return
    }
    if (data === Key.enter || data === '\r' || data === '\n') {
      const item = this.getSelectedItem()
      if (item) this.onSelect?.(item)
      return
    }
    if (data === Key.escape || data === '\x1b') {
      this.onCancel?.()
      return
    }
    // pageUp/pageDown: no-op in mock (product path also skips before calling handleInput)
  }
  invalidate(): void {}
  render(width: number): string[] {
    return this.items.slice(0, this.maxVisible).map((item) => truncateToWidth(item.label ?? item.value ?? '', width, ''))
  }
}
