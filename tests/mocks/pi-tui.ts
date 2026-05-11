const ANSI_RE = /\x1b\[[0-9;]*m/g
const WIDE_RE = /[⏳]/u

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
