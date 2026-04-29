/**
 * Tests for ByoDataProvider.recordShareAudit — the SQL + journal +
 * markDirty plumbing that turns a UI-level "I just shared this" gesture
 * into a persistable vault row.
 *
 * The function is short but it sits on a multi-step pipeline:
 *   1. checkOperational() — must throw when no vault is unlocked.
 *   2. onMutate(sql, params) — appends to crash-recovery WAL and the
 *      cloud VaultJournal under the active provider.
 *   3. db.run(sql, params) — writes the share_audit SQLite row.
 *   4. markDirty(activeProviderId) — schedules a vault save.
 *
 * We mock VaultLifecycle, IndexedDBWal, and byoWorkerClient at the
 * module boundary so the test runs without a real sql.js Database,
 * StorageProvider, or worker. The contract being verified is the
 * shape of what reaches each downstream module — not the journal's
 * upload semantics or sql.js itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────
//
// vi.mock factories are hoisted to the top of the module, so any spy
// they capture must live inside a vi.hoisted() block (which is also
// hoisted) — not a plain top-level const.

const hoisted = vi.hoisted(() => {
  const markDirtyMock = (globalThis as unknown as { __vitest_fn?: typeof vi.fn }).__vitest_fn?.()
    ?? null;
  return {
    markDirtyMock: vi.fn(),
    appendWalMock: vi.fn().mockResolvedValue(undefined),
    appendWalBlobDeleteMock: vi.fn().mockResolvedValue(undefined),
    journalAppendMock: vi.fn().mockResolvedValue(undefined),
    lifecycleState: {
      vaultId: 'vault-abc' as string,
      provider: { dummy: true } as unknown,
      walKey: new Uint8Array(32) as Uint8Array | null,
      journal: null as unknown,
    },
  };
});
hoisted.lifecycleState.journal = { append: hoisted.journalAppendMock };

vi.mock('../../src/lib/byo/VaultLifecycle', () => ({
  getVaultId: () => hoisted.lifecycleState.vaultId,
  getProvider: () => hoisted.lifecycleState.provider,
  getJournalForProvider: () => hoisted.lifecycleState.journal,
  getWalKeyForProvider: () => hoisted.lifecycleState.walKey,
  getOrInitProvider: vi.fn().mockResolvedValue({}),
  markDirty: hoisted.markDirtyMock,
}));

vi.mock('../../src/lib/byo/IndexedDBWal', () => ({
  appendWal: hoisted.appendWalMock,
  appendWalBlobDelete: hoisted.appendWalBlobDeleteMock,
}));

// The SDK index pulls in the worker client; stub it so module load
// doesn't try to spawn a real Web Worker.
vi.mock('../../src/lib/sdk/worker/byoWorkerClient', () => ({
  initByoWorker: vi.fn().mockResolvedValue(undefined),
  Worker: {},
  byoJournalAppend: vi.fn().mockResolvedValue({ entry_b64: '' }),
}));

const { markDirtyMock, appendWalMock, journalAppendMock, lifecycleState } = hoisted;

import { ByoDataProvider } from '../../src/lib/byo/ByoDataProvider';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProviderUnderTest(activeProviderId = 'pid-1') {
  const dbRun = vi.fn();
  // Minimum subset of sql.js Database that ByoDataProvider touches in
  // recordShareAudit.
  const fakeDb = { run: dbRun } as unknown as import('sql.js').Database;
  const provider = {} as Parameters<typeof ByoDataProvider>[1];
  // Constructor instantiates TrashManager, which only stores its args —
  // no I/O — so a partially-stubbed db is safe here.
  const instance = new ByoDataProvider(fakeDb, provider, activeProviderId, 'session-1');
  return { instance, dbRun };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ByoDataProvider.recordShareAudit', () => {
  beforeEach(() => {
    markDirtyMock.mockReset();
    appendWalMock.mockReset().mockResolvedValue(undefined);
    journalAppendMock.mockReset().mockResolvedValue(undefined);
    lifecycleState.vaultId = 'vault-abc';
    lifecycleState.provider = { dummy: true };
    lifecycleState.walKey = new Uint8Array(32);
    lifecycleState.journal = { append: journalAppendMock };
  });

  it('inserts an outbound row with ts/direction/file_ref/null hint into share_audit', async () => {
    const { instance, dbRun } = makeProviderUnderTest('pid-1');
    const before = Date.now();
    await instance.recordShareAudit('outbound', '42');
    const after = Date.now();

    expect(dbRun).toHaveBeenCalledTimes(1);
    const [sql, params] = dbRun.mock.calls[0];
    expect(sql).toBe(
      'INSERT INTO share_audit (ts, direction, file_ref, counterparty_hint) VALUES (?, ?, ?, ?)',
    );
    expect(Array.isArray(params)).toBe(true);
    const [ts, direction, fileRef, hint] = params as unknown[];
    expect(typeof ts).toBe('number');
    expect(ts as number).toBeGreaterThanOrEqual(before);
    expect(ts as number).toBeLessThanOrEqual(after);
    expect(direction).toBe('outbound');
    expect(fileRef).toBe('42');
    expect(hint).toBeNull();
  });

  it('records inbound direction with the provided counterparty hint', async () => {
    const { instance, dbRun } = makeProviderUnderTest();
    await instance.recordShareAudit('inbound', 'file-uuid', 'https://example.com/share');

    const [, params] = dbRun.mock.calls[0];
    expect((params as unknown[])[1]).toBe('inbound');
    expect((params as unknown[])[2]).toBe('file-uuid');
    expect((params as unknown[])[3]).toBe('https://example.com/share');
  });

  it('appends a journal entry tagged with table=share_audit, type=INSERT, rowId=0', async () => {
    const { instance } = makeProviderUnderTest('pid-7');
    await instance.recordShareAudit('outbound', '99');

    expect(journalAppendMock).toHaveBeenCalledTimes(1);
    const entry = journalAppendMock.mock.calls[0][0];
    expect(entry.table).toBe('share_audit');
    expect(entry.type).toBe('INSERT');
    // The share_audit table autoincrements `id`, which isn't in the
    // INSERT column list, so inferJournalMeta defaults rowId to 0.
    expect(entry.rowId).toBe(0);
    // Data carries the SQL + params verbatim so a remote replay can
    // re-apply the row exactly.
    const data = JSON.parse(entry.data);
    expect(data.sql).toContain('INSERT INTO share_audit');
    expect(data.params[1]).toBe('outbound');
    expect(data.params[2]).toBe('99');
  });

  it('appends a WAL entry under the active provider key', async () => {
    const { instance } = makeProviderUnderTest('pid-active');
    await instance.recordShareAudit('outbound', '7');

    expect(appendWalMock).toHaveBeenCalledTimes(1);
    const [walId, walKey, sql, params] = appendWalMock.mock.calls[0];
    expect(walId).toBe('vault-abc:pid-active');
    expect(walKey).toBeInstanceOf(Uint8Array);
    expect(sql).toContain('share_audit');
    expect((params as unknown[])[2]).toBe('7');
  });

  it('marks the active provider dirty so the next save flushes the entry', async () => {
    const { instance } = makeProviderUnderTest('pid-dirty');
    await instance.recordShareAudit('inbound', 'rf', null);

    expect(markDirtyMock).toHaveBeenCalledTimes(1);
    expect(markDirtyMock).toHaveBeenCalledWith('pid-dirty');
  });

  it('throws when no vault is unlocked (checkOperational gate)', async () => {
    const { instance } = makeProviderUnderTest();
    lifecycleState.provider = null;
    await expect(instance.recordShareAudit('outbound', '1')).rejects.toThrow('Vault not unlocked');
    // None of the downstream side effects should fire on the gate failure.
    expect(appendWalMock).not.toHaveBeenCalled();
    expect(journalAppendMock).not.toHaveBeenCalled();
    expect(markDirtyMock).not.toHaveBeenCalled();
  });

  it('skips WAL append when no walKey is registered for the provider', async () => {
    lifecycleState.walKey = null as unknown as Uint8Array;
    const { instance } = makeProviderUnderTest();
    await instance.recordShareAudit('outbound', '1');
    expect(appendWalMock).not.toHaveBeenCalled();
    // Journal append + dirty flag still run — those depend on a journal
    // being registered, not on the WAL key.
    expect(journalAppendMock).toHaveBeenCalledTimes(1);
    expect(markDirtyMock).toHaveBeenCalledTimes(1);
  });

  it('skips journal append when no journal is registered', async () => {
    lifecycleState.journal = null;
    const { instance } = makeProviderUnderTest();
    await instance.recordShareAudit('outbound', '1');
    expect(journalAppendMock).not.toHaveBeenCalled();
    // SQL run + dirty flag still happen — losing the journal degrades
    // remote sync, not local persistence.
    expect(markDirtyMock).toHaveBeenCalledTimes(1);
  });
});
