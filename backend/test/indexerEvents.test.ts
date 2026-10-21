import { describe, expect, it } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { decodeScVal, isBountyQueriedEvent, normalizeEvent } from '../worker/eventNormalizer.js';

const encode = (value: unknown) => nativeToScVal(value as never).toXDR('base64');
const encodeSymbol = (value: string) => nativeToScVal(value, { type: 'symbol' }).toXDR('base64');

function bountyEvent(action: string, payload: unknown) {
  return {
    id: '0000000001-0000000001',
    type: 'contract',
    ledgerCloseTime: '2026-10-21T00:00:00Z',
    topic: [encodeSymbol('Bounty'), encodeSymbol(action)],
    value: encode(payload),
  };
}

describe('decodeScVal', () => {
  it('decodes a base64 ScVal into a native value', () => {
    expect(decodeScVal(encodeSymbol('Queried'))).toBe('Queried');
    expect(decodeScVal(encode({ bounty_id: 7 }))).toEqual({ bounty_id: 7n });
  });

  it('leaves already-decoded and undecodable values untouched', () => {
    const fixture = { id: '1' };
    expect(decodeScVal(fixture)).toBe(fixture);
    expect(decodeScVal('not-xdr')).toBe('not-xdr');
  });
});

describe('normalizeEvent', () => {
  it('identifies the Bounty/Queried event', () => {
    expect(isBountyQueriedEvent(bountyEvent('Queried', { bounty_id: 1 }))).toBe(true);
    expect(isBountyQueriedEvent(bountyEvent('Create', { bounty_id: 1 }))).toBe(false);
  });

  it('normalizes Bounty/Queried into a self-contained state update', () => {
    const event = bountyEvent('Queried', {
      bounty_id: 7,
      deadline: 1_000,
      status: ['Expired'],
    });

    const normalized = normalizeEvent(event);

    expect(normalized.id).toBe(event.id);
    expect(normalized.type).toBe('queried');
    expect(normalized.bountyId).toBe(7);
    expect(normalized.status).toBe('Expired');
    expect(normalized.deadline).toBe(1_000);
    expect(normalized.timestamp).toBe('2026-10-21T00:00:00Z');
    // The full projection is available without a follow-up contract read.
    expect(normalized.state).toMatchObject({
      bounty_id: '7',
      deadline: '1000',
    });
    expect(normalized.raw).toBe(event);

    // The worker persists events with JSON.stringify, so BigInt values from
    // scValToNative must not leak into the normalized record.
    expect(() => JSON.stringify(normalized)).not.toThrow();
  });

  it('keeps the lifecycle action and payload for other contract events', () => {
    const event = bountyEvent('Create', { bounty_id: 3, amount: 500 });

    const normalized = normalizeEvent(event);

    expect(normalized.type).toBe('create');
    expect(normalized.bountyId).toBe(3);
    expect(normalized.payload).toMatchObject({
      bounty_id: '3',
      amount: '500',
    });
  });

  it('falls back to the raw event shape when topics and value are absent', () => {
    const event = {
      id: 'legacy-1',
      type: 'reserve',
      bounty_id: 42,
      actor: 'GACTOR',
      timestamp: '2026-10-20T00:00:00Z',
    };

    expect(normalizeEvent(event)).toMatchObject({
      id: 'legacy-1',
      type: 'reserve',
      bountyId: 42,
      actor: 'GACTOR',
      timestamp: '2026-10-20T00:00:00Z',
    });
  });
});
