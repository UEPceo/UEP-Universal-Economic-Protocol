# Oracle layer (v0.5.2)

Status: **IMPLEMENTED (testnet reference)**. Verifiable economic evidence for
**policy evaluation only** (SVC SLA, IoT tariff, dispute evidence, AMM/swap
price checks). The oracle never moves funds and is never queried on the spend
or consensus path.

- Commitments use the repository Poseidon BN254 (`src/core/poseidon.ts`). The
  incoming homemade permutation that claimed to be Poseidon was removed.
- Heights for staleness and future drift (ADR 0002). Synchronous Ed25519 via
  `src/core/ed25519.ts`. Strict public-key equality against the registry.
- A `SettlementAuthorization` is a single-use voucher for a guard to consume;
  the oracle itself does not settle.

Residual limits: configured source keys only (no on-network oracle consensus);
in-process; policy helpers are pure evaluation.
