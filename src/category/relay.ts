/**
 * uep.service.relay.v1 — chunk fraud proofs over Marketplace HOLDs (v0.5.2).
 * ChaCha20 under an HKDF key. Custody / delivery split (attack battery): once
 * the committed key is published, custodyBps (default 2000 = 20 %) of the price
 * is paid to the provider unless fraud is proven; disputes apply releaseBps to
 * the remaining delivery tranche only.
 */
import { canonicalJson } from "../core/canonical-json.ts";
import type { ActorAuth } from "../marketplace/identity.ts";
import type { CategoryEscrowPort } from "../marketplace/category-escrow.ts";
import { HeightGuard, ReplayGuard } from "./signed.ts";
import type { IndexWriter, SettlementIndex } from "./settlement-index.ts";
import { newDisputeCapRegistry, type DisputeCap, type Disputable, type EscrowView } from "./disputable.ts";
import {
  assertHex32,
  assertNonNegInt,
  assertPositiveBigint,
  chacha20,
  keyCommit,
  leafHash,
  merklePath,
  merkleRoot,
  mulDivFloor,
  sha256Hex,
  verifyMerklePath,
  wrapKey,
} from "./relay-crypto.ts";

export const CHUNK = 1024;
export const MAX_LEAVES = 1 << 20;
const MAX_PATH = 32;

export interface RelayConfig {
  minPrice: bigint;
  minBond: bigint;
  /** Max key deadline distance in heights (7 d = 120_960). */
  maxLifetimeHeights: number;
  minFraudWindowHeights: number;
  maxFraudWindowHeights: number;
  maxInvalidFraudAttempts: number;
  slashBuyerBps: number;
  /** Share of price locked as custody once the key is published (default 2000 = 20 %). */
  custodyBps: number;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  minPrice: 2n,
  minBond: 10n,
  maxLifetimeHeights: 120_960,
  minFraudWindowHeights: 12,
  maxFraudWindowHeights: 120_960,
  maxInvalidFraudAttempts: 3,
  slashBuyerBps: 8000,
  custodyBps: 2000,
};

export interface RelayOfferBody {
  version: 1;
  category: "uep.service.relay.v1";
  networkId: string;
  buyerId: string;
  providerId: string;
  recipientId: string;
  asset: string;
  price: bigint;
  minBond: bigint;
  keyDeadline: number;
  fraudWindowHeights: number;
  nonce: number;
}

export interface BlobCommitment {
  chunkRoot: string;
  wrapRoot: string;
  kCommit: string;
  contentLen: number;
  leafCount: number;
}

export interface RelayCommitBody extends BlobCommitment {
  orderId: string;
  bond: bigint;
}

export type RelayState =
  | "FUNDED"
  | "KEY_RELEASED"
  | "SETTLED"
  | "FRAUD_PROVEN"
  | "KEY_RELEASE_FAULT"
  | "EXPIRED_REFUNDED"
  | "DISPUTE_RESOLVED";

export interface RelayOrder {
  orderId: string;
  offer: RelayOfferBody;
  commit: RelayCommitBody;
  state: RelayState;
  openedAt: number;
  publishedKey?: string;
  fraudWindowEndsAt?: number;
  settledAt?: number;
  invalidFraudAttempts: Record<string, number>;
  frozenBy?: string;
}

export interface ProviderCounters {
  settledCount: number;
  expiredNoFinalCount: number;
  fraudProvenCount: number;
  distinctRecipients: string[];
}

export function completionBps(c: ProviderCounters): number | undefined {
  const den = c.settledCount + c.expiredNoFinalCount;
  if (den === 0) return undefined;
  return Math.floor((c.settledCount * 10_000) / den);
}

export function relayOrderId(offer: RelayOfferBody): string {
  return `rly_${sha256Hex(canonicalJson(["UEP-RELAY-ORDERID-v1", offer])).slice(0, 32)}`;
}

export interface PreparedBlob {
  wrapped: Buffer;
  leaves: Buffer[];
  commitment: BlobCommitment;
}

export function prepareBlob(
  content: Buffer,
  k: Buffer,
  networkId: string,
  orderId: string,
  tamper?: (wrapped: Buffer) => void,
): PreparedBlob {
  if (content.length === 0) throw new Error("RELAY_EMPTY_CONTENT");
  const key = wrapKey(k, networkId, orderId);
  const n = Math.ceil(content.length / CHUNK);
  if (n > MAX_LEAVES) throw new Error("RELAY_TOO_LARGE");
  const padded = Buffer.alloc(n * CHUNK);
  content.copy(padded);
  const wrapped = chacha20(key, 0, Buffer.alloc(12), padded);
  tamper?.(wrapped);
  const leaves: Buffer[] = [];
  const wrapLeaves: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const slice = content.subarray(i * CHUNK, Math.min(content.length, (i + 1) * CHUNK));
    leaves.push(leafHash(i, slice.length, slice));
    wrapLeaves.push(leafHash(i, CHUNK, wrapped.subarray(i * CHUNK, (i + 1) * CHUNK)));
  }
  return {
    wrapped,
    leaves,
    commitment: {
      chunkRoot: merkleRoot(leaves).toString("hex"),
      wrapRoot: merkleRoot(wrapLeaves).toString("hex"),
      kCommit: keyCommit(orderId, k),
      contentLen: content.length,
      leafCount: n,
    },
  };
}

export function unwrapChunk(wrappedChunk: Buffer, k: Buffer, index: number, networkId: string, orderId: string): Buffer {
  return chacha20(wrapKey(k, networkId, orderId), 16 * index, Buffer.alloc(12), wrappedChunk);
}

export interface FraudProof {
  chunkIndex: number;
  wrappedChunk: Buffer;
  wrapPath: Buffer[];
  leafHash: Buffer;
  chunkPath: Buffer[];
}

export function buildFraudProof(wrapped: Buffer, plainLeaves: Buffer[], chunkIndex: number): FraudProof {
  const n = plainLeaves.length;
  const wrapLeaves: Buffer[] = [];
  for (let i = 0; i < n; i++) wrapLeaves.push(leafHash(i, CHUNK, wrapped.subarray(i * CHUNK, (i + 1) * CHUNK)));
  return {
    chunkIndex,
    wrappedChunk: Buffer.from(wrapped.subarray(chunkIndex * CHUNK, (chunkIndex + 1) * CHUNK)),
    wrapPath: merklePath(wrapLeaves, chunkIndex),
    leafHash: plainLeaves[chunkIndex]!,
    chunkPath: merklePath(plainLeaves, chunkIndex),
  };
}

export function proofDigest(p: FraudProof): string {
  return sha256Hex(
    canonicalJson([
      "UEP-RELAY-FRAUDPROOF-v1",
      p.chunkIndex,
      p.wrappedChunk.toString("hex"),
      p.wrapPath.map((b) => b.toString("hex")),
      p.leafHash.toString("hex"),
      p.chunkPath.map((b) => b.toString("hex")),
    ]),
  );
}

export type FraudResult = "FRAUD_PROVEN" | "RELAY_FRAUD_INVALID" | "RELAY_FRAUD_SIZE";

export function verifyChunkFraud(
  ctx: BlobCommitment & { networkId: string; orderId: string },
  publishedKey: Buffer,
  proof: FraudProof,
): FraudResult {
  if (
    !Number.isSafeInteger(proof.chunkIndex) ||
    !Buffer.isBuffer(proof.wrappedChunk) ||
    !Buffer.isBuffer(proof.leafHash) ||
    !Array.isArray(proof.wrapPath) ||
    !Array.isArray(proof.chunkPath)
  ) {
    return "RELAY_FRAUD_INVALID";
  }
  if (
    proof.wrappedChunk.length !== CHUNK ||
    proof.leafHash.length !== 32 ||
    proof.wrapPath.length > MAX_PATH ||
    proof.chunkPath.length > MAX_PATH ||
    proof.wrapPath.some((b) => !Buffer.isBuffer(b) || b.length !== 32) ||
    proof.chunkPath.some((b) => !Buffer.isBuffer(b) || b.length !== 32)
  ) {
    return "RELAY_FRAUD_SIZE";
  }
  if (proof.chunkIndex < 0 || proof.chunkIndex >= ctx.leafCount) return "RELAY_FRAUD_INVALID";
  const wrapLeaf = leafHash(proof.chunkIndex, CHUNK, proof.wrappedChunk);
  if (!verifyMerklePath(wrapLeaf, proof.chunkIndex, ctx.leafCount, proof.wrapPath, Buffer.from(ctx.wrapRoot, "hex"))) {
    return "RELAY_FRAUD_INVALID";
  }
  if (!verifyMerklePath(proof.leafHash, proof.chunkIndex, ctx.leafCount, proof.chunkPath, Buffer.from(ctx.chunkRoot, "hex"))) {
    return "RELAY_FRAUD_INVALID";
  }
  const expectedLen = Math.min(CHUNK, ctx.contentLen - proof.chunkIndex * CHUNK);
  const plain = unwrapChunk(proof.wrappedChunk, publishedKey, proof.chunkIndex, ctx.networkId, ctx.orderId);
  const actual = leafHash(proof.chunkIndex, expectedLen, plain.subarray(0, expectedLen));
  return actual.equals(proof.leafHash) ? "RELAY_FRAUD_INVALID" : "FRAUD_PROVEN";
}

export class RelayCategory implements Disputable {
  readonly category = "relay" as const;
  private orders = new Map<string, RelayOrder>();
  private counters = new Map<string, { settled: number; expired: number; fraud: number; recipients: Set<string> }>();
  private readonly replay = new ReplayGuard();
  private readonly heights = new HeightGuard();
  private readonly caps = newDisputeCapRegistry();
  private readonly writeIndex: IndexWriter;
  private readonly cfg: RelayConfig;
  private readonly port: CategoryEscrowPort;
  private readonly networkId: string;

  constructor(port: CategoryEscrowPort, index: SettlementIndex, networkId = "uep-testnet", cfg: Partial<RelayConfig> = {}) {
    if (port.module !== "relay") throw new Error("CATEGORY_PORT_MISMATCH");
    this.port = port;
    this.networkId = networkId;
    this.cfg = { ...DEFAULT_RELAY_CONFIG, ...cfg };
    if (!Number.isSafeInteger(this.cfg.custodyBps) || this.cfg.custodyBps < 0 || this.cfg.custodyBps > 10_000) {
      throw new Error("RELAY_CUSTODY_BPS");
    }
    this.writeIndex = index.issueWriter("relay");
  }

  open(offerAuth: ActorAuth, offer: RelayOfferBody, commitAuth: ActorAuth, commit: RelayCommitBody): RelayOrder {
    const height = this.port.height();
    this.heights.check(height);
    this.validateOffer(offer, height);
    const orderId = relayOrderId(offer);

    const buyer = this.port.authenticate(offerAuth, "relay-offer", orderId, {
      version: offer.version,
      category: offer.category,
      networkId: offer.networkId,
      buyerId: offer.buyerId,
      providerId: offer.providerId,
      recipientId: offer.recipientId,
      asset: offer.asset,
      price: offer.price,
      minBond: offer.minBond,
      keyDeadline: offer.keyDeadline,
      fraudWindowHeights: offer.fraudWindowHeights,
      nonce: offer.nonce,
    });
    if (buyer !== offer.buyerId) throw new Error("RELAY_BAD_SIGNATURE");

    this.validateCommit(commit, offer);
    if (commit.orderId !== orderId) throw new Error("RELAY_ORDER_MISMATCH");
    const provider = this.port.authenticate(commitAuth, "relay-commit", orderId, {
      orderId: commit.orderId,
      bond: commit.bond,
      chunkRoot: commit.chunkRoot,
      wrapRoot: commit.wrapRoot,
      kCommit: commit.kCommit,
      contentLen: commit.contentLen,
      leafCount: commit.leafCount,
    });
    if (provider !== offer.providerId) throw new Error("RELAY_BAD_SIGNATURE");

    if (this.orders.has(orderId)) throw new Error("RELAY_NONCE_REPLAY");
    this.replay.check("relay-nonce", offer.buyerId, offer.nonce);

    this.port.assertCanOpen([
      { accountId: offer.buyerId, asset: offer.asset, amount: offer.price },
      { accountId: offer.providerId, asset: offer.asset, amount: commit.bond },
    ]);
    try {
      this.port.openHold(`${orderId}:price`, offer.buyerId, offer.asset, offer.price);
      this.port.openHold(`${orderId}:bond`, offer.providerId, offer.asset, commit.bond);
    } catch (err) {
      try { this.port.refundHold(`${orderId}:price`); } catch { /* ignore */ }
      throw err;
    }
    this.replay.consume("relay-nonce", offer.buyerId, offer.nonce);
    const order: RelayOrder = {
      orderId,
      offer: { ...offer },
      commit: { ...commit },
      state: "FUNDED",
      openedAt: height,
      invalidFraudAttempts: {},
    };
    this.orders.set(orderId, order);
    return structuredClone(order);
  }

  publishKey(auth: ActorAuth, orderId: string, k: string): "KEY_RELEASED" | "KEY_RELEASE_FAULT" {
    const height = this.port.height();
    this.heights.check(height);
    const o = this.mustGet(orderId);
    const actor = this.port.authenticate(auth, "relay-key", orderId, { orderId, k });
    if (actor !== o.offer.providerId) throw new Error("RELAY_NOT_PROVIDER");
    if (o.state !== "FUNDED") throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    if (height > o.offer.keyDeadline) throw new Error("RELAY_DEADLINE");
    assertHex32(k, "key");
    if (keyCommit(o.orderId, Buffer.from(k, "hex")) !== o.commit.kCommit) {
      this.port.refundHold(`${o.orderId}:price`);
      this.port.refundHold(`${o.orderId}:bond`);
      o.state = "KEY_RELEASE_FAULT";
      this.counter(o.offer.providerId).expired += 1;
      return "KEY_RELEASE_FAULT";
    }
    o.publishedKey = k;
    o.state = "KEY_RELEASED";
    o.fraudWindowEndsAt = height + o.offer.fraudWindowHeights;
    return "KEY_RELEASED";
  }

  confirm(auth: ActorAuth, orderId: string, chunkRoot: string): RelayOrder {
    const height = this.port.height();
    this.heights.check(height);
    const o = this.mustGet(orderId);
    const actor = this.port.authenticate(auth, "relay-confirm", orderId, { orderId, chunkRoot });
    if (actor !== o.offer.recipientId) throw new Error("RELAY_NOT_RECIPIENT");
    if (o.state !== "KEY_RELEASED") throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    if (chunkRoot !== o.commit.chunkRoot) throw new Error("RELAY_CONFIRM_ROOT");
    this.settleHappy(o, height);
    return structuredClone(o);
  }

  finalize(orderId: string): RelayOrder {
    const height = this.port.height();
    this.heights.check(height);
    const o = this.mustGet(orderId);
    if (o.state !== "KEY_RELEASED") throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    if (height <= (o.fraudWindowEndsAt ?? Number.POSITIVE_INFINITY)) throw new Error("RELAY_FRAUD_WINDOW_OPEN");
    this.settleHappy(o, height);
    return structuredClone(o);
  }

  expire(orderId: string): RelayOrder {
    const height = this.port.height();
    this.heights.check(height);
    const o = this.mustGet(orderId);
    if (o.state !== "FUNDED") throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    if (height <= o.offer.keyDeadline) throw new Error("RELAY_NOT_EXPIRED");
    this.port.refundHold(`${o.orderId}:price`);
    this.port.refundHold(`${o.orderId}:bond`);
    o.state = "EXPIRED_REFUNDED";
    this.counter(o.offer.providerId).expired += 1;
    return structuredClone(o);
  }

  submitFraudProof(auth: ActorAuth, orderId: string, proofDigestHex: string, proof: FraudProof): FraudResult {
    const height = this.port.height();
    this.heights.check(height);
    const o = this.mustGet(orderId);
    const actor = this.port.authenticate(auth, "relay-fraud", orderId, { orderId, proofDigest: proofDigestHex });
    if (actor !== o.offer.buyerId && actor !== o.offer.recipientId) throw new Error("RELAY_NOT_PARTY");
    if (o.state !== "KEY_RELEASED" || o.publishedKey === undefined) throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    if (height > (o.fraudWindowEndsAt ?? 0)) throw new Error("RELAY_FRAUD_WINDOW_CLOSED");
    if ((o.invalidFraudAttempts[actor] ?? 0) >= this.cfg.maxInvalidFraudAttempts) throw new Error("RELAY_FRAUD_ATTEMPTS");
    if (proofDigest(proof) !== proofDigestHex) throw new Error("RELAY_PROOF_DIGEST");

    const result = verifyChunkFraud(
      { ...o.commit, networkId: this.networkId, orderId: o.orderId },
      Buffer.from(o.publishedKey, "hex"),
      proof,
    );
    if (result !== "FRAUD_PROVEN") {
      o.invalidFraudAttempts[actor] = (o.invalidFraudAttempts[actor] ?? 0) + 1;
      return result;
    }

    const bond = o.commit.bond;
    const toBuyer = mulDivFloor(bond, this.cfg.slashBuyerBps, 10_000);
    const toTreasury = bond - toBuyer;
    this.port.refundHold(`${o.orderId}:price`);
    this.port.releaseHold(
      `${o.orderId}:bond`,
      [{ to: o.offer.buyerId, amount: toBuyer }].filter((p) => p.amount > 0n),
      toTreasury > 0n ? { refId: `${o.orderId}:slash`, amount: toTreasury } : undefined,
    );
    o.state = "FRAUD_PROVEN";
    o.settledAt = height;
    this.counter(o.offer.providerId).fraud += 1;
    return "FRAUD_PROVEN";
  }

  get(orderId: string): RelayOrder | undefined {
    const o = this.orders.get(orderId);
    return o ? structuredClone(o) : undefined;
  }

  providerCounters(providerId: string): ProviderCounters {
    const c = this.counters.get(providerId);
    return {
      settledCount: c?.settled ?? 0,
      expiredNoFinalCount: c?.expired ?? 0,
      fraudProvenCount: c?.fraud ?? 0,
      distinctRecipients: c ? [...c.recipients].sort() : [],
    };
  }

  issueDisputeCap(): DisputeCap {
    return this.caps.issue();
  }

  escrowView(orderId: string): EscrowView | undefined {
    const o = this.orders.get(orderId);
    if (!o) return undefined;
    return {
      orderId,
      category: "relay",
      buyerId: o.offer.buyerId,
      sellerId: o.offer.providerId,
      buyerSide: [...new Set([o.offer.buyerId, o.offer.recipientId])],
      sellerSide: [o.offer.providerId],
      escrows: [{ asset: o.offer.asset, amount: o.offer.price }],
      open: o.state === "FUNDED" || o.state === "KEY_RELEASED",
      frozen: o.frozenBy !== undefined,
    };
  }

  freeze(cap: DisputeCap, orderId: string, caseId: string): void {
    this.caps.check(cap);
    const o = this.mustGet(orderId);
    if (o.state !== "FUNDED" && o.state !== "KEY_RELEASED") throw new Error("RELAY_ORDER_STATE");
    if (o.frozenBy) throw new Error("RELAY_FROZEN");
    o.frozenBy = caseId;
  }

  unfreeze(cap: DisputeCap, orderId: string, caseId: string): void {
    this.caps.check(cap);
    const o = this.mustGet(orderId);
    if (o.frozenBy !== caseId) throw new Error("RELAY_FREEZE_OWNER");
    o.frozenBy = undefined;
  }

  apply(cap: DisputeCap, orderId: string, caseId: string, releaseBps: number): void {
    this.caps.check(cap);
    const height = this.port.height();
    const o = this.mustGet(orderId);
    if ((o.state !== "FUNDED" && o.state !== "KEY_RELEASED") || o.frozenBy !== caseId) throw new Error("RELAY_ORDER_STATE");
    if (!Number.isSafeInteger(releaseBps) || releaseBps < 0 || releaseBps > 10_000) throw new Error("RELAY_BPS");
    this.payPrice(o, releaseBps, height);
    this.port.refundHold(`${o.orderId}:bond`);
    o.state = "DISPUTE_RESOLVED";
    o.frozenBy = undefined;
    o.settledAt = height;
  }

  private mustGet(orderId: string): RelayOrder {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("RELAY_ORDER_STATE");
    return o;
  }

  private counter(providerId: string) {
    let c = this.counters.get(providerId);
    if (!c) {
      c = { settled: 0, expired: 0, fraud: 0, recipients: new Set() };
      this.counters.set(providerId, c);
    }
    return c;
  }

  private settleHappy(o: RelayOrder, height: number): void {
    this.payPrice(o, 10_000, height);
    this.port.refundHold(`${o.orderId}:bond`);
    o.state = "SETTLED";
    o.settledAt = height;
    const c = this.counter(o.offer.providerId);
    c.settled += 1;
    c.recipients.add(o.offer.recipientId);
  }

  /**
   * Price payout with custody / delivery split.
   * Before key: releaseBps of the full price.
   * After key: custody (custodyBps) always to provider + releaseBps of the delivery tranche.
   */
  private payPrice(o: RelayOrder, releaseBps: number, height: number): void {
    const price = o.offer.price;
    let providerAmount: bigint;
    if (o.state === "KEY_RELEASED" || o.publishedKey !== undefined) {
      const custody = mulDivFloor(price, this.cfg.custodyBps, 10_000);
      const delivery = price - custody;
      providerAmount = custody + mulDivFloor(delivery, releaseBps, 10_000);
    } else {
      providerAmount = mulDivFloor(price, releaseBps, 10_000);
    }
    const receipt = this.port.settleHold(`${o.orderId}:price`, o.offer.providerId, providerAmount, o.orderId);
    if (receipt.marketplaceFee > 0n) {
      this.writeIndex({
        orderId: o.orderId,
        category: "relay",
        providerId: o.offer.providerId,
        asset: o.offer.asset,
        feeCollected: receipt.marketplaceFee,
        receiptHash: receipt.receiptHash,
        settledAt: height,
      });
    }
  }

  private validateOffer(b: RelayOfferBody, height: number): void {
    if (b.version !== 1) throw new Error("RELAY_VERSION");
    if (b.category !== "uep.service.relay.v1") throw new Error("RELAY_CATEGORY");
    if (b.networkId !== this.networkId) throw new Error("RELAY_NETWORK");
    if (!this.port.isRegistered(b.buyerId) || !this.port.isRegistered(b.providerId) || !this.port.isRegistered(b.recipientId)) {
      throw new Error("IDENTITY_NOT_REGISTERED");
    }
    if (b.buyerId === b.providerId || b.recipientId === b.providerId) throw new Error("RELAY_PARTY");
    b.asset = this.port.assertAsset(b.asset);
    assertPositiveBigint(b.price, "price");
    if (b.price < this.cfg.minPrice) throw new Error("RELAY_PRICE_TOO_LOW");
    assertPositiveBigint(b.minBond, "minBond");
    if (b.minBond < this.cfg.minBond) throw new Error("RELAY_BOND_TOO_LOW");
    assertNonNegInt(b.nonce, "nonce");
    assertNonNegInt(b.keyDeadline, "keyDeadline");
    if (b.keyDeadline <= height || b.keyDeadline - height > this.cfg.maxLifetimeHeights) throw new Error("RELAY_DEADLINE");
    if (!Number.isSafeInteger(b.fraudWindowHeights) || b.fraudWindowHeights < this.cfg.minFraudWindowHeights || b.fraudWindowHeights > this.cfg.maxFraudWindowHeights) {
      throw new Error("RELAY_FRAUD_WINDOW");
    }
  }

  private validateCommit(c: RelayCommitBody, offer: RelayOfferBody): void {
    assertHex32(c.chunkRoot, "chunkRoot");
    assertHex32(c.wrapRoot, "wrapRoot");
    assertHex32(c.kCommit, "kCommit");
    if (!Number.isSafeInteger(c.contentLen) || c.contentLen < 1) throw new Error("RELAY_COMMIT_SHAPE");
    if (!Number.isSafeInteger(c.leafCount) || c.leafCount < 1) throw new Error("RELAY_COMMIT_SHAPE");
    if (c.leafCount > MAX_LEAVES || c.leafCount !== Math.ceil(c.contentLen / CHUNK)) throw new Error("RELAY_COMMIT_SHAPE");
    assertPositiveBigint(c.bond, "bond");
    if (c.bond < offer.minBond) throw new Error("RELAY_BOND_TOO_LOW");
  }
}
