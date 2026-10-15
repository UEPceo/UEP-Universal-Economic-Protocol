# ADR 0008 — Vote-format activation, height-based round timeout, peer envelope v2, height floor (0.5.81)

Status: accepted for 0.5.81 (experimental BFT lab and reference node). Not a claim about a deployed network.

## Context

Findings 2, 3, 4 and 9 on v0.5.80 asked for votes bound to epoch, validator set and proposal; a way to close a height left open by a faulty proposer; no rollback outside BFT mode; and transport messages bound to network, epoch and height with replay protection and verifiable key changes. The standing rule is that compatibility must not break without a migration path.

## Decisions

1. **Vote format by height.** The kernel takes `voteV3ActivationHeight`. Below it, votes, certificates and round changes are the 0.5.80 bytes; from it on, only v3. Heights, not time or versions negotiated on the wire, decide the format, so every honest validator makes the same choice. Mixed-version operation is supported only below the activation height. The v3 signing tag is `uep-bft-vote-v3`, separate from v2.
2. **Round timeout in producer heights.** `timeout(round) = base * 2^min(round, maxDoublings)` producer ticks (default base 4, cap 8 doublings). A timed-out validator signs a round change; f + 1 round changes for a higher round make it join. The next leader must carry the round-change certificate and any block it forces (existing kernel rule). No wall clock.
3. **Peer envelope v2.** Signature over canonical `{v, networkId, domainId, epoch, from, path, height, nonce, payloadHash}`. Receivers refuse other networks/domains/epochs, envelopes more than 64 heights old, and repeated `(from, nonce)`. v1 stays accepted (deprecated, warned) until a configured height, for 0.5.80 peers.
4. **Key rotation/revocation.** A rotation needs the old key and `threshold` other validators; a revocation needs `threshold` other validators. Both take effect at a future height and carry a per-peer sequence number.
5. **Height floor.** Outside BFT mode the node keeps its own highest persisted `{height, stateRoot}` and refuses to run below it, except with an explicit, logged operator override.

## Consequences

- Upgrading a 0.5.80 cluster is a coordinated, height-based activation, documented in COMPATIBILITY.md.
- Round-change liveness depends on the runner feeding producer ticks (`bftTick`).
- Replay memory is in-process; the 64-height window bounds what a restart forgets.
- No external dependencies, no native currency, fees unchanged.
