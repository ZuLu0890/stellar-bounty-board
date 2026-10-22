# Soroban Contract Event Indexer Worker

This worker polls Soroban contract events and normalizes them for backend use. It is isolated from the main API server and can be run as a separate process.

## How It Works

- Polls the Soroban RPC endpoint for contract events (create, reserve, submit, release, refund, dispute, and the `get_bounty` queried state event)
- Decodes the base64 `ScVal` topics and payloads returned by RPC into native values
- Normalizes events into backend-friendly records
- Appends new events to a local file (`indexed-events.json`) for demonstration (replace with DB logic as needed)
- Handles errors gracefully so failures do not affect the main API server

## Bounty state updates (`Bounty` / `Queried`)

`get_bounty` is the only read path that applies lazy expiration: an `Open` or
`Reserved` bounty whose deadline has passed is reported as `Expired` without
being written back to storage. The contract now publishes
`("Bounty", "Queried")` with the full mutable projection of the bounty
(id, maintainer, contributor, token, amount, issue number, status, deadline,
fee bps, dispute timestamp).

`eventNormalizer.js` maps that event to `type: "queried"` and copies `status`,
`deadline` and `state` onto the normalized record, so an indexed bounty can be
moved to `Expired` from the event alone — no scan of every bounty and no
follow-up contract read. Other lifecycle events keep their action-derived
`type` (`create`, `reserve`, `submit`, ...) and expose the decoded payload under
`payload`.

## Usage

1. Set environment variables:
   - `SOROBAN_CONTRACT_ID` (required): The contract ID to index
   - `SOROBAN_RPC_URL` (optional): Soroban RPC endpoint (default: `https://rpc-futurenet.stellar.org`)
   - `SOROBAN_POLL_INTERVAL` (optional): seconds between polls (default: `10`)
   - `SOROBAN_INDEXER_MAX_RETRIES` (optional): attempts per poll before giving up until the next poll; whole number >= 1 (default: `5`)
   - `SOROBAN_INDEXER_INITIAL_BACKOFF_MS` (optional): delay before the first retry in milliseconds, doubling on each further attempt (default: `1000`)

   Invalid values (non-numeric, zero, negative) fall back to the default rather than failing. The effective values are logged once at startup (`[Indexer] Effective config: ...`).

2. Run the worker:

```bash
cd backend/worker
node indexer.js
```

## Architecture

- The worker is completely isolated from the main API server.
- It can be run as a background process or managed by a process manager (e.g., PM2, systemd).
- Events are normalized in `eventNormalizer.js` (pure and unit tested) and stored for backend consumption.
- Extend the normalization logic as the contract evolves.

## Extending

- Replace file storage with a database for production use.
- Add more robust error handling and alerting as needed.
- Integrate with backend API or event consumers if required.

---

For questions, see the main [README.md](../README.md) or open an issue.
