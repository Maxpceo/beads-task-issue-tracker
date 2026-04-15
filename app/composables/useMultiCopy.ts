import { logFrontend } from '~/utils/bd-api'

// Module-level state — shared across every component that calls useMultiCopy().
// A Cmd/Ctrl+click in any place (QuickList sidebar, IssueTable rows, IssueDetailHeader)
// accumulates into the same buffer. Safe because Nuxt runs in SPA mode (ssr: false).
const copiedIds = ref<string[]>([])
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null

async function copyIssueId(issueId: string, event: MouseEvent) {
  event.stopPropagation()
  const isMulti = event.metaKey || event.ctrlKey

  try {
    if (isMulti) {
      const current = copiedIds.value
      const next = current.includes(issueId)
        ? current.filter(id => id !== issueId)
        : [...current, issueId]
      copiedIds.value = next

      if (copiedResetTimer) {
        clearTimeout(copiedResetTimer)
        copiedResetTimer = null
      }

      await navigator.clipboard.writeText(next.join(', '))
    } else {
      copiedIds.value = [issueId]
      await navigator.clipboard.writeText(issueId)

      if (copiedResetTimer) clearTimeout(copiedResetTimer)
      copiedResetTimer = setTimeout(() => {
        copiedIds.value = []
      }, 2000)
    }
  } catch (err) {
    await logFrontend('error', `[useMultiCopy] Failed to copy issue ID: ${err}`)
  }
}

function isCopied(issueId: string) {
  return copiedIds.value.includes(issueId)
}

export function useMultiCopy() {
  return { copiedIds, copyIssueId, isCopied }
}
