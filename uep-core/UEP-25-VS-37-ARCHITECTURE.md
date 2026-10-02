# UEP-25 vs UEP-37 — caminos económicos

| | UEP-25 path | UEP-37 path |
|--|-------------|-------------|
| Estado | wallet/ledger histórico | `SmtEconomicState` + MultiNodeCluster |
| ECON-01/02/03 | no | sí (experimental) |
| Canónico futuro | migrar hacia 37 | **camino experimental actual** |
| Legacy | mantener hasta migración | no duplicar features en 25 |

Regla: no evolucionar dos economías incompatibles. Nuevas features económicas van a 37 + ECON-*.
