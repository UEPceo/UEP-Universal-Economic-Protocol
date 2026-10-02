/**
 * UEP-38.17 — P4 view-change (silent leader) on BFT-CLASSIC N=4.
 * Reuses 37.7.2 ViewChangeQC. Does not change Poseidon/SpendCircuit.
 */
import { scheduledLeader } from "./uep37-leader-schedule.ts";
import {
  assembleViewChangeQC,
  signViewChangeVote,
  type ViewChangeQC,
  type ViewChangeTarget,
  type ViewChangeVote,
} from "./uep37-view-change-qc.ts";
import type { NodeIdentity } from "./node-identity.ts";
import { P4QuorumLab } from "./uep38-p4-quorum.ts";

export const P4_VIEW_VERSION = "38.17";

export function p4Leader(ids: string[], height: number, view: number): string {
  return scheduledLeader(height, ids, view);
}

export function p4ViewTarget(
  height: number,
  nextView: number,
  reason = "SILENT_LEADER_TIMEOUT",
): ViewChangeTarget {
  return {
    networkId: "uep-p4-lab",
    domainId: 1,
    epoch: 1,
    height,
    nextView,
    reason,
  };
}

export class P4ViewLab {
  readonly lab: P4QuorumLab;
  view = 0;
  height = 1;
  lastQc: ViewChangeQC | null = null;

  constructor() {
    this.lab = new P4QuorumLab(4);
  }

  ids(): string[] {
    return this.lab.replicas.map((r) => r.id);
  }

  leader(): string {
    return p4Leader(this.ids(), this.height, this.view);
  }

  canPropose(id: string): boolean {
    return this.leader() === id;
  }

  voteViewChange(identity: NodeIdentity, nextView: number): ViewChangeVote {
    return signViewChangeVote(identity, p4ViewTarget(this.height, nextView));
  }

  adoptView(nextView: number, votes: ViewChangeVote[]): { ok: boolean; reason?: string } {
    if (nextView <= this.view) return { ok: false, reason: "VIEW_NOT_HIGHER" };
    const target = p4ViewTarget(this.height, nextView);
    const keys = new Map(this.lab.replicas.map((r) => [r.id, r.identity.publicKeyHex]));
    const qc = assembleViewChangeQC(target, votes, this.ids(), (id) => keys.get(id));
    if (!qc.ok) return { ok: false, reason: qc.reason };
    this.view = nextView;
    this.lastQc = qc.qc;
    return { ok: true };
  }

  onCommittedHeight(h: number): void {
    if (h >= this.height) {
      this.height = h + 1;
      this.view = 0;
    }
  }
}
