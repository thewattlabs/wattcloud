<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import Plus from 'phosphor-svelte/lib/Plus';
  import UploadSimple from 'phosphor-svelte/lib/UploadSimple';
  import FolderPlus from 'phosphor-svelte/lib/FolderPlus';
  import FolderSimple from 'phosphor-svelte/lib/FolderSimple';

  interface Props {
    showMenu?: boolean;
    disabled?: boolean;
  onToggle?: (...args: any[]) => void;
  onUpload?: (...args: any[]) => void;
  onUploadFolder?: (...args: any[]) => void;
  onNewFolder?: (...args: any[]) => void;
  }

  let { showMenu = false, disabled = false,
  onToggle,
  onUpload,
  onUploadFolder,
  onNewFolder }: Props = $props();
function toggle() {
    if (disabled) return;
    onToggle?.();
  }

  function handleUpload() {
    onUpload?.();
  }

  function handleUploadFolder() {
    onUploadFolder?.();
  }

  function handleNewFolder() {
    onNewFolder?.();
  }

  function handleBackdropClick() {
    if (showMenu) {
      onToggle?.();
    }
  }
</script>

{#if showMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fab-backdrop"
    onclick={handleBackdropClick}
    role="button"
    tabindex="-1"
    transition:fade={{ duration: 150 }}
  ></div>

  <div class="fab-speed-dial">
    <button
      class="fab-speed-item"
      onclick={handleNewFolder}
      {disabled}
      transition:fly={{ y: 16, duration: 200, delay: 100 }}
    >
      <FolderPlus size={20} />
      <span>Create folder</span>
    </button>

    <button
      class="fab-speed-item"
      onclick={handleUploadFolder}
      {disabled}
      transition:fly={{ y: 16, duration: 200, delay: 50 }}
    >
      <FolderSimple size={20} />
      <span>Upload folder</span>
    </button>

    <button
      class="fab-speed-item"
      onclick={handleUpload}
      {disabled}
      transition:fly={{ y: 16, duration: 200, delay: 0 }}
    >
      <UploadSimple size={20} />
      <span>Upload file</span>
    </button>
  </div>
{/if}

<button
  class="fab"
  class:active={showMenu}
  class:fab-disabled={disabled}
  {disabled}
  onclick={toggle}
  aria-label={showMenu ? 'Close menu' : 'Add new'}
>
  <span class="fab-icon" class:rotated={showMenu}>
    <Plus size={24} weight="bold" />
  </span>
</button>

<style>
  .fab-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: calc(var(--z-fab) - 1);
  }

  .fab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--duration-normal) ease;
  }

  .fab-icon.rotated {
    transform: rotate(45deg);
  }

  .fab-disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
