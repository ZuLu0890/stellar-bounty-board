import { describe, it, expect } from 'vitest';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
// @ts-expect-error — plain JS worker module, no type declarations
import { decodeScVal, normalizeEvent } from '../worker/eventNormalizer.js';

// Valid StrKeys are enough for the decoder: they are never used to sign.
const MAINTAINER = Keypair.random().publicKey();
const CONTRIBUTOR = Keypair.random().publicKey();

const base64 = (value: xdr.ScVal) => value.toXDR('base64');
const symbol = (value: string) => base64(xdr.ScVal.scvSymbol(value));

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
    )
  );
}

/** The contract encodes a unit enum variant as a one-element vector. */
const unitEnum = (variant: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);

function queriedEvent(overrides: Record<string, xdr.ScVal> = {}) {
  return {
    id: '0000000042-0000000001',
    type: 'contract',
    ledgerCloseTime: '2026-10-22T10:00:00Z',
    topic: [symbol('Bounty'), symbol('Queried')],
    value: base64(
      struct({
        bounty_id: nativeToScVal(42n, { type: 'u64' }),
        maintainer: nativeToScVal(MAINTAINER, { type: 'address' }),
        contributor: nativeToScVal(CONTRIBUTOR, { type: 'address' }),
        token: nativeToScVal(MAINTAINER, { type: 'address' }),
        amount: nativeToScVal(500n, { type: 'i128' }),
        issue_number: nativeToScVal(7, { type: 'u32' }),
        status: unitEnum('Expired'),
        deadline: nativeToScVal(1_700_000_000n, { type: 'u64' }),
        protocol_fee_bps: nativeToScVal(250, { type: 'u32' }),
        dispute_raised_at: nativeToScVal(0n, { type: 'u64' }),
        ...overrides,
      })
    ),
  };
}

describe('worker event normalization', () => {
  it('decodes base64 ScVal topics and payloads', () => {
    expect(decodeScVal(symbol('Bounty'))).toBe('Bounty');
    expect(decodeScVal('not-base64')).toBe('not-base64');
    expect(decodeScVal(undefined)).toBeUndefined();
  });

  it('consumes the Bounty/Queried event without a follow-up contract read', () => {
    const record = normalizeEvent(queriedEvent());

    expect(record.type).toBe('queried');
    expect(record.bountyId).toBe(42);
    expect(record.actor).toBe(CONTRIBUTOR);
    expect(record.status).toBe('Expired');
    expect(record.deadline).toBe(1_700_000_000);
    expect(record.amount).toBe(500);
    expect(record.timestamp).toBe('2026-10-22T10:00:00Z');
    // The full mutable projection is available to update the index.
    expect(record.state).toMatchObject({
      bounty_id: '42',
      maintainer: MAINTAINER,
      contributor: CONTRIBUTOR,
      issue_number: 7,
      protocol_fee_bps: 250,
      dispute_raised_at: '0',
    });
    expect(record.state.status).toBe('Expired');
  });

  it('reports a quarantined bounty id as a string instead of losing precision', () => {
    const record = normalizeEvent(
      queriedEvent({
        bounty_id: nativeToScVal(9_007_199_254_740_993n, { type: 'u64' }),
      })
    );

    expect(record.bountyId).toBe('9007199254740993');
  });

  it('keeps lifecycle events readable and maps their short symbols to full names', () => {
    const record = normalizeEvent({
      id: 'evt-1',
      topic: [symbol('Bounty'), symbol('Refund')],
      value: base64(
        struct({
          bounty_id: nativeToScVal(1n, { type: 'u64' }),
          maintainer: nativeToScVal(MAINTAINER, { type: 'address' }),
          amount: nativeToScVal(500n, { type: 'i128' }),
        })
      ),
    });

    expect(record.type).toBe('refund');
    expect(record.bountyId).toBe(1);
    expect(record.actor).toBe(MAINTAINER);
    expect(record.amount).toBe(500);
    expect(record.payload).toEqual({
      bounty_id: '1',
      maintainer: MAINTAINER,
      amount: '500',
    });
    expect(record.status).toBeUndefined();
  });

  it('falls back to the RPC event type when topics are already native', () => {
    const record = normalizeEvent({
      id: 'evt-2',
      type: 'contract',
      topics: ['Bounty', 'Dispt'],
      value: { bounty_id: 3n, contributor: CONTRIBUTOR, arbiter: MAINTAINER },
    });

    expect(record.type).toBe('disputed');
    expect(record.bountyId).toBe(3);
    expect(record.actor).toBe(CONTRIBUTOR);
  });
});
