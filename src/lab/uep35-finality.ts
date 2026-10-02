/**
 * UEP-35.0 — Finality model (specification + lab enforcement).
 *
 * FINAL means: a transition (or batch) is irreversible under the assumed
 * fault model once a valid FinalityCertificate exists and is accepted.
 *
 * Stages (lab):
 *   PROPOSED  → proposal registered on ProposalBoard
 *   COMMITTED → CommitCert with ≥ quorum signatures
 *   FINAL     → FinalityCertificate recorded (same cert + explicit finalize step)
 *
 * Not production BFT finality under asynchronous partitions without dissemination.
 */

import type { CommitCert, TransitionProposal } from "./uep34-commit-cert.ts";
import { verifyCommitCert } from "./uep34-commit-cert.ts";
import { bftParamsFromN, type BftParams } from "./uep34-bft-params.ts";
import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";

export type FinalityStage = "none" | "proposed" | "committed" | "final";

export type FinalityCertificate = {
  type: "finality_cert";
  /** Same digest as CommitCert proposal. */
  proposalDigest: string;
  sequence: number;
  stateRoot: string;
  nullifier?: string;
  transitionId?: string;
  networkId: string;
  domainId: number;
  epoch: number;
  /** CommitCert that justified finality. */
  commitCert: CommitCert;
  /** Optional extra finalizer signatures (may equal commit voters). */
  finalizerVotes: { nodeId: string; signature: string }[];
  ts: number;
};

export function finalityVoteBody(fc: Omit<FinalityCertificate, "finalizerVotes" | "ts"> & { ts: number }): string {
  return [
    "UEP-35-FINAL",
    fc.networkId,
    String(fc.domainId),
    String(fc.epoch),
    fc.proposalDigest,
    String(fc.sequence),
    fc.stateRoot,
    fc.nullifier ?? "",
    fc.transitionId ?? "",
    String(fc.ts),
  ].join("|");
}

export function signFinalityVote(
  identity: NodeIdentity,
  partial: Omit<FinalityCertificate, "finalizerVotes" | "type">,
): { nodeId: string; signature: string } {
  return {
    nodeId: identity.nodeId,
    signature: signBytes(
      identity,
      finalityVoteBody({ ...partial, type: "finality_cert" }),
    ),
  };
}

export type FinalityRecord = {
  stage: FinalityStage;
  sequence: number;
  stateRoot: string;
  proposalDigest: string;
  cert?: FinalityCertificate;
};

/**
 * Tracks finality per sequence on a node. Double-finality of two different
 * digests at the same sequence is rejected.
 */
export class FinalityLedger {
  private bySeq = new Map<number, FinalityRecord>();
  private byDigest = new Map<string, FinalityRecord>();

  get(sequence: number): FinalityRecord | undefined {
    return this.bySeq.get(sequence);
  }

  markProposed(sequence: number, stateRoot: string, digest: string): void {
    if (this.bySeq.has(sequence) && this.bySeq.get(sequence)!.proposalDigest !== digest) {
      throw new Error("FINALITY_CONFLICT_PROPOSED");
    }
    const rec: FinalityRecord = {
      stage: "proposed",
      sequence,
      stateRoot,
      proposalDigest: digest,
    };
    this.bySeq.set(sequence, rec);
    this.byDigest.set(digest, rec);
  }

  markCommitted(sequence: number, digest: string): { ok: true } | { ok: false; reason: string } {
    const rec = this.bySeq.get(sequence);
    if (!rec) {
      // allow commit without explicit proposed if digest is new
      this.bySeq.set(sequence, {
        stage: "committed",
        sequence,
        stateRoot: "",
        proposalDigest: digest,
      });
      this.byDigest.set(digest, this.bySeq.get(sequence)!);
      return { ok: true };
    }
    if (rec.proposalDigest !== digest) {
      return { ok: false, reason: "FINALITY_DIGEST_CONFLICT" };
    }
    if (rec.stage === "final") return { ok: true };
    rec.stage = "committed";
    return { ok: true };
  }

  /**
   * Accept FinalityCertificate: requires valid CommitCert + no conflicting FINAL.
   */
  acceptFinal(
    fc: FinalityCertificate,
    candidates: string[],
    publicKeyOf: (id: string) => string | undefined,
    opts?: { requireClassicBft?: boolean },
  ): { ok: true } | { ok: false; reason: string } {
    const existing = this.bySeq.get(fc.sequence);
    if (existing && existing.stage === "final") {
      if (existing.proposalDigest === fc.proposalDigest) return { ok: true }; // idempotent
      return { ok: false, reason: "DOUBLE_FINALITY" };
    }
    if (existing && existing.proposalDigest && existing.proposalDigest !== fc.proposalDigest) {
      return { ok: false, reason: "FINALITY_DIGEST_CONFLICT" };
    }

    if (opts?.requireClassicBft) {
      const p = bftParamsFromN(candidates.length);
      if (!p.classic) return { ok: false, reason: "NON_CLASSIC_BFT_N" };
    }

    const vr = verifyCommitCert(
      fc.commitCert,
      candidates,
      publicKeyOf,
    );
    if (!vr.ok) return { ok: false, reason: `COMMIT_CERT:${vr.reason}` };

    if (fc.commitCert.proposal.digest !== fc.proposalDigest) {
      return { ok: false, reason: "FINAL_DIGEST_MISMATCH" };
    }
    if (fc.commitCert.proposal.sequence !== fc.sequence) {
      return { ok: false, reason: "FINAL_SEQUENCE_MISMATCH" };
    }
    if (fc.commitCert.proposal.newStateRoot !== fc.stateRoot) {
      return { ok: false, reason: "FINAL_ROOT_MISMATCH" };
    }

    // Optional finalizer votes (if present, need quorum)
    if (fc.finalizerVotes.length > 0) {
      const params = bftParamsFromN(candidates.length);
      const seen = new Set<string>();
      let valid = 0;
      const body = finalityVoteBody(fc);
      for (const v of fc.finalizerVotes) {
        if (seen.has(v.nodeId)) continue;
        if (!candidates.includes(v.nodeId)) continue;
        const pk = publicKeyOf(v.nodeId);
        if (!pk || !verifyBytes(pk, body, v.signature)) continue;
        seen.add(v.nodeId);
        valid++;
      }
      if (valid < params.quorum) {
        return { ok: false, reason: `FINALIZER_QUORUM:${valid}/${params.quorum}` };
      }
    }

    const rec: FinalityRecord = {
      stage: "final",
      sequence: fc.sequence,
      stateRoot: fc.stateRoot,
      proposalDigest: fc.proposalDigest,
      cert: fc,
    };
    this.bySeq.set(fc.sequence, rec);
    this.byDigest.set(fc.proposalDigest, rec);
    return { ok: true };
  }

  isFinal(sequence: number): boolean {
    return this.bySeq.get(sequence)?.stage === "final";
  }

  /** Highest FINAL sequence (or -1). */
  lastFinalSequence(): number {
    let max = -1;
    for (const [seq, r] of this.bySeq) {
      if (r.stage === "final" && seq > max) max = seq;
    }
    return max;
  }
}

export function buildFinalityCertificate(
  proposal: TransitionProposal,
  commitCert: CommitCert,
  opts: {
    networkId: string;
    domainId: number;
    epoch: number;
    finalizers: NodeIdentity[];
  },
): FinalityCertificate {
  const base = {
    type: "finality_cert" as const,
    proposalDigest: proposal.digest,
    sequence: proposal.sequence,
    stateRoot: proposal.newStateRoot,
    nullifier: proposal.nullifier,
    transitionId: proposal.transitionId,
    networkId: opts.networkId,
    domainId: opts.domainId,
    epoch: opts.epoch,
    commitCert,
    ts: Date.now(),
  };
  const finalizerVotes = opts.finalizers.map((id) =>
    signFinalityVote(id, base),
  );
  return { ...base, finalizerVotes };
}

export type { BftParams };
