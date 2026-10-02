# Cómo compilar y ejecutar `uep-zk`

`uep-zk` es la herramienta local de laboratorio del circuito UEP-26 (Groth16 sobre
BN254 con claves de desarrollo). **No** hay ceremonia de producción y las claves que
genera son solo para pruebas.

Este repositorio **no incluye ningún binario precompilado**. Se compila desde el
código fuente:

```bash
npm run build:uep-zk          # = scripts/build-uep-zk.sh
# binario resultante: uep-core/target/release/uep-zk
uep-core/target/release/uep-zk circuit-id
```

Requisitos: Rust estable (CI usa 1.85) y acceso a crates.io. El `Cargo.lock` de
`uep-26-spend-circuit` está fijado (`cargo build --locked`).

El código TypeScript del laboratorio (`src/lab/zk-bridge.ts`, `src/lab/uep-zk-runner.ts`)
busca el binario en este orden: variable `UEP_ZK_BIN`, `uep-core/target/release/uep-zk`
y otras rutas locales. `npm run test:all` compila el binario y exporta `UEP_ZK_BIN`
automáticamente.

## Smoke test

```bash
npm run smoke:zk        # demo D=4: setup + prove + verify
```

## Alcance

- Claves Groth16 de desarrollo, generadas en local. No usar fuera del laboratorio.
- Las pruebas no se vinculan todavía al ledger público de testnet (`src/testnet`), que usa
  el hash de referencia SHA-256→BN254 y un SMT de 254 bits.
