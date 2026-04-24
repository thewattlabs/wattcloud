<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';

  interface Props {
    isOpen?: boolean;
    title?: string;
    message?: string;
    confirmText?: string;
    confirmClass?: string;
    loading?: boolean;
    children?: import('svelte').Snippet;
  onConfirm?: (...args: any[]) => void;
  onCancel?: (...args: any[]) => void;
  }

  let {
    isOpen = false,
    title = 'Confirm',
    message = '',
    confirmText = 'Confirm',
    confirmClass = 'btn-danger',
    loading = false,
    children,
    onConfirm,
    onCancel
  }: Props = $props();
function handleConfirm() {
    onConfirm?.();
  }

  function handleCancel() {
    if (!loading) {
      onCancel?.();
    }
  }

  /** Map legacy confirmClass values to design-system button classes */
  function resolveButtonClass(cls: string): string {
    if (cls === 'btn-danger') return 'btn btn-danger';
    if (cls === 'btn-primary') return 'btn btn-primary';
    return 'btn btn-primary';
  }
</script>

<BottomSheet open={isOpen} {title} onClose={handleCancel}>
  <div class="confirm-body">
    {#if children}{@render children()}{:else}
      {#if message}
        <p class="confirm-message">{message}</p>
      {/if}
    {/if}
  </div>

  <div class="sheet-actions">
    <button class="btn btn-ghost" onclick={handleCancel} disabled={loading}>
      Cancel
    </button>
    <button class={resolveButtonClass(confirmClass)} onclick={handleConfirm} disabled={loading}>
      {#if loading}
        <span class="spinner"></span>
      {:else}
        {confirmText}
      {/if}
    </button>
  </div>
</BottomSheet>

<style>
  .confirm-body {
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .confirm-body :global(p) {
    margin: 0 0 var(--sp-sm);
  }

  .confirm-message {
    margin: 0;
  }
</style>
