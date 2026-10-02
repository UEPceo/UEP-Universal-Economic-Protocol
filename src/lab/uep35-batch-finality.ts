/**
 * UEP-35.5 — Bind batch execution to existing CommitCert / FinalityCert path.
 * Does NOT create a second consensus system.
 */

import { createHash } from "node:crypto";
import type { DagBatchHeader } from "./uep35-dag.ts";
import type { TransitionProposal, CommitCert } from "./uep34-commit-cert.ts";
import {
  assembleCommitCert,
  signCommitVote,
  verifyCommitCert,
  ProposalBoard,
} from "./uep34-commit-cert.ts";
import {
  buildFinalityCertificate,
  type FinalityCertificate,
  FinalityLedger,
} from "./uep35-finality.ts";
import type { NodeIdentity } from "./node-identity.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import { proposalFromEnvelope } from "./uep34-commit-cert.ts";
import {
  FinalityBoundLedger,
  type FinalizedSpend,
} from "./uep35-ledger-finality.ts";

/** Canonical proposal digest binding batch + postStateRoot + epoch/height. */
export function batchProposalBinding(input: {
  batchId: string;
  txDigest: string;
  postStateRoot: string;
  epoch: number;
  height: number;
}): string {
  return createHash("sha256")
    .update(
      [
        "UEP-35.5-BATCH-PROP",
        input.batchId,
        input.txDigest,
        input.postStateRoot,
        String(input.epoch),
        String(input.height),
      ].join("|"),
    )
    .digest("hex");
}

export function proposalFromBatchHeader(
  leader: NodeIdentity,
  header: DagBatchHeader,
  postStateRoot: string,
  networkId = "local",
  domainId = 1,
): TransitionProposal {
  const binding = batchProposalBinding({
    batchId: header.batchId,
    txDigest: header.txDigest,
    postStateRoot,
    epoch: header.epoch,
    height: header.height,
  });
  const env = signEnvelope(leader, {
    protocolVersion: NODE_PROTOCOL_VERSION,
    networkId,
    domainId,
    sequence: header.height,
    previousStateRoot: header.height <= 1 ? "GENESIS" : `PREV-${header.height - 1}`,
    newStateRoot: postStateRoot,
    transitionId: binding.slice(0, 32),
    nullifier: `NF-BATCH-${header.batchId}`,
    transactionCommitment: header.txDigest,
    ts: header.ts,
  });
  return proposalFromEnvelope(env);
}

export function commitAndFinalizeBatch(opts: {
  leader: NodeIdentity;
  finalizers: NodeIdentity[];
  header: DagBatchHeader;
  postStateRoot: string;
  networkId?: string;
  domainId?: number;
}): {
  proposal: TransitionProposal;
  cert: CommitCert;
  finality: FinalityCertificate;
  verifyOk: boolean;
} {
  const board = new ProposalBoard();
  const proposal = proposalFromBatchHeader(
    opts.leader,
    opts.header,
    opts.postStateRoot,
    opts.networkId,
    opts.domainId,
  );
  board.register(proposal);
  const votes = opts.finalizers.map((id) =>
    signCommitVote(id, proposal.digest),
  );
  const cert = assembleCommitCert(proposal, votes);
  const candidates = opts.finalizers.map((f) => f.nodeId);
  const keys: Record<string, string> = {};
  for (const f of opts.finalizers) keys[f.nodeId] = f.publicKeyHex;
  const vr = verifyCommitCert(
    cert,
    candidates,
    (id) => keys[id],
    board,
    { bftProfile: "BFT-CLASSIC" },
  );
  const finality = buildFinalityCertificate(proposal, cert, {
    networkId: opts.networkId ?? "local",
    domainId: opts.domainId ?? 1,
    epoch: opts.header.epoch,
    finalizers: opts.finalizers,
  });
  return {
    proposal,
    cert,
    finality,
    verifyOk: vr.ok,
  };
}

/** Reject certificate if batch/root/epoch/height mismatch. */
export function assertCertMatchesBatch(
  cert: CommitCert,
  header: DagBatchHeader,
  postStateRoot: string,
): { ok: true } | { ok: false; reason: string } {
  if (cert.proposal.newStateRoot !== postStateRoot) {
    return { ok: false, reason: "ROOT_MISMATCH" };
  }
  if (cert.proposal.sequence !== header.height) {
    return { ok: false, reason: "SEQUENCE_MISMATCH" };
  }
  const expectedBinding = batchProposalBinding({
    batchId: header.batchId,
    txDigest: header.txDigest,
    postStateRoot,
    epoch: header.epoch,
    height: header.height,
  });
  if (cert.proposal.transitionId !== expectedBinding.slice(0, 32)) {
    return { ok: false, reason: "BINDING_MISMATCH" };
  }
  return { ok: true };
}
