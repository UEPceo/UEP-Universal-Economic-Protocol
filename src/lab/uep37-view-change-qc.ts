/**
 * UEP-37.7.2 — Signed View-Change Quorum Certificate
 *
 * A single VIEW_CHANGE message is NOT sufficient to adopt a new view.
 * Adoption requires a ViewChangeQC with ≥ quorum distinct replica signatures
 * over the canonical target digest.
 *
 * Quorum (explicit):
 * - Prefer BFT-CLASSIC when N = 3f+1 → quorum = 2f+1
 * - Else LAB-MAJORITY → quorum = floor(N/2)+1
 *
 * Domain separation: UEP-37.7.2-VC|
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import { bftParamsFromN, type BftParams } from "./uep34-bft-params.ts";
import type { ViewChangeReason } from "./uep37-leader-schedule.ts";

export const VIEW_CHANGE_QC_VERSION = "37.7.2";

export type ViewChangeTarget = {
  networkId: string;
  domainId: number;
  epoch: number;
  /** Consensus height waiting for a leader (next height to propose). */
  height: number;
  /** View being proposed (must be > current local view to adopt). */
  nextView: number;
  reason: ViewChangeReason | string;
  /** Last committed state root. Absent on older certificates. */
  anchorRoot?: string;
};

export type ViewChangeVote = {
  nodeId: string;
  targetDigest: string;
  signature: string;
};

export type ViewChangeQC = {
  target: ViewChangeTarget;
  targetDigest: string;
  votes: ViewChangeVote[];
};

/** Canonical digest of a view-change target (what each replica signs). */
export function viewChangeTargetDigest(t: ViewChangeTarget): string {
  return [
    "UEP-37.7.2-VC",
    t.networkId,
    String(t.domainId),
    String(t.epoch),
    String(t.height),
    String(t.nextView),
    t.reason,
    ...(t.anchorRoot ? [t.anchorRoot] : []),
  ].join("|");
}

export function viewChangeQuorum(n: number): BftParams {
  return bftParamsFromN(n);
}

export function signViewChangeVote(
  identity: NodeIdentity,
  target: ViewChangeTarget,
): ViewChangeVote {
  const targetDigest = viewChangeTargetDigest(target);
  const signature = signBytes(identity, targetDigest);
  return { nodeId: identity.nodeId, targetDigest, signature };
}

export function verifyViewChangeVote(
  vote: ViewChangeVote,
  target: ViewChangeTarget,
  publicKeyHex: string,
): boolean {
  const expected = viewChangeTargetDigest(target);
  if (vote.targetDigest !== expected) return false;
  return verifyBytes(publicKeyHex, expected, vote.signature);
}

export type AssembleQcResult =
  | { ok: true; qc: ViewChangeQC }
  | { ok: false; reason: string };

/**
 * Assemble QC from votes. Requires ≥ quorum distinct valid signers
 * in candidateIds, all matching the same target digest.
 */
export function assembleViewChangeQC(
  target: ViewChangeTarget,
  votes: ViewChangeVote[],
  candidateIds: string[],
  publicKeyOf: (nodeId: string) => string | undefined,
): AssembleQcResult {
  const targetDigest = viewChangeTargetDigest(target);
  const allowed = new Set(candidateIds);
  const seen = new Set<string>();
  const accepted: ViewChangeVote[] = [];

  for (const v of votes) {
    if (!allowed.has(v.nodeId)) continue;
    if (seen.has(v.nodeId)) continue; // first vote wins; duplicates ignored
    if (v.targetDigest !== targetDigest) continue;
    const pk = publicKeyOf(v.nodeId);
    if (!pk) continue;
    if (!verifyViewChangeVote(v, target, pk)) continue;
    seen.add(v.nodeId);
    accepted.push(v);
  }

  const { quorum, n } = viewChangeQuorum(candidateIds.length);
  if (accepted.length < quorum) {
    return {
      ok: false,
      reason: `QC_INSUFFICIENT:${accepted.length}/${quorum}_N=${n}`,
    };
  }

  accepted.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return {
    ok: true,
    qc: { target, targetDigest, votes: accepted },
  };
}

export type VerifyQcResult =
  | { ok: true; params: BftParams }
  | { ok: false; reason: string };

export function verifyViewChangeQC(
  qc: ViewChangeQC,
  candidateIds: string[],
  publicKeyOf: (nodeId: string) => string | undefined,
  expected?: Partial<ViewChangeTarget>,
): VerifyQcResult {
  const expectedDigest = viewChangeTargetDigest(qc.target);
  if (qc.targetDigest !== expectedDigest) {
    return { ok: false, reason: "TARGET_DIGEST_MISMATCH" };
  }
  if (expected) {
    if (expected.networkId !== undefined && qc.target.networkId !== expected.networkId) {
      return { ok: false, reason: "NETWORK_MISMATCH" };
    }
    if (expected.domainId !== undefined && qc.target.domainId !== expected.domainId) {
      return { ok: false, reason: "DOMAIN_MISMATCH" };
    }
    if (expected.epoch !== undefined && qc.target.epoch !== expected.epoch) {
      return { ok: false, reason: "EPOCH_MISMATCH" };
    }
    if (expected.height !== undefined && qc.target.height !== expected.height) {
      return { ok: false, reason: "HEIGHT_MISMATCH" };
    }
  }

  const params = viewChangeQuorum(candidateIds.length);
  const allowed = new Set(candidateIds);
  const seen = new Set<string>();
  let valid = 0;
  for (const v of qc.votes) {
    if (!allowed.has(v.nodeId)) return { ok: false, reason: `UNKNOWN_SIGNER:${v.nodeId}` };
    if (seen.has(v.nodeId)) return { ok: false, reason: `DUPLICATE_SIGNER:${v.nodeId}` };
    const pk = publicKeyOf(v.nodeId);
    if (!pk) return { ok: false, reason: `NO_KEY:${v.nodeId}` };
    if (!verifyViewChangeVote(v, qc.target, pk)) {
      return { ok: false, reason: `BAD_SIG:${v.nodeId}` };
    }
    seen.add(v.nodeId);
    valid++;
  }
  if (valid < params.quorum) {
    return { ok: false, reason: `QC_INSUFFICIENT:${valid}/${params.quorum}` };
  }
  return { ok: true, params };
}

/** True if qc.nextView is strictly greater than localView for same height. */
export function canAdoptViewChangeQC(
  qc: ViewChangeQC,
  local: { height: number; heightView: number; networkId: string; domainId: number; epoch: number },
): { ok: true } | { ok: false; reason: string } {
  if (qc.target.networkId !== local.networkId) return { ok: false, reason: "NETWORK" };
  if (qc.target.domainId !== local.domainId) return { ok: false, reason: "DOMAIN" };
  if (qc.target.epoch !== local.epoch) return { ok: false, reason: "EPOCH" };
  if (qc.target.height !== local.height) return { ok: false, reason: "HEIGHT" };
  if (qc.target.nextView <= local.heightView) return { ok: false, reason: "STALE_VIEW" };
  return { ok: true };
}
