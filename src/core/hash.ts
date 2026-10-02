/**
 * UEP domain-separated hash backends.
 *
 * PUBLIC ALPHA v0.3.2: the active Testnet/Marketplace backend is an ordered
 * SHA-256-to-BN254-field reference hash. It replaces the old UEP-25 algebraic
 * placeholder because that placeholder was commutative and algebraically
 * invertible. This is a public-reference hardening step, not a claim that
 * production UEP ZK circuits will use SHA-256.
 *
 * Production Poseidon parameters remain a separate protocol/circuit milestone.
 * Poseidon2 is not used.
 */
import { createHash } from "node:crypto";
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

/** Public alpha reference backend. */
export const Uep25PrototypeHash: UepHashBackend = {
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
        "The public alpha uses the ordered SHA-256 field backend; production circuit design remains separate. " +
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
