export interface Message {
  role: string
  content: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>
}

export function StringEnum(values: readonly string[], options: Record<string, unknown> = {}) {
  return { type: 'string', enum: [...values], ...options }
}
