/**
 * UEP domain-separated hash backends.
 *
 * Since the research-labs integration the active backend is Poseidon over BN254
 * (width 3, alpha 5, circomlib-compatible constants), the same hash the UEP-26 spend
 * circuit and `uep-core/uep-21-poseidon` use. Domain composition (UEP-26 freeze):
 *   H(d, a, b) = Poseidon(Poseidon(Fr(d), a), b)
 *
 * The previous ordered SHA-256-to-BN254 reference backend (v0.3.2 – v0.4.7) remains
 * available as `Sha256FieldReferenceHash` for reading old fixtures; it is not active.
 * Poseidon2 is not used.
 */
import { createHash } from "node:crypto";
import { Fr } from "./field.ts";
import { poseidonDomainHash } from "./poseidon.ts";

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

/** Previous public reference backend (v0.3.2 – v0.4.7): ordered SHA-256 to BN254 field. Not active. */
export const Sha256FieldReferenceHash: UepHashBackend = {
  name: "uep-public-sha256-field-v1",
  isPoseidon2: false,
  h(domain: Domain, a: Fr, b: Fr): Fr {
    // Public testnet hardening: the previous UEP-25 algebraic placeholder was
    // commutative and algebraically invertible. It is not suitable for an
    // externally reachable ledger identity/commitment function. This backend
    // is intentionally NOT the production Poseidon circuit backend; it is a
    // collision-resistant ordered reference hash for the public alpha.
    const prefix = new TextEncoder().encode("UEP-PUBLIC-HASH-V1");
    const domainBytes = new Uint8Array(4);
    new DataView(domainBytes.buffer).setUint32(0, domain, false);
    const digest = createHash("sha256")
      .update(prefix)
      .update(domainBytes)
      .update(a.toBytesBE())
      .update(b.toBytesBE())
      .digest();
    return Fr.fromBytesBE254(new Uint8Array(digest));
  },
};

/** @deprecated Old name of the SHA-256 reference backend. */
export const Uep25PrototypeHash: UepHashBackend = Sha256FieldReferenceHash;

/** Active backend: Poseidon BN254 t=3 alpha=5 with the UEP-26 domain composition. */
export const PoseidonBn254Hash: UepHashBackend = {
  name: "uep-poseidon-bn254-x5-3-v1",
  isPoseidon2: false,
  h(domain: Domain, a: Fr, b: Fr): Fr {
    return new Fr(poseidonDomainHash(domain, a.n, b.n));
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
        "The protocol uses Poseidon BN254 t=3 α=5 (PoseidonBn254Hash). " +
        "Do not invent a Poseidon2 round structure.",
    );
  },
};

let active: UepHashBackend = PoseidonBn254Hash;

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
