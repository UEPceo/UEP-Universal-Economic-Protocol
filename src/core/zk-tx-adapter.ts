/**
 * v0.5.3 adapter between ledger transactions and the UEP-26 spend circuit
 * (crypto alignment, item 5). It puts the ZK witness contract on the
 * transaction path as far as the core and the circuit agree today:
 *
 * - BOUND by the ledger: sender, recipient, treasury, asset, amount, fee,
 *   nullifier and transaction commitment (public inputs 4..11) must equal the
 *   transaction fields before the proof is handed to the verifier.
 * - ROOTS (public inputs 0..3), opt-in `zkRootBinding: "circuit-projection"`:
 *   the core state tree has depth 254 keyed by the full field value; the
 *   circuit has depth 32 keyed by the low bits (`circuitSlotIndex`). The
 *   projection adapter (`CircuitTreeProjection`, `zkLedgerTransition`) rebuilds
 *   the ledger trees at circuit depth (state leaf = balanceLeaf with blinding 0
 *   = H_LEAF(ledger leaf, 0); nullifier leaf = nullifier) and computes the four
 *   roots a circuit witness for the transaction must use. A slot collision
 *   (two keys with the same low 32 bits) makes the projection undefined and
 *   the zk-spend is refused (ZK_SLOT_COLLISION). The hash is the UEP-25 tree
 *   hash (structural witnesses); the Poseidon circuit roots are not equal yet.
 * - Account ids: `zkAccountIds()` is the one derivation adapter. The core
 *   derives ids from the Ed25519 spend key; the circuit proves
 *   H_ACCOUNT(secret, salt). The ledger binds input 4 to the core id, so a proof
 *   over an H_ACCOUNT id does not bind; a zk-spend still needs the sender
 *   signature, which the ledger checks as for any spend.
 *
 * Verifier keys: `ZkSpendVerifier.keyMode` must be "ceremony" under
 * NODE_ENV=production; development keys (derived from a public seed) are
 * refused there (see src/lab/zk-vk-pins.ts for the lab pins).
 */
import { Fr } from "./field.ts";
import { hAccount, hLeaf } from "./hash.ts";
import { EMPTY_LEAF, SparseMerkleTree, type MerklePath } from "./smt.ts";
import { accountIdsFromSecrets } from "./spend-key.ts";
import { u64ToFr } from "./encoding.ts";
import { isProductionEnvironment } from "./test-only.ts";
import { SPEND_PUBLIC_INPUT_NAMES, type SpendProof } from "./spend-proof.ts";
import type { UepTransaction } from "./transaction.ts";

/** Depth of the UEP-26 circuit state / nullifier trees. */
export const CIRCUIT_TREE_DEPTH = 32;
/** Public-input indices the ledger binds to transaction fields. */
export const ZK_BOUND_PUBLIC_INPUTS = [4, 5, 6, 7, 8, 9, 10, 11] as const;
/** Root public inputs: bound only under `zkRootBinding: "circuit-projection"`. */
export const ZK_UNBOUND_PUBLIC_INPUTS = [0, 1, 2, 3] as const;
export const ZK_ROOT_PUBLIC_INPUTS = ZK_UNBOUND_PUBLIC_INPUTS;
export type ZkRootBindingMode = "off" | "circuit-projection";
export type ZkAccountIdDerivation = "core-key-derived" | "circuit-h-account";

/**
 * The one account-id derivation adapter (v0.5.3). "core-key-derived": the ids
 * the core accepts for (secret, salt), v3 first, then the v2 id of the same key;
 * "circuit-h-account": what the UEP-26 circuit proves today.
 */
export function zkAccountIds(secret: Fr, salt: Fr, derivation: ZkAccountIdDerivation = "core-key-derived"): Fr[] {
  if (derivation === "circuit-h-account") return [hAccount(secret, salt)];
  if (derivation !== "core-key-derived") throw new Error("ZK_ACCOUNT_DERIVATION_INVALID");
  const ids = accountIdsFromSecrets(secret, salt);
  return [ids.v3, ids.v2];
}

/** True iff `id` is an account id of (secret, salt) under `derivation`. */
export function zkAccountIdMatches(id: Fr, secret: Fr, salt: Fr, derivation: ZkAccountIdDerivation = "core-key-derived"): boolean {
  return zkAccountIds(secret, salt, derivation).some((x) => x.eq(id));
}

/** Account id the UEP-26 circuit proves (legacy H_ACCOUNT(secret, salt)). */
export function circuitAccountId(secret: Fr, salt: Fr): Fr {
  return hAccount(secret, salt);
}

/** Circuit slot of a core SMT key: the low CIRCUIT_TREE_DEPTH bits. */
export function circuitSlotIndex(key: Fr, depth = CIRCUIT_TREE_DEPTH): bigint {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 254) throw new Error("ZK_DEPTH_INVALID");
  return key.n & ((1n << BigInt(depth)) - 1n);
}

/** Ledger state leaf for one (account, asset) balance (the ledger's own tree). */
export function ledgerBalanceLeaf(account: Fr, asset: Fr, balance: bigint): Fr {
  return hLeaf(account, hLeaf(asset, u64ToFr(balance)));
}

/** Ledger state key for one (account, asset). */
export function ledgerBalanceKey(account: Fr, asset: Fr): Fr {
  return hAccount(account, asset);
}

/** Circuit leaf of a ledger balance leaf: balanceLeaf(owner, asset, amount, blinding 0). */
export function circuitBalanceLeaf(ledgerLeaf: Fr): Fr {
  return hLeaf(ledgerLeaf, Fr.zero());
}

/**
 * A depth-limited view of a full-key (depth 254) tree: every leaf moves to
 * slot circuitSlotIndex(key). Two keys on one slot throw ZK_SLOT_COLLISION.
 */
export class CircuitTreeProjection {
  readonly depth: number;
  private readonly tree: SparseMerkleTree;
  private readonly owner = new Map<bigint, bigint>();

  constructor(depth = CIRCUIT_TREE_DEPTH) {
    circuitSlotIndex(Fr.zero(), depth);
    this.depth = depth;
    this.tree = new SparseMerkleTree(depth);
  }

  /** Projection of a full-key tree; `mapLeaf` turns a stored leaf into the circuit leaf. */
  static of(full: SparseMerkleTree, mapLeaf: (leaf: Fr) => Fr = (x) => x, depth = CIRCUIT_TREE_DEPTH): CircuitTreeProjection {
    const p = new CircuitTreeProjection(depth);
    for (const [k, v] of full.toJSON().leaves) {
      const leaf = new Fr(v);
      if (!leaf.eq(EMPTY_LEAF)) p.set(new Fr(BigInt(k)), mapLeaf(leaf));
    }
    return p;
  }

  clone(): CircuitTreeProjection {
    const p = new CircuitTreeProjection(this.depth);
    for (const [slot, key] of this.owner) p.set(new Fr(key), this.tree.getIndex(slot));
    return p;
  }

  slotOf(key: Fr): bigint {
    return circuitSlotIndex(key, this.depth);
  }

  get(key: Fr): Fr {
    const slot = this.slotOf(key);
    const o = this.owner.get(slot);
    if (o !== undefined && o !== key.n) throw new Error("ZK_SLOT_COLLISION");
    return this.tree.getIndex(slot);
  }

  set(key: Fr, leaf: Fr): void {
    const slot = this.slotOf(key);
    const o = this.owner.get(slot);
    if (o !== undefined && o !== key.n) throw new Error("ZK_SLOT_COLLISION");
    this.owner.set(slot, key.n);
    this.tree.setIndex(slot, leaf);
  }

  path(key: Fr): MerklePath & { index: bigint } {
    const index = this.slotOf(key);
    return { index, ...this.tree.pathAt(index) };
  }

  root(): Fr {
    return this.tree.root();
  }
}

export type ZkTransitionStep = { key: Fr; path: MerklePath & { index: bigint }; oldLeaf: Fr; newLeaf: Fr; rootAfter: Fr };
export type ZkLedgerTransition = {
  roots: { oldStateRoot: Fr; newStateRoot: Fr; oldNullifierRoot: Fr; newNullifierRoot: Fr };
  /** sender, recipient, treasury updates in circuit order. */
  steps: [ZkTransitionStep, ZkTransitionStep, ZkTransitionStep];
  nullifierPath: MerklePath & { index: bigint };
};

/**
 * Circuit-depth transition of one spend over the projected ledger trees: the
 * sender, recipient and treasury leaves are updated in circuit order and the
 * nullifier is inserted at lowBits(nullifier). The projections are not
 * modified. Throws ZK_SLOT_COLLISION or ZK_NULLIFIER_SLOT_USED.
 */
export function zkLedgerTransition(
  state: CircuitTreeProjection,
  nullifiers: CircuitTreeProjection,
  parties: [{ account: Fr; newBalance: bigint }, { account: Fr; newBalance: bigint }, { account: Fr; newBalance: bigint }],
  asset: Fr,
  nullifier: Fr,
): ZkLedgerTransition {
  const s = state.clone();
  const oldStateRoot = s.root();
  const steps = parties.map(({ account, newBalance }) => {
    const key = ledgerBalanceKey(account, asset);
    const path = s.path(key);
    const oldLeaf = s.get(key);
    const newLeaf = circuitBalanceLeaf(ledgerBalanceLeaf(account, asset, newBalance));
    s.set(key, newLeaf);
    return { key, path, oldLeaf, newLeaf, rootAfter: s.root() };
  }) as ZkLedgerTransition["steps"];
  const n = nullifiers.clone();
  const oldNullifierRoot = n.root();
  if (!n.get(nullifier).eq(EMPTY_LEAF)) throw new Error("ZK_NULLIFIER_SLOT_USED");
  const nullifierPath = n.path(nullifier);
  n.set(nullifier, nullifier);
  return { roots: { oldStateRoot, newStateRoot: s.root(), oldNullifierRoot, newNullifierRoot: n.root() }, steps, nullifierPath };
}

/** Which root public inputs (0..3) of the proof disagree with the transition roots. */
export function zkRootMismatches(payload: ZkSpendPayload, roots: ZkLedgerTransition["roots"]): number[] {
  const want = [roots.oldStateRoot, roots.newStateRoot, roots.oldNullifierRoot, roots.newNullifierRoot].map((x) => x.toHex());
  return ZK_ROOT_PUBLIC_INPUTS.filter((i) => norm(payload.publicInputsHex[i]!) !== want[i]);
}

/** The 8 public inputs (hex, circuit order) a transaction fixes. */
export function zkTxBinding(tx: UepTransaction, treasuryId: Fr): Record<(typeof ZK_BOUND_PUBLIC_INPUTS)[number], string> {
  const hex = (x: Fr) => x.toHex();
  return {
    4: hex(tx.senderId),
    5: hex(tx.recipientId),
    6: hex(treasuryId),
    7: hex(tx.assetId),
    8: hex(u64ToFr(tx.amount)),
    9: hex(u64ToFr(tx.fee)),
    10: hex(tx.nullifier),
    11: hex(tx.transactionCommitment),
  };
}

export type ZkSpendPayload = { publicInputsHex: string[]; proof: string };

export function parseZkSpendPayload(proof: SpendProof): ZkSpendPayload | undefined {
  if (proof?.kind !== "zk-spend" || typeof proof.payload !== "string") return undefined;
  try {
    const p = JSON.parse(proof.payload) as ZkSpendPayload;
    if (!Array.isArray(p.publicInputsHex) || p.publicInputsHex.length !== SPEND_PUBLIC_INPUT_NAMES.length) return undefined;
    if (p.publicInputsHex.some((x) => typeof x !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(x))) return undefined;
    if (typeof p.proof !== "string") return undefined;
    return p;
  } catch {
    return undefined;
  }
}

const norm = (x: string) => new Fr(BigInt(x.startsWith("0x") ? x : `0x${x}`)).toHex();

/** Which bound public inputs of the proof disagree with the transaction (empty = bound). */
export function zkBindingMismatches(tx: UepTransaction, treasuryId: Fr, payload: ZkSpendPayload): number[] {
  const want = zkTxBinding(tx, treasuryId);
  return ZK_BOUND_PUBLIC_INPUTS.filter((i) => norm(payload.publicInputsHex[i]!) !== norm(want[i]));
}

/** Synchronous verifier the ledger calls after the binding check. */
export interface ZkSpendVerifier {
  readonly keyMode: "development" | "ceremony";
  verify(payload: ZkSpendPayload): boolean;
}

export function assertVerifierAllowed(v: ZkSpendVerifier, production = isProductionEnvironment()): void {
  if (!v || typeof v.verify !== "function") throw new Error("ZK_VERIFIER_INVALID");
  if (v.keyMode !== "development" && v.keyMode !== "ceremony") throw new Error("ZK_VERIFIER_KEY_MODE");
  if (v.keyMode === "development" && production) {
    throw new Error("ZK_DEV_KEYS_IN_PRODUCTION: development Groth16 keys are refused under NODE_ENV=production");
  }
}
