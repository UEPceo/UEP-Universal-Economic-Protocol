# UEP-35.0 — Finality model

## Definition

A transition is **FINAL** when a `FinalityCertificate` is accepted by a node:

1. Underlying `CommitCert` verifies (quorum ≥ 2f+1 on classic profile).
2. Certificate fields bind sequence, stateRoot, proposalDigest.
3. No prior FINAL exists at that sequence with a different digest (`DOUBLE_FINALITY`).

Stages: `none → proposed → committed → final`.

## Explicit non-claims

Not production async BFT under arbitrary WAN partitions without dissemination layer.
