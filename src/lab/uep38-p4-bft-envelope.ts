/**
 * UEP-38.7 — P4 artifact inside a signed consensus PROPOSAL (opt-in).
 * Does not change 37.x digest when zkSpend is absent.
 */
import { createNodeIdentity, type NodeIdentity } from "./node-identity.ts";
import {
  sealConsensusMsg,
  verifyConsensusMsg,
  type ConsensusEnvelope,
  type ProposalPayload,
} from "./uep35-consensus-msg.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  defaultAlignedAccounts,
  bindCircuitAccounts,
  proveWithoutApply,
  type CircuitAlignedAccounts,
} from "./uep38-zk-state-transition.ts";
import { nodeApplyVerifiedTransfer } from "./uep38-node-verify.ts";
import {
  serializeStagingArtifact,
  deserializeStagingArtifact,
} from "./uep38-p4-staging.ts";
import { HeightVoteLock } from "./uep36-aggregate-semantics.ts";

export const P4_BFT_VERSION = "38.7";

export type P4ProposalExtra = ProposalPayload & {
  amount: string;
  zkSpend: string;
};

export class P4BftReplica {
  readonly id: string;
  readonly identity: NodeIdentity;
  readonly state: SmtEconomicState;
  readonly ids: CircuitAlignedAccounts;
  lastError: string | null = null;
  readonly heightLock = new HeightVoteLock();

  constructor(id: string, depth: 4 | 32 = 4) {
    this.id = id;
    this.identity = createNodeIdentity(id);
    this.ids = defaultAlignedAccounts();
    this.state = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: depth, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    bindCircuitAccounts(this.state, this.ids);
  }

  proposeSpend(amount: bigint, height: number): ConsensusEnvelope {
    const oldRoot = this.state.stateRoot();
    const art = proveWithoutApply(this.state, this.ids, amount);
    if (!art.ok) throw new Error("PROVE_FAIL");
    const local = nodeApplyVerifiedTransfer(this.state, this.ids, amount, art);
    if (!local.ok) throw new Error(local.reason);
    const payload: P4ProposalExtra = {
      batchId: `p4-${height}`,
      txDigest: art.publicInputsHex[11] ?? art.newRootProof,
      stateRoot: this.state.stateRoot(),
      epoch: 1,
      height,
      previousStateRoot: oldRoot,
      amount: amount.toString(),
      zkSpend: serializeStagingArtifact(art),
    };
    return sealConsensusMsg(this.identity, "PROPOSAL", 1, height, payload);
  }

  acceptProposal(env: ConsensusEnvelope, senderPk: string): boolean {
    if (env.type !== "PROPOSAL") {
      this.lastError = "NOT_PROPOSAL";
      return false;
    }
    if (!verifyConsensusMsg(env, senderPk)) {
      this.lastError = "BAD_ENVELOPE_SIG";
      return false;
    }
    const p = JSON.parse(env.payload) as P4ProposalExtra;
    if (!p.zkSpend) {
      this.lastError = "ZK_SPEND_REQUIRED";
      return false;
    }
    const art = deserializeStagingArtifact(p.zkSpend);
    const lock = this.heightLock.tryLock(p.epoch ?? 1, p.height ?? env.height, env.payloadDigest);
    if (!lock.ok) {
      this.lastError = lock.reason ?? "HEIGHT_VOTE_LOCK_CONFLICT";
      return false;
    }
    const r = nodeApplyVerifiedTransfer(
      this.state,
      this.ids,
      BigInt(p.amount),
      art,
    );
    if (!r.ok) {
      this.lastError = r.reason;
      return false;
    }
    return true;
  }
}
