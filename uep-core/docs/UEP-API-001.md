# UEP-API-001 — Universal Service Interface

**Version:** 1.0.0  
**Layer:** UEP SERVICE (outside CORE)

## Principles
- External providers are never required for consensus.
- Versioned request/response with `requestId`, errors, idempotency hooks.
- No economic API token in v36.2.

## Request meta
`requestId`, `apiVersion`, `idempotencyKey?`, `timestamp`, `authTokenPresent?`, `callerId?`

## Error model
`UepApiError` codes: INVALID_REQUEST, VERSION_MISMATCH, NOT_FOUND, CONTENT_INTEGRITY_ERROR, PROVIDER_UNAVAILABLE, …

## Capabilities
`getCapabilities()` — only advertises implemented services (`storage: true`; compute/relay/oracle: false).

## API-001.1
Local HTTP adapter: /v1/capabilities /v1/health /v1/objects /v1/economic/tip /v1/economic/accounts/:id. Read model only. Not consensus.

## API-001.2
Spend submit queues. Compute, relay and oracle are lab backends. None finalize. A quote does not settle.

## API-001.3
POST /v1/spends queues. POST /v1/spends/prove drains the queue through Groth16. Local apply matches the proof. final stays false until quorum.

## API-001.4
Spend commit requires 3 of 4 Ed25519 votes over spendId|newRoot|proofHash. Two votes stay unfinal. A vote over another root is rejected.
