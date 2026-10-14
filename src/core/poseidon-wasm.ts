/**
 * v0.5.4: optional Poseidon backend.
 *
 * The normative constants stay in poseidon-bn254-params.ts (circomlib BN254
 * x^5 width 3). The JS implementation is the default. A WASM module built from
 * uep-core/uep-poseidon-wasm (same constants, same composition) can be loaded
 * with setPoseidonWasm(); domain hashes then go through that module.
 *
 * Missing WASM is not an error: the JS backend remains active.
 */
import { poseidonDomainHash } from "./poseidon.ts";
import { Domain, PoseidonBn254Hash, setHashBackend, type UepHashBackend } from "./hash.ts";
import { Fr } from "./field.ts";

export type PoseidonWasmExports = {
  poseidon2: (a: bigint, b: bigint) => bigint;
};

let wasm: PoseidonWasmExports | undefined;

export function poseidonBackendName(): string {
  return wasm ? "uep-poseidon-bn254-x5-3-wasm-v1" : PoseidonBn254Hash.name;
}

/** Install a WASM (or native) Poseidon with the same two-input contract as poseidon2(). */
export function setPoseidonWasm(mod: PoseidonWasmExports | undefined): void {
  wasm = mod;
  if (!mod) {
    setHashBackend(PoseidonBn254Hash);
    return;
  }
  const backend: UepHashBackend = {
    name: "uep-poseidon-bn254-x5-3-wasm-v1",
    isPoseidon2: false,
    h(domain: Domain, a: Fr, b: Fr): Fr {
      const inner = mod.poseidon2(BigInt(domain), a.n);
      return new Fr(mod.poseidon2(inner, b.n));
    },
  };
  setHashBackend(backend);
}

/** Domain hash through the active backend (WASM if installed, otherwise JS). */
export function poseidonDomainHashActive(domain: number, a: bigint, b: bigint): bigint {
  if (!wasm) return poseidonDomainHash(domain, a, b);
  return wasm.poseidon2(wasm.poseidon2(BigInt(domain), a), b);
}
