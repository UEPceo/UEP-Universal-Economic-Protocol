# Revisión técnica v0.5.11 — paquete para la auditoría externa

Fecha: 2026-10-09. Árbol revisado: referencia 0.5.11 más el arreglo de puente y el bus de la 0.5.12. Esta nota no es una evaluación de un tercero. Quien audite fuera del equipo debe repetir `npm run test:all` en Node 22 y 24 y leer el gasto, el snapshot y el puente.

## Alcance

Gasto y MAC, snapshot 10, puente ledger/Marketplace, ancla de recibos, nodo, LEI offline. No se recompiló el circuito Rust en esta revisión. Fees 0,1 % y 3 % no se tocaron.

## Hallazgos

| Id | Severidad | Hecho | Disposición |
|---|---|---|---|
| A1 | Alta | `ValueBridge.withdraw` y `deposit` aplican el ledger antes que el saldo del Marketplace. Si el proceso muere en medio, la nota se movió y el crédito o débito no. | 0.5.12: `recover(kind, buyerId, asset, amount, txId)` repite solo la mitad del Marketplace con el mismo id. No crea otra nota. |
| A2 | Media | El MAC de desarrollo sigue en el árbol. Un ledger normal lo rechaza; un test puede reabrirlo con `testOnlyAllowDevelopmentMac`. | Aceptado hasta el paso 2 del plan. No es camino de nodo. |
| A3 | Media | La tabla de `docs/REPRODUCIBILITY.md` es el `test:all` de la 0.5.3. Esta revisión no lo ha vuelto a ejecutar. | La auditoría externa tiene que correrlo. Sin ese resultado no hay cierre externo de la Fase 1. |
| A4 | Baja | UEP-37 sigue en el laboratorio. El nodo no lo importa (ADR 0005). | Sin cambio. |
| A5 | Info | GLEIF es solo pantalla. Una suma LEI no prueba que la entidad exista. | Sin cambio. |

No aparece un crítico nuevo en el gasto de nodo: sin el flag de laboratorio, `development-mac` responde `PROOF`.

## Criterio de Fase 1

Ingeniería cerrada en 0.5.11. El criterio externo sigue abierto hasta que la auditoría de fuera confirme A3 y no aporte un crítico o alto distinto de A1 ya dispuesto.
