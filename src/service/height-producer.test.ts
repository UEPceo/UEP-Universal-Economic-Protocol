/**
 * Height producer acceptance (ADR 0002): the single-node testnet gets
 * heights from real time, outside the transitions. A simulated wall clock is
 * injected, so the test is deterministic and fast.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeightProducer, MAX_BLOCKS_PER_TICK, MIN_BLOCK_SPACING_MS, ProducedHeight, type HeightProducerEvent } from "./height-producer.ts";
import { REFERENCE_BLOCK_TIME_MS, heightOf } from "../core/height.ts";
import { MarketplacePaymaster } from "../marketplace/paymaster.ts";
import { assertNoTestOnlyOptions, parseUntrustedOptions } from "../core/test-only.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, getOrder, publishAs, reserveAs } from "../marketplace/testkit.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { createUepHttpApi, listenUepHttpApi } from "./uep-http-api.ts";

const B = REFERENCE_BLOCK_TIME_MS;

describe("height producer", () => {
  it("40 spends of one account at distinct heights are accepted (the policy window rolls)", async () => {
    const faucet = generateEd25519KeyPair();
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, faucetSigningKey: faucet.privateKey });
    const a = await identityFromMnemonic(await generateMnemonic(128)); // in memory only
    const b = await identityFromMnemonic(await generateMnemonic(128));
    ledger.faucet(ledger.addressOf(a.accountId), "uep-test/teur", 10_000_000n);
    let wall = 1_800_000_000_000;
    const producer = new HeightProducer({ ledger, clock: () => wall });
    const heights = new Set<number>();
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      wall += B;
      assert.equal(producer.tick(), 1);
      const p = ledger.prepareSpend(a, ledger.addressOf(b.accountId), "uep-test/teur", 1_000n);
      assert.ok(!("error" in p), JSON.stringify((p as { error?: unknown }).error));
      const r = ledger.submit(p.tx);
      assert.ok("tx" in r, JSON.stringify((r as { error?: unknown }).error));
      heights.add(ledger.height);
      accepted++;
    }
    assert.equal(accepted, 40);
    assert.equal(heights.size, 40);
    assert.equal(ledger.height, 40);
  });

  it("a reservation expires once its TTL is reached in real time, not before", () => {
    const chain = new ProducedHeight();
    let wall = 0;
    const producer = new HeightProducer({ ledger: chain, clock: () => wall });
    const m = new DigitalServicesMarketplace({ height: () => chain.height });
    const listing = publishAs(m, { providerId: "prov", title: "GPU", description: "gpu hour", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 10n });
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    const ttl = order.windows.reservationTtl;
    assert.equal(ttl, 120);
    // The producer ticks once per block time (as start() does).
    for (let i = 0; i < ttl - 1; i++) { wall += B; assert.equal(producer.tick(), 1); }
    wall += B - 1; // one ms short of the TTL
    assert.equal(producer.tick(), 0);
    assert.equal(chain.height, ttl - 1);
    assert.throws(() => m.expire(order.orderId, act(m, "buyer", "expire", order.orderId)), /RESERVATION_NOT_EXPIRED/);
    assert.equal(m.reapExpiredReservations(), 0);
    wall += 1;
    assert.equal(producer.tick(), 1);
    assert.equal(m.reapExpiredReservations(), 1);
  });

  it("catches up n blocks only after n block times; never runs ahead; a clock going back seals nothing", () => {
    const chain = new ProducedHeight();
    let wall = 1_000_000;
    const sealed: number[] = [];
    const producer = new HeightProducer({ ledger: chain, clock: () => wall, onBlocks: (e) => sealed.push(e.sealed) });
    assert.equal(producer.tick(), 0);
    wall += B - 1;
    assert.equal(producer.tick(), 0);
    wall += 1;
    assert.equal(producer.tick(), 1);
    wall += 3 * B + 4_999; // a pause of 3.9 block times: 3 blocks
    assert.equal(producer.tick(), 3);
    assert.equal(chain.height, 4);
    for (let i = 0; i < 100; i++) assert.equal(producer.tick(), 0); // ticking faster than real time seals nothing
    wall -= 60_000; // the wall clock jumps back one minute
    assert.equal(producer.tick(), 0);
    wall += 60_000 + B; // back to where it was, plus one block time (the remainder carries over)
    assert.equal(producer.tick(), 1);
    assert.equal(chain.height, 5);
    assert.deepEqual(sealed, [1, 3, 1]);
  });

  it("does not add to height advanced outside the producer, and reports the lead", () => {
    const chain = new ProducedHeight({ testOnlyUnboundedHeightAdvance: true });
    let wall = 0;
    const producer = new HeightProducer({ ledger: chain, clock: () => wall });
    chain.advanceHeight(17_280); // an operator fast-forward (trusted operator, docs/THREAT-MODEL.md)
    wall += 10 * B;
    assert.equal(producer.tick(), 0);
    assert.equal(producer.status().aheadBy, 17_270);
    assert.equal(chain.height, 17_280);
    // The chain then stands still until real time reaches it (documented); outside test mode one call seals at most 12.
    assert.throws(() => new ProducedHeight().advanceHeight(MAX_BLOCKS_PER_TICK + 1), /HEIGHT_ADVANCE_CAP/);
  });

  it("enforces the minimum block spacing and validates its configuration", () => {
    const chain = new ProducedHeight();
    assert.equal(MIN_BLOCK_SPACING_MS, 5_000);
    assert.throws(() => new HeightProducer({ ledger: chain, blockTimeMs: 3_000 }), /HEIGHT_PRODUCER_BLOCK_SPACING/);
    assert.throws(() => new HeightProducer({ ledger: chain, blockTimeMs: 0 }), /HEIGHT_PRODUCER_CONFIG_INVALID/);
    assert.throws(() => new HeightProducer({ ledger: {} as never }), /HEIGHT_PRODUCER_CONFIG_INVALID/);
    assert.throws(() => new HeightProducer({ ledger: chain, clock: () => Number.NaN }), /HEIGHT_PRODUCER_CLOCK_INVALID/);
    let wall = 0;
    const slow = new HeightProducer({ ledger: chain, blockTimeMs: 10_000, clock: () => wall });
    wall += 19_999;
    assert.equal(slow.tick(), 1); // slower blocks are allowed: they only lengthen windows
  });

  it("start() seals on a timer that does not keep the process alive; stop() ends it", async () => {
    const chain = new ProducedHeight();
    let wall = 0;
    const producer = new HeightProducer({ ledger: chain, clock: () => wall }).start();
    assert.equal(producer.running, true);
    producer.stop();
    assert.equal(producer.running, false);
    wall += 2 * B;
    assert.equal(chain.height, 0); // stopped: nothing sealed without tick()
  });

  it("the HTTP adapter starts the producer with the server and stops it on close", async () => {
    const ledger = new ProducedHeight();
    const producer = new HeightProducer({ ledger });
    const m = new DigitalServicesMarketplace({ height: () => ledger.height });
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m });
    const { server, port } = await listenUepHttpApi({ api, heightProducer: producer });
    try {
      assert.equal(producer.running, true);
      const body = (await (await fetch(`http://127.0.0.1:${port}/v1/marketplace/height`)).json()) as { ok: boolean; data: { height: number; unit: string } };
      assert.equal(body.ok, true);
      assert.equal(body.data.unit, "height");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(producer.running, false);
  });

  it("measures time with a monotonic clock: a wall-clock jump seals nothing and is logged", () => {
    const chain = new ProducedHeight();
    let mono = 0;
    let wall = 1_800_000_000_000;
    const events: HeightProducerEvent[] = [];
    const producer = new HeightProducer({ ledger: chain, clock: () => mono, wallClock: () => wall, log: (e) => events.push(e) });
    const m = new DigitalServicesMarketplace({ height: heightOf(chain) });
    const listing = publishAs(m, { providerId: "prov", title: "MARS relay", description: "relay hour", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 10n, domainProfile: "MARS" });
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    // The system clock steps forward 1 h 15 s (NTP step, manual change); real time moved 0 s.
    wall += 3_615_000;
    assert.equal(producer.tick(), 0);
    assert.equal(chain.height, 0);
    assert.deepEqual(events.map((e) => e.kind), ["wall-clock-jump"]);
    assert.equal((events[0] as { jumpMs: number }).jumpMs, 3_615_000);
    assert.equal(m.reapExpiredReservations(), 0); // the reservation is still live
    assert.equal(getOrder(m, order.orderId, "buyer").status, "ACCEPTED");
    // A jump back is logged too and seals nothing; ordinary ticks then seal one block per block time.
    wall -= 7_200_000;
    mono += B; wall += B;
    assert.equal(producer.tick(), 1);
    assert.equal(events.filter((e) => e.kind === "wall-clock-jump").length, 2);
    assert.equal(producer.status().wallClockJumps, 2);
    // Defaults: performance.now() for heights; Date.now only for the jump log.
    const real = new HeightProducer({ ledger: new ProducedHeight(), log: () => undefined });
    assert.equal(real.tick(), 0);
  });

  it("caps catch-up at 12 blocks per tick; the rest of a long gap is dropped (windows freeze) and logged", () => {
    const chain = new ProducedHeight();
    let mono = 0;
    const events: HeightProducerEvent[] = [];
    const producer = new HeightProducer({ ledger: chain, clock: () => mono, log: (e) => events.push(e) });
    mono += 12 * B;
    assert.equal(producer.tick(), 12); // up to the cap: normal catch-up
    assert.equal(events.length, 0);
    mono += 3_600_000; // a stalled process: one hour (720 blocks)
    assert.equal(producer.tick(), MAX_BLOCKS_PER_TICK);
    assert.equal(chain.height, 24);
    assert.deepEqual(events, [{ kind: "catch-up-capped", due: 720, sealed: 12, dropped: 708, height: 24 }]);
    assert.equal(producer.status().droppedBlocks, 708);
    // The dropped time does not come back: the next block needs one more block time.
    assert.equal(producer.tick(), 0);
    mono += B - 1;
    assert.equal(producer.tick(), 0);
    mono += 1;
    assert.equal(producer.tick(), 1);
    assert.equal(chain.height, 25);
    assert.throws(() => new HeightProducer({ ledger: chain, maxBlocksPerTick: 13 }), /HEIGHT_PRODUCER_CONFIG_INVALID/);
    assert.throws(() => new HeightProducer({ ledger: chain, maxBlocksPerTick: 0 }), /HEIGHT_PRODUCER_CONFIG_INVALID/);
  });

  it("restart: downtime does not count (a new producer anchors at the restored height); rebind() follows a restore; a retired ledger stops the producer", () => {
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null });
    const trust = { authorities: [] as string[] };
    let mono = 0;
    const events: HeightProducerEvent[] = [];
    const producer = new HeightProducer({ ledger, clock: () => mono, log: (e) => events.push(e) });
    for (let i = 0; i < 10; i++) { mono += B; producer.tick(); }
    assert.equal(ledger.height, 10);
    const snap = ledger.snapshot();
    trust.authorities = snap.signatures.map((s) => s.publicKey);
    // One hour of downtime, then a new process restores the snapshot and starts a new producer.
    mono += 3_600_000;
    const restored = UepLedger.restore(structuredClone(snap), trust, {}, { replaces: ledger });
    const after = new HeightProducer({ ledger: restored, clock: () => mono, log: (e) => events.push(e) });
    assert.equal(after.tick(), 0); // the hour of downtime is not caught up
    mono += B;
    assert.equal(after.tick(), 1);
    assert.equal(restored.height, 11);
    // The old producer is still bound to the replaced (retired) ledger: its next tick stops it.
    producer.start();
    assert.equal(producer.tick(), 0);
    assert.equal(producer.running, false);
    assert.deepEqual(events.filter((e) => e.kind === "stopped").length, 1);
    // rebind() moves it to the restored ledger, anchored now.
    producer.rebind(restored);
    assert.equal(producer.tick(), 0);
    mono += B;
    assert.equal(producer.tick(), 1);
    assert.equal(restored.height, 12);
  });

  it("the HTTP adapter fails closed without a producer for a Marketplace on an injected height source", async () => {
    const chain = new ProducedHeight();
    const m = new DigitalServicesMarketplace({ height: heightOf(chain) });
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m });
    await assert.rejects(listenUepHttpApi({ api }), /HEIGHT_PRODUCER_REQUIRED/);
    await assert.rejects(listenUepHttpApi({ api, heightProducer: {} as never }), /HEIGHT_PRODUCER_INVALID/);
    // A test-only local counter needs no producer (tests drive it).
    const local = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: new DigitalServicesMarketplace({ testOnlyLocalHeight: true }) });
    const { server } = await listenUepHttpApi({ api: local });
    await new Promise((resolve) => server.close(resolve));
  });

  it("the HTTP adapter checks the producer for real: class, same ledger, and status on /v1/marketplace/height", async () => {
    const chain = new ProducedHeight();
    const other = new ProducedHeight();
    const m = new DigitalServicesMarketplace({ height: heightOf(chain) });
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m });
    // A stand-in object with start() / stop() is refused, in listen and in create.
    const fake = { start() {}, stop() {} };
    await assert.rejects(listenUepHttpApi({ api, heightProducer: fake as never }), /HEIGHT_PRODUCER_INVALID/);
    assert.throws(() => createUepHttpApi({ api, heightProducer: fake as never }), /HEIGHT_PRODUCER_INVALID/);
    // The producer of another ledger is refused once the heights differ.
    other.advanceHeight(3);
    let wall = 0;
    const wrong = new HeightProducer({ ledger: other, testOnlyClock: () => wall, log: () => {} });
    await assert.rejects(listenUepHttpApi({ api, heightProducer: wrong }), /HEIGHT_PRODUCER_MISMATCH/);
    assert.throws(() => createUepHttpApi({ api, heightProducer: wrong }), /HEIGHT_PRODUCER_MISMATCH/);
    // The right producer: the height route shows running / aheadBy / lastError.
    const events: HeightProducerEvent[] = [];
    const right = new HeightProducer({ ledger: chain, testOnlyClock: () => wall, log: (e) => events.push(e) });
    assert.equal(right.target, chain);
    const { server, port } = await listenUepHttpApi({ api, heightProducer: right });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/v1/marketplace/height`)).json()) as { data: { producer: { running: boolean; aheadBy: number; lastError?: string } } };
      assert.deepEqual([body.data.producer.running, body.data.producer.aheadBy, body.data.producer.lastError], [true, 0, undefined]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(right.status().lastError, undefined);
  });

  it("an injected producer clock is refused under NODE_ENV=production", () => {
    const chain = new ProducedHeight();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => new HeightProducer({ ledger: chain, clock: () => 0 }), /HEIGHT_PRODUCER_CLOCK_TEST_ONLY/);
      assert.throws(() => new HeightProducer({ ledger: chain, testOnlyClock: () => 0 }), /HEIGHT_PRODUCER_CLOCK_TEST_ONLY/);
      assert.ok(new HeightProducer({ ledger: chain, log: () => {} })); // the default monotonic clock
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
    }
    assert.throws(() => new HeightProducer({ ledger: chain, clock: () => 0, testOnlyClock: () => 0 }), /not both/);
  });

  it("the paymaster and the Marketplace must read the same height source, not only the same unit", () => {
    const chain = new ProducedHeight();
    const height = heightOf(chain);
    assert.equal(heightOf(chain), height);
    assert.throws(() => new DigitalServicesMarketplace({ height, paymaster: new MarketplacePaymaster({ testOnlyLocalHeight: true }) }), /CLOCK_CONFIG_CONFLICT/);
    assert.throws(() => new DigitalServicesMarketplace({ height, paymaster: new MarketplacePaymaster({ height: () => chain.height }) }), /CLOCK_CONFIG_CONFLICT/);
    assert.throws(() => new DigitalServicesMarketplace({ testOnlyLocalHeight: true, paymaster: new MarketplacePaymaster({ testOnlyLocalHeight: true }) }), /CLOCK_CONFIG_CONFLICT/);
    const m = new DigitalServicesMarketplace({ height, paymaster: new MarketplacePaymaster({ height }) });
    assert.equal(m.clock(), 0);
  });

  it("test-only options are rejected under NODE_ENV=production and from untrusted (JSON) options", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => new DigitalServicesMarketplace({ testOnlyLocalHeight: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new DigitalServicesMarketplace({ testOnlyNowMs: () => 0 }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new DigitalServicesMarketplace({ now: () => 0 }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new MarketplacePaymaster({ testOnlyLocalHeight: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null, testOnlyDisableProof: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null, testOnlyUnboundedHeightAdvance: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      assert.throws(() => new ProducedHeight({ testOnlyUnboundedHeightAdvance: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      const chain = new ProducedHeight();
      assert.throws(() => new DigitalServicesMarketplace({ height: heightOf(chain), reservationDeposit: 0n, testOnlyAllowZeroReservationDeposit: true }), /TEST_ONLY_OPTION_IN_PRODUCTION/);
      // Without test-only options everything works under NODE_ENV=production.
      assert.equal(new DigitalServicesMarketplace({ height: heightOf(chain) }).clock(), 0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
    // JSON-parsed options: test-only keys are refused at the boundary, at any depth.
    assert.throws(() => parseUntrustedOptions('{"testOnlyLocalHeight":true}'), /TEST_ONLY_OPTION_UNTRUSTED/);
    assert.throws(() => parseUntrustedOptions('{"marketplace":{"evidence":{},"testOnlyNowMs":1}}'), /TEST_ONLY_OPTION_UNTRUSTED: JSON options may not set marketplace.testOnlyNowMs/);
    assert.throws(() => assertNoTestOnlyOptions({ ledger: [{ testOnlyDisableProof: true }] }, "config file"), /TEST_ONLY_OPTION_UNTRUSTED: config file may not set ledger\[0\].testOnlyDisableProof/);
    assert.throws(() => assertNoTestOnlyOptions({ now: 5 }), /TEST_ONLY_OPTION_UNTRUSTED/);
    assert.deepEqual(parseUntrustedOptions('{"reservationTtlHeights":120,"notes":"testOnly in a value is fine"}'), { reservationTtlHeights: 120, notes: "testOnly in a value is fine" });
    // The string "true" is not a boolean flag.
    assert.throws(() => new DigitalServicesMarketplace({ testOnlyLocalHeight: "true" as never }), /CLOCK_CONFIG_INVALID/);
  });

  it("a Marketplace without a height source fails closed", () => {
    assert.throws(() => new DigitalServicesMarketplace(), /HEIGHT_SOURCE_REQUIRED/);
    assert.throws(() => new DigitalServicesMarketplace({ height: () => 0, testOnlyLocalHeight: true }), /CLOCK_CONFIG_CONFLICT/);
    assert.equal(new DigitalServicesMarketplace({ testOnlyLocalHeight: true }).clock(), 0);
  });
});
