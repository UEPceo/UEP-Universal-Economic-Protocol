# UEP-ECON-02 — Service settlement (lab)

## Justificación (directiva)

1. **Problema:** ECON-01 mueve valor; falta ligar el pago a *algo que ocurre* (servicio).
2. **Autonomía:** proveedores pueden ofrecer trabajo y cobrar vía estado económico UEP.
3. **Sanidad:** settlement = BatchTx ECON-01 (fee + treasury + conservación); sin token.
4. **Relación real:** obligación → entrega verificable → pago finalizado en multinodo.
5. **¿Ahora?** Sí — siguiente eslabón de la brújula tras ECON-01.
6. **Complejidad:** registro lab + TX existente; **sin** BFT/ZK/Poseidon.

## Flujo

```
Proveedor registra Offer (precio, expectedResultDigest)
        ↓
Cliente accept → Obligation OPEN
        ↓
Proveedor submitDelivery(resultDigest)
        ↓
planSettlement: digest match → BatchTx client→provider
        ↓
MultiNodeCluster propose/finalize (ECON-01)
        ↓
markSettled
```

## Verificación (lab)

`resultDigest === expectedResultDigest` (SHA-256 del payload acordado).

Producción futura: oráculos, ZK attestations, etc. — **no** en ECON-02.

## Rechazos

| Caso | reason |
|------|--------|
| Sin entrega | NOT_DELIVERED |
| Digest incorrecto | DIGEST_MISMATCH → DISPUTED |
| No es el provider | NOT_PROVIDER |
| Doble settle | ALREADY_SETTLED |
| Cancelada | CANCELLED |

## Fee

Misma política experimental ECON-01 (`floor(amount/1000)`). **No** es tokenomics definitiva.

## Tests

`test:econ-02` → 7/7 PASS (happy path, adversarial, multinode meaningful).

## No es

- Escrow on-chain / locking de fondos antes de entrega
- Consenso sobre el servicio
- Remuneración automática de provers/relayers de red
- Oracle de producción
