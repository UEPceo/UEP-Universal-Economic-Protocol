/**
 * UEP-38.2 — replica verifies Groth16 before applying the SMT transition.
 */
import { zkVerifyHex } from "./zk-bridge.ts";
import { canonicalFieldHex } from "./uep38-p4-spend-cert.ts";
import type { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  applyTransfer,
  type CircuitAlignedAccounts,
  type SpendProofArtifact,
} from "./uep38-zk-state-transition.ts";

export type NodeVerifyResult =
  | { ok: true; newRoot: string }
  | { ok: false; reason: string };

function norm(h: string): string {
  return h.replace(/^0x/i, "").toLowerCase();
}

/** DEV VK pin. Set from the bundled prover; a proof under another VK is rejected. */
let pinnedVkHex: string | null = process.env.UEP_P4_VK_HEX?.replace(/^0x/i, "").toLowerCase() || null;

export function pinP4Vk(vkHex: string): void {
  pinnedVkHex = vkHex.replace(/^0x/i, "").toLowerCase();
}

export function p4PinnedVk(): string | null {
  return pinnedVkHex;
}

export function verifyArtifactAgainstRoots(
  art: SpendProofArtifact,
  oldRoot: string,
  expectedNewRoot?: string,
): NodeVerifyResult {
  if (!art.ok || !art.vkHex || !art.proofHex || art.publicInputsHex.length !== 13) {
    return { ok: false, reason: "ARTIFACT_INCOMPLETE" };
  }
  if (pinnedVkHex && norm(art.vkHex) !== pinnedVkHex) {
    return { ok: false, reason: "VK_NOT_PINNED" };
  }
  for (const input of art.publicInputsHex) {
    const c = canonicalFieldHex(input);
    if (!c.ok) return { ok: false, reason: c.reason ?? "PUBLIC_FIELD_ALIAS" };
  }
  if (norm(art.publicInputsHex[0]!) !== norm(oldRoot)) {
    return { ok: false, reason: "OLD_ROOT_MISMATCH" };
  }
  if (BigInt("0x" + norm(art.publicInputsHex[12]!)) !== 1n) {
    return { ok: false, reason: "DOMAIN_MISMATCH" };
  }
  if (expectedNewRoot && norm(art.publicInputsHex[1]!) !== norm(expectedNewRoot)) {
    return { ok: false, reason: "NEW_ROOT_MISMATCH" };
  }
  const v = zkVerifyHex(art.vkHex, art.proofHex, art.publicInputsHex);
  if (!v.ok) return { ok: false, reason: "GROTH16_VERIFY_FAIL" };
  return { ok: true, newRoot: norm(art.publicInputsHex[1]!) };
}

/**
 * Replica: verify proof against current SMT root, then apply the same transfer.
 */
export function nodeApplyVerifiedTransfer(
  node: SmtEconomicState,
  ids: CircuitAlignedAccounts,
  amount: bigint,
  art: SpendProofArtifact,
): NodeVerifyResult {
  const old = node.stateRoot();
  const chk = verifyArtifactAgainstRoots(art, old);
  if (!chk.ok) return chk;
  const applied = applyTransfer(node, ids, amount);
  if (!applied.ok) return { ok: false, reason: applied.reason ?? "APPLY_FAIL" };
  if (norm(applied.newRoot) !== norm(art.newRootProof)) {
    return { ok: false, reason: "APPLY_ROOT_NE_PROOF" };
  }
  return { ok: true, newRoot: applied.newRoot };
}

/** Public input 10 is the nullifier. Apply and catch-up must reject a repeat. */
export function nullifierFromArtifact(art: SpendProofArtifact): string {
  return (art.publicInputsHex[10] ?? "").replace(/^0x/i, "").toLowerCase();
}

export function canonicalSpendId(domainId: string, sender: string, nonceOrNullifier: string): string {
  return `${domainId}|${sender}|${nonceOrNullifier}`;
}

export function claimFreshNullifier(seen: Set<string>, art: SpendProofArtifact): { ok: boolean; reason?: string } {
  const n = nullifierFromArtifact(art);
  if (n.length < 16) return { ok: false, reason: "NULLIFIER_MISSING" };
  if (seen.has(n)) return { ok: false, reason: "NULLIFIER_REPLAY" };
  seen.add(n);
  return { ok: true };
}
