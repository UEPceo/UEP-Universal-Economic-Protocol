import { verifyEd25519 } from "../core/ed25519.ts";
import { canonicalJson } from "../core/canonical-json.ts";
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
 * An evidence statement: k-of-n attester signatures over a source publication
 * hash. Verified by `verifyEvidenceStatement` (strict Ed25519, distinct
 * attesters of one set, bound to the order and, since 0.5.82, to the local
 * ledger network). Adapters that fetch from an external source run outside the
 * state machine (scripts/adapters/); only the hash, height and source id are
 * kept in the Marketplace state.
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
  /**
   * 0.5.82: signed message format. 2 (default) = `UEP-EVIDENCE-STATEMENT-v2`,
   * bound to the verifying node's own ledger network id. 1 = legacy unbound
   * message, accepted only when the Marketplace is configured to accept
   * archived v1 statements.
   */
  version?: 1 | 2;
  /** 0.5.82 (fix 5, structure only): hash of the canonical claim the attesters checked (see `canonicalEvidenceClaim`). */
  claimHash?: string;
};

/** 0.5.82: domain tag of the v2 statement message. */
export const EVIDENCE_STATEMENT_DOMAIN_V2 = "UEP-EVIDENCE-STATEMENT-v2";

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
  /** 0.5.82: a statement is refused when `now - observedHeight > maxAgeHeights` at submission. */
  maxAgeHeights?: number;
  /**
   * 0.5.82: what happens to a DELIVERED order that has no accepted statement
   * `evidenceDeadlineHeight` heights after its reservation (counted from the
   * order's `createdAt` height). REFUND returns the escrow to the buyer;
   * RELEASE pays the provider (refund instead when a category settlement guard
   * applies and fails). Neither path reads an external source.
   */
  onNoEvidence?: "REFUND" | "RELEASE";
  /** 0.5.82: heights after reservation (createdAt) at which `onNoEvidence` may be applied. Required with `onNoEvidence`. */
  evidenceDeadlineHeight?: number;
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

  /** v0.5.3: ids of the configured attester sets (sorted). */
  attesterSetIds(): string[] {
    return [...this.sets.keys()].sort();
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
    const out: ListingEvidencePolicy = { attesterSetId: policy.attesterSetId, maxValuePerContract: policy.maxValuePerContract };
    // 0.5.82: optional age bound and no-evidence outcome, frozen with the listing terms.
    if (policy.maxAgeHeights !== undefined) {
      if (!Number.isSafeInteger(policy.maxAgeHeights) || policy.maxAgeHeights < 0) throw new Error("EVIDENCE_POLICY_INVALID: maxAgeHeights is a non-negative integer");
      out.maxAgeHeights = policy.maxAgeHeights;
    }
    if (policy.onNoEvidence !== undefined || policy.evidenceDeadlineHeight !== undefined) {
      if (policy.onNoEvidence !== "REFUND" && policy.onNoEvidence !== "RELEASE") throw new Error("EVIDENCE_POLICY_INVALID: onNoEvidence is REFUND or RELEASE");
      if (!Number.isSafeInteger(policy.evidenceDeadlineHeight) || (policy.evidenceDeadlineHeight as number) < 1) throw new Error("EVIDENCE_POLICY_INVALID: evidenceDeadlineHeight is a positive integer (heights after reservation)");
      out.onNoEvidence = policy.onNoEvidence;
      out.evidenceDeadlineHeight = policy.evidenceDeadlineHeight;
    }
    return out;
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


/**
 * Bytes the attesters sign. The published data is not included.
 * v2 (0.5.82): domain tag + the verifying node's ledger network id. The network
 * id is always the local one, never read from the statement, so a statement
 * signed for another network does not verify here. v1 (legacy) is the unbound
 * 0.5.81 message.
 */
export function evidenceStatementMessage(statement: Omit<EvidenceStatement, "signatures">, ledgerNetworkId?: string): Uint8Array {
  const body = {
    sourceId: statement.sourceId,
    dataHash: statement.dataHash,
    observedHeight: statement.observedHeight,
    orderId: statement.orderId,
    attesterSetId: statement.attesterSetId,
  };
  if ((statement.version ?? 2) === 1) return Buffer.from(canonicalJson(body));
  if (typeof ledgerNetworkId !== "string" || ledgerNetworkId === "") throw new Error("EVIDENCE_NETWORK_REQUIRED");
  return Buffer.from(canonicalJson({ domain: EVIDENCE_STATEMENT_DOMAIN_V2, ledgerNetworkId, ...body, claimHash: statement.claimHash ?? null }));
}

export type VerifyEvidenceOptions = {
  /** The verifying node's own ledger network id (v2 messages). */
  ledgerNetworkId?: string;
  /** Accept legacy v1 (network-unbound) statements. Only for archived evidence; default false. */
  acceptV1Archive?: boolean;
};

/** k of n over the statement. Does not fetch the source and does not keep the data. */
export function verifyEvidenceStatement(statement: EvidenceStatement, set: AttesterSetPolicy, opts: VerifyEvidenceOptions = {}): void {
  if (statement.attesterSetId !== set.attesterSetId) throw new Error("EVIDENCE_SET_MISMATCH");
  if (statement.sourceId !== set.sourceId) throw new Error("EVIDENCE_SOURCE_MISMATCH");
  if (!/^[0-9a-f]{64}$/.test(statement.dataHash)) throw new Error("EVIDENCE_HASH_INVALID");
  if (!Number.isSafeInteger(statement.observedHeight) || statement.observedHeight < 0) throw new Error("EVIDENCE_HEIGHT_INVALID");
  const version = statement.version ?? 2;
  if (version !== 1 && version !== 2) throw new Error("EVIDENCE_VERSION_INVALID");
  if (version === 1 && opts.acceptV1Archive !== true) throw new Error("EVIDENCE_V1_NOT_ACCEPTED");
  if (statement.claimHash !== undefined && !/^[0-9a-f]{64}$/.test(statement.claimHash)) throw new Error("EVIDENCE_CLAIM_INVALID");
  const message = evidenceStatementMessage(statement, opts.ledgerNetworkId);
  if (!Array.isArray(statement.signatures)) throw new Error("EVIDENCE_THRESHOLD");
  const seen = new Set<string>();
  let ok = 0;
  for (const sig of statement.signatures) {
    if (seen.has(sig.attesterId)) throw new Error("EVIDENCE_ATTESTER_REPEATED");
    seen.add(sig.attesterId);
    if (!set.attesterKeys.includes(sig.attesterId)) throw new Error("EVIDENCE_ATTESTER_UNKNOWN");
    if (!verifyEd25519(message, sig.signature, sig.attesterId)) throw new Error("EVIDENCE_SIGNATURE_INVALID");
    ok += 1;
  }
  if (ok < set.threshold) throw new Error("EVIDENCE_THRESHOLD");
}

/*
 * 0.5.82 fix 5 (STRUCTURE ONLY): canonical normalized claims and distinct
 * source sets. Attesters sign the hash of one canonical claim (e.g. "a seismic
 * event of magnitude >= Mmin inside this lat/lon box within this height
 * window"), and an outcome may require k statements from distinct source sets.
 * The windowed TOLERANCES (how far two sources may disagree on magnitude,
 * position or time) are RESIDUAL: they are unset until the 30-day study, and
 * `checkClaimAgreement` refuses to decide while they are unset. Nothing here is
 * wired into settlement yet.
 */
export type EvidenceClaim = {
  kind: "SEISMIC";
  /** Minimum magnitude in tenths (integer, e.g. 45 = M4.5). */
  minMagnitudeTenths: number;
  /** Bounding box in micro-degrees (integers). */
  latMinMicro: number; latMaxMicro: number; lonMinMicro: number; lonMaxMicro: number;
  /** Ledger height window [fromHeight, toHeight]. */
  fromHeight: number; toHeight: number;
};

/** Tolerances between sources. RESIDUAL: unset until the 30-day study. */
export type ClaimTolerances = { magnitudeTenths: number; positionMicro: number; heights: number } | undefined;
export const CLAIM_TOLERANCES: ClaimTolerances = undefined;

/** Canonical bytes of a claim (integers only, fixed key order, range checks). */
export function canonicalEvidenceClaim(c: EvidenceClaim): string {
  const ints = [c.minMagnitudeTenths, c.latMinMicro, c.latMaxMicro, c.lonMinMicro, c.lonMaxMicro, c.fromHeight, c.toHeight];
  if (c.kind !== "SEISMIC" || ints.some((v) => !Number.isSafeInteger(v))) throw new Error("EVIDENCE_CLAIM_INVALID");
  if (c.latMinMicro > c.latMaxMicro || c.lonMinMicro > c.lonMaxMicro || c.latMinMicro < -90_000_000 || c.latMaxMicro > 90_000_000 || c.lonMinMicro < -180_000_000 || c.lonMaxMicro > 180_000_000) throw new Error("EVIDENCE_CLAIM_INVALID: box");
  if (c.fromHeight < 0 || c.toHeight < c.fromHeight || c.minMagnitudeTenths < 0) throw new Error("EVIDENCE_CLAIM_INVALID: window");
  return canonicalJson({ domain: "UEP-EVIDENCE-CLAIM-v1", kind: c.kind, minMagnitudeTenths: c.minMagnitudeTenths, latMinMicro: c.latMinMicro, latMaxMicro: c.latMaxMicro, lonMinMicro: c.lonMinMicro, lonMaxMicro: c.lonMaxMicro, fromHeight: c.fromHeight, toHeight: c.toHeight });
}

/**
 * k statements from k distinct source sets (distinct `sourceId` and disjoint
 * attester keys), all for the same claim hash. Does not compare values: that
 * needs the tolerances (residual).
 */
export function checkDistinctSourceSets(statements: readonly EvidenceStatement[], sets: readonly AttesterSetPolicy[], k: number, claimHash: string): void {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error("EVIDENCE_SOURCES_INVALID");
  const byId = new Map(sets.map((s) => [s.attesterSetId, s]));
  const sources = new Set<string>();
  const keys = new Set<string>();
  for (const st of statements) {
    if (st.claimHash !== claimHash) throw new Error("EVIDENCE_CLAIM_MISMATCH");
    const set = byId.get(st.attesterSetId);
    if (!set) throw new Error("EVIDENCE_SET_MISMATCH");
    if (sources.has(set.sourceId)) throw new Error("EVIDENCE_SOURCE_NOT_DISTINCT");
    for (const key of set.attesterKeys) { if (keys.has(key)) throw new Error("EVIDENCE_SOURCE_NOT_DISTINCT: shared attester"); }
    sources.add(set.sourceId);
    for (const key of set.attesterKeys) keys.add(key);
  }
  if (sources.size < k) throw new Error("EVIDENCE_SOURCES_INSUFFICIENT");
}

/** Value agreement between sources. Refuses while the tolerances are unset (residual, 30-day study). */
export function checkClaimAgreement(tolerances: ClaimTolerances = CLAIM_TOLERANCES): void {
  if (tolerances === undefined) throw new Error("EVIDENCE_TOLERANCES_UNSET: residual pending the 30-day study");
}
