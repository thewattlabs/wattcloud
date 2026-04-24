<script lang="ts" module>
  import type { Folder } from '../stores/files';

  export interface TreeFolder extends Folder {
    children: TreeFolder[];
  }
</script>

<script lang="ts">
  import FolderTree from './FolderTree.svelte';
  import FolderSimple from 'phosphor-svelte/lib/FolderSimple';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import Check from 'phosphor-svelte/lib/Check';
  import X from 'phosphor-svelte/lib/X';
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
  import Trash from 'phosphor-svelte/lib/Trash';
  import FileText from 'phosphor-svelte/lib/FileText';
  import ConfirmModal from './ConfirmModal.svelte';

  

  

  
  

  
  interface Props {
    /** Flat list of all folders (used only at level 0; ignored at deeper levels) */
    folders?: Folder[];
    selected?: number | null;
    /** Internal: pre-built tree nodes passed to recursive children */
    _treeNodes?: TreeFolder[] | null;
    level?: number;
    // BYO mode: handles encryption and persistence.
    onRename?: ((folderId: number, plaintextName: string) => Promise<void>) | null;
    // BYO mode: handles deletion and store update.
    onDelete?: ((folderId: number) => Promise<void>) | null;
    // Managed mode: inject API + store-update operations to avoid static managed imports.
    managedRenameFolder?: ((folderId: number, name: string) => Promise<void>) | null;
    managedDeletePreview?: ((folderId: number) => Promise<{ subfolder_count: number; file_count: number } | null>) | null;
    managedDeleteFolder?: ((folderId: number) => Promise<void>) | null;
  onSelect?: (...args: any[]) => void;
  onMoveFile?: (...args: any[]) => void;
  onMoveFolder?: (...args: any[]) => void;
  }

  let {
    folders = [],
    selected = 1,
    _treeNodes = null,
    level = 0,
    onRename = null,
    onDelete = null,
    managedRenameFolder = null,
    managedDeletePreview = null,
    managedDeleteFolder = null,
    onSelect,
    onMoveFile,
    onMoveFolder
  }: Props = $props();
let expanded = $state(new Set<number>());
  let renamingFolderId: number | null = $state(null);
  let renameValue = $state('');
  let showDeleteModal = $state(false);
  let deletingFolder: { id: number; name: string } | null = $state(null);
  let deletePreview: { subfolder_count: number; file_count: number } | null = $state(null);
  let deleteLoading = $state(false);

  function buildTree(flatFolders: Folder[]): TreeFolder[] {
    const map = new Map<number, TreeFolder>();
    const roots: TreeFolder[] = [];
    for (const folder of flatFolders) {
      map.set(folder.id, { ...folder, children: [] });
    }
    for (const folder of flatFolders) {
      const node = map.get(folder.id)!;
      if (folder.parent_id === null || folder.parent_id === 0) {
        roots.push(node);
      } else {
        const parent = map.get(folder.parent_id);
        if (parent) { parent.children.push(node); }
        else { roots.push(node); }
      }
    }
    return roots;
  }

  // At level 0, build tree from flat folders. At deeper levels, use pre-built nodes.
  let displayNodes = $derived(_treeNodes ? _treeNodes : buildTree(folders));

  function selectFolder(id: number) { onSelect?.(id); }

  function toggleExpand(id: number, event: Event) {
    event.stopPropagation();
    if (expanded.has(id)) { expanded.delete(id); } else { expanded.add(id); }
    expanded = expanded;
  }

  function startRename(folder: TreeFolder, event: Event) {
    event.stopPropagation();
    renamingFolderId = folder.id;
    renameValue = folder.decrypted_name || folder.name;
  }

  function cancelRename(event: Event) {
    event.stopPropagation();
    renamingFolderId = null;
    renameValue = '';
  }

  async function submitRename(folderId: number, event?: Event) {
    if (event) event.stopPropagation();
    const trimmed = renameValue.trim();
    const folder = folders.length > 0
      ? folders.find(f => f.id === folderId)
      : displayNodes.find(f => f.id === folderId);
    if (!trimmed || trimmed === (folder?.decrypted_name || folder?.name)) {
      renamingFolderId = null;
      renameValue = '';
      return;
    }
    try {
      if (onRename) {
        await onRename(folderId, trimmed);
      } else if (managedRenameFolder) {
        await managedRenameFolder(folderId, trimmed);
      }
    } catch (e) {
      console.error('Rename folder failed:', e);
    }
    renamingFolderId = null;
    renameValue = '';
  }

  function handleRenameKeydown(event: KeyboardEvent, folderId: number) {
    if (event.key === 'Enter') { submitRename(folderId, event); }
    else if (event.key === 'Escape') { cancelRename(event); }
  }

  async function deleteFolder(folder: TreeFolder, event: Event) {
    event.stopPropagation();
    if (onDelete) {
      // BYO mode: skip API preview, show modal without stats
      deletingFolder = { id: folder.id, name: folder.decrypted_name || folder.name };
      deletePreview = null;
      showDeleteModal = true;
      return;
    }
    try {
      const preview = managedDeletePreview ? await managedDeletePreview(folder.id) : null;
      deletingFolder = { id: folder.id, name: folder.decrypted_name || folder.name };
      deletePreview = preview;
      showDeleteModal = true;
    } catch (e) {
      if (confirm(`Delete folder "${folder.decrypted_name || folder.name}"? This cannot be undone.`)) {
        await performDelete(folder.id);
      }
    }
  }

  async function confirmDelete() {
    if (deletingFolder) {
      deleteLoading = true;
      await performDelete(deletingFolder.id);
      closeDeleteModal();
    }
  }

  async function performDelete(folderId: number) {
    try {
      if (onDelete) {
        await onDelete(folderId);
      } else if (managedDeleteFolder) {
        await managedDeleteFolder(folderId);
      }
    } catch (e) {
      console.error('Delete folder failed:', e);
    }
  }

  function cancelDelete() { closeDeleteModal(); }
  export function closeDeleteModal() { showDeleteModal = false; deletingFolder = null; deletePreview = null; deleteLoading = false; }

  let dragOverFolder: number | null = $state(null);
  function handleDragStart(event: DragEvent, folder: TreeFolder) { if (event.dataTransfer) { event.dataTransfer.setData('application/json', JSON.stringify({ type: 'folder', id: folder.id })); event.dataTransfer.effectAllowed = 'move'; } }
  function handleDragOver(event: DragEvent, folderId: number) { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; dragOverFolder = folderId; }
  function handleDragLeave(event: DragEvent) { event.stopPropagation(); dragOverFolder = null; }
  function handleDrop(event: DragEvent, folderId: number) {
    event.preventDefault(); event.stopPropagation(); dragOverFolder = null;
    const data = event.dataTransfer?.getData('application/json');
    if (data) { try { const parsed = JSON.parse(data); if (parsed.type === 'file') { onMoveFile?.({ fileId: parsed.id, folderId }); } else if (parsed.type === 'folder' && parsed.id !== folderId) { onMoveFolder?.({ folderId: parsed.id, parentId: folderId }); } } catch (e) { console.error('Failed to parse drag data:', e); } }
  }
</script>

<div class="folder-tree" class:is-root={level === 0}>
  {#if level === 0}
    <h3 class="tree-label">Folders</h3>
  {/if}
  <ul>
    {#each displayNodes as folder (folder.id)}
      <li
        class:active={folder.id === selected}
        class:drag-over={folder.id === dragOverFolder}
        draggable={renamingFolderId !== folder.id}
        ondragstart={(e) => handleDragStart(e, folder)}
        ondragover={(e) => handleDragOver(e, folder.id)}
        ondragleave={handleDragLeave}
        ondrop={(e) => handleDrop(e, folder.id)}
      >
        {#if renamingFolderId === folder.id}
          <div class="rename-row">
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              bind:value={renameValue}
              onkeydown={(e) => handleRenameKeydown(e, folder.id)}
              onblur={() => submitRename(folder.id)}
              autofocus
            />
            <button class="icon-btn confirm" onclick={(e) => submitRename(folder.id, e)} aria-label="Confirm rename">
              <Check size={16} weight="bold" />
            </button>
            <button class="icon-btn cancel" onclick={(e) => cancelRename(e)} aria-label="Cancel rename">
              <X size={16} weight="bold" />
            </button>
          </div>
        {:else}
          <div class="folder-row" onclick={() => selectFolder(folder.id)} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), selectFolder(folder.id))} role="button" tabindex="0">
            {#if folder.children.length > 0}
              <button
                class="icon-btn expand"
                type="button"
                onclick={(e) => { e.stopPropagation(); toggleExpand(folder.id, e); }}
                aria-label={expanded.has(folder.id) ? 'Collapse' : 'Expand'}
              >
                {#if expanded.has(folder.id)}
                  <CaretDown size={20} />
                {:else}
                  <CaretRight size={20} />
                {/if}
              </button>
            {:else}
              <span class="expand-spacer"></span>
            {/if}

            <FolderSimple
              size={20}
              weight={folder.id === selected ? 'fill' : 'regular'}
              color={folder.id === selected ? 'var(--accent-text)' : 'var(--text-secondary)'}
            />
            <span class="folder-name">{folder.decrypted_name || folder.name}</span>

            <div class="actions">
              <button class="icon-btn action-rename" type="button" onclick={(e) => { e.stopPropagation(); startRename(folder, e); }} aria-label="Rename" title="Rename">
                <PencilSimple size={20} />
              </button>
              <button class="icon-btn action-delete" type="button" onclick={(e) => { e.stopPropagation(); deleteFolder(folder, e); }} aria-label="Delete" title="Delete">
                <Trash size={20} weight="bold" />
              </button>
            </div>
          </div>

          {#if folder.children.length > 0 && expanded.has(folder.id)}
            <FolderTree
              folders={[]}
              _treeNodes={folder.children}
              {selected}
              level={level + 1}
              {onRename}
              {onDelete}
              
              
              
            />
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

  {#if level === 0}
    <ConfirmModal
      isOpen={showDeleteModal}
      title="Delete Folder"
      confirmText="Delete"
      confirmClass="btn-danger"
      loading={deleteLoading}
      onConfirm={confirmDelete}
      onCancel={cancelDelete}
    >
      {#if deletingFolder}
        <p class="warning-text">Are you sure you want to delete <strong>{deletingFolder.name}</strong>?</p>
        {#if deletePreview}
          <div class="delete-stats">
            {#if deletePreview.subfolder_count > 0}
              <div class="stat-item"><FolderSimple size={20} /><span><strong>{deletePreview.subfolder_count}</strong> subfolder{deletePreview.subfolder_count !== 1 ? 's' : ''}</span></div>
            {/if}
            {#if deletePreview.file_count > 0}
              <div class="stat-item"><FileText size={20} /><span><strong>{deletePreview.file_count}</strong> file{deletePreview.file_count !== 1 ? 's' : ''}</span></div>
            {/if}
            {#if deletePreview.subfolder_count === 0 && deletePreview.file_count === 0}
              <p class="empty-folder-note">This folder is empty.</p>
            {/if}
          </div>
        {/if}
        <p class="warning-note">This action cannot be undone.</p>
      {/if}
    </ConfirmModal>
  {/if}
</div>

<style>
  /* ── Root ──────────────────────────────────────────────── */
  .folder-tree { padding: 0; }
  .folder-tree.is-root { padding: var(--sp-sm); }

  .tree-label {
    font-size: var(--t-label-size, 0.75rem);
    font-weight: var(--t-label-weight, 500);
    letter-spacing: var(--t-label-spacing, 0.03em);
    text-transform: uppercase;
    color: var(--text-secondary);
    margin: 0 0 var(--sp-sm);
    padding: 0 var(--sp-sm);
  }

  ul { list-style: none; padding: 0; margin: 0; }
  li { margin-bottom: 2px; }

  /* ── Folder row ────────────────────────────────────────── */
  .folder-row {
    display: flex;
    align-items: center;
    gap: var(--sp-sm);
    min-height: 48px;
    padding: var(--sp-xs) var(--sp-sm);
    border-radius: var(--r-input);
    cursor: pointer;
    color: var(--text-secondary);
    transition: background var(--duration-normal, 150ms) ease;
  }
  .folder-row:hover { background: var(--bg-surface-hover); }
  .folder-row:active { background: var(--bg-surface-raised); }
  .folder-row:hover .actions { opacity: 1; }

  li.active > .folder-row {
    background: var(--accent-muted);
    color: var(--accent-text);
  }
  li.drag-over > .folder-row {
    background: var(--accent-muted);
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
    border-radius: var(--r-input);
  }

  /* ── Expand toggle ─────────────────────────────────────── */
  .icon-btn {
    width: 44px; height: 44px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none;
    border-radius: var(--r-thumbnail);
    padding: 0; cursor: pointer;
    color: var(--text-disabled);
    transition: background var(--duration-normal, 150ms) ease,
                color var(--duration-normal, 150ms) ease;
  }
  .icon-btn:hover { background: var(--bg-surface-raised); color: var(--text-secondary); }

  .icon-btn.expand { margin: -4px 0; }
  .expand-spacer { width: 44px; flex-shrink: 0; }

  /* ── Folder name ───────────────────────────────────────── */
  .folder-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-body-size, 0.9375rem);
    font-weight: 500;
  }

  /* ── Action buttons ────────────────────────────────────── */
  .actions {
    display: flex; gap: 2px;
    opacity: 0;
    transition: opacity var(--duration-normal, 150ms) ease;
    flex-shrink: 0;
  }
  .action-rename:hover { background: var(--accent-muted); color: var(--accent-text); }
  .action-delete:hover { background: var(--danger-muted); color: var(--danger); }

  /* Touch devices: always show actions */
  @media (hover: none), (pointer: coarse) {
    .actions { opacity: 1; }
  }

  /* ── Children indentation ──────────────────────────────── */
  li > :global(.folder-tree) {
    padding-left: var(--sp-md);
  }

  /* ── Rename form ───────────────────────────────────────── */
  .rename-row {
    display: flex; gap: var(--sp-xs); align-items: center;
    padding: var(--sp-xs) var(--sp-sm);
    min-height: 48px;
  }
  .rename-row input {
    flex: 1;
    padding: var(--sp-sm);
    min-height: 44px;
    border: 1px solid var(--accent);
    border-radius: var(--r-input);
    font-size: var(--t-body-size, 0.9375rem);
    background: var(--bg-input);
    color: var(--text-primary);
    outline: none;
  }
  .rename-row input:focus { box-shadow: 0 0 0 2px var(--accent-muted); }
  .rename-row .icon-btn { opacity: 1; }
  .rename-row .icon-btn.confirm { background: var(--accent); color: var(--text-inverse, #121212); }
  .rename-row .icon-btn.confirm:hover { background: var(--accent-hover); }
  .rename-row .icon-btn.cancel { background: var(--bg-surface-raised); color: var(--text-secondary); }
  .rename-row .icon-btn.cancel:hover { background: var(--bg-surface-hover); color: var(--text-primary); }

  /* ── Delete modal ──────────────────────────────────────── */
  .warning-text { margin-bottom: var(--sp-sm); color: var(--text-primary); }
  .warning-text strong { color: var(--text-primary); }
  .delete-stats {
    display: flex; flex-direction: column; gap: var(--sp-sm);
    padding: var(--sp-sm); background: var(--bg-surface); border-radius: var(--r-input);
    margin-bottom: var(--sp-sm);
  }
  .stat-item { display: flex; align-items: center; gap: var(--sp-sm); color: var(--text-secondary); }
  .stat-item strong { color: var(--text-primary); }
  .empty-folder-note { margin: 0; color: var(--text-secondary); font-style: italic; }
  .warning-note { margin: 0; font-size: var(--t-body-sm-size); color: var(--danger); }
</style>
