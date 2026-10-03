/**
 * Poisoned clock, network and randomness for state transitions (ADR 0002 rule 1).
 *
 * The determinism lint is a set of regular expressions: it catches accidents,
 * not every alias. This module checks the same property by execution. It
 * wraps the transition methods of the given classes; while one of them runs
 * (synchronously), every clock, timer, network and randomness entry point
 * below throws and is recorded as a violation:
 *   - clocks: Date.now() (also reached as Object.getPrototypeOf(Date).now,
 *     Date.prototype.constructor.now, new Date(0).constructor.now), new Date()
 *     without arguments, Date(...) called as a function with any arguments,
 *     performance.now(), performance.timeOrigin, process.hrtime(),
 *     process.uptime(), Intl.DateTimeFormat format() / formatToParts()
 *     without a date, os.uptime();
 *   - timers: setTimeout / setInterval / setImmediate / queueMicrotask, also
 *     from node:timers and node:timers/promises, and Promise.then (async
 *     continuations);
 *   - randomness: Math.random, crypto.randomUUID / getRandomValues, node:crypto
 *     random, key generation, ECDH / Diffie-Hellman, non-Ed25519 crypto.sign;
 *   - process and host state: process.env, memoryUsage, cpuUsage,
 *     resourceUsage; os load / memory / cpus / network interfaces;
 *   - files, processes and network: fs and fs/promises reads and writes,
 *     child_process, http(s), http2, net, tls, dgram, dns.
 * Calls through aliases and helpers in other files end in these patched
 * functions and are caught. NOT caught: a reference to an original function
 * captured before the poison was installed, native addons, and anything the
 * list above does not name. Like the lint, this is a guard, not a sandbox.
 * Violations are recorded even when the transition catches the error.
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
import tls from "node:tls";
import dgram from "node:dgram";
import http2 from "node:http2";
import os from "node:os";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";
import timers from "node:timers";
import timersPromises from "node:timers/promises";
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
  const realNow = RealDate.now;
  function PoisonedDate(...args) {
    if (!new.target) guard("Date() called as a function"); // returns the current time whatever the arguments
    else if (args.length === 0) guard("new Date()");
    return new.target ? Reflect.construct(RealDate, args, new.target === PoisonedDate ? RealDate : new.target) : RealDate(...args);
  }
  // Not a subclass of the real Date: Object.getPrototypeOf(Date) must not lead back to it.
  PoisonedDate.prototype = RealDate.prototype;
  PoisonedDate.now = function now() { guard("Date.now()"); return realNow.call(RealDate); };
  PoisonedDate.parse = RealDate.parse;
  PoisonedDate.UTC = RealDate.UTC;
  globalThis.Date = PoisonedDate;
  restorers.push(() => { globalThis.Date = RealDate; });
  // The real Date stays reachable through instances (new Date(0).constructor) and the prototype: poison it too.
  RealDate.now = PoisonedDate.now;
  restorers.push(() => { RealDate.now = realNow; });
  const protoCtor = Object.getOwnPropertyDescriptor(RealDate.prototype, "constructor");
  Object.defineProperty(RealDate.prototype, "constructor", { ...protoCtor, value: PoisonedDate });
  restorers.push(() => { Object.defineProperty(RealDate.prototype, "constructor", protoCtor); });

  // performance.timeOrigin (an accessor on the prototype): shadow it on the instance.
  if (globalThis.performance) {
    const perf = globalThis.performance;
    const originDesc = Object.getOwnPropertyDescriptor(perf, "timeOrigin");
    const proto = Object.getPrototypeOf(perf);
    const protoDesc = proto && Object.getOwnPropertyDescriptor(proto, "timeOrigin");
    const read = () => (protoDesc?.get ? protoDesc.get.call(perf) : originDesc?.value);
    Object.defineProperty(perf, "timeOrigin", { configurable: true, enumerable: true, get() { guard("performance.timeOrigin"); return read(); } });
    restorers.push(() => { if (originDesc) Object.defineProperty(perf, "timeOrigin", originDesc); else delete perf.timeOrigin; });
  }
  // Intl date formatting without a date reads the clock.
  for (const k of ["format", "formatToParts"]) {
    const proto = Intl.DateTimeFormat.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, k);
    if (!desc) continue;
    if (desc.get) {
      Object.defineProperty(proto, k, { ...desc, get() { const f = desc.get.call(this); return (d) => { if (d === undefined) guard(`Intl.DateTimeFormat.${k}() without a date`); return f(d); }; } });
    } else if (typeof desc.value === "function") {
      const fn = desc.value;
      Object.defineProperty(proto, k, { ...desc, value: function (d) { if (d === undefined) guard(`Intl.DateTimeFormat.${k}() without a date`); return fn.call(this, d); } });
    }
    restorers.push(() => { Object.defineProperty(proto, k, desc); });
  }
  // process.env: a guarded view while a transition runs.
  const realEnv = process.env;
  const envProxy = new Proxy(realEnv, {
    get(t, key, r) { if (typeof key === "string") guard("process.env"); return Reflect.get(t, key, r); },
    has(t, key) { guard("process.env"); return Reflect.has(t, key); },
    ownKeys(t) { guard("process.env"); return Reflect.ownKeys(t); },
  });
  try {
    process.env = envProxy;
    restorers.push(() => { process.env = realEnv; });
  } catch { /* not replaceable on this runtime */ }
  // Async continuations: a transition is synchronous; scheduling work for later is a timer.
  const realThen = Promise.prototype.then;
  Promise.prototype.then = function then(...a) { guard("Promise.then() (async continuation)"); return realThen.apply(this, a); };
  restorers.push(() => { Promise.prototype.then = realThen; });

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
  for (const k of ["uptime", "memoryUsage", "cpuUsage", "resourceUsage"]) patch(process, k, wrap(`process.${k}()`));
  for (const k of ["randomBytes", "randomUUID", "randomInt", "randomFill", "randomFillSync", "generateKeyPair", "generateKeyPairSync", "generateKey", "generateKeySync", "generatePrime", "generatePrimeSync", "getRandomValues", "createECDH", "createDiffieHellman", "createDiffieHellmanGroup", "getDiffieHellman", "createSign"]) patch(nodeCrypto, k, wrap(`crypto.${k}()`));
  // crypto.sign is deterministic for Ed25519 / Ed448 (used to sign snapshots); other key types (ECDSA, RSA-PSS) draw randomness.
  patch(nodeCrypto, "sign", (fn) => function (alg, data, key, ...rest) {
    const type = key?.asymmetricKeyType ?? key?.key?.asymmetricKeyType;
    if (type !== "ed25519" && type !== "ed448") guard("crypto.sign() with a randomized key type");
    return fn.call(this, alg, data, key, ...rest);
  });
  const modules = [
    [http, "http", ["request", "get"]], [https, "https", ["request", "get"]], [http2, "http2", ["connect"]],
    [net, "net", ["connect", "createConnection"]], [tls, "tls", ["connect"]], [dgram, "dgram", ["createSocket"]], [dns, "dns", ["lookup", "resolve"]],
    [os, "os", ["uptime", "loadavg", "freemem", "totalmem", "cpus", "networkInterfaces", "hostname", "userInfo"]],
    [fs, "fs", ["readFileSync", "readFile", "writeFileSync", "writeFile", "openSync", "open", "statSync", "stat", "existsSync", "readdirSync", "readdir", "createReadStream", "createWriteStream"]],
    [fsPromises, "fs/promises", ["readFile", "writeFile", "open", "stat", "readdir"]],
    [childProcess, "child_process", ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]],
    [timers, "timers", ["setTimeout", "setInterval", "setImmediate"]],
    [timersPromises, "timers/promises", ["setTimeout", "setInterval", "setImmediate"]],
  ];
  for (const [mod, name, keys] of modules) for (const k of keys) patch(mod, k, wrap(`${name}.${k}()`));
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
