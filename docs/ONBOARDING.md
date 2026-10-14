# Onboarding — Phase 5 start

This is a public testnet harness, not production.

## Run the checks

Node.js 22.6 or newer.

```text
npm install
npm run test:consensus
```

## Run three nodes

`config/peers.json` is three addresses and a threshold of 2. Start each with its own data dir:

```text
UEP_PEERS=config/peers.json UEP_NODE_ID=node-0 UEP_DATA_DIR=/tmp/uep-0 npm start
UEP_PEERS=config/peers.json UEP_NODE_ID=node-1 UEP_DATA_DIR=/tmp/uep-1 npm start
UEP_PEERS=config/peers.json UEP_NODE_ID=node-2 UEP_DATA_DIR=/tmp/uep-2 npm start
```

Each line prints three public keys: `publicKeyHex` (voter), `snapshotPublicKeyHex` and `faucetPublicKeyHex`. Copy all three into `peers.json` on the matching id, then restart. Those pins are the trust model:

```text
{ "id": "node-1", "url": "http://127.0.0.1:8791",
  "publicKeyHex": "...", "snapshotPublicKeyHex": "...", "faucetPublicKeyHex": "..." }
```

Without the voter pin, a first `/status` can be learned once. Without the snapshot and faucet pins, a node that starts late does not catch up (`caughtUp=false`) and keeps its own ledger. The catch-up trusts the one peer that serves the snapshot, so pin only nodes you operate or trust.

A spend goes to `POST /propose` on a peer port. A spend sent to a node's own API (`UEP_PORT`) stays in that node's ledger and does not get a quorum.

Fees: protocol 0.1 %, Marketplace 3 %. Ledger snapshot format 10. No native token. The client supplies the note opening.

## Look without being a peer

`GET /txs` needs no signature. It returns the height, the root, the count and the last twenty transaction ids. It does not return note openings.


## Security notes for public nodes (Phase 5 start)

- Peer responses carry security headers (`nosniff`, `DENY`, `no-referrer`, `no-store`).
- Only GET/POST are accepted; POST requires `application/json`.
- Quorum state on disk is signed by the node voter key.


- The peer server (`PeerNet`) binds to `127.0.0.1` by default. To expose it, set a bind address carefully and put a reverse proxy or firewall in front.
- POST bodies to `/tx`, `/vote`, `/commit` and `/propose` are limited to 2 MiB. Larger requests are rejected with `PAYLOAD_TOO_LARGE` (413).
- A simple per-IP rate limit of 120 requests / 60 s applies. Excess returns `RATE_LIMITED` (429).
- Pin `publicKeyHex`, `snapshotPublicKeyHex` and `faucetPublicKeyHex` for every peer you trust. Without pins, catch-up does not trust a late node.
- `GET /txs` and `GET /status` are unauthenticated. Do not expose sensitive data through them.
- This remains a testnet harness. Do not use real value.


## Monitoring

`GET /status` returns version, uptime, peer count, threshold and rate-limit counters in addition to height and root. See `docs/BUG-BOUNTY.md` for the public reporting process.
