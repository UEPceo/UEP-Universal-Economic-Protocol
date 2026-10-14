# Auditoría técnica UEP v0.5.6 — constancia y disposición

Fecha del informe: 9 de octubre de 2026.
Paquete auditado: `UEP-Universal-Economic-Protocol-0.5.6.zip` (679 archivos).
Informe original: `docs/audit/Auditoria-tecnica-UEP-v0.5.6.pdf`.
Parche recibido: `docs/audit/fix-supplycap.patch`.
Disposición aplicada en: 0.5.7.

Esto es la constancia interna de esa revisión asistida. No sustituye una auditoría externa formal ni la revisión criptográfica del circuito. El propio informe no ejecutó Rust, labs ni la simulación de 20k, y no revisó línea a línea ledger, marketplace, settlement, oracle ni category.

## Confirmados

| Id | Severidad | Hallazgo | Disposición en 0.5.7 |
|---|---|---|---|
| C1 | Alto | `supplyCap` eludible: las reservas de mint no contaban contra el tope, y el apply no repetía las comprobaciones. Dos reservas de 900 sobre tope 1000 emitían 1800. | Aplicado. `assertSupplyCap` suma reservas vivas. `mintWithIssuerSignatures` repite `assertMintable`, tope sin reservas y saldo `< 2^64`. Test: `src/testnet/ledger-mint-reservation-cap.test.ts`. |
| C2 | Alto (proceso) | `lint:determinism` en rojo: `randomBytes` en `ledger.ts` (0.5.4) y `process.env.UEP_SCALE` en `scale-sizes.ts` (0.5.6). Dos tests de `test:protocol` fallaban. | Cerrado para el lint. El tamaño de la prueba node ya no lee el entorno; 50k/100k/500k se eligen en `scripts/`. El blinding ya no usa entropía del SO: se deriva del `noteCounter` ya persistido en el snapshot (decisión I1, abajo). |
| C3 | Medio | `BigInt` sobre un cuerpo de hasta 16 MiB bloquea el event loop. | Cuerpo por defecto de 64 KiB. Los decimales de precio, capacidad, cantidad e importe se aceptan solo si cumplen `^(0|[1-9][0-9]{0,29})$` antes de `BigInt`. |
| C4 | Bajo | El catch de la API devolvía `e.message` en el 500. | El 500 devuelve `INTERNAL` y un id de correlación. El 413 sigue siendo `PAYLOAD_TOO_LARGE`. |

## Por inspección — no cerrados en este release

| Id | Severidad | Hallazgo | Disposición |
|---|---|---|---|
| I1 | Alto | Aleatoriedad dentro del ledger, incompatible con réplicas. | Decisión: no se allowlistea `randomBytes`. El blinding de testnet se deriva del contador de notas del snapshot, así dos réplicas que aplican la misma secuencia coinciden. Ese valor no es secreto. El compromiso aportado por el cliente, sin blinding en el ledger, queda como P1. |
| I2 | Alto | El generador WASM de Poseidon emite `u128` para un campo de 254 bits y `setPoseidonWasm` no comprueba paridad. | Abierto. No se corta un `.wasm`. Retirar o reescribir el generador con limbs de 64 bits y test de paridad antes de usarlo. |
| I3 | Alto | Vault PIN + PBKDF2 100.000 en `localStorage`. | Abierto. No se cambia el vault en este release. |
| I4 | Medio | `deriveIdentity` sin índice ni rotación. | Abierto. |
| I5 | Bajo | BIP-39 sin NFKD. | Abierto. |
| I6 | Medio | Cola de reservas de mint sin tope y FIFO. | Abierto. C1 impide pasar el tope; no limita cuántas reservas caben en la cola. |
| I7 | Medio | Ventana fija de `SecurityPolicy` y `check` que puede reiniciar cubos. | Abierto. |
| I8 | Medio | Host/Origin solo en objetos; rutas sin auth ni rate limit; sin cabeceras de seguridad. | Abierto, salvo el límite de cuerpo y el 500 genérico (C3, C4). |
| I9 | Medio | Acciones de CI por etiqueta, `tsc` no bloqueante, sin CodeQL ni `cargo deny`. | Abierto. |
| I10 | Bajo | README desfasado respecto de versión y formato de snapshot. | Parcial: el changelog y esta constancia citan 0.5.7 y el formato 10. La tabla generada desde `package.json` queda pendiente. |
| I11 | Medio | `hFold` y `hFoldV2` conviven. El circuito está en V2; el wallet y las notas no. | Abierto. El freeze UEP-26.3 no se mueve. `CIRCUIT_CONSTRAINTS` sigue siendo la medida v4. |
| I12 | Informativo | Claves de desarrollo, sin ceremonia. Groth16 exige ceremonia por cada cambio de circuito. | Abierto. No se hace ceremonia. |

## Plan que queda

P1: compromiso de nota aportado por el cliente; WASM con test de paridad o retirada; vault; superficie HTTP; CI fijado por SHA; documentación generada.

P2: hojas con atajo en el SMT; SLIP-0010 y rotación; decisión de esquema de prueba; auditoría externa del ledger, marketplace, settlement y circuitos.

Fee de protocolo 0,1 % y fee de Marketplace 3 % no cambian. Formato de snapshot 10 no cambia.


## Cierre I1 en 0.5.8

El cliente aporta la apertura. `faucet`, `prepareIssuerMint` y `mintWithIssuerSignatures` la exigen y la comprueban. La reserva ya no guarda `blindingHex`. Dos réplicas que reciben la misma apertura registran la misma nota (`src/testnet/client-note-replication.test.ts`). El plan de retirada del MAC de desarrollo está en `docs/DEV-MAC-RETIREMENT.md`; el MAC no se apaga en esta release.
