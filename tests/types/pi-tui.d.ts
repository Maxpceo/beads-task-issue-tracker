declare module '@earendil-works/pi-tui' {
  export interface Component {
    render(width: number): string[]
    handleInput?: (data: string) => void
    invalidate?: () => void
  }
  export const Key: {
    escape: string
    enter: string
    up: string
    down: string
    home: string
    end: string
    pageUp: string
    pageDown: string
    ctrl: (char: string) => string
  }
  export class Text implements Component {
    constructor(text: string)
    render(width: number): string[]
  }
  export class Container implements Component {
    children: Component[]
    addChild(child: Component): void
    removeChild?(child: Component): void
    clear?(): void
    invalidate?(): void
    render(width: number): string[]
  }
  export class Input implements Component {
    focused: boolean
    constructor(opts?: unknown)
    getValue(): string
    setValue(next: string): void
    handleInput(data: string): void
    invalidate(): void
    render(width: number): string[]
  }
  export class SelectList implements Component {
    constructor(items: Array<{ value?: string; label?: string }>, maxVisible: number, theme?: unknown)
    selectedIndex: number
    onSelect?: (item: { value?: string; label?: string }) => void
    onCancel?: () => void
    onSelectionChange?: (item: { value?: string; label?: string }) => void
    setSelectedIndex(index: number): void
    getSelectedItem(): { value?: string; label?: string } | undefined
    handleInput(data: string): void
    invalidate(): void
    render(width: number): string[]
  }
  export function visibleWidth(text: string): number
  export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string
}
