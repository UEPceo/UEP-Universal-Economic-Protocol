# Plan de retirada del MAC de desarrollo

Entregable de cierre de la Fase 1 (ROADMAP). El paso 1 queda hecho en 0.5.11: un ledger de nodo rechaza `development-mac`. El proveedor sigue en el árbol solo para tests con `testOnlyAllowDevelopmentMac`. El fee de protocolo sigue en 0,1 %. El circuito no se receremonia aquí.

## Qué es hoy

`DevelopmentSpendProofProvider` (`src/core/spend-proof.ts`) es un MAC algebraico sobre los 12 inputs públicos. No es una prueba de conocimiento cero. Verificarlo exige el secreto del emisor, así que no puede salir del proceso. Desde v0.5.0 el gasto remoto usa `SENDER_SIGNATURE_PROOF`: Ed25519 sobre el binding de la transacción y `signedSpendNullifier`. Desde v0.4.7 `requireProof` queda fijo al construir el ledger y no se apaga fuera de tests.

El MAC cubre el gasto local de una sola entrada. El gasto multi-entrada ya es solo de firma de emisor (ADR 0004).

## Qué no se hace

No se apaga el MAC en 0.5.8. Los tests de protocolo y el quickstart local dependen de él. Apagarlo sin la firma de emisor en ese camino dejaría el testnet sin autorización de gasto.

## Sustituto

1. Todo gasto que cruza un proceso usa `sender-signature` y la clave de gasto de la cuenta derivada. El nodo verifica con la clave pública. El secreto no viaja.
2. El compromiso de transacción del circuito queda en `hFoldV2` (UEP-26.3, tag `v5-foldv2`). Un gasto ZK sustituye al MAC solo después de una ceremonia o de un esquema de setup universal, y solo si el verificador no necesita el secreto.
3. `CIRCUIT_CONSTRAINTS` sigue siendo la medida v4. No hay ceremonia en este plan.

## Pasos

| Paso | Release | Cambio |
|---|---|---|
| 0 | 0.5.8 | Este documento. El MAC sigue en el camino local. |
| 1 | 0.5.11 | Hecho. `submit` rechaza `development-mac` salvo `testOnlyAllowDevelopmentMac`. El quickstart y el smoke ya usan la firma de emisor. |
| 2 | la siguiente | Se borra `activeSpendProofProvider = DevelopmentSpendProofProvider`. El proveedor queda detrás de un import de test. |
| 3 | antes de Fase 4 | Un nodo de réplica no carga el módulo del MAC. La Fase 4 no arranca con un gasto cuya verificación exija el secreto. |

## Criterio de hecho

Un segundo proceso aplica un gasto sin el secreto del emisor, la firma verifica, el nullifier coincide y el MAC no está en el binario de ese proceso.
