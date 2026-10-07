/**
 * Category integration tests (v0.5.2): swap / relay / dispute / drip over the
 * Marketplace escrow port, with valueAccounting conserved after each step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, enrollIdentity, testCredit } from "../marketplace/testkit.ts";
import { createTestAuthority } from "../marketplace/testkit.ts";
import { SettlementIndex } from "./settlement-index.ts";
import { SwapCategory, swapHashlock, swapIntentId } from "./swap.ts";
import {
  RelayCategory,
  prepareBlob,
  relayOrderId,
  buildFraudProof,
  proofDigest,
} from "./relay.ts";
import { DisputeCategory, disputeIdOf, verdictKindFor } from "./dispute.ts";
import { DripController } from "./drip.ts";

const EUR = "uep-test/teur";
const ENERGY = "uep-test/tenergy";

function market(height = 1000) {
  let h = height;
  const admin = createTestAuthority("admin");
  const m = new DigitalServicesMarketplace({
    adminIdentity: admin.identityId,
    adminPublicKey: admin.publicKeyHex,
    height: () => h,
  });
  return {
    m,
    admin,
    advance: (n: number) => { h += n; },
    setHeight: (x: number) => { h = x; },
    height: () => h,
  };
}

test("swap happy path: dual hold, settle, fee on fromAsset, conservation", () => {
  const { m, height } = market(1000);
  const buyer = enrollIdentity(m, "buyer", { asset: EUR, amount: 10_000n });
  const maker = enrollIdentity(m, "maker", { asset: ENERGY, amount: 10_000n });
  const index = new SettlementIndex();
  const swap = new SwapCategory(m.issueCategoryEscrowPort("swap"), index);

  const preimage = "preimage-at-least-16b";
  const intent = {
    version: 1 as const,
    category: "uep.service.swap.v1" as const,
    networkId: "uep-testnet",
    buyerId: buyer.identityId,
    marketMakerId: maker.identityId,
    fromAsset: EUR,
    fromAmount: 1_000n,
    toAsset: ENERGY,
    toAmount: 500n,
    hashlock: swapHashlock(preimage, 1, "uep-testnet"),
    deadline: height() + 1000,
    orderNonce: 1,
  };
  const intentId = swapIntentId(intent);
  const opened = swap.open(
    act(m, buyer.identityId, "swap-intent", intentId, {
      version: 1, category: intent.category, networkId: intent.networkId,
      buyerId: intent.buyerId, marketMakerId: intent.marketMakerId,
      fromAsset: intent.fromAsset, fromAmount: intent.fromAmount,
      toAsset: intent.toAsset, toAmount: intent.toAmount,
      hashlock: intent.hashlock, deadline: intent.deadline, orderNonce: 1,
    }),
    intent,
    act(m, maker.identityId, "swap-accept", intentId, { intentId }),
    { intentId },
  );
  assert.equal(opened.state, "DUAL_HOLD_LOCKED");
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.equal(m.valueAccounting(ENERGY).conserved, true);
  assert.ok((m.valueAccounting(EUR).categoryHeld ?? 0n) === 1_000n);

  const settled = swap.settle(intentId, preimage);
  assert.equal(settled.state, "ATOMICALLY_SETTLED");
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.equal(m.valueAccounting(ENERGY).conserved, true);
  assert.equal(m.valueAccounting(EUR).categoryHeld, 0n);
  assert.equal(m.availableBalance(ENERGY, maker.identityId), 10_000n - 500n); // paid out toAsset
  // maker received fromAsset net of marketplace fee; buyer received ENERGY in full
  assert.equal(m.availableBalance(ENERGY, buyer.identityId), 500n);
  assert.ok(m.availableBalance(EUR, maker.identityId) > 0n);
  assert.ok(index.get(intentId));
});

test("swap expire refunds both legs", () => {
  const { m, advance, height } = market(100);
  const buyer = enrollIdentity(m, "b2", { asset: EUR, amount: 5_000n });
  const maker = enrollIdentity(m, "m2", { asset: ENERGY, amount: 5_000n });
  const index = new SettlementIndex();
  const swap = new SwapCategory(m.issueCategoryEscrowPort("swap"), index);
  const intent = {
    version: 1 as const,
    category: "uep.service.swap.v1" as const,
    networkId: "uep-testnet",
    buyerId: buyer.identityId,
    marketMakerId: maker.identityId,
    fromAsset: EUR,
    fromAmount: 200n,
    toAsset: ENERGY,
    toAmount: 100n,
    hashlock: swapHashlock("another-preimage16", 2, "uep-testnet"),
    deadline: height() + 10,
    orderNonce: 2,
  };
  const intentId = swapIntentId(intent);
  swap.open(
    act(m, buyer.identityId, "swap-intent", intentId, {
      version: 1, category: intent.category, networkId: intent.networkId,
      buyerId: intent.buyerId, marketMakerId: intent.marketMakerId,
      fromAsset: intent.fromAsset, fromAmount: intent.fromAmount,
      toAsset: intent.toAsset, toAmount: intent.toAmount,
      hashlock: intent.hashlock, deadline: intent.deadline, orderNonce: 2,
    }),
    intent,
    act(m, maker.identityId, "swap-accept", intentId, { intentId }),
    { intentId },
  );
  advance(11);
  const expired = swap.expire(intentId);
  assert.equal(expired.state, "EXPIRED_REFUNDED");
  assert.equal(m.availableBalance(EUR, buyer.identityId), 5_000n);
  assert.equal(m.availableBalance(ENERGY, maker.identityId), 5_000n);
  assert.equal(m.valueAccounting(EUR).conserved, true);
});

test("relay happy path with custody tranche and fraud-proof path", () => {
  const { m, height, advance } = market(500);
  const buyer = enrollIdentity(m, "rb", { asset: EUR, amount: 10_000n });
  const provider = enrollIdentity(m, "rp", { asset: EUR, amount: 10_000n });
  const recipient = enrollIdentity(m, "rr", { asset: EUR, amount: 0n });
  const index = new SettlementIndex();
  const relay = new RelayCategory(m.issueCategoryEscrowPort("relay"), index);

  const offer = {
    version: 1 as const,
    category: "uep.service.relay.v1" as const,
    networkId: "uep-testnet",
    buyerId: buyer.identityId,
    providerId: provider.identityId,
    recipientId: recipient.identityId,
    asset: EUR,
    price: 100n,
    minBond: 50n,
    keyDeadline: height() + 200,
    fraudWindowHeights: 20,
    nonce: 1,
  };
  const orderId = relayOrderId(offer);
  const k = Buffer.alloc(32, 0x11);
  const prepared = prepareBlob(Buffer.from("hello relay content for chunking!!"), k, "uep-testnet", orderId);
  const commit = { orderId, bond: 50n, ...prepared.commitment };

  relay.open(
    act(m, buyer.identityId, "relay-offer", orderId, {
      version: 1, category: offer.category, networkId: offer.networkId,
      buyerId: offer.buyerId, providerId: offer.providerId, recipientId: offer.recipientId,
      asset: offer.asset, price: offer.price, minBond: offer.minBond,
      keyDeadline: offer.keyDeadline, fraudWindowHeights: offer.fraudWindowHeights, nonce: 1,
    }),
    offer,
    act(m, provider.identityId, "relay-commit", orderId, {
      orderId, bond: commit.bond, chunkRoot: commit.chunkRoot, wrapRoot: commit.wrapRoot,
      kCommit: commit.kCommit, contentLen: commit.contentLen, leafCount: commit.leafCount,
    }),
    commit,
  );
  assert.equal(m.valueAccounting(EUR).conserved, true);

  const released = relay.publishKey(
    act(m, provider.identityId, "relay-key", orderId, { orderId, k: k.toString("hex") }),
    orderId,
    k.toString("hex"),
  );
  assert.equal(released, "KEY_RELEASED");

  relay.confirm(
    act(m, recipient.identityId, "relay-confirm", orderId, { orderId, chunkRoot: commit.chunkRoot }),
    orderId,
    commit.chunkRoot,
  );
  assert.equal(relay.get(orderId)?.state, "SETTLED");
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.ok(index.get(orderId));

  // Fraud path on a second order with tampered wrap.
  const offer2 = { ...offer, nonce: 2, keyDeadline: height() + 200 };
  const orderId2 = relayOrderId(offer2);
  const k2 = Buffer.alloc(32, 0x22);
  const prepared2 = prepareBlob(Buffer.from("second blob for fraud demonstration!!"), k2, "uep-testnet", orderId2, (w) => { w[0] ^= 0xff; });
  const commit2 = { orderId: orderId2, bond: 50n, ...prepared2.commitment };
  relay.open(
    act(m, buyer.identityId, "relay-offer", orderId2, {
      version: 1, category: offer2.category, networkId: offer2.networkId,
      buyerId: offer2.buyerId, providerId: offer2.providerId, recipientId: offer2.recipientId,
      asset: offer2.asset, price: offer2.price, minBond: offer2.minBond,
      keyDeadline: offer2.keyDeadline, fraudWindowHeights: offer2.fraudWindowHeights, nonce: 2,
    }),
    offer2,
    act(m, provider.identityId, "relay-commit", orderId2, {
      orderId: orderId2, bond: commit2.bond, chunkRoot: commit2.chunkRoot, wrapRoot: commit2.wrapRoot,
      kCommit: commit2.kCommit, contentLen: commit2.contentLen, leafCount: commit2.leafCount,
    }),
    commit2,
  );
  relay.publishKey(
    act(m, provider.identityId, "relay-key", orderId2, { orderId: orderId2, k: k2.toString("hex") }),
    orderId2,
    k2.toString("hex"),
  );
  const proof = buildFraudProof(prepared2.wrapped, prepared2.leaves, 0);
  const dig = proofDigest(proof);
  const result = relay.submitFraudProof(
    act(m, buyer.identityId, "relay-fraud", orderId2, { orderId: orderId2, proofDigest: dig }),
    orderId2,
    dig,
    proof,
  );
  assert.equal(result, "FRAUD_PROVEN");
  assert.equal(m.valueAccounting(EUR).conserved, true);
});

test("dispute quorum resolves swap; drip claims from settlement index", () => {
  const { m, admin, height, advance } = market(2000);
  const a1 = enrollIdentity(m, "arb1");
  const a2 = enrollIdentity(m, "arb2");
  const a3 = enrollIdentity(m, "arb3");
  const buyer = enrollIdentity(m, "db", { asset: EUR, amount: 20_000n });
  const maker = enrollIdentity(m, "dm", { asset: ENERGY, amount: 20_000n });
  // Fund maker with EUR for bond too
  testCredit(m, maker.identityId, EUR, 5_000n);

  const index = new SettlementIndex();
  const swapPort = m.issueCategoryEscrowPort("swap");
  const disputePort = m.issueCategoryEscrowPort("dispute");
  const swap = new SwapCategory(swapPort, index);
  const dispute = new DisputeCategory(disputePort, [a1.identityId, a2.identityId, a3.identityId], 2);
  dispute.attach(swap, swap.issueDisputeCap());

  const preimage = "dispute-preimage-16";
  const intent = {
    version: 1 as const,
    category: "uep.service.swap.v1" as const,
    networkId: "uep-testnet",
    buyerId: buyer.identityId,
    marketMakerId: maker.identityId,
    fromAsset: EUR,
    fromAmount: 1_000n,
    toAsset: ENERGY,
    toAmount: 400n,
    hashlock: swapHashlock(preimage, 7, "uep-testnet"),
    deadline: height() + 50_000,
    orderNonce: 7,
  };
  const intentId = swapIntentId(intent);
  swap.open(
    act(m, buyer.identityId, "swap-intent", intentId, {
      version: 1, category: intent.category, networkId: intent.networkId,
      buyerId: intent.buyerId, marketMakerId: intent.marketMakerId,
      fromAsset: intent.fromAsset, fromAmount: intent.fromAmount,
      toAsset: intent.toAsset, toAmount: intent.toAmount,
      hashlock: intent.hashlock, deadline: intent.deadline, orderNonce: 7,
    }),
    intent,
    act(m, maker.identityId, "swap-accept", intentId, { intentId }),
    { intentId },
  );

  const dspId = disputeIdOf("swap", intentId);
  const bond = 50n;
  dispute.open(
    act(m, buyer.identityId, "dispute-open", dspId, {
      category: "swap", orderId: intentId, bondAsset: EUR, bondAmount: bond, nonce: 1,
    }),
    { category: "swap", orderId: intentId, bondAsset: EUR, bondAmount: bond, nonce: 1 },
  );
  advance(721); // past evidence window
  const verdict = {
    disputeId: dspId,
    orderId: intentId,
    category: "swap" as const,
    kind: verdictKindFor(0),
    releaseBps: 0,
    frivolous: false,
  };
  dispute.resolve(dspId, [
    { auth: act(m, a1.identityId, "dispute-verdict", dspId, verdict), body: verdict },
    { auth: act(m, a2.identityId, "dispute-verdict", dspId, verdict), body: verdict },
  ]);
  assert.equal(dispute.get(dspId)?.state, "RESOLVED");
  assert.equal(swap.get(intentId)?.state, "DISPUTE_RESOLVED");
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.equal(m.valueAccounting(ENERGY).conserved, true);

  // Separate happy swap → drip
  const intent2 = {
    ...intent,
    orderNonce: 8,
    hashlock: swapHashlock("drip-preimage-xxxx", 8, "uep-testnet"),
    fromAmount: 2_000n,
    toAmount: 800n,
  };
  const id2 = swapIntentId(intent2);
  swap.open(
    act(m, buyer.identityId, "swap-intent", id2, {
      version: 1, category: intent2.category, networkId: intent2.networkId,
      buyerId: intent2.buyerId, marketMakerId: intent2.marketMakerId,
      fromAsset: intent2.fromAsset, fromAmount: intent2.fromAmount,
      toAsset: intent2.toAsset, toAmount: intent2.toAmount,
      hashlock: intent2.hashlock, deadline: intent2.deadline, orderNonce: 8,
    }),
    intent2,
    act(m, maker.identityId, "swap-accept", id2, { intentId: id2 }),
    { intentId: id2 },
  );
  swap.settle(id2, "drip-preimage-xxxx");
  const work = index.get(id2)!;
  assert.ok(work.feeCollected > 0n);

  // Only 15 % of the marketplace fee lands in DISTRIBUTABLE_PROFIT; drip is capped by that.
  const distributable = m.treasury.balanceOf(EUR).DISTRIBUTABLE_PROFIT;
  assert.ok(distributable > 0n);
  const budget = distributable < work.feeCollected ? distributable : work.feeCollected;
  m.allocateDripBudget("alloc-1", EUR, budget, act(m, admin.identityId, "drip-budget", "alloc-1", { asset: EUR, amount: budget }));
  const drip = new DripController(m.issueSubsidyPort(), index);
  const entitlement = work.feeCollected / 2n; // perOrderBps 5000
  const claimAmt = entitlement < budget ? entitlement : budget;
  assert.ok(claimAmt > 0n);
  const paid = drip.claim(
    act(m, maker.identityId, "drip-claim", id2, {
      nodeId: maker.identityId, asset: EUR, amount: claimAmt, orderId: id2, receiptHash: work.receiptHash, nonce: 1,
    }),
    { nodeId: maker.identityId, asset: EUR, amount: claimAmt, orderId: id2, receiptHash: work.receiptHash, nonce: 1 },
  );
  assert.equal(paid, claimAmt);
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.throws(() => drip.claim(
    act(m, maker.identityId, "drip-claim", id2, {
      nodeId: maker.identityId, asset: EUR, amount: 1n, orderId: id2, receiptHash: work.receiptHash, nonce: 2,
    }),
    { nodeId: maker.identityId, asset: EUR, amount: 1n, orderId: id2, receiptHash: work.receiptHash, nonce: 2 },
  ), /DRIP_ALREADY_CLAIMED|DRIP_COOLDOWN|DRIP_NO_ENTITLEMENT|DRIP_AMOUNT|DRIP_BUDGET/);
});
