/**
 * UEP-38.6 — P4 Staging over TCP mesh (localhost).
 * Wire kind: P4_SPEND  payload = UTF-8 JSON { amount, artifact }
 */
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
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

export const P4_MESH_KIND = "P4_SPEND";
export const P4_MESH_VERSION = "38.6";

export class P4MeshNode {
  readonly id: string;
  readonly mesh: TcpMeshEndpoint;
  readonly state: SmtEconomicState;
  readonly ids: CircuitAlignedAccounts;
  lastError: string | null = null;
  received = 0;

  constructor(id: string, depth: 4 | 32 = 4) {
    this.id = id;
    this.mesh = new TcpMeshEndpoint(id);
    this.ids = defaultAlignedAccounts();
    this.state = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n },
      { testOnlyDepth: depth, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    bindCircuitAccounts(this.state, this.ids);
    this.mesh.onMessage((_from, kind, payload) => {
      if (kind !== P4_MESH_KIND) return;
      this.received++;
      try {
        const msg = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          amount: string;
          artifact: string;
        };
        const art = deserializeStagingArtifact(msg.artifact);
        const r = nodeApplyVerifiedTransfer(
          this.state,
          this.ids,
          BigInt(msg.amount),
          art,
        );
        if (!r.ok) this.lastError = r.reason;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  async listen(): Promise<number> {
    return this.mesh.listen("127.0.0.1", 0);
  }

  async connect(peerId: string, port: number): Promise<void> {
    await this.mesh.connectPeer(peerId, "127.0.0.1", port);
  }

  async commitAndBroadcast(amount: bigint): Promise<{ ok: boolean; reason?: string }> {
    const art = proveWithoutApply(this.state, this.ids, amount);
    if (!art.ok) return { ok: false, reason: "PROVE_FAIL" };
    const local = nodeApplyVerifiedTransfer(this.state, this.ids, amount, art);
    if (!local.ok) return { ok: false, reason: local.reason };
    const body = Buffer.from(
      JSON.stringify({
        amount: amount.toString(),
        artifact: serializeStagingArtifact(art),
      }),
      "utf8",
    );
    this.mesh.broadcast(P4_MESH_KIND, body);
    return { ok: true };
  }

  async close(): Promise<void> {
    await this.mesh.close();
  }
}
