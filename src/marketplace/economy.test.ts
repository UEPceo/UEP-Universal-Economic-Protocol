import test from "node:test";
import assert from "node:assert/strict";
import {
  MarketplaceTreasury,
  calculateMarketplaceFee,
  quoteSettlement,
} from "./economy.ts";

test("marketplace economy charges 3% only on settled value", () => {
  assert.equal(calculateMarketplaceFee(100_00n), 3_00n);
  const q = quoteSettlement(100_00n, "EUR");
  assert.equal(q.marketplaceFee, 3_00n);
  assert.equal(q.providerNet, 97_00n);
});

test("treasury allocates every fee without value leakage", () => {
  const t = new MarketplaceTreasury();
  const q = t.settleMarketplaceFee("order-1", 100_00n, "EUR");
  assert.equal(q.marketplaceFee, 3_00n);
  assert.equal(t.totalOf("EUR"), 3_00n);
  const b = t.balanceOf("EUR");
  assert.equal(b.OPERATIONS, 1_20n);
  assert.equal(b.RISK_RESERVE, 75n);
  assert.equal(b.PRODUCT_DEVELOPMENT, 60n);
  assert.equal(b.DISTRIBUTABLE_PROFIT, 45n);
});

test("settlement fee is idempotency protected", () => {
  const t = new MarketplaceTreasury();
  t.settleMarketplaceFee("order-1", 100n, "EUR");
  assert.throws(() => t.settleMarketplaceFee("order-1", 100n, "EUR"), /FEE_ALREADY_SETTLED/);
});

test("treasury withdrawal requires authorization and cannot replay", () => {
  const t = new MarketplaceTreasury();
  t.settleMarketplaceFee("order-1", 10_000n, "EUR");
  const w = t.withdraw({
    withdrawalId: "wd-1",
    bucket: "DISTRIBUTABLE_PROFIT",
    asset: "EUR",
    amount: 45n,
    beneficiary: "marketplace-owner-entity",
    reason: "approved profit distribution",
    authorizationRef: "board-approval-001",
  });
  assert.equal(w.amount, 45n);
  assert.throws(() => t.withdraw({
    withdrawalId: "wd-1",
    bucket: "DISTRIBUTABLE_PROFIT",
    asset: "EUR",
    amount: 1n,
    beneficiary: "marketplace-owner-entity",
    reason: "replay",
    authorizationRef: "board-approval-001",
  }), /WITHDRAWAL_REPLAY/);
});

test("risk reserve cannot be overspent", () => {
  const t = new MarketplaceTreasury();
  t.settleMarketplaceFee("order-1", 100_00n, "EUR");
  assert.throws(() => t.withdraw({
    withdrawalId: "wd-risk",
    bucket: "RISK_RESERVE",
    asset: "EUR",
    amount: 76n,
    beneficiary: "approved-refund-processor",
    reason: "refund reserve",
    authorizationRef: "ops-001",
  }), /INSUFFICIENT_TREASURY_BALANCE/);
});
