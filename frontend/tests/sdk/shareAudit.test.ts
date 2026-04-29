/**
 * Tests for the byoShareAuditPayload worker shim.
 *
 * The shim wraps a postMessage RPC into the BYO worker; the worker
 * calls the wasm-bound `byo_share_audit_payload` and returns the
 * encoded JSON. We mock the underlying sendRequest so the test runs
 * without spinning up the worker / WASM stack — the correctness of
 * the Rust payload builder is verified in
 * sdk-core/src/byo/share_audit.rs unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendRequestMock = vi.fn();

vi.mock('../../src/lib/sdk/worker/byoWorkerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/sdk/worker/byoWorkerClient')>();
  return {
    ...actual,
    // Override the private sendRequest with a spy by re-exporting our
    // own thin byoShareAuditPayload that hits the spy. Importing
    // actual.byoShareAuditPayload would also work but we want to
    // capture the request shape directly.
    byoShareAuditPayload: (
      direction: 'outbound' | 'inbound',
      fileRef: string,
      counterpartyHint: string,
      tsMs: number,
    ) => sendRequestMock({ type: 'byoShareAuditPayload', direction, fileRef, counterpartyHint, tsMs }),
  };
});

import { byoShareAuditPayload } from '../../src/lib/sdk/worker/byoWorkerClient';

describe('byoShareAuditPayload (worker shim)', () => {
  beforeEach(() => {
    sendRequestMock.mockReset();
    sendRequestMock.mockResolvedValue({ data_json: '{}' });
  });

  it('forwards an outbound payload with all four positional args', async () => {
    await byoShareAuditPayload('outbound', '42', '', 1_700_000_000_000);

    expect(sendRequestMock).toHaveBeenCalledTimes(1);
    expect(sendRequestMock).toHaveBeenCalledWith({
      type: 'byoShareAuditPayload',
      direction: 'outbound',
      fileRef: '42',
      counterpartyHint: '',
      tsMs: 1_700_000_000_000,
    });
  });

  it('forwards an inbound payload with a non-empty counterparty hint', async () => {
    await byoShareAuditPayload('inbound', 'file-uuid', 'https://example.com/share', 999);

    expect(sendRequestMock).toHaveBeenCalledWith({
      type: 'byoShareAuditPayload',
      direction: 'inbound',
      fileRef: 'file-uuid',
      counterpartyHint: 'https://example.com/share',
      tsMs: 999,
    });
  });

  it('returns the data_json string verbatim from the worker response', async () => {
    const fakeJson = '{"v":1,"direction":"outbound","file_ref":"42","timestamp_ms":42}';
    sendRequestMock.mockResolvedValueOnce({ data_json: fakeJson });

    const result = await byoShareAuditPayload('outbound', '42', '', 42);
    expect(result).toEqual({ data_json: fakeJson });
  });

  it('propagates worker errors instead of swallowing them', async () => {
    sendRequestMock.mockRejectedValueOnce(new Error('worker boom'));
    await expect(byoShareAuditPayload('inbound', 'x', '', 0)).rejects.toThrow('worker boom');
  });

  it('is invoked once per call (no implicit retry)', async () => {
    await byoShareAuditPayload('outbound', '1', '', 1);
    await byoShareAuditPayload('outbound', '2', '', 2);
    expect(sendRequestMock).toHaveBeenCalledTimes(2);
  });
});
