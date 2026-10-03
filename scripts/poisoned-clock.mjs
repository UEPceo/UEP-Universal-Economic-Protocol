/**
 * Poisoned clock, network and randomness for state transitions (ADR 0002 rule 1).
 *
 * The determinism lint is a set of regular expressions: it catches accidents,
 * not every alias. This module checks the same property by execution. It
 * wraps the transition methods of the given classes; while one of them runs
 * (synchronously), every clock, timer, network and randomness entry point
 * throws and is recorded as a violation:
 *   Date.now(), new Date() / Date() without arguments, performance.now(),
 *   process.hrtime(), process.uptime(), setTimeout / setInterval /
 *   setImmediate / queueMicrotask, fetch, Math.random, crypto.randomUUID /
 *   getRandomValues, node:crypto random and key generation, http(s).request,
 *   net.connect, dns.lookup.
 * Aliases (`const d = Date; d.now()`), `globalThis['fetch']` and calls through
 * helpers in other files are caught too, because they end in the same
 * function. Violations are recorded even when the transition catches the error.
 *
 * Used by scripts/poisoned-clock-preload.mjs (node --import) and by
 * src/service/poisoned-clock.test.ts. Test tooling only, never imported by
 * transition code.
 */
import nodeCrypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

let depth = 0;
let current = "";
const violations = [];
const restorers = [];

function guard(what) {
  if (depth > 0) {
    const v = `${what} inside ${current}`;
    violations.push(v);
    throw new Error(`POISONED_CLOCK: ${v}`);
  }
}

function patch(obj, key, make) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  const original = obj[key];
  if (typeof original !== "function") return;
  if (desc && !("value" in desc)) {
    // Accessor (e.g. node:crypto getRandomValues): replace it if configurable, else leave it (it delegates to a patched function).
    if (!desc.configurable) return;
    Object.defineProperty(obj, key, { configurable: true, enumerable: desc.enumerable, writable: true, value: make(original) });
    restorers.push(() => { Object.defineProperty(obj, key, desc); });
    return;
  }
  obj[key] = make(original);
  restorers.push(() => { obj[key] = original; });
}

function poisonGlobals() {
  const RealDate = globalThis.Date;
  function PoisonedDate(...args) {
    if (args.length === 0) guard("new Date() / Date()");
    return new.target ? Reflect.construct(RealDate, args, new.target) : RealDate(...args);
  }
  Object.setPrototypeOf(PoisonedDate, RealDate);
  PoisonedDate.prototype = RealDate.prototype;
  PoisonedDate.now = function now() { guard("Date.now()"); return RealDate.now(); };
  PoisonedDate.parse = RealDate.parse;
  PoisonedDate.UTC = RealDate.UTC;
  globalThis.Date = PoisonedDate;
  restorers.push(() => { globalThis.Date = RealDate; });

  const wrap = (name) => (fn) => function (...a) { guard(name); return fn.apply(this, a); };
  if (globalThis.performance) patch(globalThis.performance, "now", wrap("performance.now()"));
  patch(Math, "random", wrap("Math.random()"));
  for (const t of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "fetch"]) patch(globalThis, t, wrap(`${t}()`));
  if (globalThis.crypto) for (const k of ["randomUUID", "getRandomValues"]) patch(globalThis.crypto, k, (fn) => function (...a) { guard(`crypto.${k}()`); return fn.apply(globalThis.crypto, a); });
  const hr = process.hrtime;
  const poisonedHr = function (...a) { guard("process.hrtime()"); return hr.apply(process, a); };
  poisonedHr.bigint = function () { guard("process.hrtime.bigint()"); return hr.bigint(); };
  process.hrtime = poisonedHr;
  restorers.push(() => { process.hrtime = hr; });
  patch(process, "uptime", wrap("process.uptime()"));
  for (const k of ["randomBytes", "randomUUID", "randomInt", "randomFill", "randomFillSync", "generateKeyPair", "generateKeyPairSync", "generateKey", "generateKeySync", "generatePrime", "generatePrimeSync", "getRandomValues"]) patch(nodeCrypto, k, wrap(`crypto.${k}()`));
  for (const [mod, name, keys] of [[http, "http", ["request", "get"]], [https, "https", ["request", "get"]], [net, "net", ["connect", "createConnection"]], [dns, "dns", ["lookup", "resolve"]]]) for (const k of keys) patch(mod, k, wrap(`${name}.${k}()`));
  syncBuiltinESMExports();
}

function wrapMethod(target, key, label) {
  const original = target[key];
  target[key] = function (...a) {
    const prev = current;
    depth++;
    current = label;
    try {
      return original.apply(this, a);
    } finally {
      depth--;
      current = prev;
    }
  };
  restorers.push(() => { target[key] = original; });
}

/**
 * Install the poison. `classes` maps a label to { cls, exclude?: string[] }:
 * every own prototype method (not getters, not the constructor) and every
 * static method of `cls` is treated as a transition, except `exclude`
 * (client-side builders such as prepareSpend, or quote()).
 */
let installed = false;

/** Remove and return the violations recorded so far (for tests that provoke them on purpose). */
export function takeViolations() {
  return violations.splice(0, violations.length);
}

/** True when the poison is active (for example through the preload). */
export function poisonedClockInstalled() {
  return installed;
}

export function installPoisonedClock(classes) {
  if (installed) return { violations, uninstall() {}, alreadyInstalled: true };
  installed = true;
  poisonGlobals();
  for (const [label, { cls, exclude = [] }] of Object.entries(classes)) {
    for (const [target, prefix] of [[cls.prototype, `${label}.`], [cls, `${label}.`]]) {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (key === "constructor" || key === "prototype" || key === "length" || key === "name" || exclude.includes(key)) continue;
        const d = Object.getOwnPropertyDescriptor(target, key);
        if (!d || typeof d.value !== "function" || d.get || d.set) continue;
        wrapMethod(target, key, `${prefix}${key}()`);
      }
    }
  }
  return {
    violations,
    uninstall() {
      while (restorers.length) restorers.pop()();
      syncBuiltinESMExports();
      installed = false;
    },
    alreadyInstalled: false,
  };
}

/** Transition classes of the testnet ledger, the Marketplace, the paymaster and the IoT/M2M service. */
export async function defaultTransitionClasses(srcRoot) {
  const { UepLedger } = await import(`${srcRoot}/testnet/ledger.ts`);
  const { DigitalServicesMarketplace } = await import(`${srcRoot}/marketplace/marketplace.ts`);
  const { MarketplacePaymaster } = await import(`${srcRoot}/marketplace/paymaster.ts`);
  const { IoTM2MService } = await import(`${srcRoot}/service/iot-m2m.ts`);
  return {
    // prepareSpend / preparePayment build and sign a spend on the client side (fresh note blindings).
    UepLedger: { cls: UepLedger, exclude: ["prepareSpend", "preparePayment"] },
    DigitalServicesMarketplace: { cls: DigitalServicesMarketplace },
    // quote() is not a transition: its result is an input to reserve().
    MarketplacePaymaster: { cls: MarketplacePaymaster, exclude: ["quote"] },
    IoTM2MService: { cls: IoTM2MService },
  };
}
