# UEP-ECON-03 — Escrow / hold del cliente (lab)

## Justificación (directiva)

1. **Problema:** en ECON-02 el cliente podía aceptar varias obligaciones sobre el mismo saldo.
2. **Autonomía:** proveedores confían en que el pago está *reservado* hasta entrega o cancel.
3. **Sanidad:** hold = price+fee; settlement sigue ECON-01 (conservación + treasury).
4. **Relación real:** obliga capacidad económica antes del servicio.
5. **¿Ahora?** Sí — cierra el hueco de over-commit tras ECON-02.
6. **Complejidad:** `EscrowBook` lab; **sin** BFT/ZK/Poseidon; sin token.

## Flujo

```
acceptWithEscrow
  → canHold(available >= price+fee)
  → Obligation OPEN + Hold HELD

submitDelivery → planSettlement → BatchTx multinodo
  → completeSettlement → Hold CONSUMED + SETTLED

cancel OPEN → Hold RELEASED
DISPUTED → releaseDisputed → Hold RELEASED (lab; sin refund TX automático)
```

## available

`available(client) = chain.balance(client) - Σ holds HELD`

## Tests

`test:econ-03` → 7/7 PASS · regresión ECON-01/02 12/12 PASS

## Limitaciones

- Hold **no** mueve fondos on-chain (no cuenta escrow en SMT); es reserva lógica sobre vista de saldo.
- Escrow on-chain (leaf dedicada) = futura ECON-04 si se prioriza.
- Fee policy sigue experimental.
