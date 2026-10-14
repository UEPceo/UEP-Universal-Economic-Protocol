# Disposición — VULN-UEP-08 / 09 y PROP-SEC-01..05

Contrastado con la 0.5.31. No se añade código de estos hallazgos.

| Id | Disposición |
|---|---|
| VULN-UEP-08 | No aplica. `src/settlement/value-bridge.ts` no tiene `releaseCollateral`, ni `totalSyntheticCirculating`, ni recibos de quema. No hay token nativo ni sintético. El puente acredita lo que la custodia recibió y `reconcile` exige custodia ≥ deuda. |
| VULN-UEP-09 | No aplica. `walletOutputBlinding` no llama a `Date.now()`. Con dominio 0 usa `(contador+1)*16+tag`. Con dominio distinto de 0 usa SHA-256 de dominio, contador y tag. El test `client-note-blind.test.ts` comprueba que no es un desplazamiento fijo. |
| PROP-SEC-01 | No se implementa. Describe colateral sintético y validadores. Este árbol no tiene ni lo uno ni lo otro. |
| PROP-SEC-02 | No se implementa sobre la premisa de un PRNG por milisegundos, que no está. El cegado replicable lo aporta el cliente. |
| PROP-SEC-03 | No se implementa. No hay ceremonia de producción ni conjunto de validadores. Los laboratorios no son el nodo. |
| PROP-SEC-04 | No se implementa. Un desafío de proof-of-work no es una regla de este protocolo. |
| PROP-SEC-05 | No se implementa. No hay sockets entre validadores: la Fase 4 no ha empezado. |

Un apto para producción no se sigue de este texto.
