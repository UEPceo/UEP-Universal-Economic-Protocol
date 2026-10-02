/**
 * UEP domain-separated hash backends.
 *
 * LIVE BACKEND (wallet + Testnet today):
 *   UEP-25 algebraic placeholder (verbatim from uep-25-prototype/src/hash.rs):
 *     d = Fr(domain); x = a+d; y = b+d; h = (x+y)^2 + x*y + d
 *   Status: IMPLEMENTED / TESTED (vectors in uep.test.ts).
 *
 * UEP-26 CIRCUIT DESIGN (frozen 2026-09-23, see uep-core/UEP-26-HASH-PARAMETERS-FREEZE.md):
 *   Permutation: Poseidon BN254 t=3 alpha=5 (UEP-21). NOT Poseidon2.
 *   Domain composition: H(d,a,b) = Poseidon(Poseidon(Fr(d), a), b)
 *   Live migration to Poseidon is a separate coordinated release (vectors GOLDEN in UEP-26.5; wallet still on UEP-25 placeholder).
 *
 * Poseidon2: NOT used. Backend must throw. Different permutation; future protocol version only.
 */
import { Fr } from "./field.ts";

/** Domain separators (numeric tags). Const object keeps Node strip-types happy. */
export const Domain = {
  Account: 1,
  Nullifier: 2,
  MerkleNode: 3,
  Leaf: 4,
  Transaction: 5,
} as const;
export type Domain = (typeof Domain)[keyof typeof Domain];

export interface UepHashBackend {
  readonly name: string;
  readonly isPoseidon2: boolean;
  h(domain: Domain, a: Fr, b: Fr): Fr;
}

/** Faithful port of UEP-25 `hash::h`. */
export const Uep25PrototypeHash: UepHashBackend = {
  name: "uep25-algebraic-placeholder",
  isPoseidon2: false,
  h(domain: Domain, a: Fr, b: Fr): Fr {
    const d = new Fr(domain);
    const x = a.add(d);
    const y = b.add(d);
    const sum = x.add(y);
    return sum.mul(sum).add(x.mul(y)).add(d);
  },
};

/**
 * Poseidon2 is deliberately not implemented here.
 * UEP-21 froze Poseidon (not Poseidon2) BN254 width-3 via arkworks.
 * Poseidon2 parameters are not interchangeable and are not present in the artifacts.
 *
 * Status: CONCEPTUAL
 */
export const Poseidon2Backend: UepHashBackend = {
  name: "poseidon2-excluded",
  isPoseidon2: true,
  h(): Fr {
    throw new Error(
      "UEP-26: Poseidon2 is excluded (not interchangeable with frozen Poseidon BN254 t=3 α=5). " +
        "Live wallet uses Uep25PrototypeHash; circuit design uses UEP-21 Poseidon. " +
        "Do not invent a Poseidon2 round structure.",
    );
  },
};

let active: UepHashBackend = Uep25PrototypeHash;

export function getHashBackend(): UepHashBackend {
  return active;
}

export function setHashBackend(backend: UepHashBackend): void {
  active = backend;
}

export function h(domain: Domain, a: Fr, b: Fr): Fr {
  return active.h(domain, a, b);
}

export function hAccount(secret: Fr, salt: Fr): Fr {
  return h(Domain.Account, secret, salt);
}

export function hNullifier(secret: Fr, nonce: Fr): Fr {
  return h(Domain.Nullifier, secret, nonce);
}

export function hMerkle(left: Fr, right: Fr): Fr {
  return h(Domain.MerkleNode, left, right);
}

export function hLeaf(a: Fr, b: Fr): Fr {
  return h(Domain.Leaf, a, b);
}

export function hTx(a: Fr, b: Fr): Fr {
  return h(Domain.Transaction, a, b);
}

/**
 * Left-fold of H under a domain (UEP-26-HASH-PARAMETERS-FREEZE.md §4 / § tx commitment).
 *
 * Normative:
 *   H_fold(d, [])         = H(d, 0, 0)          // empty aggregate
 *   H_fold(d, [x0])       = x0                  // single element is identity
 *   H_fold(d, [x0,...,xk]) = H(d, H_fold(d,[x0..x{k-1}]), xk)
 *
 * Previous wallet code hashed a singleton with Fr.zero(); that diverged from the freeze
 * and is corrected here before transaction-commitment is frozen in the SpendCircuit.
 */
export function hFold(domain: Domain, items: Fr[]): Fr {
  if (items.length === 0) return h(domain, Fr.zero(), Fr.zero());
  if (items.length === 1) return items[0]!;
  let acc = items[0]!;
  for (let i = 1; i < items.length; i++) acc = h(domain, acc, items[i]!);
  return acc;
}
