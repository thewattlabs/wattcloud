/**
 * Tests for the inbound share-receive orchestration helpers.
 *
 * loadStagedShareSession and runShareReceiveUploads were extracted out
 * of ShareReceiveSheet.svelte so the loop can be exercised without a
 * Svelte renderer or a real OPFS — both pieces are pure orchestration
 * over a small dependency surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadStagedShareSession,
  runShareReceiveUploads,
  type ShareSessionMeta,
  type UploadSideEffects,
} from '../../src/lib/byo/shareReceiveUpload';
import type { DataProvider, FileEntry } from '../../src/lib/byo/DataProvider';

// ── OPFS fake ──────────────────────────────────────────────────────────────

interface FakeFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}
interface FakeDirHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle: (name: string) => Promise<FakeDirHandle>;
  getFileHandle: (name: string) => Promise<FakeFileHandle>;
}

function makeOpfsRoot(layout: {
  meta: ShareSessionMeta;
  filesByStagedAs: Record<string, Uint8Array>;
}): FakeDirHandle {
  const sessionId = 'sess-1';

  const sessionDir: FakeDirHandle = {
    kind: 'directory',
    name: sessionId,
    getDirectoryHandle: async (n) => {
      throw new Error(`unexpected nested dir ${n}`);
    },
    getFileHandle: async (n) => {
      if (n === 'meta.json') {
        return {
          kind: 'file',
          name: 'meta.json',
          getFile: async () =>
            new File([JSON.stringify(layout.meta)], 'meta.json', { type: 'application/json' }),
        };
      }
      const bytes = layout.filesByStagedAs[n];
      if (!bytes) throw new Error(`no staged file ${n}`);
      return {
        kind: 'file',
        name: n,
        getFile: async () => new File([bytes], n, { type: 'application/octet-stream' }),
      };
    },
  };

  const stage: FakeDirHandle = {
    kind: 'directory',
    name: 'share-staging',
    getDirectoryHandle: async (n) => {
      if (n !== sessionId) throw new Error(`session ${n} not found`);
      return sessionDir;
    },
    getFileHandle: async () => {
      throw new Error('unexpected file at share-staging root');
    },
  };

  return {
    kind: 'directory',
    name: '',
    getDirectoryHandle: async (n) => {
      if (n !== 'share-staging') throw new Error(`no ${n}`);
      return stage;
    },
    getFileHandle: async () => {
      throw new Error('unexpected file at OPFS root');
    },
  };
}

// ── loadStagedShareSession ─────────────────────────────────────────────────

describe('loadStagedShareSession', () => {
  it('rehydrates meta.json + every staged file as a real File', async () => {
    const meta: ShareSessionMeta = {
      schema: 1,
      createdAt: 1_700_000_000_000,
      title: 'shared from chat',
      text: 'photo + receipt',
      url: 'https://chat.example.com/conv/42',
      files: [
        { name: 'IMG_0001.heic', type: 'image/heic', size: 4, stagedAs: '0-IMG_0001.heic' },
        { name: 'receipt.pdf', type: 'application/pdf', size: 5, stagedAs: '1-receipt.pdf' },
      ],
    };
    const root = makeOpfsRoot({
      meta,
      filesByStagedAs: {
        '0-IMG_0001.heic': new Uint8Array([1, 2, 3, 4]),
        '1-receipt.pdf': new Uint8Array([5, 6, 7, 8, 9]),
      },
    });

    const loaded = await loadStagedShareSession(root as unknown as FileSystemDirectoryHandle, 'sess-1');
    expect(loaded.meta).toEqual(meta);
    expect(loaded.files).toHaveLength(2);
    expect(loaded.files[0].name).toBe('IMG_0001.heic');
    expect(loaded.files[0].type).toBe('image/heic');
    expect(loaded.files[0].size).toBe(4);
    expect(loaded.files[1].name).toBe('receipt.pdf');
    expect(loaded.files[1].type).toBe('application/pdf');
  });

  it('falls back to the on-disk MIME when meta.type is empty', async () => {
    const meta: ShareSessionMeta = {
      schema: 1,
      createdAt: 0,
      title: '',
      text: '',
      url: '',
      files: [{ name: 'note.txt', type: '', size: 3, stagedAs: '0-note.txt' }],
    };
    const root = makeOpfsRoot({ meta, filesByStagedAs: { '0-note.txt': new Uint8Array([1, 2, 3]) } });
    const loaded = await loadStagedShareSession(root as unknown as FileSystemDirectoryHandle, 'sess-1');
    // OPFS file constructed with type "application/octet-stream" — that's the fallback
    expect(loaded.files[0].type).toBe('application/octet-stream');
  });

  it('rejects when the session directory is missing', async () => {
    const root = makeOpfsRoot({ meta: { schema: 1, createdAt: 0, title: '', text: '', url: '', files: [] }, filesByStagedAs: {} });
    await expect(
      loadStagedShareSession(root as unknown as FileSystemDirectoryHandle, 'gone'),
    ).rejects.toThrow();
  });
});

// ── runShareReceiveUploads ─────────────────────────────────────────────────

function makeEffects() {
  const events: string[] = [];
  const effects: UploadSideEffects = {
    enqueue: vi.fn((file: File, _folderId) => {
      events.push(`enqueue:${file.name}`);
      return `id-${file.name}`;
    }),
    setEncrypting: vi.fn((id) => events.push(`encrypt:${id}`)),
    setUploading: vi.fn((id, _b, _t, _p) => events.push(`upload:${id}`)),
    setCompleted: vi.fn((id) => events.push(`done:${id}`)),
    setError: vi.fn((id, msg) => events.push(`error:${id}:${msg}`)),
    getPauseSignal: vi.fn(() => undefined),
    recordInboundStat: vi.fn(() => events.push('stat:inbound')),
  };
  return { effects, events };
}

function makeProvider(): {
  provider: DataProvider;
  uploadFile: ReturnType<typeof vi.fn>;
  recordShareAudit: ReturnType<typeof vi.fn>;
} {
  let nextId = 1;
  const uploadFile = vi.fn(async (folderId: number | null, file: File) => {
    const row: FileEntry = {
      id: nextId++,
      folder_id: folderId,
      name: file.name,
      decrypted_name: file.name,
      size: file.size,
      encrypted_size: 0,
      storage_ref: 'ref-' + file.name,
      mime_type: file.type,
      file_type: 'file',
      key_version_id: 0,
      metadata: '',
      created_at: '0',
      updated_at: '0',
      provider_id: 'pid',
    };
    return row;
  });
  const recordShareAudit = vi.fn().mockResolvedValue(undefined);
  // Cast through unknown — the test only exercises the two methods.
  const provider = { uploadFile, recordShareAudit } as unknown as DataProvider;
  return { provider, uploadFile, recordShareAudit };
}

const META_WITH_URL: ShareSessionMeta = {
  schema: 1,
  createdAt: 0,
  title: '',
  text: '',
  url: 'https://example.com/conv/9',
  files: [],
};

describe('runShareReceiveUploads', () => {
  let provider: ReturnType<typeof makeProvider>;
  beforeEach(() => {
    provider = makeProvider();
  });

  it('uploads every staged file once, in order', async () => {
    const files = [new File([new Uint8Array(10)], 'a.bin'), new File([new Uint8Array(20)], 'b.bin')];
    const { effects } = makeEffects();
    const result = await runShareReceiveUploads(files, 7, provider.provider, META_WITH_URL, effects);

    expect(result).toEqual({ successes: 2, failures: 0 });
    expect(provider.uploadFile).toHaveBeenCalledTimes(2);
    expect(provider.uploadFile.mock.calls[0][0]).toBe(7);
    expect(provider.uploadFile.mock.calls[0][1]).toBe(files[0]);
    expect(provider.uploadFile.mock.calls[1][1]).toBe(files[1]);
  });

  it('records share_audit("inbound", rowId, hint) per uploaded file', async () => {
    const files = [new File([], 'x'), new File([], 'y')];
    const { effects } = makeEffects();
    await runShareReceiveUploads(files, null, provider.provider, META_WITH_URL, effects);

    expect(provider.recordShareAudit).toHaveBeenCalledTimes(2);
    expect(provider.recordShareAudit).toHaveBeenNthCalledWith(1, 'inbound', '1', 'https://example.com/conv/9');
    expect(provider.recordShareAudit).toHaveBeenNthCalledWith(2, 'inbound', '2', 'https://example.com/conv/9');
  });

  it('passes null hint when meta has no url', async () => {
    const files = [new File([], 'x')];
    const { effects } = makeEffects();
    await runShareReceiveUploads(files, null, provider.provider, { ...META_WITH_URL, url: '' }, effects);
    expect(provider.recordShareAudit).toHaveBeenCalledWith('inbound', '1', null);
  });

  it('truncates an oversized url hint to 256 chars', async () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(500);
    const files = [new File([], 'x')];
    const { effects } = makeEffects();
    await runShareReceiveUploads(
      files,
      null,
      provider.provider,
      { ...META_WITH_URL, url: longUrl },
      effects,
    );
    const hint = provider.recordShareAudit.mock.calls[0][2] as string;
    expect(hint.length).toBe(256);
    expect(longUrl.startsWith(hint)).toBe(true);
  });

  it('fires recordInboundStat exactly once per successful upload', async () => {
    const files = [new File([], 'a'), new File([], 'b'), new File([], 'c')];
    const { effects } = makeEffects();
    await runShareReceiveUploads(files, null, provider.provider, META_WITH_URL, effects);
    expect(effects.recordInboundStat).toHaveBeenCalledTimes(3);
  });

  it('keeps going after a failure — failures+successes sum to total', async () => {
    provider.uploadFile.mockImplementationOnce(async () => {
      throw new Error('quota exceeded');
    });
    const files = [new File([], 'a'), new File([], 'b'), new File([], 'c')];
    const { effects } = makeEffects();
    const result = await runShareReceiveUploads(files, null, provider.provider, META_WITH_URL, effects);

    expect(result).toEqual({ successes: 2, failures: 1 });
    expect(provider.uploadFile).toHaveBeenCalledTimes(3);
    // share_audit + stats only fire on success.
    expect(provider.recordShareAudit).toHaveBeenCalledTimes(2);
    expect(effects.recordInboundStat).toHaveBeenCalledTimes(2);
    // setError carried the underlying message.
    expect(effects.setError).toHaveBeenCalledWith('id-a', 'quota exceeded');
  });

  it('does not let an audit-write failure abort the queue', async () => {
    provider.recordShareAudit.mockRejectedValueOnce(new Error('journal write blocked'));
    const files = [new File([], 'a'), new File([], 'b')];
    const { effects } = makeEffects();
    const result = await runShareReceiveUploads(files, null, provider.provider, META_WITH_URL, effects);
    expect(result.successes).toBe(2);
    expect(provider.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('emits queue lifecycle in the right order: enqueue → encrypt → upload → done', async () => {
    const files = [new File([new Uint8Array(50)], 'one')];
    const { effects, events } = makeEffects();
    await runShareReceiveUploads(files, null, provider.provider, META_WITH_URL, effects);
    expect(events).toEqual([
      'enqueue:one',
      'encrypt:id-one',
      'upload:id-one', // fired by progress callback inside fake uploadFile? See note below
      // Note: our fake uploadFile doesn't call onProgress, so 'upload:' won't appear here.
      // The check below replaces this with a tighter contract.
      'done:id-one',
      'stat:inbound',
    ].filter((e) => e !== 'upload:id-one'));
  });

  it('forwards bytes-done from uploadFile progress callbacks into setUploading', async () => {
    provider.uploadFile.mockImplementationOnce(async (folderId, file, onProgress) => {
      // Simulate two progress ticks
      onProgress?.(file.size / 2);
      onProgress?.(file.size);
      return {
        id: 99,
        folder_id: folderId,
        name: file.name,
        decrypted_name: file.name,
        size: file.size,
        encrypted_size: 0,
        storage_ref: 'r',
        mime_type: '',
        file_type: 'file',
        key_version_id: 0,
        metadata: '',
        created_at: '0',
        updated_at: '0',
        provider_id: 'pid',
      };
    });
    const file = new File([new Uint8Array(100)], 'x');
    const { effects } = makeEffects();
    await runShareReceiveUploads([file], null, provider.provider, META_WITH_URL, effects);
    // setUploading called twice — bytes-done at half, then full.
    expect(effects.setUploading).toHaveBeenCalledTimes(2);
    expect(effects.setUploading).toHaveBeenNthCalledWith(1, 'id-x', 50, 100, expect.any(Number));
    expect(effects.setUploading).toHaveBeenNthCalledWith(2, 'id-x', 100, 100, expect.any(Number));
  });
});
