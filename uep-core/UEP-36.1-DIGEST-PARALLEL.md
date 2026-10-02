# UEP-36.1 / 36.1.1 — Digest aggregation + parallel-safe scheduling

See **UEP-36.1.1-DIGEST-PARALLEL-HARDENING.md** for the authoritative semantics after hardening.

## DEMONSTRATED
- digest-only aggregate
- deterministic aggregate (canonical encoding)
- conflict-free wave **scheduling** (sequential apply of waves)
- process multi-leader
- state convergence

## NOT YET
- true concurrent execution
- aggregate wired into CommitCert
- production BFT
- Poseidon/SMT execution
- global-scale throughput
