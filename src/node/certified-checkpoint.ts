/**
 * 0.5.84 item 2: certified checkpoints for validator synchronization.
 *
 * A checkpoint binds (networkId, domainId, BFT height, blockId, stateRoot, validatorSetHash,
 * txCount, ledgerHeight). Each validator signs it with its pinned Ed25519 key only when its own
 * durable commit journal has APPLIED that height with that blockId and post-root. A checkpoint is
 * certified when signatures from a quorum (2f + 1 distinct validators of the bound set) verify.
 *
 * Snapshot acceptance (acceptSnapshotAgainstCheckpoint) rejects:
 *   CHECKPOINT_QUORUM_MISSING      fewer than 2f + 1 valid distinct signatures, unknown signers
 *   CHECKPOINT_CONTEXT_MISMATCH    other network, domain or validator set
 *   CHECKPOINT_STALE               not above what this node already has (no rollback)
 *   CHECKPOINT_INCOMPATIBLE        the snapshot does not match the checkpoint (root, height, last block, tx count)
 *   CHECKPOINT_CONFLICT            this node already has the same height with another root or block
 *
 * "Certified" is the technical term for "signed by a quorum of the configured validator set"; it
 * says nothing about the network as a whole.
 */
import { signEd25519, stableStringify, verifyEd25519, type PrivateKeyLike } from "../core/ed25519.ts";
import type { BftValidator } from "./bft-consensus.ts";
import { validatorSetHash } from "./unified-node-state.ts";

export type CheckpointBody = {
  v: 1;
  networkId: string;
  domainId: string;
  height: number;
  blockId: string;
  stateRoot: string;
  validatorSetHash: string;
  txCount: number;
  ledgerHeight: number;
};
export type CheckpointSignature = { validatorId: string; signature: string };
export type CertifiedCheckpoint = { body: CheckpointBody; signatures: CheckpointSignature[] };
export type CheckpointContext = { networkId: string; domainId: string; validators: readonly BftValidator[]; faultTolerance: number };
export type LedgerView = { height: number; stateRoot: () => { toHex(): string }; txs: readonly { txId: { toHex(): string } }[] };

const HEX64 = /^[0-9a-f]{64}$/;

export function checkpointMessage(body: CheckpointBody): string {
  return `uep-certified-checkpoint-v1:${stableStringify(body)}`;
}

export function quorumSize(ctx: Pick<CheckpointContext, "faultTolerance">): number {
  return 2 * ctx.faultTolerance + 1;
}

export function signCheckpoint(body: CheckpointBody, validatorId: string, key: PrivateKeyLike): CheckpointSignature {
  return { validatorId, signature: signEd25519(checkpointMessage(body), key) };
}

function wellFormed(body: CheckpointBody): boolean {
  return !!body && body.v === 1 && typeof body.networkId === "string" && typeof body.domainId === "string" &&
    Number.isSafeInteger(body.height) && body.height >= 0 && Number.isSafeInteger(body.ledgerHeight) && body.ledgerHeight >= 0 &&
    Number.isSafeInteger(body.txCount) && body.txCount >= 0 && HEX64.test(body.stateRoot) && HEX64.test(body.validatorSetHash) &&
    typeof body.blockId === "string" && body.blockId.length > 0;
}

/** Valid distinct signers from the bound validator set (order-independent). */
export function validSigners(cp: CertifiedCheckpoint, ctx: CheckpointContext): string[] {
  const keys = new Map(ctx.validators.map(v => [v.id, v.publicKeyHex]));
  const seen = new Set<string>();
  const msg = checkpointMessage(cp.body);
  for (const s of cp.signatures ?? []) {
    const pk = keys.get(s.validatorId);
    if (!pk || seen.has(s.validatorId)) continue;
    if (verifyEd25519(msg, String(s.signature ?? ""), pk)) seen.add(s.validatorId);
  }
  return [...seen];
}

/** Throws a CHECKPOINT_* error unless the checkpoint is well formed, bound to ctx and quorum-signed. */
export function verifyCertifiedCheckpoint(cp: CertifiedCheckpoint, ctx: CheckpointContext): void {
  if (!cp || !wellFormed(cp.body)) throw new Error("CHECKPOINT_MALFORMED");
  if (cp.body.networkId !== ctx.networkId || cp.body.domainId !== ctx.domainId || cp.body.validatorSetHash !== validatorSetHash(ctx.validators)) {
    throw new Error("CHECKPOINT_CONTEXT_MISMATCH");
  }
  if (validSigners(cp, ctx).length < quorumSize(ctx)) throw new Error("CHECKPOINT_QUORUM_MISSING");
}

/** Build the body for a ledger head reached through the certified commit journal. */
export function checkpointBodyFor(ctx: CheckpointContext, height: number, blockId: string, ledger: LedgerView): CheckpointBody {
  return {
    v: 1, networkId: ctx.networkId, domainId: ctx.domainId, height, blockId,
    stateRoot: ledger.stateRoot().toHex(), validatorSetHash: validatorSetHash(ctx.validators),
    txCount: ledger.txs.length, ledgerHeight: ledger.height,
  };
}

/**
 * Decide whether a snapshot (already signature-checked by UepLedger.restore) may replace the local
 * state. `local` is what this node has: its ledger and the last certified checkpoint it accepted.
 */
export function acceptSnapshotAgainstCheckpoint(
  cp: CertifiedCheckpoint, ctx: CheckpointContext, snapshot: LedgerView,
  local: { ledger: LedgerView; lastCheckpoint?: CertifiedCheckpoint | null; appliedAt?: (height: number) => { blockId: string; postRoot: string | null } | undefined },
): void {
  verifyCertifiedCheckpoint(cp, ctx);
  const b = cp.body;
  const last = local.lastCheckpoint?.body;
  if (last && b.height <= last.height) throw new Error("CHECKPOINT_STALE");
  if (b.ledgerHeight < local.ledger.height || b.txCount < local.ledger.txs.length) throw new Error("CHECKPOINT_STALE");
  if (b.ledgerHeight === local.ledger.height && b.txCount === local.ledger.txs.length && b.stateRoot === local.ledger.stateRoot().toHex()) {
    throw new Error("CHECKPOINT_STALE"); // nothing new
  }
  const mine = local.appliedAt?.(b.height);
  if (mine && (mine.blockId !== b.blockId || (mine.postRoot !== null && mine.postRoot !== b.stateRoot))) throw new Error("CHECKPOINT_CONFLICT");
  if (snapshot.stateRoot().toHex() !== b.stateRoot || snapshot.height !== b.ledgerHeight || snapshot.txs.length !== b.txCount ||
      snapshot.txs.at(-1)?.txId.toHex() !== b.blockId) {
    throw new Error("CHECKPOINT_INCOMPATIBLE");
  }
}
