/**
 * Evidence trust model and value caps (ADR 0002 rule 6, docs/EVIDENCE.md).
 *
 * Evidence certifies only that "source X published data D at height H,
 * signed by k of n attesters". It never certifies that D is true. If the
 * source itself is wrong, every honest attester signs the same wrong data, so
 * the value that evidence can move is capped:
 *  - per contract: each order of a listing bound to evidence may lock at most
 *    `maxValuePerContract` (gross amount + gas, in the listing asset);
 *  - per attester set: the funded open value (orders HELD, DELIVERED or
 *    DISPUTED; not unfunded reservations) of all orders bound to one attester
 *    set may not exceed its cap for that asset. The set cap is taken when the
 *    order is funded and released once when it closes.
 *
 * Attester sets name their source (`sourceId`) and their attesters' public
 * keys. Two sets that observe the same source with any attester in common are
 * rejected, so the same attesters cannot multiply a cap by registering the
 * same source under several set ids. A cap per source and per attester across
 * sets, and the use of `threshold` / `size` / keys to verify statements, come
 * with the evidence records of phase 2.3; until then they are validated only.
 *
 * This module holds the parameters and the deterministic checks only. The
 * evidence records themselves (hash, type, external reference, signers) are
 * phase 2.3 of the roadmap; attester selection and payment are open decisions.
 * Amounts of different assets are never added together.
 */
import { tupleKey } from "../core/composite-key.ts";

/**
 * Shape of an evidence statement (phase 2.3; not verified here). Adapters
 * that fetch from an external source run outside the state machine; only the
 * statement's hash and signatures would enter the state.
 */
export type EvidenceStatement = {
  /** Public source identifier, e.g. a dataset URL or product id. */
  sourceId: string;
  /** SHA-256 of the bytes the source published (the data stays outside the state). */
  dataHash: string;
  /** Height of the settling ledger at which the attesters observed the publication. */
  observedHeight: number;
  /** Order (contract) the statement is bound to, against replay in another contract. */
  orderId: string;
  attesterSetId: string;
  /** Signatures of distinct attesters of the set; valid with at least `threshold`. */
  signatures: Array<{ attesterId: string; signature: string }>;
};

/** An attester set registered with the Marketplace (k of n) and its open-value caps per asset. */
export type AttesterSetPolicy = {
  attesterSetId: string;
  /** Public identifier of the source the set observes (dataset URL, product id). */
  sourceId: string;
  /** Ed25519 public keys (64 hex) of the n attesters, all distinct. */
  attesterKeys: string[];
  /** k: signatures required (validated now, used to verify statements in phase 2.3). */
  threshold: number;
  /** n: attesters in the set; equals attesterKeys.length. */
  size: number;
  /** Asset id -> maximum open value bound to this set (smallest unit). An asset without an entry is refused. */
  valueCaps: Record<string, bigint>;
};

/** Evidence terms of a listing, fixed at publication (part of the signed listing terms). */
export type ListingEvidencePolicy = {
  attesterSetId: string;
  /** Maximum value one order (contract) may lock: grossAmount + gasFee, in the listing asset. */
  maxValuePerContract: bigint;
};

export type EvidenceCapsConfig = {
  /** Registered attester sets. Default: none, so no listing can be bound to evidence. */
  attesterSets?: AttesterSetPolicy[];
};

const ATTESTER_SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const SOURCE_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Read-only view of the evidence caps (what `DigitalServicesMarketplace.evidenceCaps` exposes). */
export type EvidenceCapsView = {
  /** Funded open value bound to one set in one asset. */
  openValue(attesterSetId: string, asset: string): bigint;
  /** Copy of a registered attester set. */
  attesterSet(attesterSetId: string): AttesterSetPolicy;
};

/** Validated registry of attester sets and the open value bound to each (set, asset). */
export class EvidenceCaps {
  private readonly sets = new Map<string, AttesterSetPolicy>();
  private readonly exposure = new Map<string, bigint>();

  constructor(config: EvidenceCapsConfig = {}) {
    for (const set of config.attesterSets ?? []) {
      if (!set || typeof set.attesterSetId !== "string" || !ATTESTER_SET_ID_PATTERN.test(set.attesterSetId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID");
      if (this.sets.has(set.attesterSetId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: duplicate id");
      if (!Number.isSafeInteger(set.threshold) || !Number.isSafeInteger(set.size) || set.threshold < 1 || set.size < set.threshold) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: need 1 <= k <= n");
      if (typeof set.sourceId !== "string" || !SOURCE_ID_PATTERN.test(set.sourceId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: sourceId required");
      if (!Array.isArray(set.attesterKeys) || set.attesterKeys.length !== set.size) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: attesterKeys must list the n attesters");
      const keys = set.attesterKeys.map((k) => (typeof k === "string" ? k.toLowerCase() : ""));
      if (keys.some((k) => !PUBLIC_KEY_PATTERN.test(k)) || new Set(keys).size !== keys.length) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: attesterKeys are distinct Ed25519 public keys (64 hex)");
      for (const other of this.sets.values()) {
        if (other.sourceId === set.sourceId && other.attesterKeys.some((k) => keys.includes(k))) throw new Error("EVIDENCE_ATTESTER_SET_DUPLICATE: another set observes the same source with a common attester");
      }
      const caps: Record<string, bigint> = {};
      for (const [asset, cap] of Object.entries(set.valueCaps ?? {})) {
        if (!asset || typeof cap !== "bigint" || cap <= 0n) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: caps are positive bigints");
        caps[asset] = cap;
      }
      this.sets.set(set.attesterSetId, Object.freeze({ attesterSetId: set.attesterSetId, sourceId: set.sourceId, attesterKeys: Object.freeze([...keys]) as string[], threshold: set.threshold, size: set.size, valueCaps: Object.freeze(caps) }));
    }
  }

  attesterSet(attesterSetId: string): AttesterSetPolicy {
    const set = this.sets.get(attesterSetId);
    if (!set) throw new Error("EVIDENCE_ATTESTER_SET_UNKNOWN");
    return { ...set, attesterKeys: [...set.attesterKeys], valueCaps: { ...set.valueCaps } };
  }

  /** Cap of one set for one asset (throws if the set has none for it). */
  setCap(attesterSetId: string, asset: string): bigint {
    const cap = this.sets.get(attesterSetId)?.valueCaps[asset];
    if (this.sets.get(attesterSetId) === undefined) throw new Error("EVIDENCE_ATTESTER_SET_UNKNOWN");
    if (cap === undefined) throw new Error("EVIDENCE_ATTESTER_SET_CAP_UNDEFINED: the attester set has no cap for this asset");
    return cap;
  }

  /** Validate a listing's evidence terms at publication. */
  assertListingPolicy(policy: ListingEvidencePolicy, asset: string): ListingEvidencePolicy {
    if (!policy || typeof policy !== "object" || typeof policy.attesterSetId !== "string" || typeof policy.maxValuePerContract !== "bigint" || policy.maxValuePerContract <= 0n) throw new Error("EVIDENCE_POLICY_INVALID");
    const cap = this.setCap(policy.attesterSetId, asset);
    if (policy.maxValuePerContract > cap) throw new Error("EVIDENCE_POLICY_INVALID: maxValuePerContract exceeds the attester set cap");
    return { attesterSetId: policy.attesterSetId, maxValuePerContract: policy.maxValuePerContract };
  }

  /** Funded open value bound to one set in one asset. */
  openValue(attesterSetId: string, asset: string): bigint {
    return this.exposure.get(tupleKey(attesterSetId, asset)) ?? 0n;
  }

  /**
   * Deterministic lock check (no mutation): `value` (gross + gas of one order)
   * must fit the per-contract cap and the set's remaining cap for `asset`.
   * Called at reservation (fail early) and again when the order is funded.
   */
  checkLock(policy: ListingEvidencePolicy, asset: string, value: bigint): void {
    if (value > policy.maxValuePerContract) throw new Error("EVIDENCE_CONTRACT_CAP_EXCEEDED");
    const cap = this.setCap(policy.attesterSetId, asset);
    if (this.openValue(policy.attesterSetId, asset) + value > cap) throw new Error("EVIDENCE_ATTESTER_SET_CAP_EXCEEDED");
  }

  /** Record the funded value of an order (checks again first). */
  lock(policy: ListingEvidencePolicy, asset: string, value: bigint): void {
    this.checkLock(policy, asset, value);
    const key = tupleKey(policy.attesterSetId, asset);
    this.exposure.set(key, (this.exposure.get(key) ?? 0n) + value);
  }

  /** Release the open value of a closed order (exactly once per lock). */
  release(attesterSetId: string, asset: string, value: bigint): void {
    const key = tupleKey(attesterSetId, asset);
    const next = (this.exposure.get(key) ?? 0n) - value;
    if (next < 0n) throw new Error("EVIDENCE_EXPOSURE_UNDERFLOW");
    if (next === 0n) this.exposure.delete(key);
    else this.exposure.set(key, next);
  }

  /**
   * Settlement check: the value an evidence-gated release moves stays within
   * the per-contract cap. Redundant while terms are frozen (checkLock already
   * bounds the order); kept as defence in depth.
   */
  checkSettlement(policy: ListingEvidencePolicy, value: bigint): void {
    if (value > policy.maxValuePerContract) throw new Error("EVIDENCE_CONTRACT_CAP_EXCEEDED");
  }
}

/** Read-only view over an EvidenceCaps instance (no lock / release). */
export function evidenceCapsView(caps: EvidenceCaps): EvidenceCapsView {
  return Object.freeze({
    openValue: (attesterSetId: string, asset: string) => caps.openValue(attesterSetId, asset),
    attesterSet: (attesterSetId: string) => caps.attesterSet(attesterSetId),
  });
}
