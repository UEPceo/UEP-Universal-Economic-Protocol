# Disposición de la auditoría recibida el 2026-10-09 (v0.5.16 en el texto)

El texto está en `AUDIT-EXTERNA-2026-10-09-c.md`. No se acepta la calificación 96/100 ni el apto para producción. Este árbol no es una red descentralizada. No hay token nativo. El estado canónico sigue siendo UEP-25.

| Id | Qué hay en este árbol |
|---|---|
| VULN-01 | Ya contado. `assertSupplyCap` suma las reservas de emisión pendientes. No se añade un mutex de líderes. |
| VULN-02 | El doble gasto descrito está en laboratorios UEP-36/38. El nodo no los importa. No se añade una malla TCP ni un CAS de mempool. |
| VULN-03 | Las ventanas de disputa van por altura. `Date.now` en el productor solo registra saltos de reloj de pared y no decide una altura. No se cambia el tiempo de transición a `hrtime`. |
| VULN-04 | En producción el verificador ZK exige `keyMode: "ceremony"`. Las claves de desarrollo se rechazan. No hay ceremonia en esta versión. |
| VULN-05 | El SMT de consenso tiene profundidad 254, no 32. El banco de memoria es de laboratorio. No se compacta el árbol canónico en este corte. |
| VULN-06 | La liquidación de categoría pasa por el motor de recibos. No hay un parche distinto que aplicar sobre un fallo reproducido aquí. |
| VULN-07 | La verificación Ed25519 ya exige punto de orden primo y S canónico. No se anuncia ausencia de canales laterales. |

Las cifras de 4.650 TPS y la aplicación interactiva no están en este repositorio y no se copian como resultado.
