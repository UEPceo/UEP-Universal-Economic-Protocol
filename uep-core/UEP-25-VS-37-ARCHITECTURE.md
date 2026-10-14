# UEP-25 vs UEP-37 — economic paths (lab)

| | UEP-25 path | UEP-37 path |
|--|-------------|-------------|
| State | historical wallet/ledger | `SmtEconomicState` + `MultiNodeCluster` |
| ECON-01/02/03 | no | yes (experimental) |
| Future canonical path | **canonical for Phase 4 (ADR 0005)** | lab only; not imported by the node |
| Legacy | keep until migrated | do not duplicate features in 25 |

Rule: do not evolve two incompatible economies. ADR 0005 makes UEP-25 the canonical state. UEP-37 stays a lab and is not a migration target until a later ADR.

Note: both are lab paths. The public testnet rules live in `src/core` and
`src/testnet` (see `docs/LABS.md`).
