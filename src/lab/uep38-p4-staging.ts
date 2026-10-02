/**
 * UEP-38.4 — P4 STAGING (lab, DEV keys)
 *
 * Leader proves a Poseidon spend against SMT stateRoot.
 * Each replica: verify-hex → public_0 == local root → apply → public_1 == new root.
 *
 * NOT production: DEV Groth16 keys, in-process replicas, holds still off-circuit.
 */
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  defaultAlignedAccounts,
  bindCircuitAccounts,
  proveWithoutApply,
  type CircuitAlignedAccounts,
  type SpendProofArtifact,
} from "./uep38-zk-state-transition.ts";
import { nodeApplyVerifiedTransfer } from "./uep38-node-verify.ts";

export const P4_STAGING_PROFILE = "P4-STAGING-DEV";
export const P4_STAGING_VERSION = "38.4";

export type StagingNode = {
  id: string;
  state: SmtEconomicState;
};

export class P4StagingLab {
  readonly profile = P4_STAGING_PROFILE;
  readonly nodes: StagingNode[];
  readonly ids: CircuitAlignedAccounts;
  readonly depth: 4 | 32;

  constructor(n = 3, depth: 4 | 32 = 4, balances?: Record<string, bigint>) {
    this.depth = depth;
    this.ids = defaultAlignedAccounts();
    const initial = balances ?? { alice: 10_000n, bob: 0n };
    this.nodes = [];
    for (let i = 0; i < n; i++) {
      const state = SmtEconomicState.genesis(initial, {
        testOnlyDepth: depth,
        isTestFixture: true,
        leafMode: "poseidon-zk",
      });
      bindCircuitAccounts(state, this.ids);
      this.nodes.push({ id: `s${i}`, state });
    }
  }

  leader(): StagingNode {
    return this.nodes[0]!;
  }

  roots(): string[] {
    return this.nodes.map((n) => n.state.stateRoot());
  }

  allSameRoot(): boolean {
    const r = this.roots();
    return r.every((x) => x === r[0]);
  }

  /**
   * Leader proves; every replica including leader applies only after verify-hex.
   */
  commitTransfer(amount: bigint): {
    ok: boolean;
    reason?: string;
    artifact?: SpendProofArtifact;
    roots: string[];
  } {
    if (!this.allSameRoot()) {
      return { ok: false, reason: "REPLICA_DIVERGED_BEFORE", roots: this.roots() };
    }
    const art = proveWithoutApply(this.leader().state, this.ids, amount);
    if (!art.ok) {
      return { ok: false, reason: "PROVE_FAIL", artifact: art, roots: this.roots() };
    }
    for (const n of this.nodes) {
      const r = nodeApplyVerifiedTransfer(n.state, this.ids, amount, art);
      if (!r.ok) {
        return { ok: false, reason: `${n.id}:${r.reason}`, artifact: art, roots: this.roots() };
      }
    }
    if (!this.allSameRoot()) {
      return { ok: false, reason: "REPLICA_DIVERGED_AFTER", artifact: art, roots: this.roots() };
    }
    return { ok: true, artifact: art, roots: this.roots() };
  }
}

export function serializeStagingArtifact(art: SpendProofArtifact): string {
  return JSON.stringify({
    ok: art.ok,
    vkHex: art.vkHex,
    proofHex: art.proofHex,
    publicInputsHex: art.publicInputsHex,
    oldRootProof: art.oldRootProof,
    newRootProof: art.newRootProof,
  });
}

export function deserializeStagingArtifact(s: string): SpendProofArtifact {
  const j = JSON.parse(s) as SpendProofArtifact;
  return {
    ok: !!j.ok,
    vkHex: String(j.vkHex ?? ""),
    proofHex: String(j.proofHex ?? ""),
    publicInputsHex: Array.isArray(j.publicInputsHex) ? j.publicInputsHex.map(String) : [],
    oldRootProof: String(j.oldRootProof ?? ""),
    newRootProof: String(j.newRootProof ?? ""),
    stdout: "",
    stderr: "",
  };
}
