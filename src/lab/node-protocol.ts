/**
 * UEP-31/32 — Multi-node protocol with Ed25519 envelope signatures (UEP-32.1).
 *
 * Single sequencer orders commits. Replicas apply if previous root matches
 * and sequencer signature verifies against registry public key.
 *
 * FAILOVER NOT IMPLEMENTED — sequencer loss is detected, not recovered.
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import { zkVerifyHex } from "./zk-bridge.ts";
import { pinnedVk } from "./zk-vk-pins.ts";
import { assertEnvelopeMatchesPublicInputs } from "./envelope-public-bind.ts";
import {
  proposalFromEnvelope,
  verifyCommitCert,
  type CommitCert,
  type ProposalBoard,
} from "./uep34-commit-cert.ts";

export const NODE_PROTOCOL_VERSION = 2;

export type { NodeIdentity } from "./node-identity.ts";
export { createNodeIdentity } from "./node-identity.ts";

export type NodeEnvelope = {
  protocolVersion: number;
  networkId: string;
  domainId: number;
  nodeId: string;
  sequence: number;
  previousStateRoot: string;
  newStateRoot: string;
  previousNullifierRoot?: string;
  newNullifierRoot?: string;
  transitionId: string;
  nullifier: string;
  transactionCommitment?: string;
  proofHex?: string;
  publicInputsHex?: string[];
  /** Verifying key hex (lab/debug only; must match pin when registry set). */
  vkHex?: string;
  /** Canonical VK identifier for network-pinned keys (preferred). */
  vkId?: string;
  ts: number;
  /** Ed25519 signature hex over canonical body */
  signature: string;
};

export function envelopeBody(e: Omit<NodeEnvelope, "signature">): string {
  // UEP-32.5: proof + public inputs + vk are part of the signed body when present.
  const pubs = e.publicInputsHex?.length
    ? e.publicInputsHex.map((h, i) => `pi${i}=${h}`).join("&")
    : "";
  return [
    `v=${e.protocolVersion}`,
    `net=${e.networkId}`,
    `dom=${e.domainId}`,
    `node=${e.nodeId}`,
    `seq=${e.sequence}`,
    `prev=${e.previousStateRoot}`,
    `next=${e.newStateRoot}`,
    `nprev=${e.previousNullifierRoot ?? ""}`,
    `nnext=${e.newNullifierRoot ?? ""}`,
    `tid=${e.transitionId}`,
    `nf=${e.nullifier}`,
    `txc=${e.transactionCommitment ?? ""}`,
    `vkid=${e.vkId ?? ""}`,
    `vk=${e.vkHex ?? ""}`,
    `proof=${e.proofHex ?? ""}`,
    `pubs=${pubs}`,
    `ts=${e.ts}`,
  ].join("|");
}

export function signEnvelope(
  identity: NodeIdentity,
  partial: Omit<NodeEnvelope, "signature" | "nodeId">,
): NodeEnvelope {
  const e: Omit<NodeEnvelope, "signature"> = {
    ...partial,
    protocolVersion: partial.protocolVersion ?? NODE_PROTOCOL_VERSION,
    nodeId: identity.nodeId,
  };
  const signature = signBytes(identity, envelopeBody(e));
  return { ...e, signature };
}

/** Verify envelope against sequencer public key hex from registry. */
export function verifyEnvelope(
  e: NodeEnvelope,
  sequencerPublicKeyHex: string,
  expectedNodeId?: string,
): boolean {
  if (e.protocolVersion !== NODE_PROTOCOL_VERSION) return false;
  if (expectedNodeId && e.nodeId !== expectedNodeId) return false;
  const body: Omit<NodeEnvelope, "signature"> = {
    protocolVersion: e.protocolVersion,
    networkId: e.networkId,
    domainId: e.domainId,
    nodeId: e.nodeId,
    sequence: e.sequence,
    previousStateRoot: e.previousStateRoot,
    newStateRoot: e.newStateRoot,
    previousNullifierRoot: e.previousNullifierRoot,
    newNullifierRoot: e.newNullifierRoot,
    transitionId: e.transitionId,
    nullifier: e.nullifier,
    transactionCommitment: e.transactionCommitment,
    proofHex: e.proofHex,
    publicInputsHex: e.publicInputsHex,
    vkHex: e.vkHex,
    vkId: e.vkId,
    ts: e.ts,
  };
  return verifyBytes(sequencerPublicKeyHex, envelopeBody(body), e.signature);
}

export class LabNode {
  readonly identity: NodeIdentity;
  readonly networkId: string;
  readonly domainId: number;
  /** Public key of the authorized sequencer (from registry). */
  sequencerPublicKeyHex: string;
  sequencerNodeId: string;
  stateRoot: string = "GENESIS";
  nullifierRoot: string = "GENESIS_NF";
  sequence = 0;
  applied = new Map<string, NodeEnvelope>();
  /** Canonical nullifier set at node layer (UEP-33.2). */
  consumedNullifiers = new Set<string>();
  log: NodeEnvelope[] = [];
  /** Detected sequencer silence / failure (no automatic failover). */
  sequencerFailed = false;
  /**
   * UEP-32.5: when true, APPLY requires valid Groth16 (proofHex + publicInputsHex + vkHex).
   * Structural lab sets false; DEV-ZK / TESTNET-ZK set true.
   */
  requireZkVerify = false;
  /** Operator-configured VK for the lab profile without registry (default: pinned dev key). */
  defaultVkHex?: string;
  /**
   * Pinned VK registry. When set with requireZkVerify, envelope.vkId must resolve;
   * envelope.vkHex is not trusted unless it matches the pin.
   */
  vkRegistry?: import("./verifying-key-registry.ts").VerifyingKeyRegistry;
  /** TESTNET-ZK: require vkId (no free-form vkHex-only accept). */
  requirePinnedVkId = false;
  /**
   * UEP-34.5/34.6: when true, apply() requires a valid CommitCert matching the
   * full envelope proposal digest. Bypass via apply(env) alone is rejected.
   */
  requireCommitCert = false;
  /** Candidates authorized to vote on commit certs (nodeIds). */
  commitCandidates: string[] = [];
  /** Resolve public keys for commit voters. */
  commitPublicKeyOf?: (nodeId: string) => string | undefined;
  /** Optional shared proposal board (equivocation / poison). */
  proposalBoard?: ProposalBoard;

  constructor(
    identity: NodeIdentity,
    networkId: string,
    domainId: number,
    sequencerPublicKeyHex: string,
    sequencerNodeId: string,
    opts?: {
      requireZkVerify?: boolean;
      defaultVkHex?: string;
      vkRegistry?: import("./verifying-key-registry.ts").VerifyingKeyRegistry;
      requirePinnedVkId?: boolean;
      requireCommitCert?: boolean;
      commitCandidates?: string[];
      commitPublicKeyOf?: (nodeId: string) => string | undefined;
      proposalBoard?: ProposalBoard;
    },
  ) {
    this.identity = identity;
    this.networkId = networkId;
    this.domainId = domainId;
    this.sequencerPublicKeyHex = sequencerPublicKeyHex;
    this.sequencerNodeId = sequencerNodeId;
    if (opts?.requireZkVerify) this.requireZkVerify = true;
    if (opts?.defaultVkHex) this.defaultVkHex = opts.defaultVkHex;
    if (opts?.vkRegistry) this.vkRegistry = opts.vkRegistry;
    if (opts?.requirePinnedVkId) this.requirePinnedVkId = true;
    if (opts?.requireCommitCert) this.requireCommitCert = true;
    if (opts?.commitCandidates) this.commitCandidates = opts.commitCandidates;
    if (opts?.commitPublicKeyOf) this.commitPublicKeyOf = opts.commitPublicKeyOf;
    if (opts?.proposalBoard) this.proposalBoard = opts.proposalBoard;
  }

  propose(input: {
    previousStateRoot: string;
    newStateRoot: string;
    previousNullifierRoot?: string;
    newNullifierRoot?: string;
    transitionId: string;
    nullifier: string;
    transactionCommitment?: string;
    proofHex?: string;
    publicInputsHex?: string[];
    vkHex?: string;
    vkId?: string;
  }): NodeEnvelope {
    if (this.identity.nodeId !== this.sequencerNodeId) {
      throw new Error("NOT_SEQUENCER");
    }
    if (input.previousStateRoot !== this.stateRoot) {
      throw new Error("SEQUENCER_STALE_ROOT");
    }
    return signEnvelope(this.identity, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: this.networkId,
      domainId: this.domainId,
      sequence: this.sequence + 1,
      previousStateRoot: input.previousStateRoot,
      newStateRoot: input.newStateRoot,
      previousNullifierRoot: input.previousNullifierRoot ?? this.nullifierRoot,
      newNullifierRoot: input.newNullifierRoot ?? this.nullifierRoot,
      transitionId: input.transitionId,
      nullifier: input.nullifier,
      transactionCommitment: input.transactionCommitment,
      proofHex: input.proofHex,
      publicInputsHex: input.publicInputsHex,
      vkHex: input.vkHex,
      vkId: input.vkId,
      ts: Date.now(),
    });
  }

  /**
   * Accept transition. Order (UEP-32.5):
   * Ed25519 → network/domain → sequence/root/replay → [Groth16] → APPLY
   */
  apply(
    env: NodeEnvelope,
    opts?: { commitCert?: CommitCert },
  ): { ok: true } | { ok: false; error: string } {
    if (!verifyEnvelope(env, this.sequencerPublicKeyHex, this.sequencerNodeId)) {
      return { ok: false, error: "BAD_SIGNATURE" };
    }
    if (env.networkId !== this.networkId) {
      return { ok: false, error: "NETWORK_MISMATCH" };
    }
    if (env.domainId !== this.domainId) {
      return { ok: false, error: "DOMAIN_MISMATCH" };
    }
    if (this.applied.has(env.transitionId)) {
      return { ok: false, error: "IDEMPOTENT_REPLAY" };
    }
    if (this.consumedNullifiers.has(env.nullifier)) {
      return { ok: false, error: "NULLIFIER_REPLAY" };
    }
    if (env.previousStateRoot !== this.stateRoot) {
      return { ok: false, error: "STALE_ROOT" };
    }
    if (env.sequence !== this.sequence + 1) {
      return { ok: false, error: "SEQUENCE_GAP" };
    }

    // UEP-34.6: CommitCert is mandatory when requireCommitCert is set.
    // Callers cannot bypass via apply(env) alone.
    if (this.requireCommitCert) {
      const cert = opts?.commitCert;
      if (!cert) {
        return { ok: false, error: "COMMIT_CERT_REQUIRED" };
      }
      const expected = proposalFromEnvelope(env);
      if (cert.proposal.digest !== expected.digest) {
        return { ok: false, error: "COMMIT_CERT_DIGEST_MISMATCH" };
      }
      // Ensure cert proposal fields match envelope (full binding)
      if (
        cert.proposal.sequence !== env.sequence ||
        cert.proposal.newStateRoot !== env.newStateRoot ||
        cert.proposal.previousStateRoot !== env.previousStateRoot ||
        cert.proposal.nullifier !== env.nullifier ||
        cert.proposal.transitionId !== env.transitionId ||
        cert.proposal.leaderNodeId !== env.nodeId
      ) {
        return { ok: false, error: "COMMIT_CERT_PROPOSAL_MISMATCH" };
      }
      if (!this.commitPublicKeyOf || this.commitCandidates.length === 0) {
        return { ok: false, error: "COMMIT_CERT_CONFIG" };
      }
      const vr = verifyCommitCert(
        cert,
        this.commitCandidates,
        this.commitPublicKeyOf,
        this.proposalBoard,
      );
      if (!vr.ok) {
        return { ok: false, error: `COMMIT_CERT_INVALID:${vr.reason}` };
      }
    }

    if (this.requireZkVerify) {
      if (!env.proofHex || !env.publicInputsHex) {
        return { ok: false, error: "ZK_PROOF_REQUIRED" };
      }
      if (env.publicInputsHex.length !== 13) {
        return { ok: false, error: "ZK_PUBLIC_INPUTS_LEN" };
      }

      let vk: string | null | undefined = null;
      if (this.vkRegistry) {
        if (!env.vkId) {
          return { ok: false, error: "VK_ID_REQUIRED" };
        }
        const pinned = this.vkRegistry.get(this.networkId, env.vkId);
        if (!pinned) {
          return { ok: false, error: "VK_ID_NOT_PINNED" };
        }
        // Wire vkHex must match pin if present (cannot swap VK)
        if (env.vkHex && env.vkHex !== pinned.vkHex) {
          return { ok: false, error: "VK_HEX_PIN_MISMATCH" };
        }
        vk = pinned.vkHex;
      } else if (this.requirePinnedVkId) {
        return { ok: false, error: "VK_REGISTRY_REQUIRED" };
      } else {
        // Lab profile without registry: operator-configured key, else the
        // pinned development key. A key carried by the envelope is never used.
        try {
          vk = this.defaultVkHex ?? pinnedVk(4, BigInt(this.domainId)).vkHex;
        } catch {
          return { ok: false, error: "VK_NOT_PINNED" };
        }
        if (env.vkHex && env.vkHex.replace(/^0x/i, "").toLowerCase() !== vk.replace(/^0x/i, "").toLowerCase()) {
          return { ok: false, error: "VK_HEX_PIN_MISMATCH" };
        }
      }

      const bind = assertEnvelopeMatchesPublicInputs(env, {
        requireCanonicalRoots: true,
      });
      if (!bind.ok) {
        return { ok: false, error: bind.error };
      }
      const v = zkVerifyHex(vk, env.proofHex, env.publicInputsHex);
      if (!v.ok) {
        return { ok: false, error: "ZK_VERIFY_FAILED" };
      }
    }

    this.stateRoot = env.newStateRoot;
    if (env.newNullifierRoot) this.nullifierRoot = env.newNullifierRoot;
    this.sequence = env.sequence;
    this.applied.set(env.transitionId, env);
    this.consumedNullifiers.add(env.nullifier);
    this.log.push(env);
    return { ok: true };
  }

  catchUp(envs: NodeEnvelope[]): number {
    let n = 0;
    for (const e of envs) {
      if (this.applied.has(e.transitionId)) continue;
      const r = this.apply(e);
      if (!r.ok) throw new Error(`CATCH_UP_FAIL: ${r.error} seq=${e.sequence}`);
      n++;
    }
    return n;
  }

  /** Lab: mark sequencer failure (FAILOVER NOT IMPLEMENTED). */
  markSequencerFailed(): void {
    this.sequencerFailed = true;
  }
}
