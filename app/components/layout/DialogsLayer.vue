<script setup lang="ts">
import StatusBadge from '~/components/issues/StatusBadge.vue'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import ImagePreviewDialog from '~/components/ui/image-preview/ImagePreviewDialog.vue'
import MarkdownPreviewDialog from '~/components/ui/markdown-preview/MarkdownPreviewDialog.vue'

const {
  isDeleteDialogOpen, deleteTargetTitles, isDeleting, confirmDelete,
  isEpicDeleteDialogOpen, epicToDelete, epicChildren, isDeletingEpic, confirmEpicDelete,
  isCloseDialogOpen, isClosing, confirmClose,
  isDetachDialogOpen, detachImagePath, isDetaching, handleDetachImage,
  isRemoveDepDialogOpen, pendingDepRemoval, isRemovingDep, handleRemoveDependency,
  availableRelationTypes, availableIssuesForDeps, priorityTextColor,
  isAddBlockerDialogOpen, addBlockerIssueId, addBlockerSearchQuery, addBlockerSelectedTarget, addBlockerFilteredOptions, isAddingBlocker, handleAddBlocker,
  isAddRelDialogOpen, addRelIssueId, addRelSelectedType, addRelSearchQuery, addRelSelectedTarget, addRelFilterClosed, addRelFilteredOptions, isAddingRel, handleAddRelation,
  isRemoveRelDialogOpen, pendingRelRemoval, isRemovingRel, handleRemoveRelation,
} = useIssueDialogs()

const { selectedIssue } = useIssues()
const imagePreview = useImagePreview()
const markdownPreview = useMarkdownPreview()

const { t } = useI18n()
</script>

<template>
  <!-- Delete Confirmation Dialog -->
  <ConfirmDialog
    v-model:open="isDeleteDialogOpen"
    :title="t('layout.dialogs.delete.title')"
    :confirm-text="t('layout.dialogs.delete.confirm')"
    :cancel-text="t('common.cancel')"
    variant="destructive"
    :is-loading="isDeleting"
    @confirm="confirmDelete"
  >
    <template #description>
      <p class="text-sm text-muted-foreground">
        {{ deleteTargetTitles.length > 1 ? t('layout.dialogs.delete.aboutToDeleteMany') : t('layout.dialogs.delete.aboutToDeleteOne') }}
      </p>
      <div class="mt-2 space-y-1">
        <p
          v-for="title in deleteTargetTitles.slice(0, 5)"
          :key="title"
          class="text-sm font-medium text-sky-400"
        >
          {{ title }}
        </p>
        <p v-if="deleteTargetTitles.length > 5" class="text-sm text-muted-foreground">
          {{ t('layout.dialogs.delete.andMore', { count: deleteTargetTitles.length - 5, total: deleteTargetTitles.length }) }}
        </p>
      </div>
      <p class="mt-3 text-sm text-muted-foreground">
        {{ t('layout.dialogs.delete.cannotBeUndone') }}
      </p>
    </template>
  </ConfirmDialog>

  <!-- Epic Delete Confirmation Dialog (for issues with children) -->
  <Dialog v-model:open="isEpicDeleteDialogOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <svg class="w-5 h-5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {{ t('layout.dialogs.epicDelete.title') }}
        </DialogTitle>
        <DialogDescription as="div">
          <p class="text-sm text-muted-foreground">
            <i18n-t keypath="layout.dialogs.epicDelete.hasChildren" tag="span">
              <template #title>
                <span class="font-medium text-sky-400">{{ epicToDelete?.title }}</span>
              </template>
              <template #count>{{ epicChildren.length }}</template>
            </i18n-t>
          </p>
          <div class="mt-2 space-y-1 max-h-32 overflow-y-auto">
            <p v-for="child in epicChildren.slice(0, 5)" :key="child.id" class="text-sm text-muted-foreground">
              <span class="font-medium">{{ child.title }}</span>
            </p>
            <p v-if="epicChildren.length > 5" class="text-sm text-muted-foreground">
              {{ t('layout.dialogs.epicDelete.andMore', { count: epicChildren.length - 5 }) }}
            </p>
          </div>
          <p class="mt-3 text-sm text-muted-foreground">
            {{ t('layout.dialogs.epicDelete.whatToDo') }}
          </p>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="flex-col gap-2 sm:flex-col">
        <Button
          variant="destructive"
          class="w-full"
          :disabled="isDeletingEpic"
          @click="confirmEpicDelete('delete-all')"
        >
          <svg v-if="isDeletingEpic" class="animate-spin -ml-1 mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          {{ t('layout.dialogs.epicDelete.deleteAll') }}
        </Button>
        <Button
          variant="outline"
          class="w-full"
          :disabled="isDeletingEpic"
          @click="confirmEpicDelete('detach')"
        >
          {{ t('layout.dialogs.epicDelete.detach') }}
        </Button>
        <Button
          variant="ghost"
          class="w-full"
          :disabled="isDeletingEpic"
          @click="isEpicDeleteDialogOpen = false"
        >
          {{ t('common.cancel') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Close Confirmation Dialog -->
  <ConfirmDialog
    v-model:open="isCloseDialogOpen"
    :title="t('layout.dialogs.closeIssue.title')"
    :confirm-text="t('layout.dialogs.closeIssue.confirm')"
    :cancel-text="t('common.cancel')"
    :is-loading="isClosing"
    @confirm="confirmClose"
  >
    <template #description>
      <p class="text-sm text-muted-foreground">
        {{ t('layout.dialogs.closeIssue.aboutToClose') }}
      </p>
      <div class="mt-2">
        <p class="text-sm text-sky-400 font-mono">{{ selectedIssue?.id }}</p>
        <p class="text-sm font-medium">{{ selectedIssue?.title }}</p>
      </div>
      <p class="mt-3 text-sm text-muted-foreground">
        {{ t('layout.dialogs.closeIssue.willBeMarkedCompleted') }}
      </p>
    </template>
  </ConfirmDialog>

  <!-- Detach Attachment Confirmation Dialog -->
  <ConfirmDialog
    v-model:open="isDetachDialogOpen"
    :title="t('layout.dialogs.detach.title')"
    :confirm-text="t('layout.dialogs.detach.confirm')"
    :cancel-text="t('common.cancel')"
    variant="destructive"
    :is-loading="isDetaching"
    @confirm="handleDetachImage"
  >
    <template #description>
      <p class="text-sm text-muted-foreground">
        {{ t('layout.dialogs.detach.confirmQuestion') }}
      </p>
      <p class="mt-2 text-xs text-muted-foreground font-mono break-all">
        {{ detachImagePath }}
      </p>
      <p v-if="detachImagePath?.includes('.beads/attachments/')" class="mt-3 text-sm text-destructive">
        {{ t('layout.dialogs.detach.willBeDeleted') }}
      </p>
      <p v-else class="mt-3 text-sm text-muted-foreground">
        {{ t('layout.dialogs.detach.onlyReferenceRemoved') }}
      </p>
    </template>
  </ConfirmDialog>

  <!-- Remove Dependency Confirmation Dialog -->
  <ConfirmDialog
    v-model:open="isRemoveDepDialogOpen"
    :title="t('layout.dialogs.removeDep.title')"
    :confirm-text="t('common.remove')"
    :cancel-text="t('common.cancel')"
    variant="destructive"
    :is-loading="isRemovingDep"
    @confirm="handleRemoveDependency"
  >
    <template #description>
      <p class="text-sm text-muted-foreground">
        {{ t('layout.dialogs.removeDep.confirmQuestion') }}
      </p>
      <div v-if="pendingDepRemoval" class="mt-2 space-y-2">
        <div>
          <p class="text-xs text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.removeDep.issue') }}</p>
          <p class="text-sm font-mono text-sky-400">{{ pendingDepRemoval.issueId }}</p>
          <p class="text-sm text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === pendingDepRemoval!.issueId)?.title }}</p>
        </div>
        <div>
          <p class="text-xs text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.removeDep.blocker') }}</p>
          <p class="text-sm font-mono text-sky-400">{{ pendingDepRemoval.blockerId }}</p>
          <p class="text-sm text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === pendingDepRemoval!.blockerId)?.title }}</p>
        </div>
      </div>
    </template>
  </ConfirmDialog>

  <!-- Add Blocker Dialog -->
  <Dialog v-model:open="isAddBlockerDialogOpen">
    <DialogContent class="sm:max-w-lg overflow-hidden">
      <DialogHeader>
        <DialogTitle>{{ t('layout.dialogs.addBlocker.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('layout.dialogs.addBlocker.from') }} <span class="font-mono text-sky-400">{{ addBlockerIssueId }}</span>
          <br />
          <span class="text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === addBlockerIssueId)?.title }}</span>
        </DialogDescription>
      </DialogHeader>
      <div class="space-y-4 py-2 overflow-hidden">
        <div class="space-y-1.5 overflow-hidden">
          <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.addBlocker.blockedBy') }}</label>
          <input
            v-model="addBlockerSearchQuery"
            type="text"
            class="h-9 w-full text-sm px-3 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            :placeholder="t('layout.dialogs.addBlocker.searchPlaceholder')"
          />
          <div class="max-h-64 overflow-y-auto rounded-md border border-border">
            <button
              v-for="opt in addBlockerFilteredOptions"
              :key="opt.id"
              class="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors min-w-0"
              :class="{ 'bg-accent': addBlockerSelectedTarget === opt.id }"
              @click="addBlockerSelectedTarget = opt.id"
            >
              <span :class="['font-medium shrink-0', priorityTextColor(opt.priority)]">{{ opt.id }}</span>
              <span class="truncate text-muted-foreground flex-1 min-w-0">{{ opt.title }}</span>
              <StatusBadge :status="opt.status" class="shrink-0 scale-75 origin-right" />
            </button>
            <p v-if="!addBlockerFilteredOptions.length && addBlockerSearchQuery" class="px-3 py-2 text-sm text-muted-foreground">
              {{ t('layout.dialogs.addBlocker.noMatches') }}
            </p>
            <p v-if="!addBlockerFilteredOptions.length && !addBlockerSearchQuery" class="px-3 py-2 text-sm text-muted-foreground">
              {{ t('layout.dialogs.addBlocker.typeToSearch') }}
            </p>
          </div>
        </div>
      </div>
      <DialogFooter class="gap-3">
        <Button variant="outline" @click="isAddBlockerDialogOpen = false">{{ t('common.cancel') }}</Button>
        <Button
          :disabled="!addBlockerSelectedTarget || isAddingBlocker"
          @click="handleAddBlocker"
        >
          <svg
            v-if="isAddingBlocker"
            class="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ t('layout.dialogs.addBlocker.submit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Add Relation Dialog -->
  <Dialog v-model:open="isAddRelDialogOpen">
    <DialogContent class="sm:max-w-lg overflow-hidden">
      <DialogHeader>
        <DialogTitle>{{ t('layout.dialogs.addRelation.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('layout.dialogs.addRelation.from') }} <span class="font-mono text-sky-400">{{ addRelIssueId }}</span>
          <br />
          <span class="text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === addRelIssueId)?.title }}</span>
        </DialogDescription>
      </DialogHeader>
      <div class="space-y-4 py-2 overflow-hidden">
        <!-- Relation type selector -->
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.addRelation.type') }}</label>
          <select
            v-model="addRelSelectedType"
            class="h-9 w-full text-sm px-3 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option v-for="rt in availableRelationTypes" :key="rt.value" :value="rt.value">{{ rt.label }}</option>
          </select>
        </div>
        <!-- Target issue search -->
        <div class="space-y-1.5 overflow-hidden">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.addRelation.target') }}</label>
            <button
              type="button"
              class="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors select-none"
              :class="addRelFilterClosed
                ? 'border-sky-500/50 bg-sky-500/10 text-sky-400'
                : 'border-border text-muted-foreground hover:border-muted-foreground/50'"
              @click="addRelFilterClosed = !addRelFilterClosed"
            >
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" /></svg>
              {{ t('layout.dialogs.addRelation.excludeClosed') }}
            </button>
          </div>
          <input
            v-model="addRelSearchQuery"
            type="text"
            class="h-9 w-full text-sm px-3 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            :placeholder="t('layout.dialogs.addRelation.searchPlaceholder')"
          />
          <div class="max-h-64 overflow-y-auto rounded-md border border-border">
            <button
              v-for="opt in addRelFilteredOptions"
              :key="opt.id"
              class="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors min-w-0"
              :class="{ 'bg-accent': addRelSelectedTarget === opt.id }"
              @click="addRelSelectedTarget = opt.id"
            >
              <span :class="['font-medium shrink-0', priorityTextColor(opt.priority)]">{{ opt.id }}</span>
              <span class="truncate text-muted-foreground flex-1 min-w-0">{{ opt.title }}</span>
              <StatusBadge :status="opt.status" class="shrink-0 scale-75 origin-right" />
            </button>
            <p v-if="!addRelFilteredOptions.length && addRelSearchQuery" class="px-3 py-2 text-sm text-muted-foreground">
              {{ t('layout.dialogs.addRelation.noMatches') }}
            </p>
            <p v-if="!addRelFilteredOptions.length && !addRelSearchQuery" class="px-3 py-2 text-sm text-muted-foreground">
              {{ t('layout.dialogs.addRelation.typeToSearch') }}
            </p>
          </div>
        </div>
      </div>
      <DialogFooter class="gap-3">
        <Button variant="outline" @click="isAddRelDialogOpen = false">{{ t('common.cancel') }}</Button>
        <Button
          :disabled="!addRelSelectedTarget || isAddingRel"
          @click="handleAddRelation"
        >
          <svg
            v-if="isAddingRel"
            class="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ t('layout.dialogs.addRelation.submit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Remove Relation Confirmation Dialog -->
  <ConfirmDialog
    v-model:open="isRemoveRelDialogOpen"
    :title="t('layout.dialogs.removeRelation.title')"
    :confirm-text="t('common.remove')"
    :cancel-text="t('common.cancel')"
    variant="destructive"
    :is-loading="isRemovingRel"
    @confirm="handleRemoveRelation"
  >
    <template #description>
      <p class="text-sm text-muted-foreground">
        {{ t('layout.dialogs.removeRelation.confirmQuestion') }}
      </p>
      <div v-if="pendingRelRemoval" class="mt-2 space-y-2">
        <div>
          <p class="text-xs text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.removeRelation.issue') }}</p>
          <p class="text-sm font-mono text-sky-400">{{ pendingRelRemoval.issueId }}</p>
          <p class="text-sm text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === pendingRelRemoval!.issueId)?.title }}</p>
        </div>
        <div>
          <p class="text-xs text-muted-foreground uppercase tracking-wide">{{ t('layout.dialogs.removeRelation.relatedTo') }}</p>
          <p class="text-sm font-mono text-sky-400">{{ pendingRelRemoval.targetId }}</p>
          <p class="text-sm text-muted-foreground">{{ availableIssuesForDeps.find(i => i.id === pendingRelRemoval!.targetId)?.title }}</p>
        </div>
      </div>
    </template>
  </ConfirmDialog>

  <!-- Image Preview Dialog -->
  <ImagePreviewDialog
    v-model:open="imagePreview.isOpen.value"
    :image-src="imagePreview.imageSrc.value"
    :image-alt="imagePreview.imageAlt.value"
    :has-multiple-images="imagePreview.hasMultipleImages.value"
    :can-go-next="imagePreview.canGoNext.value"
    :can-go-prev="imagePreview.canGoPrev.value"
    :image-counter="imagePreview.imageCounter.value"
    @next="imagePreview.goNext"
    @prev="imagePreview.goPrev"
  />

  <!-- Markdown Preview Dialog -->
  <MarkdownPreviewDialog
    v-model:open="markdownPreview.isOpen.value"
    :markdown-content="markdownPreview.markdownContent.value"
    :markdown-title="markdownPreview.markdownTitle.value"
    :is-loading="markdownPreview.isLoading.value"
    :has-multiple-files="markdownPreview.hasMultipleFiles.value"
    :can-go-next="markdownPreview.canGoNext.value"
    :can-go-prev="markdownPreview.canGoPrev.value"
    :file-counter="markdownPreview.fileCounter.value"
    :is-edit-mode="markdownPreview.isEditMode.value"
    :edited-content="markdownPreview.editedContent.value"
    :is-saving="markdownPreview.isSaving.value"
    @next="markdownPreview.goNext"
    @prev="markdownPreview.goPrev"
    @toggle-edit="markdownPreview.toggleEdit"
    @save="markdownPreview.requestSave"
    @cancel-edit="markdownPreview.cancelEdit"
    @update:edited-content="markdownPreview.editedContent.value = $event"
  />

  <!-- Markdown Save Confirmation -->
  <ConfirmDialog
    v-model:open="markdownPreview.showSaveConfirm.value"
    :title="t('layout.dialogs.markdownSave.title')"
    :description="t('layout.dialogs.markdownSave.description')"
    :confirm-text="t('common.save')"
    :cancel-text="t('common.cancel')"
    :is-loading="markdownPreview.isSaving.value"
    @confirm="markdownPreview.confirmSave"
    @cancel="markdownPreview.cancelSave"
  />
</template>
