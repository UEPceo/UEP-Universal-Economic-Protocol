/**
 * UEP-38.2 — replica verifies Groth16 before applying the SMT transition.
 */
import { pinnedVk, zkVerifyPinned } from "./zk-vk-pins.ts";
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

/** Hex of the pinned development verifying key for `depth` (see zk-vk-pins.ts). */
export function p4PinnedVk(depth: 4 | 32 = 4): string {
  return pinnedVk(depth, 1n).vkHex;
}

/**
 * Check a spend artifact against the replica's roots and verify it under the
 * pinned verifying key for (circuit version, depth, domain 1). The key carried
 * by the artifact is never used for verification.
 */
export function verifyArtifactAgainstRoots(
  art: SpendProofArtifact,
  oldRoot: string,
  expectedNewRoot?: string,
  depth: 4 | 32 = 4,
): NodeVerifyResult {
  if (!art.ok || !art.proofHex || art.publicInputsHex.length !== 13) {
    return { ok: false, reason: "ARTIFACT_INCOMPLETE" };
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
  const v = zkVerifyPinned(depth, 1n, art.proofHex, art.publicInputsHex, art.vkHex);
  if (!v.ok) {
    if (v.code === "VK_NOT_PINNED" || v.code === "VK_PIN_MISMATCH") return { ok: false, reason: "VK_NOT_PINNED" };
    return { ok: false, reason: "GROTH16_VERIFY_FAIL" };
  }
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
  const chk = verifyArtifactAgainstRoots(art, old, undefined, node.depth as 4 | 32);
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
