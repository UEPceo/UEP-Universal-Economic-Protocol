# Revisión de estructura — 0.5.16

El nodo de referencia sigue siendo un proceso: ledger UEP-25, productor de altura, Marketplace, puente, cola, serializador y HTTP. No importa `SmtEconomicState` ni el laboratorio UEP-37. Las rutas de relay y oracle del nodo usan los adaptadores de `src/service/module-adapters.ts`, no los stubs de laboratorio.

No aparece un segundo libro. El ancla de recibos sigue tope 4.096. El gasto de nodo sigue rechazando el MAC de desarrollo. Fees 0,1 % y 3 %. Snapshot de ledger 10.

Lo que no es un fallo: el disco de objetos y los contratos de categoría no son estado de consenso. Hay que registrar de nuevo un contrato de categoría al restaurar, igual que los hooks.
