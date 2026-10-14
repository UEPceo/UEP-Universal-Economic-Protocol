# uep-poseidon-wasm

Optional Poseidon BN254 (width 3, alpha 5) backend for the testnet hash.

Constants and the domain composition are the same as `src/core/poseidon.ts`:

```
H(d, a, b) = Poseidon(Poseidon(Fr(d), a), b)
```

The round constants and MDS are generated from `src/core/poseidon-bn254-params.ts`
by `build.sh` so the WASM module cannot drift from the JS backend.

Build (wasm32-unknown-unknown):

```
rustup target add wasm32-unknown-unknown
bash uep-core/uep-poseidon-wasm/build.sh
```

Load the result with `setPoseidonWasm` (`src/core/poseidon-wasm.ts`). If the
module is absent, the JS backend stays active. SpendCircuit parameters are not changed.
