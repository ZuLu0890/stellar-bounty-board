// Normalizes Soroban RPC contract events into backend-friendly records.
//
// The RPC `getEvents` endpoint returns every event topic and payload as a
// base64-encoded `ScVal`, which means the `("Bounty", "<action>")` topic pair
// is not readable until it is decoded. The decoder lives here, separate from
// `indexer.js`, so it can be unit tested without starting the polling worker.
//
// While `get_bounty` is a read, it is the only read path that applies lazy
// expiration: an Open/Reserved bounty whose deadline has passed is reported as
// Expired without being written back. The contract now publishes
// `("Bounty", "Queried")` with the full mutable projection of the bounty, so
// this module maps that event to `type: "queried"` and copies `status`,
// `deadline` and `state` onto the record. An indexer can therefore move a
// bounty to Expired from the event alone, without scanning every bounty on a
// timer or issuing a follow-up contract read.
//
// Every other lifecycle event keeps its action-derived type and exposes its
// decoded struct under `payload`.

import { scValToNative, xdr } from "@stellar/stellar-sdk";

export const BOUNTY_EVENT_DOMAIN = "Bounty";
export const QUERIED_EVENT_ACTION = "Queried";

// The contract uses seven-character symbols to stay within `symbol_short!`.
// These are the names consumers should see in `type`.
const ACTION_TYPES = Object.freeze({
  Create: "create",
  Reserv: "reserve",
  Reassign: "reassign",
  Submit: "submit",
  Releas: "release",
  Refund: "refund",
  Cancel: "cancel",
  Extnd: "extend_deadline",
  Dispt: "disputed",
  Reslv: "resolved",
  Queried: "queried",
});

/**
 * Decode a base64 `ScVal` into a native value.
 *
 * Values that are already decoded (or fixtures that are not valid XDR) are
 * returned unchanged, so this is safe to apply to both RPC events and tests.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function decodeScVal(value) {
  if (typeof value !== "string") return value;
  try {
    return scValToNative(xdr.ScVal.fromXDR(value, "base64"));
  } catch {
    return value;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

/**
 * A unit enum variant is encoded as a single-element vector, so
 * `scValToNative` yields `["Expired"]` rather than `"Expired"`.
 */
function normalizeStatus(status) {
  if (Array.isArray(status) && status.length === 1) return status[0];
  return status;
}

/**
 * `scValToNative` returns BigInt for u64/i128 values, which `JSON.stringify`
 * (used when the worker persists events) cannot serialize.
 */
function toJsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)]));
  }
  return value;
}

function toSafeNumber(value) {
  if (typeof value !== "bigint") return value;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function eventTopics(event) {
  const raw = Array.isArray(event?.topic) ? event.topic : Array.isArray(event?.topics) ? event.topics : [];
  return raw.map(decodeScVal);
}

function toPlainObject(decoded) {
  // Depending on the SDK version, a Soroban struct decodes either to a plain
  // object or to a Map with symbol keys.
  if (decoded instanceof Map) return Object.fromEntries(decoded.entries());
  if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) return decoded;
  return {};
}

function eventPayload(event) {
  return toPlainObject(decodeScVal(event?.value ?? event?.data ?? event));
}

/**
 * Map a Soroban RPC event to the record the backend persists.
 *
 * @param {Record<string, any>} event An event as returned by the RPC endpoint.
 * @returns {Record<string, any>}
 */
export function normalizeEvent(event) {
  const [domain, action] = eventTopics(event);
  const payload = eventPayload(event);
  const hasPayload = Object.keys(payload).length > 0;

  const normalized = {
    id: event?.id ?? event?.paging_token ?? event?.pagingToken,
    type: ACTION_TYPES[action] ?? (typeof action === "string" ? action.toLowerCase() : event?.type),
    bountyId: toSafeNumber(firstDefined(payload.bounty_id, event?.bounty_id)),
    actor: firstDefined(
      payload.contributor,
      payload.maintainer,
      payload.arbiter,
      event?.actor,
    ),
    timestamp: firstDefined(event?.ledgerCloseTime, event?.ledger_closed_at, event?.ledgerClosedAt, event?.timestamp),
    raw: event,
  };

  if (domain === BOUNTY_EVENT_DOMAIN && action === QUERIED_EVENT_ACTION) {
    // `get_bounty` published the post-lazy-expiration state, so the record is
    // complete without a follow-up contract read. The state keeps the whole
    // projection, with the unit-variant status flattened for consumers.
    const state = toJsonSafe(payload);
    state.status = normalizeStatus(state.status);
    normalized.type = "queried";
    normalized.status = state.status;
    normalized.deadline = toSafeNumber(payload.deadline);
    normalized.state = state;
  } else if (hasPayload) {
    normalized.payload = toJsonSafe(payload);
  }

  if (payload.amount !== undefined) {
    normalized.amount = toSafeNumber(payload.amount);
  }

  return normalized;
}
