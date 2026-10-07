# Testnet reference ledger (`src/testnet`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.3.0 |
| Tests | npm run test:protocol, npm run check:snapshot-compat, npm run smoke:testnet, npm run quickstart |
| Depends on | core, identity, network, settlement (pure anchor checks) |

## Purpose

Local, single-node, in-process ledger: balances per asset, signed spends, nullifier set, protocol fee (0.1 %, per-asset floor) to the protocol treasury, signed snapshots with a migration chain (format 8). v0.5.3: optional signed asset registry (unknown or deprecated assets refused, registry hash in the snapshot), settlement anchors and multi-input transactions.

## Notes

- Snapshot format changes need a migration step and golden fixtures (`docs/COMPATIBILITY.md`).
- Not a network: one process is the time authority (`docs/THREAT-MODEL.md`).

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
