/**
 * ADR 0002 rule 1, checked by execution: transitions run with a poisoned
 * clock, network and randomness (scripts/poisoned-clock.mjs). A full ledger,
 * Marketplace and IoT flow records no violation; clock, network and
 * randomness reads inside a transition are caught, including aliases the
 * regular-expression lint cannot see. `npm run test:poisoned-clock` runs the
 * Marketplace and IoT suites under the same poison (preload).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
// @ts-ignore -- plain ESM test tooling without type declarations
import { installPoisonedClock, defaultTransitionClasses, takeViolations } from "../../scripts/poisoned-clock.mjs";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import nodeCrypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import childProcess from "node:child_process";
import tls from "node:tls";
import dgram from "node:dgram";
import timers from "node:timers";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs } from "./iot-testkit.ts";

let handle: { violations: string[]; uninstall(): void };
before(async () => {
  handle = installPoisonedClock(await defaultTransitionClasses(new URL("..", import.meta.url).href.replace(/\/$/, "")));
});
after(() => handle.uninstall());

describe("poisoned clock", () => {
  it("a full ledger, Marketplace and IoT flow touches no clock, timer, network or randomness inside a transition", async () => {
    const F = generateEd25519KeyPair();
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, faucetSigningKey: F.privateKey, testOnlyUnboundedHeightAdvance: true });
    const a = await identityFromMnemonic(await generateMnemonic(128)); // in memory only
    const b = await identityFromMnemonic(await generateMnemonic(128));
    ledger.faucet(ledger.addressOf(a.accountId), "uep-test/teur", 100_000n);
    for (let i = 0; i < 3; i++) {
      ledger.advanceHeight(1);
      const p = ledger.prepareSpend(a, ledger.addressOf(b.accountId), "uep-test/teur", 1_000n); // client side, not a transition
      assert.ok(!("error" in p));
      assert.ok("tx" in ledger.submit(p.tx));
    }

    const m = new DigitalServicesMarketplace({ height: () => ledger.height });
    const listing = publishAs(m, { providerId: "prov", title: "GPU", description: "gpu hour", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 10n });
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    fund(m, order.orderId, order.fundingDue);
    deliver(m, order.orderId, "prov", Buffer.from("LICENSE:1"));
    settle(m, order.orderId, "buyer");
    const second = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    ledger.advanceHeight(second.windows.reservationTtl);
    m.expire(second.orderId, act(m, "buyer", "expire", second.orderId));

    const arbiter = createTestAuthority("iot-arbiter");
    const iotM = new DigitalServicesMarketplace({ height: () => ledger.height, settlementArbiterId: "iot-arbiter", settlementArbiterPublicKey: arbiter.publicKeyHex });
    const iot = new IoTM2MService(iotM, { telemetryMaxAgeMs: 60_000 });
    registerProviderAs(iot, { providerId: "iot-provider-1", displayName: "Lab" });
    registerMachineAs(iot, { machineId: "machine-01", providerId: "iot-provider-1", serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-01" });
    const iotListing = publishAs(iotM, { providerId: "iot-provider-1", title: "Temperature", description: "sim", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
    const r = requestAs(iot, { buyerId: "iot-buyer", listingId: iotListing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r.requestId, "iot-buyer");
    const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" });
    deliverTelemetryAs(iot, r.requestId, "iot-provider-1", t);
    iot.verifyTelemetry(r.requestId, t);
    settleIoTAs(iot, r.requestId, "iot-buyer");

    assert.deepEqual(takeViolations(), []);
  });

  it("catches clock, network and randomness reads in a settlement guard, also through aliases", () => {
    const attempts: Array<[string, () => unknown]> = [
      ["Date.now()", () => Date.now()],
      ["alias of Date", () => { const d = Date; return d.now(); }],
      ["new Date()", () => new Date()],
      ["globalThis['fetch']", () => (globalThis as unknown as Record<string, (u: string) => unknown>)["fetch"]!("http://127.0.0.1:1/")],
      ["Math.random()", () => Math.random()],
      ["crypto.randomUUID()", () => globalThis.crypto.randomUUID()],
      ["performance.now()", () => performance.now()],
      ["setTimeout()", () => setTimeout(() => undefined, 0)],
      ["key generation", () => generateEd25519KeyPair()],
      // Second review: Date through its prototype chain or called as a function, other clocks,
      // host state, key agreement, files, processes, network and async continuations.
      ["Date(0) as a function", () => (Date as unknown as (x: number) => string)(0)],
      ["Date.prototype.constructor.now()", () => (Date.prototype.constructor as DateConstructor).now()],
      ["new (Date.prototype.constructor)()", () => new (Date.prototype.constructor as DateConstructor)()],
      ["new Date(0).constructor.now()", () => (new Date(0).constructor as DateConstructor).now()],
      ["Intl.DateTimeFormat().format()", () => new Intl.DateTimeFormat("en").format()],
      ["performance.timeOrigin", () => performance.timeOrigin],
      ["node:timers setTimeout", () => timers.setTimeout(() => undefined, 0)],
      ["os.uptime()", () => os.uptime()],
      ["process.memoryUsage()", () => process.memoryUsage()],
      ["process.cpuUsage()", () => process.cpuUsage()],
      ["process.env", () => process.env.HOME],
      ["createECDH().generateKeys()", () => nodeCrypto.createECDH("prime256v1").generateKeys()],
      ["createDiffieHellman(512)", () => nodeCrypto.createDiffieHellman(512)],
      ["fs.readFileSync", () => fs.readFileSync("/etc/hostname")],
      ["child_process.execSync", () => childProcess.execSync("true")],
      ["tls.connect", () => tls.connect(1, "127.0.0.1")],
      ["dgram.createSocket", () => dgram.createSocket("udp4")],
      ["Promise.then (async continuation)", () => Promise.resolve().then(() => Date.now())],
    ];
    for (const [label, read] of attempts) {
      const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
      m.attachCategoryService("API", { settlementGuard: () => { read(); } });
      const listing = publishAs(m, { providerId: "prov", title: `API ${label}`, description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
      const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
      fund(m, order.orderId, order.fundingDue);
      deliver(m, order.orderId, "prov", Buffer.from("payload"));
      assert.throws(() => settle(m, order.orderId, "buyer"), /POISONED_CLOCK/, label);
      const v = takeViolations();
      assert.equal(v.length, 1, `${label}: ${v.join("; ")}`);
      assert.match(v[0]!, /inside DigitalServicesMarketplace\./);
    }
    // Object.getPrototypeOf(Date) no longer leads back to an unpatched Date (it is Function.prototype, as for the real Date).
    assert.equal(Object.getPrototypeOf(Date), Function.prototype);
    // Outside a transition the same calls work normally.
    assert.ok(Date.now() > 0 && Math.random() >= 0 && new Date(0).constructor === Date && typeof process.env.PATH === "string");
    assert.ok(performance.timeOrigin > 0 && new Intl.DateTimeFormat("en").format().length > 0);
  });
});
