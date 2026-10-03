/**
 * ZkSpendProofProvider — UEP-28.7 binding-aware.
 *
 * Rules:
 * - publicInputs MUST equal publicInputsFromHex(publicInputsHex)
 * - verify(proof, expectedPublicInputs) checks expected vs proof hex, then SNARK
 * - Node must pass publics derived from the transaction binding
 */
import type { SpendPublicInputs } from "../core/spend-proof.ts";
import { publicInputsOrdered } from "../core/spend-proof.ts";
import {
  type ZkSpendInstance,
  validateZkSpendInstance,
  serializeZkSpendInstance,
  ZK_WITNESS_CONTRACT_VERSION,
} from "../core/zk-witness-contract.ts";
import {
  findUepZkBinary,
  zkProveExportD4,
  zkProveSpendJson,
  type UepZkDemoResult,
} from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";
import {
  publicInputsFromHex,
  publicInputsToHex,
  reconcileProofPublicInputs,
  normalizeFrHex,
  diffPublicInputHex,
  assertProofBindsTxFields,
  type TxFieldBinding,
} from "./zk-public-inputs.ts";

import { zkVerifyPinned } from "./zk-vk-pins.ts";

export type ZkSpendProof = {
  kind: "zk-spend";
  protocolVersion: string;
  circuitTag: string;
  vkId?: string;
  proofHex?: string;
  vkHex?: string;
  /** Exactly 12 field hex strings — authoritative for SNARK verify. */
  publicInputsHex?: string[];
  /** Structured form; MUST match publicInputsHex after reconcile. */
  publicInputs: SpendPublicInputs;
  backend: string;
  demo?: UepZkDemoResult;
};

export interface ZkSpendProofProvider {
  readonly name: string;
  readonly isZeroKnowledge: boolean;
  prove(instance: ZkSpendInstance): Promise<ZkSpendProof>;
  /**
   * Verify proof against **expected** public inputs (from the transaction),
   * not only against fields embedded in the proof object.
   */
  verify(proof: ZkSpendProof, expectedPublicInputs: SpendPublicInputs): Promise<boolean>;
}

export class WitnessOnlyProvider implements ZkSpendProofProvider {
  readonly name = "witness-only";
  readonly isZeroKnowledge = false;

  async prove(instance: ZkSpendInstance): Promise<ZkSpendProof> {
    const v = validateZkSpendInstance(instance, {
      checkTrees: !instance.witness.usePoseidon,
      checkCrypto: true,
    });
    if (!v.ok) throw new Error(`Witness invalid: ${v.errors.join("; ")}`);
    const hex = publicInputsToHex(instance.publicInputs);
    return {
      kind: "zk-spend",
      protocolVersion: ZK_WITNESS_CONTRACT_VERSION,
      circuitTag: "WITNESS-ONLY",
      publicInputs: instance.publicInputs,
      publicInputsHex: hex,
      backend: "validation-only — no Groth16 proof bytes",
    };
  }

  async verify(proof: ZkSpendProof, expected: SpendPublicInputs): Promise<boolean> {
    if (proof.kind !== "zk-spend") return false;
    const rec = reconcileProofPublicInputs(proof);
    const expHex = publicInputsToHex(expected);
    const gotHex = rec.publicInputsHex ?? publicInputsToHex(rec.publicInputs);
    return diffPublicInputHex(expHex, gotHex.slice(0, 12)).length === 0;
  }
}

/** Fixture path (demo only) — still returns hex as authority. */
export class LocalRustFixtureProvider implements ZkSpendProofProvider {
  readonly name = "local-rust-fixture-d4";
  readonly isZeroKnowledge = true;

  async prove(instance: ZkSpendInstance): Promise<ZkSpendProof> {
    if (!findUepZkBinary()) throw new Error("uep-zk binary not found");
    const art = zkProveExportD4();
    if (!art.ok) throw new Error(`prove-export-d4 failed: ${art.raw}`);
    const hex = art.publicInputsHex.map(normalizeFrHex);
    const fromHex = publicInputsFromHex(hex);
    return {
      kind: "zk-spend",
      protocolVersion: ZK_WITNESS_CONTRACT_VERSION,
      circuitTag: art.tag ?? "fixture-d4",
      vkId: art.vkId,
      vkHex: art.vkHex,
      proofHex: art.proofHex,
      publicInputsHex: hex,
      publicInputs: fromHex, // FROM hex — never instance.publicInputs
      backend: "uep-zk prove-export-d4 fixture (publics = fixture, not wallet instance)",
    };
  }

  async verify(proof: ZkSpendProof, expected: SpendPublicInputs): Promise<boolean> {
    return verifyZkSpendProofAgainstExpected(proof, expected, LAB_ZK_DOMAIN_ID);
  }
}

/**
 * Wallet economic → Poseidon prove-spend-json.
 * publicInputs are always taken from Rust art.publicInputsHex.
 */
export class PoseidonWalletProvider implements ZkSpendProofProvider {
  readonly name = "poseidon-wallet-json";
  readonly isZeroKnowledge = true;
  depth: 4 | 32;

  constructor(depth: 4 | 32 = 4) {
    this.depth = depth;
  }

  async prove(instance: ZkSpendInstance): Promise<ZkSpendProof> {
    const w = instance.witness;
    const pub = instance.publicInputs;
    const req = buildPoseidonSpendRequest({
      depth: this.depth,
      senderSecret: w.senderSecret,
      senderSalt: w.senderSalt,
      recipientId: pub.recipientId,
      treasuryId: pub.treasuryId,
      assetId: pub.assetId,
      amount: pub.amount.n,
      fee: pub.fee.n,
      senderOldBalance: w.senderOldAmount.n,
      recipientOldBalance: w.recipientOldAmount.n,
      treasuryOldBalance: w.treasuryOldAmount.n,
      noteBlinding: w.noteBlinding,
      recipientBlinding: w.recipientBlinding,
      treasuryBlinding: w.treasuryBlinding,
    });
    const art = zkProveSpendJson(req);
    if (!art.ok) throw new Error(art.error ?? "prove-spend-json failed");
    const hex = art.publicInputsHex.map(normalizeFrHex);
    if (hex.length !== 13) throw new Error("prover returned != 13 public inputs");
    const fromHex = publicInputsFromHex(hex);
    return {
      kind: "zk-spend",
      protocolVersion: ZK_WITNESS_CONTRACT_VERSION,
      circuitTag: `poseidon-d${this.depth}-wallet`,
      vkId: art.vkId,
      vkHex: art.vkHex,
      proofHex: art.proofHex,
      publicInputsHex: hex,
      publicInputs: fromHex, // CRITICAL: from prover hex only
      backend: "uep-zk prove-spend-json — publics bound to prover output",
    };
  }

  async verify(proof: ZkSpendProof, expected: SpendPublicInputs): Promise<boolean> {
    return verifyZkSpendProofAgainstExpected(proof, expected, LAB_ZK_DOMAIN_ID, this.depth);
  }
}

/** Domain number used by the lab prover profile (uep-zk `domain_id` default). */
export const LAB_ZK_DOMAIN_ID = 1n;

/**
 * Independent SNARK verify with external expected publics.
 * 1) expected hex must equal proof.publicInputsHex[0..11] (economic publics)
 * 2) proof.publicInputsHex[12] (domain_id) must equal the verifier's expected domain
 * 3) Groth16 verify under the PINNED verifying key for (circuit version, depth, domain);
 *    see zk-vk-pins.ts. A key carried by the proof object is never used.
 */
export function verifyZkSpendProofAgainstExpected(
  proof: ZkSpendProof,
  expected: SpendPublicInputs,
  expectedDomainId: bigint,
  depth: 4 | 32 = 4,
): boolean {
  if (proof.kind !== "zk-spend") return false;
  if (!proof.proofHex || !proof.publicInputsHex) return false;
  if (proof.publicInputsHex.length !== 13) return false;
  if (typeof expectedDomainId !== "bigint" || expectedDomainId < 0n) return false;
  const expHex = publicInputsToHex(expected);
  // Indices 0..11 are the economic publics; index 12 is domain_id (UEP-38.34).
  if (diffPublicInputHex(expHex, proof.publicInputsHex.slice(0, 12)).length > 0) return false;
  // Domain binding: a proof made for another domain is rejected.
  let domain: bigint;
  try {
    domain = BigInt("0x" + normalizeFrHex(proof.publicInputsHex[12]!).replace(/^0x/i, ""));
  } catch {
    return false;
  }
  if (domain !== expectedDomainId) return false;
  return zkVerifyPinned(depth, expectedDomainId, proof.proofHex, proof.publicInputsHex.map(normalizeFrHex), proof.vkHex).ok;
}

/** @deprecated use verifyZkSpendProofAgainstExpected with explicit publics and domain */
export function verifyZkSpendProofIndependent(proof: ZkSpendProof, expectedDomainId: bigint): boolean {
  const rec = reconcileProofPublicInputs(proof);
  if (!rec.proofHex || !rec.publicInputsHex) return false;
  return verifyZkSpendProofAgainstExpected(rec, rec.publicInputs, expectedDomainId);
}

export function verifyProofBindsTransaction(
  proof: ZkSpendProof,
  tx: TxFieldBinding,
  expectedDomainId: bigint = LAB_ZK_DOMAIN_ID,
): boolean {
  const b = assertProofBindsTxFields(proof, tx);
  if (!b.ok) return false;
  const rec = reconcileProofPublicInputs(proof);
  return verifyZkSpendProofAgainstExpected(proof, rec.publicInputs, expectedDomainId);
}

export const defaultZkProvider: ZkSpendProofProvider = new WitnessOnlyProvider();

export function exportWitnessForProver(instance: ZkSpendInstance): string {
  return JSON.stringify(serializeZkSpendInstance(instance));
}
