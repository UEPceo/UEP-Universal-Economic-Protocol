# ADR 0005 — Canonical economic state is UEP-25

Status: accepted (0.5.10). Decided before any Phase 4 consensus work.

## Context

Two trees exist. `UepLedger` (UEP-25, depth 254, snapshot format 10) holds the notes, nullifiers, fees and anchors that versions 0.5.x actually run. `SmtEconomicState` (UEP-37, depth 32) is a laboratory cluster. `uep-core/UEP-25-VS-37-ARCHITECTURE.md` used to call 37 the future path. Consensus labs import core only. One test mixes a lab with the testnet. Phase 4 needs one state.

## Decision

UEP-25 is the canonical economic state. The node, the HTTP service, the Marketplace bridge and any future consensus adapter import `UepLedger`. They do not import `SmtEconomicState`.

UEP-37 stays a lab. It is not a second economy and it is not a migration target until a later ADR shows it can host the same notes, nullifiers, fee rule and snapshot format 10. Until that ADR, new economic behavior goes to the 25 path.

## Consequences

- Depth 32 is not the public state.
- A consensus experiment that needs balances reads the 25 ledger, or it stays in the lab and does not settle.
- Receipt anchors are ledger state. Marketplace balances become ledger notes only through `src/settlement/value-bridge.ts`.
