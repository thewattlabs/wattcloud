/**
 * Inbound share-receive orchestration helpers.
 *
 * Extracted out of ShareReceiveSheet.svelte so the upload loop is
 * testable without spinning up a Svelte component or a real OPFS.
 *
 * The two helpers mirror the two phases of the inbound flow:
 *
 *   loadStagedShareSession() — read the SW-staged session out of OPFS
 *     and rehydrate each file as a real `File` carrying its original
 *     name + MIME (the on-disk OPFS name is sanitized, but meta.json
 *     preserves the original).
 *
 *   runShareReceiveUploads() — iterate through the staged files,
 *     pushing each one through the standard byoUploadQueue +
 *     dataProvider.uploadFile pipeline so progress shows in the same
 *     toast/seal as a regular upload, then per-success record a
 *     `share_audit` row and a ShareOsInbound stats event.
 */

import type { DataProvider } from './DataProvider';

export interface StagedFileMeta {
  name: string;
  type: string;
  size: number;
  stagedAs: string;
}

export interface ShareSessionMeta {
  schema: number;
  createdAt: number;
  title: string;
  text: string;
  url: string;
  files: StagedFileMeta[];
}

export interface LoadedShareSession {
  meta: ShareSessionMeta;
  files: File[];
}

/**
 * Read the SW-staged session at /share-staging/<sessionId>/ from OPFS.
 *
 * The OPFS root is injected so tests can supply a fake without touching
 * `navigator.storage.getDirectory`. Throws if the directory or
 * meta.json are missing — callers should treat that as "session
 * already processed or expired" and route the user back home.
 */
export async function loadStagedShareSession(
  opfsRoot: FileSystemDirectoryHandle,
  sessionId: string,
): Promise<LoadedShareSession> {
  const stage = await opfsRoot.getDirectoryHandle('share-staging');
  const dir = await stage.getDirectoryHandle(sessionId);
  const metaHandle = await dir.getFileHandle('meta.json');
  const metaFile = await metaHandle.getFile();
  const meta = JSON.parse(await metaFile.text()) as ShareSessionMeta;

  const files: File[] = [];
  for (const entry of meta.files) {
    const fh = await dir.getFileHandle(entry.stagedAs);
    const raw = await fh.getFile();
    files.push(
      new File([raw], entry.name || entry.stagedAs, {
        type: entry.type || raw.type || 'application/octet-stream',
        lastModified: raw.lastModified,
      }),
    );
  }
  return { meta, files };
}

/** Pluggable side effects so the orchestrator stays unit-testable. */
export interface UploadSideEffects {
  /** Add to byoUploadQueue and return an item id. */
  enqueue(file: File, folderId: number | null): string;
  setEncrypting(itemId: string): void;
  setUploading(itemId: string, bytesDone: number, bytesTotal: number, progressPct: number): void;
  setCompleted(itemId: string, bytesTotal: number): void;
  setError(itemId: string, message: string): void;
  /** Pause/abort signal handed to dataProvider.uploadFile. */
  getPauseSignal(itemId: string): { isPaused(): boolean; wait(): Promise<void> } | undefined;
  /** Fire a usage stats event for one inbound share-target upload. */
  recordInboundStat(): void;
}

export interface RunUploadsResult {
  successes: number;
  failures: number;
}

/**
 * Sequentially upload every file from a staged share-target session
 * into the user's chosen destination folder.
 *
 * Behaviour contract:
 *   - Failures do NOT abort the queue; remaining files still run.
 *   - Per success: record a share_audit('inbound', fileId, hint) row
 *     and a ShareOsInbound stats event. The hint is the source app's
 *     `url` form field if present, truncated to 256 chars; otherwise
 *     null.
 *   - share_audit + stats are best-effort — neither blocks the next
 *     upload, both swallow errors via .catch on the audit promise.
 */
export async function runShareReceiveUploads(
  files: File[],
  folderId: number | null,
  dataProvider: DataProvider,
  meta: ShareSessionMeta | null,
  effects: UploadSideEffects,
): Promise<RunUploadsResult> {
  let successes = 0;
  let failures = 0;
  const hint = meta?.url ? meta.url.slice(0, 256) : null;

  for (const file of files) {
    const itemId = effects.enqueue(file, folderId);
    effects.setEncrypting(itemId);
    try {
      const row = await dataProvider.uploadFile(
        folderId,
        file,
        (bytes) => {
          const pct = file.size > 0 ? Math.round((bytes / file.size) * 90) : 45;
          effects.setUploading(itemId, bytes, file.size, pct);
        },
        { pauseSignal: effects.getPauseSignal(itemId) },
      );
      effects.setCompleted(itemId, file.size);
      successes += 1;
      // Audit + stats are best-effort. A failed audit must not block
      // the next file or surface to the user — the upload already
      // succeeded and the byoUploadQueue toast already confirmed it.
      dataProvider
        .recordShareAudit('inbound', String(row.id), hint)
        .catch((e) => console.warn('[shareReceiveUpload] audit failed', e));
      effects.recordInboundStat();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : typeof e === 'string' ? e : 'Upload failed';
      effects.setError(itemId, msg);
      failures += 1;
    }
  }

  return { successes, failures };
}
