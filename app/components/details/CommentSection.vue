<script setup lang="ts">
import type { Comment } from '~/types/issue'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import { ScrollArea } from '~/components/ui/scroll-area'
import { LinkifiedText } from '~/components/ui/linkified-text'

const props = defineProps<{
  comments: Comment[]
  readonly?: boolean
}>()

// Collapsible state for the whole section (persisted per project)
const commentsSectionState = useProjectStorage<{ open: boolean }>('commentsSection', { open: true })
const isCommentsOpen = computed(() => commentsSectionState.value.open)
const toggleComments = () => {
  const newValue = { open: !commentsSectionState.value.open }
  commentsSectionState.value = newValue
  saveProjectValue('commentsSection', newValue)
}

// Table of contents (collapsible list of comment headers)
const isTocOpen = ref(false)

// Sort comments by date descending (most recent first)
const sortedComments = computed(() => {
  return [...props.comments].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
})

// Truncate comment text for TOC preview
const truncate = (text: string, maxLen = 40) => {
  const firstLine = text.split('\n')[0]
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '…' : firstLine
}

// Resizable comments height (persisted per project)
const MIN_HEIGHT = 160
const MAX_HEIGHT = 500
const commentsHeightState = useProjectStorage<{ height: number }>('commentsHeight', { height: 240 })
const commentsHeight = computed(() => commentsHeightState.value.height)
const isResizingComments = ref(false)
const resizeStartY = ref(0)
const resizeStartHeight = ref(0)

const onResizeMove = (e: MouseEvent) => {
  if (!isResizingComments.value) return
  const diff = e.clientY - resizeStartY.value
  const newHeight = Math.min(Math.max(resizeStartHeight.value + diff, MIN_HEIGHT), MAX_HEIGHT)
  commentsHeightState.value = { height: newHeight }
  saveProjectValue('commentsHeight', { height: newHeight })
}

const stopResize = () => {
  isResizingComments.value = false
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

const startResize = (e: MouseEvent) => {
  e.preventDefault()
  isResizingComments.value = true
  resizeStartY.value = e.clientY
  resizeStartHeight.value = commentsHeightState.value.height
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

// Scroll to comment + highlight
const activeCommentId = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

const scrollToComment = (commentId: string) => {
  const el = document.getElementById(`comment-${commentId}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  activeCommentId.value = commentId
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { activeCommentId.value = null }, 2000)
  isTocOpen.value = false
}

const newComment = ref('')

const formatDate = (dateStr: string) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const formatShortDate = (dateStr: string) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const getInitials = (name: string) => {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const emit = defineEmits<{
  addComment: [content: string]
}>()

const handleSubmit = () => {
  if (newComment.value.trim()) {
    emit('addComment', newComment.value.trim())
    newComment.value = ''
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- Header row: collapse toggle + comment count + TOC toggle -->
    <div class="flex items-center gap-1.5">
      <button
        class="flex items-center gap-1.5 flex-1 text-left group"
        @click="toggleComments"
      >
        <svg
          class="w-3 h-3 text-muted-foreground transition-transform"
          :class="{ '-rotate-90': !isCommentsOpen }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <h4 class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground group-hover:text-foreground transition-colors">
          Comments ({{ comments.length }})
        </h4>
      </button>

      <!-- TOC toggle button (only when section is open and has >1 comment) -->
      <button
        v-if="isCommentsOpen && sortedComments.length > 1"
        class="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
        :class="{ 'text-foreground bg-muted': isTocOpen }"
        title="Оглавление комментариев"
        @click="isTocOpen = !isTocOpen"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
    </div>

    <div v-show="isCommentsOpen" class="pl-4.5 space-y-3">
      <!-- Table of Contents (collapsible) -->
      <div
        v-if="isTocOpen && sortedComments.length > 1"
        class="border border-border rounded-md bg-muted/30 overflow-hidden"
      >
        <button
          v-for="comment in sortedComments"
          :key="'toc-' + comment.id"
          class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2 border-b border-border last:border-b-0"
          @click="scrollToComment(comment.id)"
        >
          <span class="font-medium text-muted-foreground shrink-0">{{ getInitials(comment.author) }}</span>
          <span class="text-muted-foreground shrink-0">{{ formatShortDate(comment.createdAt) }}</span>
          <span class="truncate text-foreground/70">{{ truncate(comment.content) }}</span>
        </button>
      </div>

      <!-- Comments list -->
      <div v-if="sortedComments.length > 0" class="relative">
        <ScrollArea :style="{ height: `${commentsHeight}px` }">
          <div class="space-y-3 pr-4">
            <div
              v-for="comment in sortedComments"
              :id="`comment-${comment.id}`"
              :key="comment.id"
              class="flex gap-2 rounded-md px-1.5 py-1 -mx-1.5 transition-colors duration-300"
              :class="{ 'bg-primary/10 ring-1 ring-primary/20': activeCommentId === comment.id }"
            >
              <Avatar class="h-6 w-6">
                <AvatarFallback class="text-[10px]">
                  {{ getInitials(comment.author) }}
                </AvatarFallback>
              </Avatar>

              <div class="flex-1 space-y-0.5">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium">{{ comment.author }}</span>
                  <span class="text-[10px] text-muted-foreground">
                    {{ formatDate(comment.createdAt) }}
                  </span>
                </div>
                <p class="text-xs whitespace-pre-wrap"><LinkifiedText :text="comment.content" /></p>
              </div>
            </div>
          </div>
        </ScrollArea>
        <!-- Resize handle -->
        <div
          class="h-1.5 cursor-row-resize group flex items-center justify-center hover:bg-primary/10 transition-colors rounded-b"
          @mousedown="startResize"
        >
          <div class="w-8 h-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-primary/50 transition-colors" />
        </div>
      </div>

      <div v-else class="text-center text-muted-foreground text-xs py-3">
        No comments yet
      </div>

      <form v-if="!readonly" class="space-y-2" @submit.prevent="handleSubmit">
        <Textarea
          v-model="newComment"
          placeholder="Add a comment..."
          rows="2"
          class="text-xs"
        />
        <div class="flex justify-end">
          <Button type="submit" size="sm" class="h-7 text-xs" :disabled="!newComment.trim()">
            Add Comment
          </Button>
        </div>
      </form>
    </div>
  </div>
</template>
