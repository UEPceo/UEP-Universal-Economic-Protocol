# UEP-ECON-01 — Economically meaningful transaction (lab)

## Justificación (directiva permanente)

1. **Problema:** tras 37.x tenemos roots/consenso; faltaba demostrar que una TX finalizada mueve valor, cobra fee y acredita treasury de forma legible.
2. **Autonomía:** el fee protocolario es el embrión de sostenibilidad de infra (sin token nativo).
3. **Sanidad económica:** conservación `sum(accounts)+treasury` invariante; fee = `floor(amount/1000)`.
4. **Relación con TX real:** propose → finalize multinodo → balances + treasury + stateRoot.
5. **¿Ahora?** Sí — reequilibra tras el tramo de consenso 37.7.x.
6. **Complejidad:** reutiliza `creatorFee`, `SmtEconomicState`, `MultiNodeCluster`; sin token, sin BFT nuevo.

## Definición

Una TX es **economicallyMeaningful** si:

- `fee = creatorFee(amount) > 0` (amount ≥ 1000 bajo política actual);
- conservación de supply rastreada;
- débito sender = amount+fee; crédito recipient = amount; Δtreasury = fee;
- `stateRoot` cambia tras finality en nodos honestos.

## Receipt

`EconomicReceipt` (`uep-econ-01.ts`): before/after snapshot, fee, deltas, flags.

## Tests

`test:econ-01` → 5/5 PASS

| Caso | Resultado |
|------|-----------|
| Fee policy 1000/999 | PASS |
| Structural 5000 → treasury 5, conserve | PASS |
| Poseidon-zk 2000 → meaningful | PASS |
| Dust fee=0 → valid but not meaningful | PASS |
| Insufficient → null propose | PASS |

## No es

- Settlement de servicio externo verificable
- Remuneración de provers/relayers
- Token nativo
- Economía interplanetaria

Siguiente cadena: **ECON-02 service settlement stub** (cuando se priorice).
