<script setup lang="ts">
import { ArrowRight, LoaderCircle } from "@lucide/vue";
import { computed } from "vue";

const props = defineProps<{
  selectedCount: number;
  estimatedTotal: string;
  reportInteractive: boolean;
  preparing: boolean;
  removing: boolean;
}>();

defineEmits<{ clear: []; review: [] }>();

const actionsDisabled = computed(() => !props.reportInteractive || props.preparing || props.removing);
</script>

<template>
  <aside class="worktree-selection-dock" aria-label="Selected worktree total">
    <div class="selection-dock-summary" role="status" aria-live="polite" aria-atomic="true">
      <span>Estimated space to free</span>
      <strong>{{ estimatedTotal }}</strong>
      <small>{{ selectedCount }} {{ selectedCount === 1 ? "worktree" : "worktrees" }} selected · Entire checkouts</small>
    </div>
    <div class="selection-dock-actions">
      <button class="secondary-button" :disabled="actionsDisabled" @click="$emit('clear')">
        Clear selection
      </button>
      <button class="danger-button" :disabled="actionsDisabled" @click="$emit('review')">
        <LoaderCircle v-if="preparing" :size="16" class="spinning" />
        {{ preparing ? "Preparing review…" : `Review ${selectedCount} selected` }}
        <ArrowRight v-if="!preparing" :size="16" />
      </button>
    </div>
  </aside>
</template>
