/**
 * v0.5.3: a dispute freeze has a maximum duration (MAX_FREEZE_HEIGHTS). After
 * it, the order's own refund / timeout path opens even if the dispute never
 * timed out, and a late timeout only settles the claimant's bond.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FREEZE_HEIGHTS, freezeLapsed } from "./disputable.ts";
import { harness, EUR } from "./category-testkit.ts";

test("freeze cap: the constant and the lapse rule", () => {
  assert.equal(MAX_FREEZE_HEIGHTS, 241_920); // 14 days at 5 s
  assert.equal(freezeLapsed(undefined, 10 ** 9), false);
  assert.equal(freezeLapsed(100, 100 + MAX_FREEZE_HEIGHTS), false);
  assert.equal(freezeLapsed(100, 101 + MAX_FREEZE_HEIGHTS), true);
});

test("freeze cap: dispute windows must end before the freeze lapses", () => {
  assert.throws(() => harness(1, { dispute: { evidenceHeights: 720, resolutionHeights: MAX_FREEZE_HEIGHTS } }), /DISPUTE_WINDOWS/);
  assert.throws(() => harness(1, { dispute: { resolutionHeights: 0 } }), /DISPUTE_WINDOWS/);
  harness(1, { dispute: { evidenceHeights: 720, resolutionHeights: MAX_FREEZE_HEIGHTS - 721 } });
});

test("freeze cap: a swap frozen by a dispute nobody times out is refunded after the cap", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 0n, 10_000n);
  const s = H.openSwap(buyer, maker);
  const dsp = H.openDispute(buyer, "swap", s.intentId, 50n);
  H.advance(MAX_FREEZE_HEIGHTS);
  assert.throws(() => H.swap.expire(s.intentId), /SWAP_FROZEN/);
  assert.throws(() => H.swap.lapseFreeze(s.intentId), /SWAP_FREEZE_NOT_LAPSED/);
  H.advance(1);
  const done = H.swap.expire(s.intentId);
  assert.equal(done.state, "EXPIRED_REFUNDED");
  assert.equal(done.frozenBy, undefined);
  assert.equal(typeof done.freezeLapsedAt, "number");
  assert.equal(H.bal(EUR, buyer), 10_000n - 50n); // swap refunded; only the dispute bond is still held
  // The late timeout settles the bond only (20 % to the respondent).
  const c = H.dispute.timeout(dsp);
  assert.equal(c.state, "TIMED_OUT");
  assert.equal(c.freezeLapsed, true);
  assert.equal(c.releaseBps, undefined);
  assert.equal(H.bal(EUR, buyer), 10_000n - 10n);
  assert.ok(H.conserved());
});

test("freeze cap: a relay frozen over its key deadline refunds both holds without a provider fault", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const r = H.openRelay(buyer, prov, buyer, { price: 1_000n, bond: 100n });
  const dsp = H.openDispute(buyer, "relay", r.orderId, 100n);
  H.advance(MAX_FREEZE_HEIGHTS + 1);
  const lapsed = H.relay.lapseFreeze(r.orderId);
  assert.equal(lapsed.frozenBy, undefined);
  assert.throws(() => H.relay.lapseFreeze(r.orderId), /RELAY_NOT_FROZEN/);
  const provBefore = H.bal(EUR, prov);
  const o = H.relay.expire(r.orderId);
  assert.equal(o.state, "EXPIRED_REFUNDED");
  assert.equal(H.bal(EUR, prov), provBefore + 100n); // bond back in full: the freeze blocked the key
  const c = H.dispute.timeout(dsp);
  assert.equal(c.freezeLapsed, true);
  assert.ok(H.conserved());
});

test("freeze cap: after KEY_RELEASED the fraud window gets back at most the cap, then finalize pays the provider", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const rcpt = H.user("rcpt");
  const r = H.openRelay(buyer, prov, rcpt, { price: 2_000n, bond: 100n });
  assert.equal(r.publish(), "KEY_RELEASED");
  const windowEnd = H.relay.get(r.orderId)!.fraudWindowEndsAt!;
  H.openDispute(buyer, "relay", r.orderId, 50n);
  H.advance(MAX_FREEZE_HEIGHTS + 1);
  assert.throws(() => H.relay.finalize(r.orderId), /RELAY_FRAUD_WINDOW_OPEN/); // lapsed: window extended by the cap
  assert.equal(H.relay.get(r.orderId)!.fraudWindowEndsAt, windowEnd + MAX_FREEZE_HEIGHTS);
  H.advance(H.relay.get(r.orderId)!.fraudWindowEndsAt! - H.height() + 1);
  assert.equal(H.relay.finalize(r.orderId).state, "SETTLED");
  assert.ok(H.conserved());
});
