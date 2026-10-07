# Category modules (v0.5.2, hardened in v0.5.3)

Status: **IMPLEMENTED (testnet reference)**. Swap, relay, dispute and drip over
Marketplace HOLDs. Not a production DEX, messaging network or arbitration service.

| Module | Role |
| --- | --- |
| `swap` | Bilateral cross-asset hashlock settlement (SHA-256 hashlock, not Poseidon) |
| `relay` | Chunk fraud proofs; ChaCha20 under HKDF; custody 20 % / delivery 80 % |
| `dispute` | k-of-n arbiter quorum; bonds; applies verdicts via `DisputeCap` |
| `drip` | Subsidy claims bound to the settlement index (swap/relay only) |

Funds move only through a once-issued `CategoryEscrowPort` / `SubsidyPort` from
the Marketplace. Identities and signatures are Marketplace `ActorAuth`. Heights
from the Marketplace clock. One fee path (Marketplace fee on the provider part
via the settlement engine).

## v0.5.3 changes

| Change | Finding | Code | Tests |
|---|---|---|---|
| A relay dispute that times out after `KEY_RELEASED` **resumes** the order (fraud window extended by the frozen time, then `finalize`) instead of refunding 80 % to the buyer | V52-01 | `relay.ts timeoutOutcome`, `dispute.ts timeout` | `category-hardening.test.ts` (V52-01 ×2) |
| A wrong key (`KEY_RELEASE_FAULT`) or no key by the deadline pays `faultBondSlashBps` (default 20 %) of the provider bond to the buyer | V52-02 | `relay.ts slashForFault` | V52-02 ×2 |
| A dispute timeout pays `timeoutBondToRespondentBps` (default 20 %) of the claimant's bond to the respondent (freeze compensation); 0 restores v0.5.2 | V52-03 (mitigation) | `dispute.ts timeout` | V52-03 |
| Per-asset dispute bond floor `minBondByAsset` (falls back to `minBond`) | — | `dispute.ts minBondFor` | per-asset bond minimum |
| Swap prices can be checked against the oracle gate when the buyer signs an `oracleBand` | V52-04 follow-up | `swap.ts` | `oracle-wiring.test.ts`, `oracle-liveness.test.ts` |
| **Maximum freeze duration** `MAX_FREEZE_HEIGHTS` (241,920 heights, 14 days at 5 s): an older freeze lapses and the order's own refund / timeout path opens (swap `expire`, relay `expire` / `finalize`, `lapseFreeze()`); a relay frozen over its key deadline is refunded without a provider fault; the fraud window gets back at most the cap; a late dispute timeout only settles the bond; `evidenceHeights + resolutionHeights` must stay below the cap | — | `disputable.ts`, `swap.ts`, `relay.ts`, `dispute.ts` | `freeze-cap.test.ts` |

Ported module tests (relay fraud / slashing, dispute quorum, swap and drip
negatives, deterministic fuzz with conservation and wind-down liveness) are in
`src/category/category-hardening.test.ts`.

The **hashlock swap** (this module) is a bilateral SHA-256 hashlock settlement between
two identities. It is not the **AMM lab pool** in `uep-zk` labs, which is a research
prototype and never moves testnet ledger value.

## Residual limits (honest list)

- **Commitments stay SHA-256** (hashlock, relay chunk tree, ids). Moving them to
  Poseidon was evaluated for v0.5.3 and not done: the hashlock must stay SHA-256 to
  remain compatible with standard HTLC preimages, and the relay chunk tree commits to
  raw 1 KiB chunks, where SHA-256 is the natural fit and nothing on the ZK path consumes
  it yet. A Poseidon variant would need a versioned commitment field plus a migration;
  it is deferred until a circuit actually needs it.
- **Arbiters**: fixed k-of-n set chosen at construction; no appeal, no arbiter stake or
  slashing, no rotation. A colluding quorum can decide any case within the escrow.
- **Sybil**: identities are cheap; reputation counters (`providerCounters`,
  `adverseCount`) are informative only and are not Sybil-resistant.
- **Liveness**: a dispute still freezes the order for up to evidence + resolution
  heights (~7 days); v0.5.3 only makes the freeze cost something on timeout.
- **IoT attestation**: device readings are signed by the device key only; there is no
  hardware attestation (TPM / secure element) and no remote-attestation chain.
- **Encryption**: relay uses ChaCha20 under an HKDF key with a published key after
  payment; there is no HPKE / recipient-key encryption, so the content is readable by
  anyone who sees the published key.
- Capabilities are in-process objects (not a security boundary between processes).
- The drip budget is an administrator-signed allowance on `DISTRIBUTABLE_PROFIT`.
