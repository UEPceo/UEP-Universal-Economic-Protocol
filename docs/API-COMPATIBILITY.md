# API compatibility (Phase 3)

The local HTTP API is versioned by the `x-uep-api` response header. A minor release may add a route. It does not remove one, and it does not change the meaning of a signed action. Fees stay 0.1 % protocol and 3 % Marketplace. Ledger snapshot format 10 is not an API field.

A client that only uses `sdk/client`, `sdk/marketplace` and `sdk/iot-m2m` is the supported surface. Importing `src/marketplace` is not.

The worked example is `examples/sample-service.ts`. `npm run example:service` runs it against a local API.

Developer CLI: `npm run cli -- height --url http://127.0.0.1:8787`. It does not import the ledger.

Bridge: `GET /v1/bridge/info`, `POST /v1/bridge/deposit` (client-signed spend), `POST /v1/bridge/withdraw` (buyer signature). The node credits only what custody received. An admin credit is still the testnet rail, not the backed path.
