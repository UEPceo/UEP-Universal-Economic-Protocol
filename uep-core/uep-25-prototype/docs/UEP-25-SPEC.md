# UEP-25 — Atomic Sparse-State Transition Specification

## Objetivo

Cerrar los fallos arquitectónicos detectados en UEP-23/24 y acercar el núcleo a
un prototipo verificable.

## Invariantes

### Propiedad

`SenderID = H_ACCOUNT(secret, salt)`

### Nullifier

`N = H_NULLIFIER(secret, nonce)`

El mismo `secret + nonce` no puede aceptarse dos veces.

### Fee

`fee = floor(amount * 10 / 10000)`.

Esto representa 0,1% en unidades enteras, con redondeo hacia abajo.

### Transferencia

`sender_new = sender_old - amount - fee`

`recipient_new = recipient_old + amount`

`treasury_new = treasury_old + fee`

### Conservación

`sender_old + recipient_old + treasury_old`
=
`sender_new + recipient_new + treasury_new`

### Estado

La aceptación final exige:

`old_state_root -> new_state_root`

mediante tres actualizaciones SMT atómicas y:

`old_nullifier_root -> new_nullifier_root`

mediante la inserción del nullifier.

## Dominios

Se separan hashes de:

- cuentas,
- nullifiers,
- hojas,
- nodos Merkle,
- commitments de transacción.

Esto evita reutilizar accidentalmente una misma relación hash para objetos
semánticamente diferentes.

## Lo que falta antes de testnet

1. Congelar parámetros Poseidon/Poseidon2.
2. Implementar los gadgets R1CS de hash y SMT con esos parámetros.
3. Probar membership/update de las tres hojas.
4. Probar inserción de nullifier y no-replay dentro del circuito.
5. Generar Groth16 real y verificar contra el conjunto de inputs públicos.
6. Añadir serialización canónica y versionada.
7. Medir rendimiento en hardware definido.
8. Añadir fuzzing y property-based testing.
9. Revisar overflow/range constraints dentro del propio circuito.
10. Congelar el genesis/configuration ID de la red.
