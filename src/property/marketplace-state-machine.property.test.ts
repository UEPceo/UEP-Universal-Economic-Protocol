/** 0.5.81 item 6: marketplace order state machine (seeded property run, recovery, hold expiry, disputes). Seed: UEP_MKT_SEED (default 20261015). */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, type OrderStatus } from "../marketplace/marketplace.ts";
import { ORDER_TRANSITIONS, ORDER_PHASE, assertOrderTransition, isTerminalOrderStatus } from "../marketplace/order-state-machine.ts";
import { adoptTestIdentities, cancel, createTestAuthority, deliver, disputeAs, expire, fund, getOrder, publishAs, refundAs, reserveAs, resolveAs, settle } from "../marketplace/testkit.ts";

const ADMIN = createTestAuthority("sm-admin");
const ARBITER = createTestAuthority("sm-arbiter");
const SEED = Number(process.env.UEP_MKT_SEED ?? 20261015) >>> 0 || 1;
const mk = () => new DigitalServicesMarketplace({ testOnlyLocalHeight: true, adminIdentity: "sm-admin", adminPublicKey: ADMIN.publicKeyHex, settlementArbiterId: "sm-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex });
function prng(seed: number) { let x = seed; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

test("item 6: transition table is closed, terminal states are absorbing, settlement needs a receipt", () => {
  for (const [from, tos] of Object.entries(ORDER_TRANSITIONS) as [OrderStatus, OrderStatus[]][]) {
    for (const to of tos) assert.ok(ORDER_PHASE[to]);
    for (const to of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      if (tos.includes(to)) continue;
      assert.throws(() => assertOrderTransition(from, to, { settlementReceiptHash: "x" }), /ORDER_TRANSITION_INVALID/);
    }
  }
  assert.throws(() => assertOrderTransition("DELIVERED", "SETTLED"), /SETTLEMENT_RECEIPT_REQUIRED/);
  for (const t of ["SETTLED", "REFUNDED", "CANCELLED", "EXPIRED"] as const) assert.ok(isTerminalOrderStatus(t));
});

test(`item 6: seeded random operations only take table transitions, conserve value, stay idempotent and survive snapshot recovery (seed ${SEED})`, () => {
  const rnd = prng(SEED);
  let m = mk();
  const listing = publishAs(m, { providerId: "sm-prov", title: "GPU", description: "compute", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 1_000n });
  const orders: { id: string; buyer: string }[] = [];
  const seen = new Set<string>();
  const statusOf = (id: string, buyer: string) => getOrder(m, id, buyer).status;
  for (let step = 0; step < 400; step++) {
    let op = rnd() % 11;
    if (op === 0 || orders.length === 0) {
      const buyer = `sm-buyer-${rnd() % 4}`;
      let o;
      try { o = reserveAs(m, { listingId: listing.listingId, buyerId: buyer, quantity: 1n + BigInt(rnd() % 3), idempotencyKey: `k-${step}` }); } catch (e) { assert.match(String(e), /LIMIT|CAPACITY/); continue; }
      assert.equal(o.status, "ACCEPTED");
      orders.push({ id: o.orderId, buyer });
      continue;
    }
    if (op === 10) { // recovery: export, restore into a fresh instance, compare
      const snap = m.exportSnapshot();
      const fresh = mk();
      adoptTestIdentities(m, fresh);
      if (m.clock() > 0) assert.throws(() => fresh.restoreSnapshot(snap, { snapshotPublicKeys: m.snapshotPublicKeys() }), /HEIGHT_REGRESSED/);
      fresh.advanceHeight(m.clock());
      fresh.restoreSnapshot(snap, { snapshotPublicKeys: m.snapshotPublicKeys() });
      for (const o of orders) assert.equal(getOrder(fresh, o.id, o.buyer).status, statusOf(o.id, o.buyer));
      m = fresh;
      continue;
    }
    const o = orders[rnd() % orders.length]!;
    const before = statusOf(o.id, o.buyer);
    if (op !== 0 && rnd() % 2 === 0) { // bias towards the happy path so every phase is exercised
      const next: Partial<Record<OrderStatus, number[]>> = { ACCEPTED: [1], HELD: [2], DELIVERED: [3, 3, 4, 6], DISPUTED: [5] };
      const c = next[before]; if (c) op = c[rnd() % c.length]!;
    }
    const order = getOrder(m, o.id, o.buyer);
    const run = () => {
      switch (op) {
        case 1: return fund(m, o.id, order.fundingDue ?? 0n, `f-${o.id}`, o.buyer);
        case 2: return deliver(m, o.id, "sm-prov", Buffer.from(`r-${o.id}`), `d-${o.id}`);
        case 3: return settle(m, o.id, o.buyer);
        case 4: return disputeAs(m, o.buyer, o.id, "late");
        case 5: return resolveAs(m, "sm-arbiter", o.id, rnd() % 2 ? { outcome: "RELEASE" } : { outcome: "REFUND_BUYER" });
        case 6: return refundAs(m, "sm-prov", o.id);
        case 7: return cancel(m, o.id, o.buyer);
        case 8: m.advanceHeight(1 + (rnd() % 40)); return expire(m, o.id, o.buyer);
        default: m.advanceHeight(1 + (rnd() % 5)); return undefined;
      }
    };
    let first: unknown; let ok = true;
    try { first = run(); } catch { ok = false; }
    const after = statusOf(o.id, o.buyer);
    if (after !== before) {
      assert.ok(ORDER_TRANSITIONS[before].includes(after), `${before}->${after} at step ${step}`);
      seen.add(`${before}->${after}`);
    }
    if (!ok) assert.equal(after, before, "a refused operation must not change status");
    // Idempotence: repeating a successful fund/deliver/settle/refund with the same id does not move value again.
    if (ok && first !== undefined && (op === 1 || op === 2 || op === 3 || op === 6)) {
      const acct = m.valueAccounting("EUR");
      try { run(); } catch { /* a refused repeat is also fine */ }
      assert.deepEqual(m.valueAccounting("EUR"), acct, `repeat of op ${op} moved value`);
      assert.equal(statusOf(o.id, o.buyer), after);
    }
    if (ORDER_PHASE[after] === "SETTLEMENT") {
      const ord = getOrder(m, o.id, o.buyer);
      assert.ok(ord.settlementReceiptHash);
      assert.equal(m.settlementReceipt(o.id)?.receiptHash, ord.settlementReceiptHash);
    }
    assert.ok(m.valueAccounting("EUR").conserved, `conservation at step ${step}`);
  }
  // The run must have exercised the main edges.
  for (const e of ["ACCEPTED->HELD", "HELD->DELIVERED", "DELIVERED->SETTLED"]) assert.ok(seen.has(e), `edge ${e} not exercised; seen ${[...seen].join(",")}`);
});

test("item 6: hold expiry is height-based and returns the hold; dispute resolution is deterministic for the same inputs", () => {
  const outcome = () => {
    const m = mk();
    const listing = publishAs(m, { providerId: "sm-prov", title: "GPU", description: "compute", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 10n });
    const a = reserveAs(m, { listingId: listing.listingId, buyerId: "sm-b", quantity: 1n, idempotencyKey: "x1", orderId: "sm-o1" });
    assert.throws(() => expire(m, a.orderId, "sm-b"), /RESERVATION_NOT_EXPIRED/);
    m.advanceHeight(10_000);
    assert.equal(expire(m, a.orderId, "sm-b").status, "EXPIRED");
    const b = reserveAs(m, { listingId: listing.listingId, buyerId: "sm-b", quantity: 1n, idempotencyKey: "x2", orderId: "sm-o2" });
    fund(m, b.orderId, getOrder(m, b.orderId, "sm-b").fundingDue!, "f", "sm-b");
    deliver(m, b.orderId, "sm-prov", Buffer.from("r"));
    disputeAs(m, "sm-b", b.orderId, "bad");
    const r = resolveAs(m, "sm-arbiter", b.orderId, { outcome: "SPLIT", providerAmount: 40n });
    assert.ok(m.valueAccounting("EUR").conserved);
    return { r: JSON.stringify(r, (_k, v) => typeof v === "bigint" ? v.toString() : v), acct: JSON.stringify(m.valueAccounting("EUR"), (_k, v) => typeof v === "bigint" ? v.toString() : v) };
  };
  assert.deepEqual(outcome(), outcome());
});
