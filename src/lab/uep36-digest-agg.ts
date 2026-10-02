/**
 * UEP-36.1.2 — Digest aggregation (LAB).
 *
 * Official consensus proposal kind: DIGEST_AGGREGATE.
 * No execution stateRoot. Entries ordered by batchId for availability semantics
 * (order does not encode execution order — execution uses ConflictGraph).
 */

import { createHash } from "node:crypto";

export type BatchDigestEntry = {
  batchId: string;
  txDigest: string;
};

export type DigestAggregate = {
  version: "36.1.1";
  epoch: number;
  height: number;
  previousStateRoot: string;
  entries: BatchDigestEntry[];
  aggregateDigest: string;
};

export function encodeField(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

export function encodeU32(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error("INVALID_U32");
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}

/** Sort by batchId (UTF-8 byte order) for availability-set semantics. */
export function canonicalizeEntries(
  entries: BatchDigestEntry[],
): BatchDigestEntry[] {
  return [...entries].sort((a, b) =>
    a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0,
  );
}

export function canonicalAggregateBytes(
  epoch: number,
  height: number,
  previousStateRoot: string,
  entries: BatchDigestEntry[],
): Buffer {
  const ordered = canonicalizeEntries(entries);
  const parts: Buffer[] = [
    Buffer.from("UEP36.1.1AGG", "utf8"),
    encodeU32(epoch),
    encodeU32(height),
    encodeField(previousStateRoot),
    encodeU32(ordered.length),
  ];
  for (const e of ordered) {
    parts.push(encodeField(e.batchId));
    parts.push(encodeField(e.txDigest));
  }
  return Buffer.concat(parts);
}

export function computeAggregateDigest(
  epoch: number,
  height: number,
  previousStateRoot: string,
  entries: BatchDigestEntry[],
): string {
  return createHash("sha256")
    .update(canonicalAggregateBytes(epoch, height, previousStateRoot, entries))
    .digest("hex");
}

export type AggregateValidation =
  | { ok: true }
  | { ok: false; reason: string };

export function validateAggregateEntries(
  entries: BatchDigestEntry[],
): AggregateValidation {
  if (entries.length === 0) return { ok: false, reason: "EMPTY_ENTRIES" };
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e.batchId !== "string" || typeof e.txDigest !== "string") {
      return { ok: false, reason: "MALFORMED_ENTRY" };
    }
    if (e.batchId.length === 0) return { ok: false, reason: "EMPTY_BATCH_ID" };
    if (e.txDigest.length === 0) return { ok: false, reason: "EMPTY_TX_DIGEST" };
    if (seen.has(e.batchId)) {
      return { ok: false, reason: `DUPLICATE_BATCH_ID:${e.batchId}` };
    }
    seen.add(e.batchId);
  }
  return { ok: true };
}

export function buildDigestAggregate(
  epoch: number,
  height: number,
  previousStateRoot: string,
  entries: BatchDigestEntry[],
): DigestAggregate {
  const v = validateAggregateEntries(entries);
  if (!v.ok) throw new Error(v.reason);
  if (typeof previousStateRoot !== "string" || previousStateRoot.length === 0) {
    throw new Error("EMPTY_PREVIOUS_ROOT");
  }
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("INVALID_EPOCH");
  if (!Number.isInteger(height) || height < 1) throw new Error("INVALID_HEIGHT");

  const ordered = canonicalizeEntries(entries);
  const aggregateDigest = computeAggregateDigest(
    epoch,
    height,
    previousStateRoot,
    ordered,
  );
  return {
    version: "36.1.1",
    epoch,
    height,
    previousStateRoot,
    entries: ordered.map((e) => ({ batchId: e.batchId, txDigest: e.txDigest })),
    aggregateDigest,
  };
}

export function aggregateProposalPayload(
  agg: DigestAggregate,
): Record<string, unknown> {
  return {
    kind: "DIGEST_AGGREGATE",
    version: agg.version,
    epoch: agg.epoch,
    height: agg.height,
    previousStateRoot: agg.previousStateRoot,
    aggregateDigest: agg.aggregateDigest,
    entryDigests: agg.entries.map((e) => ({
      batchId: e.batchId,
      txDigest: e.txDigest,
    })),
  };
}

const REQUIRED_KEYS = [
  "kind",
  "version",
  "epoch",
  "height",
  "previousStateRoot",
  "aggregateDigest",
  "entryDigests",
] as const;

/**
 * Strong validation of official DIGEST_AGGREGATE proposal payload.
 */
export function isDigestOnlyAggregatePayload(payloadJson: string): boolean {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (obj.kind !== "DIGEST_AGGREGATE") return false;
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return false;
  }
  if (typeof obj.version !== "string") return false;
  if (typeof obj.epoch !== "number" || !Number.isInteger(obj.epoch)) return false;
  if (typeof obj.height !== "number" || !Number.isInteger(obj.height)) return false;
  if (typeof obj.previousStateRoot !== "string") return false;
  if (typeof obj.aggregateDigest !== "string") return false;
  if (!Array.isArray(obj.entryDigests)) return false;
  if (obj.entryDigests.length === 0) return false;
  if ("txs" in obj || "stateRoot" in obj || "amount" in obj) return false;

  const entries: BatchDigestEntry[] = [];
  for (const e of obj.entryDigests as unknown[]) {
    if (typeof e !== "object" || e === null) return false;
    const rec = e as Record<string, unknown>;
    if (typeof rec.batchId !== "string" || typeof rec.txDigest !== "string") {
      return false;
    }
    if ("txs" in rec || "amount" in rec || "stateRoot" in rec) return false;
    entries.push({ batchId: rec.batchId, txDigest: rec.txDigest });
  }
  if (!validateAggregateEntries(entries).ok) return false;

  // Integrity against claimed fields
  try {
    const expected = computeAggregateDigest(
      obj.epoch as number,
      obj.height as number,
      obj.previousStateRoot as string,
      entries,
    );
    if (expected !== obj.aggregateDigest) return false;
  } catch {
    return false;
  }
  return true;
}

/** Official name for multi-leader / consensus guards — same as aggregate payload. */
export function isDigestOnlyProposalPayload(payloadJson: string): boolean {
  return isDigestOnlyAggregatePayload(payloadJson);
}

export function verifyAggregateIntegrity(agg: DigestAggregate): boolean {
  const v = validateAggregateEntries(agg.entries);
  if (!v.ok) return false;
  return (
    computeAggregateDigest(
      agg.epoch,
      agg.height,
      agg.previousStateRoot,
      agg.entries,
    ) === agg.aggregateDigest
  );
}

export function verifyAggregateContext(
  agg: DigestAggregate,
  epoch: number,
  height: number,
  previousStateRoot: string,
): AggregateValidation {
  if (!verifyAggregateIntegrity(agg)) return { ok: false, reason: "INTEGRITY" };
  if (agg.epoch !== epoch) return { ok: false, reason: "EPOCH_MISMATCH" };
  if (agg.height !== height) return { ok: false, reason: "HEIGHT_MISMATCH" };
  if (agg.previousStateRoot !== previousStateRoot) {
    return { ok: false, reason: "PREV_ROOT_MISMATCH" };
  }
  return { ok: true };
}

export type AggregateConsensusInput = {
  aggregate: DigestAggregate;
  proposalPayload: Record<string, unknown>;
};

export function toConsensusInput(agg: DigestAggregate): AggregateConsensusInput {
  if (!verifyAggregateIntegrity(agg)) throw new Error("INVALID_AGGREGATE");
  return {
    aggregate: agg,
    proposalPayload: aggregateProposalPayload(agg),
  };
}
