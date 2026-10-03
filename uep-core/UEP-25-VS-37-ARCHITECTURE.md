# UEP-25 vs UEP-37 — economic paths (lab)

| | UEP-25 path | UEP-37 path |
|--|-------------|-------------|
| State | historical wallet/ledger | `SmtEconomicState` + `MultiNodeCluster` |
| ECON-01/02/03 | no | yes (experimental) |
| Future canonical path | migrate towards 37 | **current experimental path** |
| Legacy | keep until migrated | do not duplicate features in 25 |

Rule: do not evolve two incompatible economies. New economic lab features go to
the 37 path and the ECON-* labs.

Note: both are lab paths. The public testnet rules live in `src/core` and
`src/testnet` (see `docs/LABS.md`).
