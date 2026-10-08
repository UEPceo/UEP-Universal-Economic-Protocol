/**
 * UEP-33 / 33.2 — Persist LabNode roots/log/nullifiers with integrity checks.
 */

import fs from "node:fs";
import path from "node:path";
import type { NodeEnvelope } from "./node-protocol.ts";
import type { LabNode } from "./node-protocol.ts";

export type LabNodeDiskState = {
  version: 2;
  nodeId: string;
  networkId: string;
  domainId: number;
  stateRoot: string;
  nullifierRoot: string;
  sequence: number;
  log: NodeEnvelope[];
  consumedNullifiers: string[];
  savedAt: number;
};

export function saveLabNodeState(dir: string, node: LabNode): void {
  fs.mkdirSync(dir, { recursive: true });
  const st: LabNodeDiskState = {
    version: 2,
    nodeId: node.identity.nodeId,
    networkId: node.networkId,
    domainId: node.domainId,
    stateRoot: node.stateRoot,
    nullifierRoot: node.nullifierRoot,
    sequence: node.sequence,
    log: node.log,
    consumedNullifiers: [...node.consumedNullifiers],
    savedAt: Date.now(),
  };
  const file = path.join(dir, "lab-node-state.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
}

export function loadLabNodeState(dir: string): LabNodeDiskState | null {
  const file = path.join(dir, "lab-node-state.json");
  if (!fs.existsSync(file)) return null;
  const st = JSON.parse(fs.readFileSync(file, "utf8")) as LabNodeDiskState;
  const version: number = st.version; // files on disk may carry version 1
  if (version !== 1 && version !== 2) {
    throw new Error("SNAPSHOT_VERSION_UNSUPPORTED");
  }
  return st;
}

/**
 * Apply disk state only if identity matches this node.
 */
export function applyDiskState(node: LabNode, st: LabNodeDiskState): void {
  if (st.nodeId !== node.identity.nodeId) {
    throw new Error("SNAPSHOT_NODE_ID_MISMATCH");
  }
  if (st.networkId !== node.networkId) {
    throw new Error("SNAPSHOT_NETWORK_MISMATCH");
  }
  if (st.domainId !== node.domainId) {
    throw new Error("SNAPSHOT_DOMAIN_MISMATCH");
  }
  node.stateRoot = st.stateRoot;
  node.nullifierRoot = st.nullifierRoot;
  node.sequence = st.sequence;
  node.log = st.log ?? [];
  node.applied.clear();
  node.consumedNullifiers.clear();
  for (const e of node.log) {
    node.applied.set(e.transitionId, e);
    node.consumedNullifiers.add(e.nullifier);
  }
  // Prefer explicit set from v2
  if (st.consumedNullifiers) {
    for (const n of st.consumedNullifiers) node.consumedNullifiers.add(n);
  }
}
