/**
 * UEP-36.9 — LAB snapshot of consensus-critical node state for restart simulation.
 * Not a production WAL. Preserves vote locks + economic tip so a "restarted"
 * node cannot double-vote an old height.
 */

import type { IndependentNode } from "./uep35-multinode.ts";
import { HeightVoteLock } from "./uep36-aggregate-semantics.ts";

export type NodeConsensusSnapshot = {
  version: "36.9.1";
  nodeId: string;
  epoch: number;
  sequence: number;
  stateRoot: string;
  previousRoot: string;
  voteLocks: Record<string, string>;
  finalizedBatchIds: string[];
  appliedBatchIds: string[];
  /** Phase A.1 / D-1: durable anti-replay (must survive restart). */
  appliedTxIds: string[];
  authNonces: string[];
  commitCertDigests: string[];
  finalityCertDigests: string[];
};

export function snapshotNodeConsensus(node: IndependentNode): NodeConsensusSnapshot {
  return {
    version: "36.9",
    nodeId: node.id,
    epoch: 0, // LAB single-epoch
    sequence: node.economic.sequence,
    stateRoot: node.economic.stateRoot(),
    previousRoot: node.economic.previousRoot(),
    voteLocks: node.voteLock.snapshot(),
    finalizedBatchIds: [...node.economic.finalizedBatchIds],
    appliedBatchIds: [...node.appliedBatches],
    appliedTxIds: [...(node.economic as { appliedTxIds?: Set<string> }).appliedTxIds ?? []],
    authNonces: [...(node.economic as { authNonces?: Set<string> }).authNonces ?? []],
    commitCertDigests: [...node.commitCerts.keys()],
    finalityCertDigests: [...node.finalityCerts.keys()],
  };
}

/**
 * Soft restart: clear transient message/vote de-dupe sets, restore vote locks.
 * Economic state and certificates remain (simulates durable store already applied).
 */
export function softRestartNode(node: IndependentNode, snap?: NodeConsensusSnapshot): void {
  const lockSnap = snap?.voteLocks ?? node.voteLock.snapshot();
  node.seenMsgIds.clear();
  node.seenVotes.clear();
  node.votes.clear();
  node.pendingProposals.clear();
  node.voteLock = new HeightVoteLock();
  node.voteLock.restore(lockSnap);
  if (snap?.appliedTxIds && "appliedTxIds" in node.economic) {
    (node.economic as { appliedTxIds: Set<string> }).appliedTxIds = new Set(snap.appliedTxIds);
  }
  if (snap?.authNonces && "authNonces" in node.economic) {
    (node.economic as { authNonces: Set<string> }).authNonces = new Set(snap.authNonces);
  }
}

export function voteLockBlocks(
  node: IndependentNode,
  epoch: number,
  height: number,
  otherDigest: string,
): boolean {
  const existing = node.voteLock.get(epoch, height);
  if (!existing) return false;
  if (existing === otherDigest) return false;
  return !node.voteLock.tryLock(epoch, height, otherDigest).ok;
}
