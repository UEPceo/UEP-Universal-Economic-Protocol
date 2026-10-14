# Disposición de la auditoría externa (texto recibido 2026-10-09)

El texto íntegro está en `AUDIT-EXTERNA-2026-10-09.md`. Esta nota dice qué de ese texto está en este árbol y qué no se adopta. Fees 0,1 % de protocolo y 3 % de Marketplace. Snapshot 10. Estado canónico UEP-25.

## Qué se acepta

- El ancla de recibos ya agrupa como máximo 4.096 recibos (`MAX_RECEIPTS_PER_ANCHOR` en `src/settlement/anchor.ts`). Una raíz RFC 9162 no sustituye al SMT de profundidad 254. El informe lo dice y el código ya está así.
- No se anuncia un TPS de consenso. El lote de recibos y el SMT son medidas distintas. `src/settlement/batch.ts` ya lo advierte: el tiempo de pared no es una transición.
- Las suites citadas de settlement, oracle y categoría son las de `src/`. Sus números de la 0.5.3 no se reescriben como si fueran de esta versión.

## Qué no está en este árbol

- No hay `uep-settlement/`, `treasury-policy.ts`, `reference-ledger.ts` ni `UepLedgerBridge`. El puente de este repositorio es `src/settlement/value-bridge.ts`.
- No hay un split 40/25/20/15 que retirar. No se introduce.
- No hay `timeoutRefund` con mutex ni los 30 tests de `uep-settlement/tests`. No se fabrican para coincidir con el informe.
- La tabla de 20k–500k es una medición del informe. Este repositorio no la copia como resultado propio de la 0.5.12.

## Recomendaciones

- Workers para Ed25519: fuera de la transición. No entran en el ledger.
- Buffers fijos de recibo: el lote ya hashea el `receiptHash`. No se cambia el formato.
- Tope 4.096: ya vigente.
- Ventana que olvida nonces: no se adopta. Olvidar un nonce reabre el replay. El rechazo de nonce repetido se queda.

## Fase 2

El 2.1 cubre ya el pedido y la telemetría IoT: un evento por transición, repetición sin duplicado. Sigue abierto el 2.2 de almacenamiento y el 2.3 de evidencia.
