/**
 * UEP-33 — Multi-process / multi-machine lab cluster helper.
 *
 * Three independent AuthNetworkNode instances (sequencer + 2 replicas),
 * optional disk persistence, disconnect/reconnect + catch-up.
 *
 * Same code path works for:
 *   - one host, three processes (lab)
 *   - three hosts (set sequencerHost / listenHost=0.0.0.0)
 */

import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
  type NodeIdentity,
} from "./node-identity.ts";
import { LabNode } from "./node-protocol.ts";
import { AuthNetworkNode, sleep } from "./node-auth-transport.ts";
import {
  VerifyingKeyRegistry,
  pinProverArtifact,
} from "./verifying-key-registry.ts";
import {
  saveLabNodeState,
  loadLabNodeState,
  applyDiskState,
} from "./lab-node-persist.ts";
import path from "node:path";
import fs from "node:fs";

export type Uep33ClusterConfig = {
  networkId?: string;
  domainId?: number;
  dataDir?: string;
  listenHost?: string;
  requireZkVerify?: boolean;
  /** Shared pinned VK (optional; structural lab may omit). */
  pinnedVk?: { vkId: string; vkHex: string };
};

export type ClusterHandles = {
  seqId: NodeIdentity;
  seq: AuthNetworkNode;
  r1: AuthNetworkNode;
  r2: AuthNetworkNode;
  nodeRegistry: NodeRegistry;
  vkRegistry: VerifyingKeyRegistry;
  seqPort: number;
  dataDir: string;
  stop: () => Promise<void>;
  persist: () => void;
  /** Simulate replica offline: close transport only. */
  disconnectReplica: (which: 1 | 2) => Promise<void>;
  /** Reconnect replica and catch-up. */
  reconnectReplica: (which: 1 | 2) => Promise<void>;
};

export async function bootUep33Cluster(
  cfg: Uep33ClusterConfig = {},
): Promise<ClusterHandles> {
  const networkId = cfg.networkId ?? "local";
  const domainId = cfg.domainId ?? 1;
  const listenHost = cfg.listenHost ?? "127.0.0.1";
  const requireZkVerify = cfg.requireZkVerify === true;
  const dataDir =
    cfg.dataDir ??
    path.join("/tmp", `uep33-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const seqId = createNodeIdentity("node-a-seq");
  const r1Id = createNodeIdentity("node-b-rep");
  const r2Id = createNodeIdentity("node-c-rep");

  const nodeRegistry = new NodeRegistry();
  for (const [id, role] of [
    [seqId, "sequencer"],
    [r1Id, "replica"],
    [r2Id, "replica"],
  ] as const) {
    nodeRegistry.register(
      registryFromIdentity(id, {
        networkId,
        domainId,
        role,
      }),
    );
  }

  const vkRegistry = new VerifyingKeyRegistry();
  if (cfg.pinnedVk) {
    pinProverArtifact(vkRegistry, {
      networkId,
      vkId: cfg.pinnedVk.vkId,
      vkHex: cfg.pinnedVk.vkHex,
    });
  }

  const labOpts = {
    requireZkVerify,
    vkRegistry: requireZkVerify ? vkRegistry : undefined,
    requirePinnedVkId: requireZkVerify,
  };

  const mk = (id: typeof seqId, isSeq: boolean) =>
    new AuthNetworkNode({
      lab: new LabNode(
        id,
        networkId,
        domainId,
        seqId.publicKeyHex,
        seqId.nodeId,
        labOpts,
      ),
      registry: nodeRegistry,
      isSequencer: isSeq,
      role: isSeq ? "sequencer" : "replica",
      listenHost,
    });

  const seq = mk(seqId, true);
  const r1 = mk(r1Id, false);
  const r2 = mk(r2Id, false);

  // Restore if disk state exists
  for (const [node, name] of [
    [seq, "node-a"],
    [r1, "node-b"],
    [r2, "node-c"],
  ] as const) {
    const st = loadLabNodeState(path.join(dataDir, name));
    if (st) applyDiskState(node.lab, st);
  }

  const seqPort = await seq.start();
  await r1.start();
  await r2.start();
  await r1.connectToSequencer("127.0.0.1", seqPort);
  await r2.connectToSequencer("127.0.0.1", seqPort);
  await sleep(40);

  const persist = () => {
    saveLabNodeState(path.join(dataDir, "node-a"), seq.lab);
    saveLabNodeState(path.join(dataDir, "node-b"), r1.lab);
    saveLabNodeState(path.join(dataDir, "node-c"), r2.lab);
  };

  return {
    seqId,
    seq,
    r1,
    r2,
    nodeRegistry,
    vkRegistry,
    seqPort,
    dataDir,
    persist,
    async stop() {
      persist();
      await seq.stop();
      await r1.stop();
      await r2.stop();
    },
    async disconnectReplica(which) {
      const n = which === 1 ? r1 : r2;
      await n.transport.close();
    },
    async reconnectReplica(which) {
      const n = which === 1 ? r1 : r2;
      // re-listen + re-auth
      await n.transport.listen(0);
      await n.connectToSequencer("127.0.0.1", seqPort);
      await sleep(30);
      n.requestCatchUp();
      await sleep(80);
    },
  };
}

export function rootsEqual(a: AuthNetworkNode, b: AuthNetworkNode, c: AuthNetworkNode): boolean {
  return (
    a.lab.stateRoot === b.lab.stateRoot &&
    b.lab.stateRoot === c.lab.stateRoot &&
    a.lab.sequence === b.lab.sequence &&
    b.lab.sequence === c.lab.sequence &&
    a.lab.nullifierRoot === b.lab.nullifierRoot
  );
}
