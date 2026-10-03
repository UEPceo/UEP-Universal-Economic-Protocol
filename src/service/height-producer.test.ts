/**
 * Height producer acceptance (ADR 0002): the single-node testnet gets
 * heights from real time, outside the transitions. A simulated wall clock is
 * injected, so the test is deterministic and fast.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeightProducer, MIN_BLOCK_SPACING_MS, ProducedHeight } from "./height-producer.ts";
import { REFERENCE_BLOCK_TIME_MS } from "../core/height.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, publishAs, reserveAs } from "../marketplace/testkit.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

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
    wall += ttl * B - 1; // one ms short of the TTL
    producer.tick();
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
    const chain = new ProducedHeight();
    let wall = 0;
    const producer = new HeightProducer({ ledger: chain, clock: () => wall });
    chain.advanceHeight(17_280); // an operator fast-forward (trusted operator, docs/THREAT-MODEL.md)
    wall += 10 * B;
    assert.equal(producer.tick(), 0);
    assert.equal(producer.status().aheadBy, 17_270);
    assert.equal(chain.height, 17_280);
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

  it("a Marketplace without a height source fails closed", () => {
    assert.throws(() => new DigitalServicesMarketplace(), /HEIGHT_SOURCE_REQUIRED/);
    assert.throws(() => new DigitalServicesMarketplace({ height: () => 0, testOnlyLocalHeight: true }), /CLOCK_CONFIG_CONFLICT/);
    assert.equal(new DigitalServicesMarketplace({ testOnlyLocalHeight: true }).clock(), 0);
  });
});
