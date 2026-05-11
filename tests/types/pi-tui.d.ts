declare module '@earendil-works/pi-tui' {
  export function visibleWidth(text: string): number
  export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string
}
