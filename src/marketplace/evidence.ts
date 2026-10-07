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
 *    order is funded and released once when it closes;
 *  - per provider inside a set: one provider's funded open value may not
 *    exceed `providerCapBps` of the set cap (default 2500 = 25%), so one
 *    provider (or a buyer funding orders on its own listing) cannot fill the
 *    whole set cap. Like every per-identity cap it binds identities, so it
 *    relies on identities being costly. If funding fails because a cap is
 *    full, the Marketplace closes the reservation without fault and returns
 *    the buyer's deposit.
 *  - per buyer inside a set (v0.5.3): one buyer's funded open value may not
 *    exceed `buyerCapBps` of the set cap (default 2500 = 25%). Hitting the
 *    buyer quota is the buyer's own limit, not a no-fault close.
 *  - provider bond (v0.5.3): a listing bound to evidence must lock a
 *    `sellerBond` in the listing asset of at least `providerBondBps` of the
 *    per-provider subcap (default 1000 = 10%), taken from the provider's
 *    balance at publication and returned when the listing is delisted and
 *    has no open evidence-bound order. Every extra identity that wants a
 *    share of a set therefore locks capital in the traded asset. No token,
 *    no registration fee.
 *
 * Attester sets name their source (`sourceId`) and their attesters' public
 * keys. Keys are normalized (raw 64 lowercase hex; SPKI DER hex accepted) and
 * must be prime-order Ed25519 points (no all-zero, identity, small-order or
 * off-curve keys). Until the evidence records of phase 2.3, each attester key
 * may belong to ONE set only, whatever the `sourceId` says: the same
 * attesters cannot multiply a cap by registering the source again under
 * another set id or another spelling of its URL. A cap per source and per
 * attester across sets, and the use of `threshold` / `size` / keys to verify
 * statements, come with phase 2.3; until then they are validated only.
 *
 * This module holds the parameters and the deterministic checks only. The
 * evidence records themselves (hash, type, external reference, signers) are
 * phase 2.3 of the roadmap; attester selection and payment are open decisions.
 * Amounts of different assets are never added together.
 */
import { tupleKey } from "../core/composite-key.ts";
import { normalizeEd25519PublicKeyHex } from "../core/ed25519-point.ts";

/** Default per-provider subcap inside an attester set: 25% of the set cap (basis points). */
export const DEFAULT_PROVIDER_CAP_BPS = 2_500;
/** v0.5.3: default per-buyer quota inside an attester set: 25% of the set cap (basis points). */
export const DEFAULT_BUYER_CAP_BPS = 2_500;
/** v0.5.3: default minimum provider bond of an evidence-bound listing: 10% of the per-provider subcap (basis points). */
export const DEFAULT_PROVIDER_BOND_BPS = 1_000;

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
  /** Ed25519 public keys (64 hex, or SPKI DER hex) of the n attesters, all distinct prime-order points; stored as 64 lowercase hex. */
  attesterKeys: string[];
  /** k: signatures required (validated now, used to verify statements in phase 2.3). */
  threshold: number;
  /** n: attesters in the set; equals attesterKeys.length. */
  size: number;
  /** Asset id -> maximum open value bound to this set (smallest unit). An asset without an entry is refused. */
  valueCaps: Record<string, bigint>;
  /** Optional per-provider subcap, in basis points of each set cap (1 to 10000; default DEFAULT_PROVIDER_CAP_BPS = 25%). */
  providerCapBps?: number;
  /** v0.5.3: optional per-buyer quota, in basis points of each set cap (1 to 10000; default DEFAULT_BUYER_CAP_BPS = 25%). */
  buyerCapBps?: number;
  /** v0.5.3: minimum provider bond, in basis points of the per-provider subcap (0 to 10000; default DEFAULT_PROVIDER_BOND_BPS = 10%). */
  providerBondBps?: number;
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

/** Read-only view of the evidence caps (what `DigitalServicesMarketplace.evidenceCaps` exposes). */
export type EvidenceCapsView = {
  /** Funded open value bound to one set in one asset. */
  openValue(attesterSetId: string, asset: string): bigint;
  /** Funded open value of one provider inside one set, in one asset. */
  providerOpenValue(attesterSetId: string, asset: string, providerId: string): bigint;
  /** Per-provider subcap of one set for one asset. */
  providerCap(attesterSetId: string, asset: string): bigint;
  /** v0.5.3: funded open value of one buyer inside one set, in one asset. */
  buyerOpenValue(attesterSetId: string, asset: string, buyerId: string): bigint;
  /** v0.5.3: per-buyer quota of one set for one asset. */
  buyerCap(attesterSetId: string, asset: string): bigint;
  /** v0.5.3: minimum provider bond of a listing bound to one set, in the listing asset. */
  minProviderBond(attesterSetId: string, asset: string): bigint;
  /** Copy of a registered attester set. */
  attesterSet(attesterSetId: string): AttesterSetPolicy;
};

/** Validated registry of attester sets and the open value bound to each (set, asset). */
export class EvidenceCaps {
  private readonly sets = new Map<string, AttesterSetPolicy>();
  private readonly exposure = new Map<string, bigint>();
  /** Attester key (64 lowercase hex) -> the one set it belongs to. */
  private readonly keyOwner = new Map<string, string>();

  constructor(config: EvidenceCapsConfig = {}) {
    for (const set of config.attesterSets ?? []) {
      if (!set || typeof set.attesterSetId !== "string" || !ATTESTER_SET_ID_PATTERN.test(set.attesterSetId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID");
      if (this.sets.has(set.attesterSetId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: duplicate id");
      if (!Number.isSafeInteger(set.threshold) || !Number.isSafeInteger(set.size) || set.threshold < 1 || set.size < set.threshold) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: need 1 <= k <= n");
      if (typeof set.sourceId !== "string" || !SOURCE_ID_PATTERN.test(set.sourceId)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: sourceId required");
      if (!Array.isArray(set.attesterKeys) || set.attesterKeys.length !== set.size) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: attesterKeys must list the n attesters");
      const keys = set.attesterKeys.map((k) => normalizeEd25519PublicKeyHex(k));
      if (keys.some((k) => k === undefined)) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: attesterKeys are Ed25519 public keys (64 hex or SPKI DER hex) of prime order; zero, small-order and off-curve keys are refused");
      if (new Set(keys).size !== keys.length) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: attesterKeys are distinct Ed25519 public keys");
      // Until phase 2.3: one set per attester key, whatever the sourceId (no URL canonicalization to get wrong).
      for (const k of keys as string[]) {
        const owner = this.keyOwner.get(k);
        if (owner !== undefined) throw new Error(`EVIDENCE_ATTESTER_SET_DUPLICATE: attester key ${k.slice(0, 12)}... already belongs to set ${owner}; each key may belong to one set until evidence records (phase 2.3)`);
      }
      const bps = set.providerCapBps ?? DEFAULT_PROVIDER_CAP_BPS;
      if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10_000) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: providerCapBps is 1 to 10000");
      const buyerBps = set.buyerCapBps ?? DEFAULT_BUYER_CAP_BPS;
      if (!Number.isSafeInteger(buyerBps) || buyerBps < 1 || buyerBps > 10_000) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: buyerCapBps is 1 to 10000");
      const bondBps = set.providerBondBps ?? DEFAULT_PROVIDER_BOND_BPS;
      if (!Number.isSafeInteger(bondBps) || bondBps < 0 || bondBps > 10_000) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: providerBondBps is 0 to 10000");
      const caps: Record<string, bigint> = {};
      for (const [asset, cap] of Object.entries(set.valueCaps ?? {})) {
        if (!asset || typeof cap !== "bigint" || cap <= 0n) throw new Error("EVIDENCE_ATTESTER_SET_INVALID: caps are positive bigints");
        caps[asset] = cap;
      }
      for (const k of keys as string[]) this.keyOwner.set(k, set.attesterSetId);
      this.sets.set(set.attesterSetId, Object.freeze({ attesterSetId: set.attesterSetId, sourceId: set.sourceId, attesterKeys: Object.freeze([...(keys as string[])]) as string[], threshold: set.threshold, size: set.size, valueCaps: Object.freeze(caps), providerCapBps: bps, buyerCapBps: buyerBps, providerBondBps: bondBps }));
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

  /** Per-provider subcap of one set for one asset: ceil(setCap x providerCapBps / 10000). */
  providerCap(attesterSetId: string, asset: string): bigint {
    const cap = this.setCap(attesterSetId, asset);
    const bps = BigInt(this.sets.get(attesterSetId)!.providerCapBps ?? DEFAULT_PROVIDER_CAP_BPS);
    return (cap * bps + 9_999n) / 10_000n;
  }

  /** v0.5.3: per-buyer quota of one set for one asset: ceil(setCap x buyerCapBps / 10000). */
  buyerCap(attesterSetId: string, asset: string): bigint {
    const cap = this.setCap(attesterSetId, asset);
    const bps = BigInt(this.sets.get(attesterSetId)!.buyerCapBps ?? DEFAULT_BUYER_CAP_BPS);
    return (cap * bps + 9_999n) / 10_000n;
  }

  /** v0.5.3: minimum provider bond of a listing bound to the set: ceil(providerCap x providerBondBps / 10000). */
  minProviderBond(attesterSetId: string, asset: string): bigint {
    const sub = this.providerCap(attesterSetId, asset);
    const bps = BigInt(this.sets.get(attesterSetId)!.providerBondBps ?? DEFAULT_PROVIDER_BOND_BPS);
    return (sub * bps + 9_999n) / 10_000n;
  }

  /** Validate a listing's evidence terms at publication. */
  assertListingPolicy(policy: ListingEvidencePolicy, asset: string): ListingEvidencePolicy {
    if (!policy || typeof policy !== "object" || typeof policy.attesterSetId !== "string" || typeof policy.maxValuePerContract !== "bigint" || policy.maxValuePerContract <= 0n) throw new Error("EVIDENCE_POLICY_INVALID");
    const cap = this.setCap(policy.attesterSetId, asset);
    if (policy.maxValuePerContract > cap) throw new Error("EVIDENCE_POLICY_INVALID: maxValuePerContract exceeds the attester set cap");
    if (policy.maxValuePerContract > this.providerCap(policy.attesterSetId, asset)) throw new Error("EVIDENCE_POLICY_INVALID: maxValuePerContract exceeds the per-provider subcap of the attester set");
    return { attesterSetId: policy.attesterSetId, maxValuePerContract: policy.maxValuePerContract };
  }

  /** Funded open value bound to one set in one asset. */
  openValue(attesterSetId: string, asset: string): bigint {
    return this.exposure.get(tupleKey(attesterSetId, asset)) ?? 0n;
  }

  /** Funded open value of one provider inside one set, in one asset. */
  providerOpenValue(attesterSetId: string, asset: string, providerId: string): bigint {
    return this.exposure.get(tupleKey(attesterSetId, asset, "provider", providerId)) ?? 0n;
  }

  /** v0.5.3: funded open value of one buyer inside one set, in one asset. */
  buyerOpenValue(attesterSetId: string, asset: string, buyerId: string): bigint {
    return this.exposure.get(tupleKey(attesterSetId, asset, "buyer", buyerId)) ?? 0n;
  }

  /**
   * Deterministic lock check (no mutation): `value` (gross + gas of one order)
   * must fit the per-contract cap, the set's remaining cap for `asset` and the
   * provider's remaining subcap. Called at reservation (fail early) and again
   * when the order is funded.
   */
  checkLock(policy: ListingEvidencePolicy, asset: string, value: bigint, providerId: string, buyerId?: string): void {
    if (value > policy.maxValuePerContract) throw new Error("EVIDENCE_CONTRACT_CAP_EXCEEDED");
    // v0.5.3: the buyer's own quota first (a buyer limit, never a no-fault close).
    if (buyerId !== undefined && this.buyerOpenValue(policy.attesterSetId, asset, buyerId) + value > this.buyerCap(policy.attesterSetId, asset)) throw new Error("EVIDENCE_BUYER_CAP_EXCEEDED");
    const cap = this.setCap(policy.attesterSetId, asset);
    if (this.openValue(policy.attesterSetId, asset) + value > cap) throw new Error("EVIDENCE_ATTESTER_SET_CAP_EXCEEDED");
    if (this.providerOpenValue(policy.attesterSetId, asset, providerId) + value > this.providerCap(policy.attesterSetId, asset)) throw new Error("EVIDENCE_PROVIDER_CAP_EXCEEDED");
  }

  private addExposure(key: string, delta: bigint): void {
    const next = (this.exposure.get(key) ?? 0n) + delta;
    if (next < 0n) throw new Error("EVIDENCE_EXPOSURE_UNDERFLOW");
    if (next === 0n) this.exposure.delete(key);
    else this.exposure.set(key, next);
  }

  /** Record the funded value of an order (checks again first). */
  lock(policy: ListingEvidencePolicy, asset: string, value: bigint, providerId: string, buyerId?: string): void {
    this.checkLock(policy, asset, value, providerId, buyerId);
    this.addExposure(tupleKey(policy.attesterSetId, asset), value);
    this.addExposure(tupleKey(policy.attesterSetId, asset, "provider", providerId), value);
    if (buyerId !== undefined) this.addExposure(tupleKey(policy.attesterSetId, asset, "buyer", buyerId), value);
  }

  /** Release the open value of a closed order (exactly once per lock). */
  release(attesterSetId: string, asset: string, value: bigint, providerId: string, buyerId?: string): void {
    if (this.openValue(attesterSetId, asset) < value || this.providerOpenValue(attesterSetId, asset, providerId) < value) throw new Error("EVIDENCE_EXPOSURE_UNDERFLOW");
    if (buyerId !== undefined && this.buyerOpenValue(attesterSetId, asset, buyerId) < value) throw new Error("EVIDENCE_EXPOSURE_UNDERFLOW");
    this.addExposure(tupleKey(attesterSetId, asset), -value);
    this.addExposure(tupleKey(attesterSetId, asset, "provider", providerId), -value);
    if (buyerId !== undefined) this.addExposure(tupleKey(attesterSetId, asset, "buyer", buyerId), -value);
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
    providerOpenValue: (attesterSetId: string, asset: string, providerId: string) => caps.providerOpenValue(attesterSetId, asset, providerId),
    providerCap: (attesterSetId: string, asset: string) => caps.providerCap(attesterSetId, asset),
    buyerOpenValue: (attesterSetId: string, asset: string, buyerId: string) => caps.buyerOpenValue(attesterSetId, asset, buyerId),
    buyerCap: (attesterSetId: string, asset: string) => caps.buyerCap(attesterSetId, asset),
    minProviderBond: (attesterSetId: string, asset: string) => caps.minProviderBond(attesterSetId, asset),
    attesterSet: (attesterSetId: string) => caps.attesterSet(attesterSetId),
  });
}
