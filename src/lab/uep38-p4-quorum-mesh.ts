/**
 * UEP-38.9 — 38.8 quorum over TcpMeshEndpoint (localhost).
 * Kinds: P4_PROPOSAL | P4_VOTE | P4_COMMIT
 */
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
import type { ConsensusEnvelope } from "./uep35-consensus-msg.ts";
import { P4QuorumLab, type P4Vote, P4_QUORUM_NEED } from "./uep38-p4-quorum.ts";

export const P4_QMESH_VERSION = "38.9";

export class P4QuorumMesh {
  readonly lab: P4QuorumLab;
  readonly meshes: TcpMeshEndpoint[];
  votes: P4Vote[] = [];
  committed = false;
  lastError: string | null = null;
  env: ConsensusEnvelope | null = null;

  constructor(depth: 4 | 32 = 4) {
    this.lab = new P4QuorumLab(depth);
    this.meshes = this.lab.replicas.map((r) => new TcpMeshEndpoint(r.id));
    for (let i = 0; i < this.meshes.length; i++) {
      const idx = i;
      this.meshes[i]!.onMessage((_from, kind, payload) => {
        this.onKind(idx, kind, payload);
      });
    }
  }

  private onKind(idx: number, kind: string, payload: Uint8Array): void {
    try {
      const text = Buffer.from(payload).toString("utf8");
      if (kind === "P4_PROPOSAL") {
        const env = JSON.parse(text) as ConsensusEnvelope;
        this.env = env;
        const v = this.lab.vote(env, this.lab.replicas[idx]!);
        if (v) this.meshes[idx]!.broadcast("P4_VOTE", Buffer.from(JSON.stringify(v), "utf8"));
      } else if (kind === "P4_VOTE") {
        const v = JSON.parse(text) as P4Vote;
        if (!this.votes.some((x) => x.nodeId === v.nodeId && x.digest === v.digest)) {
          this.votes.push(v);
        }
        this.tryCommit();
      } else if (kind === "P4_COMMIT") {
        if (this.committed) return;
        const body = JSON.parse(text) as { env: ConsensusEnvelope; votes: P4Vote[] };
        const r = this.lab.commit(body.env, body.votes);
        if (!r.ok) this.lastError = r.reason ?? "COMMIT_FAIL";
        else this.committed = true;
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private tryCommit(): void {
    if (this.committed || !this.env) return;
    const good = this.lab.votesValid(this.env, this.votes);
    if (good.length < P4_QUORUM_NEED) return;
    const body = Buffer.from(JSON.stringify({ env: this.env, votes: good }), "utf8");
    this.meshes[0]!.broadcast("P4_COMMIT", body);
    const r = this.lab.commit(this.env, good);
    if (!r.ok) this.lastError = r.reason ?? "COMMIT_FAIL";
    else this.committed = true;
  }

  async start(): Promise<void> {
    const ports: number[] = [];
    for (const m of this.meshes) ports.push(await m.listen("127.0.0.1", 0));
    for (let i = 0; i < this.meshes.length; i++) {
      for (let j = 0; j < this.meshes.length; j++) {
        if (i === j) continue;
        await this.meshes[i]!.connectPeer(this.lab.replicas[j]!.id, "127.0.0.1", ports[j]!);
      }
    }
  }

  async propose(amount: bigint, height: number): Promise<void> {
    const env = this.lab.buildProposal(amount, height);
    this.env = env;
    const raw = Buffer.from(JSON.stringify(env), "utf8");
    this.meshes[0]!.broadcast("P4_PROPOSAL", raw);
    const v0 = this.lab.vote(env, this.lab.replicas[0]!);
    if (v0) {
      this.votes.push(v0);
      this.meshes[0]!.broadcast("P4_VOTE", Buffer.from(JSON.stringify(v0), "utf8"));
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.meshes.map((m) => m.close()));
  }
}
