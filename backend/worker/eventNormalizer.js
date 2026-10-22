// Decode Soroban's XDR topics and value before passing events to consumers.
// Maps the contract's short event symbols to stable backend type strings.
// https://github.com/ritik4ever/stellar-bounty-board/issues/1253

// Topic symbol -> backend type mapping
const EVENT_TYPE_MAP = {
  // Bounty event symbols (short 4-char)
  Create: "create",
  Reserv: "reserve",
  Submit: "submit",
  Releas: "release",
  Refund: "refund",
  Dispt: "disputed",

  // New: Queried event from get_bounty
  Queried: "queried",
};

// Decode a single ScVal from base64 XDR to a JS value
function decodeScVal(value) {
  if (typeof value !== "string") return value;
  // Use @stellar/stellar-sdk to decode base64 ScVal
  // If not available, fall back to raw string
  try {
    const { ScVal, xdr } = require("@stellar/stellar-sdk");
    return ScVal.fromXDR(value, "base64");
  } catch (e) {
    return value;
  }
}

// Decode the topics array (topic[0] = event symbol, topic[1] = sub-symbol)
function decodeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  return topics.map(decodeScVal);
}

// Decode the event value/payload
function decodeValue(value) {
  if (typeof value !== "string") return value;
  try {
    const { ScVal, xdr } = require("@stellar/stellar-sdk");
    return ScVal.fromXDR(value, "base64");
  } catch (e) {
    return value;
  }
}

// Decode event data (value field) into a plain object
function eventData(value) {
  const decoded = decodeValue(value);
  if (decoded instanceof Map) {
    return Object.fromEntries(decoded.entries());
  }
  return decoded && typeof decoded === "object" ? decoded : {};
}

// Map a short event symbol to a stable backend type string
function mapEventType(topic1) {
  const short = topic1 && typeof topic1 === "string" ? topic1 : "";
  return EVENT_TYPE_MAP[short] || (short || "unknown");
}

// Map the Queried event payload to backend state
function mapQueriedPayload(payload) {
  if (!payload) return null;

  // Extract fields from the decoded BountyQueried payload
  const status = payload.status || payload.bountyStatus || "open";
  const deadline = payload.deadline || payload.bountyDeadline || 0;
  const state = {
    bountyId: payload.bounty_id || payload.bountyId,
    maintainer: payload.maintainer || payload.maintainerAddress,
    contributor: payload.contributor || payload.contributorAddress,
    token: payload.token || payload.tokenAddress,
    amount: payload.amount || 0,
    issueNumber: payload.issue_number || payload.issueNumber,
    protocolFeeBps: payload.protocol_fee_bps || payload.protocolFeeBps,
    disputeRaisedAt: payload.dispute_raised_at || payload.disputeRaisedAt,
  };

  return { status, deadline, state };
}

// Normalize a Soroban contract event into a plain JS object
// suitable for the backend API and indexer consumption.
export function normalizeEvent(event) {
  const topics = Array.isArray(event.topic)
    ? event.topic.map(decodeScVal)
    : Array.isArray(event.topics)
      ? event.topics.map(decodeScVal)
      : [];

  const data = eventData(event.value ?? event.data ?? event);

  // Determine the event type from the second topic symbol
  const type = mapEventType(topics[1]);

  // Special handling: Queried events carry the full bounty state
  let normalized = {
    id: event.id ?? event.paging_token ?? event.pagingToken,
    type,
    bountyId: data.bounty_id || data.bountyId || null,
    maintainer: data.maintainer || data.maintainerAddress || null,
    contributor: data.contributor || data.contributorAddress || null,
    arbiter: data.arbiter || data.arbiterAddress || null,
    amount: data.amount !== undefined ? Number(data.amount) || 0 : 0,
    timestamp: event.ledger_closed_at ?? event.ledgerClosedAt ?? event.timestamp,
    raw: event,
  };

  // If this is a Queried event, also surface status/deadline/state for indexer use
  if (type === "queried") {
    const queriedState = mapQueriedPayload(data);
    if (queriedState) {
      normalized.status = queriedState.status;
      normalized.deadline = queriedState.deadline;
      normalized.state = queriedState.state;
    }
  }

  // For the release transition, surface released flag
  if (type === "release") {
    normalized.released = true;
  }

  return normalized;
}

// Batch-normalize multiple events
export function normalizeEvents(events) {
  return events.map(normalizeEvent);
}

export { mapEventType, mapQueriedPayload };