/**
 * UEP-32.1 — Ed25519 node identity (replaces lab HMAC).
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";

export type NodeRole = "sequencer" | "replica" | "observer";

export type NodeIdentity = {
  nodeId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI DER hex for registry / wire */
  publicKeyHex: string;
};

export type NodeRegistryEntry = {
  nodeId: string;
  publicKeyHex: string;
  networkId: string;
  domainId: number;
  role: NodeRole;
  status: "active" | "revoked" | "offline";
};

export function createNodeIdentity(nodeId: string): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  return { nodeId, privateKey, publicKey, publicKeyHex };
}

export function publicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(hex, "hex"),
    type: "spki",
    format: "der",
  });
}

export function signBytes(identity: NodeIdentity, data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return cryptoSign(null, buf, identity.privateKey).toString("hex");
}

export function verifyBytes(
  publicKeyHex: string,
  data: Buffer | string,
  signatureHex: string,
): boolean {
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const sig = Buffer.from(signatureHex, "hex");
    const pk = publicKeyFromHex(publicKeyHex);
    return cryptoVerify(null, buf, pk, sig);
  } catch {
    return false;
  }
}

/** Simple in-memory registry (UEP-32.2). */
export class NodeRegistry {
  private entries = new Map<string, NodeRegistryEntry>();

  register(entry: NodeRegistryEntry): void {
    this.entries.set(entry.nodeId, { ...entry });
  }

  get(nodeId: string): NodeRegistryEntry | undefined {
    return this.entries.get(nodeId);
  }

  publicKeyHex(nodeId: string): string | undefined {
    return this.entries.get(nodeId)?.publicKeyHex;
  }

  isActive(nodeId: string): boolean {
    const e = this.entries.get(nodeId);
    return !!e && e.status === "active";
  }

  list(): NodeRegistryEntry[] {
    return [...this.entries.values()];
  }

  revoke(nodeId: string): void {
    const e = this.entries.get(nodeId);
    if (e) e.status = "revoked";
  }
}

export function registryFromIdentity(
  id: NodeIdentity,
  opts: {
    networkId: string;
    domainId: number;
    role: NodeRole;
  },
): NodeRegistryEntry {
  return {
    nodeId: id.nodeId,
    publicKeyHex: id.publicKeyHex,
    networkId: opts.networkId,
    domainId: opts.domainId,
    role: opts.role,
    status: "active",
  };
}
