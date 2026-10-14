# Auditoría externa recibida (segunda nota, 2026-10-09)

El texto recibido describe de nuevo un motor `uep-settlement` con `treasury-policy.ts`, un split 40/25/20/15, `timeoutRefund` con mutex y `UepLedgerBridge`, y un SMT de profundidad 32 a ~180 actualizaciones por segundo.

## Disposición

Ese motor no está en este árbol. No se crea para coincidir con el informe. El SMT canónico es el de profundidad 254 (ADR 0005). El de profundidad 32 es laboratorio y no es el nodo.

Los hitos que el informe recomienda a continuación ya están en el árbol:

- 2.1 bus de eventos: pedido e IoT, id determinista, repetición sin duplicado (0.5.12 y 0.5.13).
- 2.3 evidencia: enunciado k-de-n, bytes fuera del estado (0.5.15).

El siguiente hueco del roadmap era el 2.5, no repetir esos dos. El tope de 4.096 recibos por ancla y los fees 0,1 % y 3 % no cambian. Las cifras de TPS del informe no se copian como resultado de esta versión.
