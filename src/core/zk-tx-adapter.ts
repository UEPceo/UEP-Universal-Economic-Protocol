/**
 * v0.5.3 adapter between ledger transactions and the UEP-26 spend circuit
 * (crypto alignment, item 5). It puts the ZK witness contract on the
 * transaction path as far as the core and the circuit agree today:
 *
 * - BOUND by the ledger: sender, recipient, treasury, asset, amount, fee,
 *   nullifier and transaction commitment (public inputs 4..11) must equal the
 *   transaction fields before the proof is handed to the verifier.
 * - NOT BOUND (documented gaps): the four roots (public inputs 0..3). The core
 *   state tree has depth 254 keyed by the full field value; the circuit has
 *   depth 32 keyed by the low bits (`circuitSlotIndex`). Their roots differ, so a
 *   proof cannot attest the ledger roots yet.
 * - Account ids: the core derives ids from the Ed25519 spend key; the circuit
 *   proves H_ACCOUNT(secret, salt) (`circuitAccountId`). A zk-spend therefore
 *   still needs the sender signature, which the ledger checks as for any spend.
 *
 * Verifier keys: `ZkSpendVerifier.keyMode` must be "ceremony" under
 * NODE_ENV=production; development keys (derived from a public seed) are
 * refused there (see src/lab/zk-vk-pins.ts for the lab pins).
 */
import { Fr } from "./field.ts";
import { hAccount } from "./hash.ts";
import { u64ToFr } from "./encoding.ts";
import { isProductionEnvironment } from "./test-only.ts";
import { SPEND_PUBLIC_INPUT_NAMES, type SpendProof } from "./spend-proof.ts";
import type { UepTransaction } from "./transaction.ts";

/** Depth of the UEP-26 circuit state / nullifier trees. */
export const CIRCUIT_TREE_DEPTH = 32;
/** Public-input indices the ledger binds to transaction fields. */
export const ZK_BOUND_PUBLIC_INPUTS = [4, 5, 6, 7, 8, 9, 10, 11] as const;
/** Public-input indices not bound yet (roots; depth gap). */
export const ZK_UNBOUND_PUBLIC_INPUTS = [0, 1, 2, 3] as const;

/** Account id the UEP-26 circuit proves (legacy H_ACCOUNT(secret, salt)). */
export function circuitAccountId(secret: Fr, salt: Fr): Fr {
  return hAccount(secret, salt);
}

/** Circuit slot of a core SMT key: the low CIRCUIT_TREE_DEPTH bits. */
export function circuitSlotIndex(key: Fr, depth = CIRCUIT_TREE_DEPTH): bigint {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 254) throw new Error("ZK_DEPTH_INVALID");
  return key.n & ((1n << BigInt(depth)) - 1n);
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
