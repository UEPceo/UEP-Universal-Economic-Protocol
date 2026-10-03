/**
 * UEP-38.8 — verify first, apply only after 2f+1 votes (N=4 → 3).
 */
import { signBytes, verifyBytes } from "./node-identity.ts";
import type { ConsensusEnvelope } from "./uep35-consensus-msg.ts";
import { payloadDigest, verifyConsensusMsg } from "./uep35-consensus-msg.ts";
import { scheduledLeader } from "./uep37-leader-schedule.ts";
import { verifyArtifactAgainstRoots } from "./uep38-node-verify.ts";
import { nodeApplyVerifiedTransfer } from "./uep38-node-verify.ts";
import { deserializeStagingArtifact } from "./uep38-p4-staging.ts";
import { P4BftReplica, type P4ProposalExtra } from "./uep38-p4-bft-envelope.ts";
import { proveWithoutApply } from "./uep38-zk-state-transition.ts";
import { sealConsensusMsg } from "./uep35-consensus-msg.ts";
import { serializeStagingArtifact } from "./uep38-p4-staging.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";

export const P4_QUORUM_VERSION = "38.21";
export const P4_QUORUM_N = 4;
export const P4_QUORUM_NEED = 3; // BFT-CLASSIC N=4 f=1

export type P4Vote = { nodeId: string; digest: string; signature: string; spendCertSig?: string };

export function p4VoteBody(digest: string, height: number, epoch = 1, view = 0, networkId = "uep-p4-lab"): string {
  return `UEP-38.21-P4-VOTE|${networkId}|${epoch}|${view}|${height}|${digest}`;
}

export class P4QuorumLab {
  readonly replicas: P4BftReplica[];

  constructor(depth: 4 | 32 = 4) {
    const gate = assertBftConfig(4, "BFT-CLASSIC");
    if (!gate.ok) throw new Error(gate.reason);
    this.replicas = [
      new P4BftReplica("q0", depth),
      new P4BftReplica("q1", depth),
      new P4BftReplica("q2", depth),
      new P4BftReplica("q3", depth),
    ];
  }

  pk(id: string): string {
    return this.replicas.find((r) => r.id === id)!.identity.publicKeyHex;
  }

  /** Prove without applying on any replica. */
  buildProposal(amount: bigint, height: number): ConsensusEnvelope {
    const leader = this.replicas[0]!;
    const oldRoot = leader.state.stateRoot();
    const art = proveWithoutApply(leader.state, leader.ids, amount);
    if (!art.ok) throw new Error("PROVE_FAIL");
    const payload: P4ProposalExtra = {
      batchId: `p4q-${height}`,
      txDigest: art.newRootProof,
      stateRoot: art.newRootProof,
      epoch: 1,
      height,
      previousStateRoot: oldRoot,
      amount: amount.toString(),
      zkSpend: serializeStagingArtifact(art),
    };
    return sealConsensusMsg(leader.identity, "PROPOSAL", 1, height, payload);
  }

  inspect(env: ConsensusEnvelope, replica: P4BftReplica): { ok: boolean; reason?: string } {
    if (!verifyConsensusMsg(env, this.pk(env.sender))) {
      return { ok: false, reason: "BAD_ENVELOPE_SIG" };
    }
    const p = JSON.parse(env.payload) as P4ProposalExtra;
    const art = deserializeStagingArtifact(p.zkSpend);
    const v = verifyArtifactAgainstRoots(art, replica.state.stateRoot(), p.stateRoot, replica.state.depth as 4 | 32);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true };
  }

  vote(env: ConsensusEnvelope, replica: P4BftReplica): P4Vote | null {
    const ins = this.inspect(env, replica);
    if (!ins.ok) {
      replica.lastError = ins.reason ?? "INSPECT_FAIL";
      return null;
    }
    const lock = replica.heightLock.tryLock(env.epoch, env.height, env.payloadDigest, replica.id);
    if (!lock.ok) {
      replica.lastError = lock.reason ?? "HEIGHT_VOTE_LOCK_CONFLICT";
      return null;
    }
    const p = JSON.parse(env.payload) as { view?: number };
    const ids = this.replicas.map((r) => r.id);
    if (env.sender !== scheduledLeader(env.height, ids, p.view ?? 0)) {
      replica.lastError = "NOT_LEADER";
      return null;
    }
    const body = p4VoteBody(env.payloadDigest, env.height, env.epoch, p.view ?? 0);
    return {
      nodeId: replica.id,
      digest: env.payloadDigest,
      signature: signBytes(replica.identity, body),
    };
  }

  votesValid(env: ConsensusEnvelope, votes: P4Vote[]): P4Vote[] {
    let view = 0;
    try { view = Number((JSON.parse(env.payload) as { view?: number }).view ?? 0); } catch { return []; }
    const body = p4VoteBody(env.payloadDigest, env.height, env.epoch, view);
    const seen = new Set<string>();
    const ok: P4Vote[] = [];
    for (const v of votes) {
      if (v.digest !== env.payloadDigest) continue;
      if (seen.has(v.nodeId)) continue;
      const pk = this.replicas.find((r) => r.id === v.nodeId)?.identity.publicKeyHex;
      if (!pk) continue;
      if (!verifyBytes(pk, body, v.signature)) continue;
      seen.add(v.nodeId);
      ok.push(v);
    }
    return ok;
  }

  private envelopeOk(env: ConsensusEnvelope): { ok: boolean; reason?: string } {
    if (payloadDigest(env.payload) !== env.payloadDigest) return { ok: false, reason: "DIGEST_MISMATCH" };
    const pk = this.pk(env.sender);
    if (!pk || !verifyConsensusMsg(env, pk)) return { ok: false, reason: "BAD_ENVELOPE_SIG" };
    try {
      const p = JSON.parse(env.payload) as { view?: number };
      const ids = this.replicas.map((r) => r.id);
      if (env.sender !== scheduledLeader(env.height, ids, p.view ?? 0)) return { ok: false, reason: "NOT_LEADER" };
    } catch {
      return { ok: false, reason: "BAD_PAYLOAD" };
    }
    return { ok: true };
  }

  commit(
    env: ConsensusEnvelope,
    votes: P4Vote[],
    only?: P4BftReplica[],
  ): { ok: boolean; reason?: string } {
    const bound = this.envelopeOk(env);
    if (!bound.ok) return bound;
    const good = this.votesValid(env, votes);
    if (good.length < P4_QUORUM_NEED) {
      return { ok: false, reason: `NO_QUORUM:${good.length}` };
    }
    let p: P4ProposalExtra;
    try { p = JSON.parse(env.payload) as P4ProposalExtra; } catch { return { ok: false, reason: "BAD_PAYLOAD" }; }
    const art = deserializeStagingArtifact(p.zkSpend);
    const want = art.newRootProof.replace(/^0x/i, "").toLowerCase();
    for (const r of only ?? this.replicas) {
      const have = r.state.stateRoot().replace(/^0x/i, "").toLowerCase();
      if (have === want) continue;
      const applied = nodeApplyVerifiedTransfer(r.state, r.ids, BigInt(p.amount), art);
      if (!applied.ok) return { ok: false, reason: `${r.id}:${applied.reason}` };
    }
    return { ok: true };
  }

  /** Late replica: apply a certified commit without having voted. */
  catchUp(
    replica: (typeof this.replicas)[number],
    env: ConsensusEnvelope,
    votes: P4Vote[],
  ): { ok: boolean; reason?: string } {
    const bound = this.envelopeOk(env);
    if (!bound.ok) return bound;
    const good = this.votesValid(env, votes);
    if (good.length < P4_QUORUM_NEED) {
      return { ok: false, reason: `NO_QUORUM:${good.length}` };
    }
    let p: P4ProposalExtra;
    try { p = JSON.parse(env.payload) as P4ProposalExtra; } catch { return { ok: false, reason: "BAD_PAYLOAD" }; }
    const art = deserializeStagingArtifact(p.zkSpend);
    const v = verifyArtifactAgainstRoots(art, replica.state.stateRoot(), p.stateRoot, replica.state.depth as 4 | 32);
    if (!v.ok) return { ok: false, reason: v.reason };
    const want = art.newRootProof.replace(/^0x/i, "").toLowerCase();
    const have = replica.state.stateRoot().replace(/^0x/i, "").toLowerCase();
    if (have !== want) {
      const applied = nodeApplyVerifiedTransfer(
        replica.state,
        replica.ids,
        BigInt(p.amount),
        art,
      );
      if (!applied.ok) return { ok: false, reason: applied.reason };
    }
    replica.heightLock.tryLock(env.epoch, env.height, env.payloadDigest, replica.id);
    return { ok: true };
  }
}
