/**
 * UEP-36.10 — Frozen Aggregate / Proposal Semantics
 *
 * Contract rules (LAB, but authoritative for 36.x):
 *
 * 1. Height is consensus-logical: one certified transition per (epoch, height).
 * 2. Waves inside parallel-safe scheduling do NOT create heights.
 * 3. DigestAggregate commitment binds: epoch, height, previousStateRoot, entries.
 *    It does NOT bind the post-execution stateRoot (that is verified at vote time).
 * 4. Official proposal kind for multi-batch: aggregateDigest + batchIds required.
 * 5. Vote lock: a node votes at most one proposalDigest per (epoch, height).
 * 6. Leader equivocation: two distinct proposalDigests at same (epoch, height)
 *    from the same sender are evidence; honest nodes do not vote both.
 * 7. previousStateRoot must match the voter's local previous root when voting.
 */

import type { ProposalPayload } from "./uep35-consensus-msg.ts";
import { proposalDigestFromPayload } from "./uep35-consensus-msg.ts";
import {
  validateAggregateEntries,
  buildDigestAggregate,
} from "./uep36-digest-agg.ts";

export const AGGREGATE_SEMANTICS_VERSION = "36.10";

export type SemanticOk = { ok: true };
export type SemanticErr = { ok: false; reason: string };
export type SemanticResult = SemanticOk | SemanticErr;

export function heightLockKey(epoch: number, height: number): string {
  return `${epoch}|${height}`;
}

/** Structural validation of a proposal payload (single or aggregate). */
export function validateProposalSemantics(p: ProposalPayload): SemanticResult {
  if (!Number.isInteger(p.epoch) || p.epoch < 0) {
    return { ok: false, reason: "INVALID_EPOCH" };
  }
  if (!Number.isInteger(p.height) || p.height < 1) {
    return { ok: false, reason: "INVALID_HEIGHT" };
  }
  if (typeof p.previousStateRoot !== "string" || p.previousStateRoot.length === 0) {
    return { ok: false, reason: "EMPTY_PREVIOUS_ROOT" };
  }
  if (typeof p.stateRoot !== "string" || p.stateRoot.length === 0) {
    return { ok: false, reason: "EMPTY_STATE_ROOT" };
  }
  if (typeof p.batchId !== "string" || p.batchId.length === 0) {
    return { ok: false, reason: "EMPTY_BATCH_ID" };
  }

  // Aggregate path
  if (p.aggregateDigest !== undefined || (p.batchIds && p.batchIds.length > 0)) {
    if (typeof p.aggregateDigest !== "string" || p.aggregateDigest.length < 16) {
      return { ok: false, reason: "MISSING_AGGREGATE_DIGEST" };
    }
    if (!p.batchIds || p.batchIds.length === 0) {
      return { ok: false, reason: "MISSING_BATCH_IDS" };
    }
    if (!p.batchIds.includes(p.batchId)) {
      return { ok: false, reason: "BATCH_ID_NOT_IN_BATCH_IDS" };
    }
    const seen = new Set<string>();
    for (const id of p.batchIds) {
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, reason: "EMPTY_BATCH_ID_IN_LIST" };
      }
      if (seen.has(id)) return { ok: false, reason: `DUPLICATE_BATCH_ID:${id}` };
      seen.add(id);
    }
    if (p.entryDigests && p.entryDigests.length > 0) {
      const v = validateAggregateEntries(p.entryDigests);
      if (!v.ok) return v;
      const entryIds = new Set(p.entryDigests.map((e) => e.batchId));
      for (const id of p.batchIds) {
        if (!entryIds.has(id)) {
          return { ok: false, reason: `BATCH_ID_MISSING_ENTRY:${id}` };
        }
      }
      // Integrity: aggregateDigest must match recomputation from entries
      try {
        const recomputed = buildDigestAggregate(
          p.epoch,
          p.height,
          p.previousStateRoot,
          p.entryDigests,
        );
        if (recomputed.aggregateDigest !== p.aggregateDigest) {
          return { ok: false, reason: "AGGREGATE_DIGEST_MISMATCH" };
        }
      } catch (e) {
        return {
          ok: false,
          reason: `AGGREGATE_RECOMPUTE_FAIL:${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Vote-lock registry for a single node.
 * Once a digest is locked for (epoch,height), only that digest may receive a vote.
 */
export class HeightVoteLock {
  private locks = new Map<string, string>(); // key → proposalDigest
  private evidence: Array<{
    epoch: number;
    height: number;
    digestA: string;
    digestB: string;
    sender?: string;
  }> = [];

  get(epoch: number, height: number): string | undefined {
    return this.locks.get(heightLockKey(epoch, height));
  }

  /**
   * Attempt to lock (or confirm) a vote at (epoch,height).
   * Returns ok if first vote or same digest; conflict if different digest already locked.
   */
  tryLock(
    epoch: number,
    height: number,
    digest: string,
    sender?: string,
  ): SemanticResult {
    const key = heightLockKey(epoch, height);
    const existing = this.locks.get(key);
    if (existing === undefined) {
      this.locks.set(key, digest);
      return { ok: true };
    }
    if (existing === digest) return { ok: true };
    this.evidence.push({
      epoch,
      height,
      digestA: existing,
      digestB: digest,
      sender,
    });
    return { ok: false, reason: "HEIGHT_VOTE_LOCK_CONFLICT" };
  }

  /**
   * Record two proposals at same height (leader equivocation observation).
   * Does not auto-lock; used for detection/tests.
   */
  noteConflictingProposals(
    epoch: number,
    height: number,
    digestA: string,
    digestB: string,
    sender: string,
  ): void {
    if (digestA === digestB) return;
    this.evidence.push({ epoch, height, digestA, digestB, sender });
  }

  hasEvidence(): boolean {
    return this.evidence.length > 0;
  }

  getEvidence() {
    return [...this.evidence];
  }

  /** Serialize for persistence tests */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.locks);
  }

  restore(snap: Record<string, string>): void {
    this.locks = new Map(Object.entries(snap));
  }
}

/**
 * Track proposals observed per (sender, epoch, height) to detect equivocation.
 */
export class ProposalTracker {
  private bySenderHeight = new Map<string, Set<string>>(); // sender|epoch|height → digests

  observe(
    sender: string,
    epoch: number,
    height: number,
    digest: string,
  ): { equivocation: boolean; digests: string[] } {
    const key = `${sender}|${epoch}|${height}`;
    const set = this.bySenderHeight.get(key) ?? new Set();
    set.add(digest);
    this.bySenderHeight.set(key, set);
    const digests = [...set];
    return { equivocation: digests.length > 1, digests };
  }
}

/**
 * Reject vote if previousStateRoot does not match local chain tip binding.
 */
export function previousRootMatches(
  localPrevious: string,
  proposalPrevious: string,
): SemanticResult {
  if (localPrevious !== proposalPrevious) {
    return { ok: false, reason: "PREVIOUS_ROOT_MISMATCH" };
  }
  return { ok: true };
}

/** Ensure digest computation is stable for aggregate path. */
export function assertAggregateDigestBinding(p: ProposalPayload): SemanticResult {
  if (!p.aggregateDigest) return { ok: true };
  const d = proposalDigestFromPayload(p);
  if (d.length !== 64) return { ok: false, reason: "BAD_PROPOSAL_DIGEST_LEN" };
  // Recompute must be deterministic
  const d2 = proposalDigestFromPayload({ ...p });
  if (d !== d2) return { ok: false, reason: "NON_DETERMINISTIC_DIGEST" };
  return { ok: true };
}
