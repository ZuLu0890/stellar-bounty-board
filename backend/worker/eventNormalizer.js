// Normalizes Soroban RPC contract events into backend-friendly records.
//
// Kept separate from indexer.js so it can be unit tested without starting the
// polling worker. Soroban RPC returns topics and the event value as base64
// encoded `ScVal`; decoding them here means consumers no longer need a
// follow-up contract read to learn a bounty's state.

import { scValToNative, xdr } from '@stellar/stellar-sdk';

export const BOUNTY_EVENT_DOMAIN = 'Bounty';
export const QUERIED_EVENT_ACTION = 'Queried';

/**
 * Decodes a base64 `ScVal` into a native value. Values that are already
 * decoded (or cannot be decoded) are returned unchanged so this function is
 * safe to apply to both RPC events and fixtures.
 */
export function decodeScVal(value) {
  if (typeof value !== 'string') return value;
  try {
    return scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
  } catch {
    return value;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

/**
 * Unit variants of a contract enum are encoded as a single-element vector, so
 * `scValToNative` yields `["Expired"]` rather than `"Expired"`.
 */
function normalizeStatus(status) {
  if (Array.isArray(status) && status.length === 1) return status[0];
  return status;
}

/**
 * `scValToNative` returns BigInt for u64/i128 values, which `JSON.stringify`
 * (used by the worker's persistence step) cannot serialize. Keep ids and
 * deadlines as numbers while they are safe, and stringify the rest.
 */
function toJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)])
    );
  }
  return value;
}

function toSafeNumber(value) {
  if (typeof value !== 'bigint') return value;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

/**
 * Returns true when the event is the `("Bounty", "Queried")` event published by
 * `get_bounty`. `get_bounty` is the only read path that applies lazy
 * expiration, so this is the event the indexer uses to observe an
 * Open/Reserved -> Expired transition without polling every bounty.
 */
export function isBountyQueriedEvent(event) {
  const topics = Array.isArray(event?.topic) ? event.topic.map(decodeScVal) : [];
  return topics[0] === BOUNTY_EVENT_DOMAIN && topics[1] === QUERIED_EVENT_ACTION;
}

/**
 * Maps a Soroban RPC event to the shape the backend persists. Lifecycle events
 * carry a `("Bounty", "<action>")` topic pair and a struct payload.
 */
export function normalizeEvent(event) {
  const topics = Array.isArray(event.topic) ? event.topic.map(decodeScVal) : [];
  const [domain, action] = topics;
  const decodedPayload = decodeScVal(event.value);
  const payload = decodedPayload && typeof decodedPayload === 'object' ? decodedPayload : {};

  const normalized = {
    id: event.id,
    type: typeof action === 'string' ? action.toLowerCase() : event.type,
    bountyId: toSafeNumber(firstDefined(payload.bounty_id, event.bounty_id)),
    actor: firstDefined(payload.contributor, payload.maintainer, payload.arbiter, event.actor),
    timestamp: firstDefined(event.ledgerCloseTime, event.timestamp),
    raw: event,
  };

  if (domain === BOUNTY_EVENT_DOMAIN && action === QUERIED_EVENT_ACTION) {
    // `get_bounty` emits the post-lazy-expiration projection, so the indexer
    // can update its record from this event alone.
    normalized.type = 'queried';
    normalized.status = normalizeStatus(toJsonSafe(payload.status));
    normalized.deadline = toSafeNumber(payload.deadline);
    normalized.state = toJsonSafe(payload);
  } else if (Object.keys(payload).length > 0) {
    normalized.payload = toJsonSafe(payload);
  }

  return normalized;
}
