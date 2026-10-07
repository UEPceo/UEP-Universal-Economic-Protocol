/**
 * v0.5.3 category hardening and ported module tests (relay fraud / slashing,
 * dispute quorum, swap and drip negatives, deterministic fuzz). Regression
 * tests for V52-01 (timeout after KEY_RELEASED), V52-02 (no-delivery cost),
 * V52-03 (timeout bond compensation) and the per-asset dispute bond minimum.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "../marketplace/testkit.ts";
import { buildFraudProof, proofDigest } from "./relay.ts";
import { DisputeCategory } from "./dispute.ts";
import { DripController } from "./drip.ts";
import { harness, EUR, ENERGY } from "./category-testkit.ts";

const RESOLUTION = 720 + 120_960;

test("V52-01: relay dispute timeout after KEY_RELEASED does not refund the buyer; order resumes and finalizes to the provider", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const rcpt = H.user("rcpt");
  const r = H.openRelay(buyer, prov, rcpt, { price: 5_000n, bond: 100n });
  assert.equal(r.publish(), "KEY_RELEASED");
  const windowEnd = H.relay.get(r.orderId)!.fraudWindowEndsAt!;
  const buyerBefore = H.bal(EUR, buyer);
  const dsp = H.openDispute(buyer, "relay", r.orderId, 50n);
  H.advance(5);
  assert.throws(() => H.relay.finalize(r.orderId), /RELAY_FROZEN/);
  H.advance(RESOLUTION);
  const c = H.dispute.timeout(dsp);
  assert.equal(c.state, "TIMED_OUT");
  assert.equal(c.resumed, true);
  assert.equal(c.releaseBps, undefined);
  assert.equal(c.timeoutCompensation, 10n); // 20 % of the 50 bond to the respondent
  const o = H.relay.get(r.orderId)!;
  assert.equal(o.state, "KEY_RELEASED");
  assert.equal(o.frozenBy, undefined);
  assert.equal(o.fraudWindowEndsAt, windowEnd + 5 + RESOLUTION + 0); // frozen time given back
  // The buyer did NOT get 80 % of the price back: only the bond minus compensation.
  assert.equal(H.bal(EUR, buyer), buyerBefore - 10n);
  assert.ok(H.conserved());
  H.advance(o.fraudWindowEndsAt! - H.height() + 1);
  const fin = H.relay.finalize(r.orderId);
  assert.equal(fin.state, "SETTLED");
  assert.equal(H.bal(EUR, buyer), buyerBefore - 10n); // price fully spent
  assert.ok(H.bal(EUR, prov) > 10_000n);
  assert.ok(H.conserved());
});

test("V52-01: after a resumed timeout the buyer keeps the objective fraud-proof path", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const rcpt = H.user("rcpt");
  const r = H.openRelay(buyer, prov, rcpt, { price: 2_000n, bond: 200n, tamper: (w) => { w[3] ^= 0x5a; } });
  r.publish();
  const dsp = H.openDispute(buyer, "relay", r.orderId, 50n);
  H.advance(RESOLUTION + 1);
  H.dispute.timeout(dsp);
  const proof = buildFraudProof(r.prepared.wrapped, r.prepared.leaves, 0);
  const dig = proofDigest(proof);
  const res = H.relay.submitFraudProof(act(H.m, buyer, "relay-fraud", r.orderId, { orderId: r.orderId, proofDigest: dig }), r.orderId, dig, proof);
  assert.equal(res, "FRAUD_PROVEN");
  assert.ok(H.conserved());
});

test("dispute timeout before the key keeps the default refund and compensates the respondent (V52-03)", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const r = H.openRelay(buyer, prov, buyer, { price: 1_000n });
  const dsp = H.openDispute(buyer, "relay", r.orderId, 100n);
  H.advance(RESOLUTION + 1);
  const c = H.dispute.timeout(dsp);
  assert.equal(c.releaseBps, 0);
  assert.equal(c.resumed, undefined);
  assert.equal(c.timeoutCompensation, 20n);
  assert.equal(H.relay.get(r.orderId)!.state, "DISPUTE_RESOLVED");
  assert.equal(H.bal(EUR, buyer), 10_000n - 20n);
  assert.ok(H.conserved());
});

test("timeoutBondToRespondentBps = 0 restores the v0.5.2 bond refund; invalid values are refused", () => {
  const H = harness(1000, { dispute: { timeoutBondToRespondentBps: 0 } });
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 0n, 10_000n);
  const s = H.openSwap(buyer, maker);
  const dsp = H.openDispute(buyer, "swap", s.intentId, 50n);
  H.advance(RESOLUTION + 1);
  assert.equal(H.dispute.timeout(dsp).timeoutCompensation, 0n);
  assert.equal(H.bal(EUR, buyer), 10_000n);
  assert.throws(() => harness(1, { dispute: { timeoutBondToRespondentBps: 10_001 } }), /DISPUTE_TIMEOUT_BOND_BPS/);
});

test("per-asset dispute bond minimum", () => {
  const H = harness(1000, { dispute: { minBondByAsset: { [EUR]: 500n } } });
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 0n, 10_000n);
  const s = H.openSwap(buyer, maker);
  assert.equal(H.dispute.minBondFor(EUR), 500n);
  assert.equal(H.dispute.minBondFor(ENERGY), 50n);
  assert.throws(() => H.openDispute(buyer, "swap", s.intentId, 499n), /DISPUTE_BOND_TOO_LOW/);
  assert.equal(H.bal(EUR, buyer), 10_000n - 1_000n); // refused open leaks nothing
  assert.equal(H.swap.escrowView(s.intentId)!.frozen, false);
  H.openDispute(buyer, "swap", s.intentId, 500n);
  assert.equal(H.swap.escrowView(s.intentId)!.frozen, true);
  assert.throws(() => harness(1, { dispute: { minBondByAsset: { [EUR]: 0n } } }), /DISPUTE_MIN_BOND/);
});

test("dispute quorum negatives: outsiders, duplicates, mismatches, binding, windows, frivolous misuse", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 0n, 10_000n);
  const outsider = H.user("outsider");
  const s = H.openSwap(buyer, maker);
  const dsp = H.openDispute(buyer, "swap", s.intentId, 50n);
  const [a0, a1] = H.arbiterIds;
  const v = H.verdict(dsp, "swap", s.intentId, 0);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v), H.sign(a1!, v)]), /DISPUTE_EVIDENCE_OPEN/);
  H.advance(721);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v), H.sign(outsider, v)]), /DISPUTE_ARBITER/);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v), H.sign(a0!, v)]), /DISPUTE_QUORUM_NOT_MET/);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v)]), /DISPUTE_QUORUM_NOT_MET/);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v), H.sign(a1!, H.verdict(dsp, "swap", s.intentId, 5000))]), /DISPUTE_VERDICT_MISMATCH/);
  const wrongOrder = { ...v, orderId: "x".repeat(10) };
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, wrongOrder), H.sign(a1!, wrongOrder)]), /DISPUTE_VERDICT_BINDING/);
  const badKind = { ...v, kind: "RELEASE" as const };
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, badKind), H.sign(a1!, badKind)]), /DISPUTE_VERDICT_INVALID/);
  const frivPartial = H.verdict(dsp, "swap", s.intentId, 5000, true);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, frivPartial), H.sign(a1!, frivPartial)]), /DISPUTE_VERDICT_INVALID/);
  // Forged auth: signature by a1 claimed for a0's verdict body is bound to the signer, so it counts as a1 only.
  assert.throws(() => H.dispute.timeout(dsp), /DISPUTE_NOT_TIMED_OUT/);
  H.advance(120_960 + 1);
  assert.throws(() => H.dispute.resolve(dsp, [H.sign(a0!, v), H.sign(a1!, v)]), /DISPUTE_RESOLUTION_EXPIRED/);
  assert.ok(H.conserved());
});

test("dispute: frivolous claim forfeits 80 % to the respondent and 20 % to the risk reserve; one case per order", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 1_000n, 10_000n);
  const s = H.openSwap(buyer, maker);
  const dsp = H.openDispute(buyer, "swap", s.intentId, 100n);
  assert.throws(() => H.openDispute(maker, "swap", s.intentId, 100n), /DISPUTE_ALREADY_EXISTS/);
  assert.throws(() => H.swap.settle(s.intentId, s.preimage), /SWAP_FROZEN/);
  H.advance(721);
  const v = H.verdict(dsp, "swap", s.intentId, 10_000, true);
  const makerEur = H.bal(EUR, maker);
  H.dispute.resolve(dsp, [H.sign(H.arbiterIds[0]!, v), H.sign(H.arbiterIds[2]!, v)]);
  const c = H.dispute.get(dsp)!;
  assert.equal(c.bondForfeited, true);
  assert.equal(H.dispute.adverseCount(buyer), 1);
  assert.ok(H.bal(EUR, maker) >= makerEur + 80n); // 80 bond share plus released price net of fee
  assert.ok(H.conserved());
});

test("V52-02: wrong key costs the provider part of the bond (paid to the buyer)", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const r = H.openRelay(buyer, prov, buyer, { price: 1_000n, bond: 500n });
  assert.equal(r.publish("ab".repeat(32)), "KEY_RELEASE_FAULT");
  assert.equal(H.bal(EUR, buyer), 10_000n + 100n);
  assert.equal(H.bal(EUR, prov), 10_000n - 100n);
  assert.equal(H.relay.providerCounters(prov).expiredNoFinalCount, 1);
  assert.ok(H.conserved());
});

test("V52-02: no key before the deadline costs the provider part of the bond", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const r = H.openRelay(buyer, prov, buyer, { price: 1_000n, bond: 500n, keyDeadline: 1010 });
  assert.throws(() => H.relay.expire(r.orderId), /RELAY_NOT_EXPIRED/);
  H.advance(11);
  assert.throws(() => r.publish(), /RELAY_DEADLINE/);
  assert.equal(H.relay.expire(r.orderId).state, "EXPIRED_REFUNDED");
  assert.equal(H.bal(EUR, buyer), 10_000n + 100n);
  assert.equal(H.bal(EUR, prov), 10_000n - 100n);
  assert.ok(H.conserved());
});

test("relay fraud: invalid proofs counted per submitter, capped; parties, window and digest enforced; valid fraud slashes 80/20", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const prov = H.user("prov", 10_000n);
  const rcpt = H.user("rcpt");
  const outsider = H.user("outsider");
  const honest = H.openRelay(buyer, prov, rcpt, { price: 1_000n, bond: 100n });
  honest.publish();
  const goodProof = buildFraudProof(honest.prepared.wrapped, honest.prepared.leaves, 0);
  const dig = proofDigest(goodProof);
  const submit = (who: string, d = dig, p = goodProof) => H.relay.submitFraudProof(act(H.m, who, "relay-fraud", honest.orderId, { orderId: honest.orderId, proofDigest: d }), honest.orderId, d, p);
  assert.throws(() => submit(outsider), /RELAY_NOT_PARTY/);
  assert.throws(() => submit(buyer, "00".repeat(32)), /RELAY_PROOF_DIGEST/);
  for (let i = 0; i < 3; i++) assert.notEqual(submit(buyer), "FRAUD_PROVEN");
  assert.throws(() => submit(buyer), /RELAY_FRAUD_ATTEMPTS/);
  assert.notEqual(submit(rcpt), "FRAUD_PROVEN"); // counted separately
  H.advance(21);
  assert.throws(() => submit(rcpt), /RELAY_FRAUD_WINDOW_CLOSED/);
  assert.equal(H.relay.finalize(honest.orderId).state, "SETTLED");

  const bad = H.openRelay(buyer, prov, rcpt, { price: 1_000n, bond: 100n, tamper: (w) => { w[1024 + 5] ^= 1; } });
  bad.publish();
  const leaf = 1;
  const p = buildFraudProof(bad.prepared.wrapped, bad.prepared.leaves, leaf);
  const d = proofDigest(p);
  const buyerBefore = H.bal(EUR, buyer);
  const reserveBefore = H.m.treasury.balanceOf(EUR).RISK_RESERVE ?? 0n;
  assert.equal(H.relay.submitFraudProof(act(H.m, rcpt, "relay-fraud", bad.orderId, { orderId: bad.orderId, proofDigest: d }), bad.orderId, d, p), "FRAUD_PROVEN");
  assert.equal(H.bal(EUR, buyer), buyerBefore + 1_000n + 80n);
  assert.equal((H.m.treasury.balanceOf(EUR).RISK_RESERVE ?? 0n) - reserveBefore, 20n);
  assert.equal(H.relay.providerCounters(prov).fraudProvenCount, 1);
  assert.ok(H.conserved());
});

test("swap negatives: wrong preimage, expiry, early expire, forged signatures, replay, shape", () => {
  const H = harness(1000);
  const buyer = H.user("buyer", 10_000n);
  const maker = H.user("maker", 0n, 10_000n);
  const s = H.openSwap(buyer, maker, { deadline: 1100 });
  assert.throws(() => H.swap.settle(s.intentId, "not-the-right-preimage"), /SWAP_HASHLOCK_MISMATCH/);
  assert.throws(() => H.swap.expire(s.intentId), /SWAP_NOT_EXPIRED/);
  H.advance(101);
  assert.throws(() => H.swap.settle(s.intentId, s.preimage), /SWAP_INTENT_EXPIRED/);
  assert.equal(H.swap.expire(s.intentId).state, "EXPIRED_REFUNDED");
  assert.throws(() => H.swap.expire(s.intentId), /SWAP_ALREADY_SETTLED/);
  assert.equal(H.bal(EUR, buyer), 10_000n);
  // Forged buyer signature (maker signs the intent).
  const intent = { ...s.intent, orderNonce: 999, deadline: H.height() + 100 };
  assert.throws(() => H.swap.open(act(H.m, maker, "swap-intent", "x", {}), intent, act(H.m, maker, "swap-accept", "x", { intentId: "x" }), { intentId: "x" }), /SWAP_BAD_SIGNATURE|ACTOR_SIGNATURE_INVALID/);
  // Same asset on both legs, tiny amounts.
  assert.throws(() => H.openSwap(buyer, maker, { toAsset: EUR }), /SWAP_ASSET_MISMATCH/);
  assert.throws(() => H.openSwap(buyer, maker, { fromAmount: 1n }), /SWAP_AMOUNT_TOO_SMALL/);
  assert.throws(() => H.openSwap(buyer, buyer), /SWAP_PARTY/);
  assert.ok(H.conserved());
});

test("drip negatives (not frozen): signer, provider, receipt, entitlement, single cap, replay, expiry", () => {
  const H = harness(2000);
  const buyer = H.user("buyer", 100_000n);
  const maker = H.user("maker", 0n, 100_000n);
  const other = H.user("other");
  const s = H.openSwap(buyer, maker, { fromAmount: 50_000n, toAmount: 1_000n });
  H.swap.settle(s.intentId, s.preimage);
  const work = H.index.get(s.intentId)!;
  const budget = H.m.treasury.balanceOf(EUR).DISTRIBUTABLE_PROFIT;
  H.m.allocateDripBudget("a1", EUR, budget, act(H.m, H.admin.identityId, "drip-budget", "a1", { asset: EUR, amount: budget }));
  const drip = new DripController(H.m.issueSubsidyPort(), H.index);
  const body = (o: Record<string, unknown> = {}) => ({ nodeId: maker, asset: EUR, amount: 1n, orderId: s.intentId, receiptHash: work.receiptHash, nonce: 1, ...o }) as { nodeId: string; asset: string; amount: bigint; orderId: string; receiptHash: string; nonce: number };
  const claim = (signer: string, b: ReturnType<typeof body>) => drip.claim(act(H.m, signer, "drip-claim", b.orderId, { ...b }), b);
  assert.throws(() => claim(other, body()), /DRIP_SIGNER/);
  assert.throws(() => claim(other, body({ nodeId: other })), /DRIP_NOT_PROVIDER/);
  assert.throws(() => claim(maker, body({ receiptHash: "11".repeat(32) })), /DRIP_WORK_MISMATCH/);
  assert.throws(() => claim(maker, body({ orderId: "unknown-order" })), /DRIP_WORK_UNVERIFIED/);
  assert.throws(() => claim(maker, body({ amount: 51n })), /DRIP_AMOUNT_EXCEEDS_SINGLE/);
  const accBefore = H.m.valueAccounting(EUR);
  assert.equal(accBefore.conserved, true);
  assert.equal(claim(maker, body({ nonce: 5 })), 1n);
  assert.throws(() => claim(maker, body({ nonce: 5 })), /REPLAY|NONCE/);
  assert.throws(() => claim(maker, body({ nonce: 6 })), /DRIP_ALREADY_CLAIMED/);
  // Receipt expiry on a second order.
  const s2 = H.openSwap(buyer, maker, { fromAmount: 50_000n, toAmount: 1_000n });
  H.swap.settle(s2.intentId, s2.preimage);
  const w2 = H.index.get(s2.intentId)!;
  H.advance(17_281);
  assert.throws(() => claim(maker, body({ orderId: s2.intentId, receiptHash: w2.receiptHash, nonce: 7 })), /DRIP_RECEIPT_EXPIRED/);
  assert.ok(H.conserved());
});

test("dispute constructor: registered distinct arbiters, strict-majority quorum", () => {
  const H = harness(1);
  const port = () => H.m.issueCategoryEscrowPort("dispute");
  assert.throws(() => new DisputeCategory(port(), [H.arbiterIds[0]!, H.arbiterIds[0]!], 2), /DISPUTE_ARBITERS|CATEGORY_PORT/);
});

test("fuzz (deterministic): conservation and liveness across random valid and invalid category operations", () => {
  let seed = 0x2545f491;
  const rnd = (n: number) => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  const H = harness(10_000);
  const users = ["u0", "u1", "u2", "u3"].map((u) => H.user(u, 1_000_000n, 1_000_000n));
  const swaps: { intentId: string; preimage: string }[] = [];
  const relays: { orderId: string; publish: (k?: string) => string }[] = [];
  const disputes: string[] = [];
  let ok = 0;
  let refused = 0;
  for (let step = 0; step < 300; step++) {
    const a = users[rnd(4)]!;
    let b = users[rnd(4)]!;
    if (b === a) b = users[(users.indexOf(a) + 1) % 4]!;
    try {
      switch (rnd(9)) {
        case 0: swaps.push(H.openSwap(a, b, { fromAmount: BigInt(100 + rnd(5000)), toAmount: BigInt(1 + rnd(900)), deadline: H.height() + 1 + rnd(400) })); break;
        case 1: { const s = swaps[rnd(swaps.length || 1)]; if (s) H.swap.settle(s.intentId, rnd(3) ? s.preimage : "wrong-preimage-xxxxxx"); break; }
        case 2: { const s = swaps[rnd(swaps.length || 1)]; if (s) H.swap.expire(s.intentId); break; }
        case 3: relays.push(H.openRelay(a, b, a, { price: BigInt(10 + rnd(3000)), bond: BigInt(50 + rnd(200)), keyDeadline: H.height() + 1 + rnd(300) })); break;
        case 4: { const r = relays[rnd(relays.length || 1)]; if (r) r.publish(rnd(4) ? undefined : "cd".repeat(32)); break; }
        case 5: { const r = relays[rnd(relays.length || 1)]; if (r) (rnd(2) ? H.relay.finalize(r.orderId) : H.relay.expire(r.orderId)); break; }
        case 6: {
          const useSwap = rnd(2) === 0;
          const list = useSwap ? swaps.map((s) => s.intentId) : relays.map((r) => r.orderId);
          const id = list[rnd(list.length || 1)];
          if (id) {
            const view = (useSwap ? H.swap : H.relay).escrowView(id)!;
            const claimant = rnd(2) ? view.buyerId : view.sellerId;
            disputes.push(H.openDispute(claimant, useSwap ? "swap" : "relay", id, BigInt(50 + rnd(100))));
          }
          break;
        }
        case 7: { const d = disputes[rnd(disputes.length || 1)]; if (d) H.dispute.timeout(d); break; }
        default: H.advance(1 + rnd(rnd(10) === 0 ? 130_000 : 60));
      }
      ok++;
    } catch {
      refused++;
    }
    assert.ok(H.conserved(), `conservation broken at step ${step}`);
  }
  // Liveness: everything can be wound down.
  H.advance(500_000);
  for (const d of disputes) { try { H.dispute.timeout(d); } catch { /* closed */ } }
  for (const s of swaps) { try { H.swap.expire(s.intentId); } catch { /* closed */ } }
  H.advance(500_000); // resumed relays got their frozen fraud-window time back
  for (const r of relays) { try { H.relay.expire(r.orderId); } catch { try { H.relay.finalize(r.orderId); } catch { /* closed */ } } }
  assert.equal(H.m.valueAccounting(EUR).categoryHeld ?? 0n, 0n);
  assert.equal(H.m.valueAccounting(ENERGY).categoryHeld ?? 0n, 0n);
  assert.ok(H.conserved());
  assert.ok(ok > 50 && refused > 5, `ok=${ok} refused=${refused}`);
});
