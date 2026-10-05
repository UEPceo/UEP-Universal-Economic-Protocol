/**
 * v0.5.0 API authorization hardening: end-to-end HTTP tests. Marketplace calls
 * that change or read private state need the actor's signed authorization
 * (x-uep-actor-id / x-uep-signature / x-uep-issued-at); a missing or invalid
 * one is 401, a valid one for the wrong actor is 403.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { listingTerms, signAction, signReservation, type ActorAuth, type MarketplaceAction } from "../marketplace/identity.ts";
import { createTestAuthority, enrollIdentity } from "../marketplace/testkit.ts";
import { contentHash } from "./content-hash.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

const ADMIN = createTestAuthority("admin-http");
const ASSET = "uep-test/teur";
let now = 1_800_000_000_000;

function setup() {
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, adminIdentity: "admin-http", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-http" });
  const provider = enrollIdentity(m, "provider-1");
  const buyer = enrollIdentity(m, "buyer-1", { asset: ASSET, amount: 1_000_000n });
  const mallory = enrollIdentity(m, "mallory", { asset: ASSET, amount: 1_000_000n });
  const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m });
  return { m, api, provider, buyer, mallory };
}

function sign(m: DigitalServicesMarketplace, who: { identityId: string; privateKey: any }, action: MarketplaceAction, target: string, details: Record<string, unknown> = {}): ActorAuth {
  return signAction({ marketplaceId: m.marketplaceId, action, actorId: who.identityId, target, details }, who.privateKey);
}

function headers(auth?: ActorAuth, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...extra };
  if (auth) {
    h["x-uep-actor-id"] = auth.actorId;
    h["x-uep-signature"] = auth.signature;
    if (auth.issuedAt !== undefined) h["x-uep-issued-at"] = String(auth.issuedAt);
  }
  return h;
}

describe("API authorization hardening (HTTP, signed actors)", () => {
  let server: Server;
  let base: string;
  let ctx: ReturnType<typeof setup>;
  let orderId: string;
  let listingId: string;

  before(async () => {
    ctx = setup();
    const started = await listenUepHttpApi({ api: ctx.api, cors: { allowedOrigins: ["https://wallet.example"] } });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });
  after(() => server.close());

  const post = (path: string, body: unknown, auth?: ActorAuth, extra?: Record<string, string>) =>
    fetch(base + path, { method: "POST", headers: headers(auth, extra), body: typeof body === "string" || body instanceof Uint8Array ? body as any : JSON.stringify(body) });

  it("publish: anonymous 401, impersonation 401, provider signature 201", async () => {
    const input = { listingId: "l-http-1", providerId: "provider-1", title: "API access", description: "metered api", category: "API" as const, asset: ASSET, unitPrice: 10n, capacity: 5n };
    const wire = { ...input, unitPrice: "10", capacity: "5" };
    assert.equal((await post("/v1/marketplace/listings", wire)).status, 401);
    // Mallory claims the provider id but signs with her own key.
    const forged = { ...sign(ctx.m, ctx.mallory, "publish", input.listingId, listingTerms(input)), actorId: "provider-1" };
    assert.equal((await post("/v1/marketplace/listings", wire, forged)).status, 401);
    const r = await post("/v1/marketplace/listings", wire, sign(ctx.m, ctx.provider, "publish", input.listingId, listingTerms(input)));
    assert.equal(r.status, 201);
    listingId = ((await r.json()) as any).data.listingId;
  });

  it("order: missing reservation signature 401, buyer signature 201", async () => {
    assert.equal((await post("/v1/marketplace/orders", { listingId, buyerId: "buyer-1", quantity: "1", idempotencyKey: "k1" })).status, 401);
    const signature = signReservation({ marketplaceId: ctx.m.marketplaceId, listingId, buyerId: "buyer-1", quantity: 1n, idempotencyKey: "k1" }, ctx.buyer.privateKey);
    const r = await post("/v1/marketplace/orders", { listingId, buyerId: "buyer-1", quantity: "1", idempotencyKey: "k1", signature });
    assert.equal(r.status, 201);
    orderId = ((await r.json()) as any).data.orderId;
  });

  it("read order: anonymous 401, other actor 403, buyer 200; x-uep-caller-id is not an authorization", async () => {
    const path = `/v1/marketplace/orders/${orderId}`;
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { headers: { "x-uep-caller-id": "buyer-1" } })).status, 401);
    const malloryRead = sign(ctx.m, ctx.mallory, "read", orderId, { issuedAt: now });
    assert.equal((await fetch(base + path, { headers: headers({ ...malloryRead, issuedAt: now }) })).status, 403);
    const buyerRead = sign(ctx.m, ctx.buyer, "read", orderId, { issuedAt: now });
    const ok = await fetch(base + path, { headers: headers({ ...buyerRead, issuedAt: now }) });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).data.status, "ACCEPTED");
  });

  it("fund: anonymous 401, wrong actor 403, bad signature 401, buyer 200", async () => {
    const order = ctx.m.getOrder(orderId, { ...sign(ctx.m, ctx.buyer, "read", orderId, { issuedAt: now }), issuedAt: now });
    const amount = order.grossAmount + (order.gasFee ?? 0n) - order.reservationDeposit;
    const path = `/v1/marketplace/orders/${orderId}/fund`;
    assert.equal((await post(path, { amount: String(amount) })).status, 401);
    assert.equal((await post(path, { amount: String(amount) }, sign(ctx.m, ctx.mallory, "fund", orderId, { amount }))).status, 403);
    // Signature over a different amount does not verify.
    assert.equal((await post(path, { amount: String(amount) }, sign(ctx.m, ctx.buyer, "fund", orderId, { amount: amount + 1n }))).status, 401);
    const r = await post(path, { amount: String(amount) }, sign(ctx.m, ctx.buyer, "fund", orderId, { amount }), { "idempotency-key": "fund-1" });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).data.status, "HELD");
  });

  it("deliver: anonymous 401, buyer 403, provider 200", async () => {
    const bytes = Buffer.from("result-bytes");
    const deliveryHash = contentHash(bytes);
    const path = `/v1/marketplace/orders/${orderId}/deliver`;
    const send = (auth?: ActorAuth) => fetch(base + path, { method: "POST", headers: headers(auth, { "content-type": "application/octet-stream" }), body: bytes });
    assert.equal((await send()).status, 401);
    assert.equal((await send(sign(ctx.m, ctx.buyer, "deliver", orderId, { deliveryHash }))).status, 403);
    const r = await send(sign(ctx.m, ctx.provider, "deliver", orderId, { deliveryHash }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).data.status, "DELIVERED");
  });

  it("settle: anonymous 401, wrong actor 403, buyer 200", async () => {
    const path = `/v1/marketplace/orders/${orderId}/settle`;
    assert.equal((await post(path, {})).status, 401);
    assert.equal((await post(path, {}, sign(ctx.m, ctx.mallory, "settle", orderId))).status, 403);
    const r = await post(path, {}, sign(ctx.m, ctx.buyer, "settle", orderId));
    assert.equal(r.status, 200);
  });

  it("cancel: anonymous 401, wrong actor 403, buyer 200", async () => {
    const signature = signReservation({ marketplaceId: ctx.m.marketplaceId, listingId, buyerId: "buyer-1", quantity: 1n, idempotencyKey: "k2" }, ctx.buyer.privateKey);
    const created = await post("/v1/marketplace/orders", { listingId, buyerId: "buyer-1", quantity: "1", idempotencyKey: "k2", signature });
    const id2 = ((await created.json()) as any).data.orderId as string;
    const path = `/v1/marketplace/orders/${id2}/cancel`;
    assert.equal((await post(path, {})).status, 401);
    assert.equal((await post(path, {}, sign(ctx.m, ctx.mallory, "cancel", id2))).status, 403);
    const r = await post(path, {}, sign(ctx.m, ctx.buyer, "cancel", id2));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).data.status, "CANCELLED");
  });

  it("treasury: anonymous 401, non-admin 403, signed administrator read 200", async () => {
    const path = `/v1/marketplace/treasury/${encodeURIComponent(ASSET)}`;
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { headers: { "x-uep-caller-id": "admin-http" } })).status, 401);
    // The retired role string is not an identity.
    assert.equal((await fetch(base + path, { headers: { "x-uep-caller-id": "marketplace-admin" } })).status, 401);
    const target = `treasury:${ASSET}`;
    const buyer = sign(ctx.m, ctx.buyer, "read", target, { issuedAt: now });
    assert.equal((await fetch(base + path, { headers: headers({ ...buyer, issuedAt: now }) })).status, 403);
    const admin = sign(ctx.m, ADMIN, "read", target, { issuedAt: now });
    const r = await fetch(base + path, { headers: headers({ ...admin, issuedAt: now }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).ok, true);
  });

  it("CORS: allowlisted origin gets headers, others none, OPTIONS preflight 204, no credentials", async () => {
    const pre = await fetch(base + "/v1/marketplace/listings", { method: "OPTIONS", headers: { origin: "https://wallet.example", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://wallet.example");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-uep-signature/);
    assert.equal(pre.headers.get("access-control-allow-credentials"), null);
    const other = await fetch(base + "/v1/capabilities", { headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre2 = await fetch(base + "/v1/capabilities", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(pre2.status, 204);
    assert.equal(pre2.headers.get("access-control-allow-origin"), null);
  });
});

describe("objects endpoint access", () => {
  it("bearer token required when configured; without a token only loopback hosts are served", async () => {
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
    const { server, port } = await listenUepHttpApi({ api, objectsToken: "test-only-objects-token" });
    try {
      const url = `http://127.0.0.1:${port}/v1/objects/o1`;
      assert.equal((await fetch(url, { method: "PUT", body: "x" })).status, 401);
      assert.equal((await fetch(url, { method: "PUT", body: "x", headers: { authorization: "Bearer wrong" } })).status, 401);
      assert.equal((await fetch(url, { method: "PUT", body: "x", headers: { authorization: "Bearer test-only-objects-token" } })).status, 200);
    } finally { server.close(); }
    const open = await listenUepHttpApi({ api });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${open.port}/v1/objects/o2`, { method: "PUT", body: "y" })).status, 200);
    } finally { open.server.close(); }
  });
});

/** Raw request with explicit Host / Origin headers (fetch cannot set Host). */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: d }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/** HTTP/1.0 request without any Host header. */
function noHostRequest(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1", () => sock.write(`GET ${path} HTTP/1.0\r\n\r\n`));
    let d = "";
    sock.on("data", (c) => (d += c));
    sock.on("end", () => resolve(Number(d.split(" ")[1])));
    sock.on("error", reject);
  });
}

describe("objects endpoint: Host / Origin allowlist (DNS rebinding)", () => {
  const newApi = () => new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });

  it("rebound Host / Origin get 403 on PUT, GET and LIST without a token; loopback Host and same-origin pass", async () => {
    const { server, port } = await listenUepHttpApi({ api: newApi() });
    try {
      const evil = { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` };
      const put = await rawRequest(port, "PUT", "/v1/objects/demo", { ...evil, "content-type": "application/octet-stream" }, "secret-bytes");
      assert.equal(put.status, 403);
      assert.equal(JSON.parse(put.body).error.code, "OBJECTS_HOST_NOT_ALLOWED");
      assert.equal((await rawRequest(port, "GET", "/v1/objects", evil)).status, 403);
      assert.equal((await rawRequest(port, "GET", "/v1/objects/demo", evil)).status, 403);
      assert.equal((await rawRequest(port, "DELETE", "/v1/objects/demo", evil)).status, 403);
      // Host alone rebound (no Origin) is still refused.
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `attacker.example:${port}` })).status, 403);
      // Loopback Host with a foreign Origin is refused.
      const o = await rawRequest(port, "GET", "/v1/objects", { host: `127.0.0.1:${port}`, origin: "http://attacker.example" });
      assert.equal(o.status, 403);
      assert.equal(JSON.parse(o.body).error.code, "OBJECTS_ORIGIN_NOT_ALLOWED");
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `127.0.0.1:${port}`, origin: "null" })).status, 403);
      // Loopback Host on another port is refused.
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `127.0.0.1:${port === 65535 ? 1 : port + 1}` })).status, 403);
      // Malformed and missing Host are refused (fail closed).
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: "127.0.0.1:99999" })).status, 403);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: "user@127.0.0.1" })).status, 403);
      assert.equal(await noHostRequest(port, "/v1/objects"), 403);
      // Non-loopback names that resolve to loopback are not on the default list.
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `localhost.attacker.example:${port}` })).status, 403);
      // Allowed: loopback names, with or without port, and same-origin loopback Origin.
      assert.equal((await rawRequest(port, "PUT", "/v1/objects/ok", { host: `127.0.0.1:${port}` }, "a")).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects/ok", { host: `localhost:${port}` })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `[::1]:${port}` })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: "localhost" })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
      // Non-object routes are unchanged.
      assert.equal((await rawRequest(port, "GET", "/v1/capabilities", evil)).status, 200);
    } finally { server.close(); }
  });

  it("a bearer token does not bypass the Host / Origin check", async () => {
    const { server, port } = await listenUepHttpApi({ api: newApi(), objectsToken: "test-only-objects-token" });
    try {
      const auth = { authorization: "Bearer test-only-objects-token" };
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: `attacker.example:${port}` })).status, 403);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: `127.0.0.1:${port}`, origin: "http://attacker.example" })).status, 403);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: `127.0.0.1:${port}` })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { host: `127.0.0.1:${port}` })).status, 401);
    } finally { server.close(); }
  });

  it("configured allowedHosts / objectsAllowedOrigins replace the defaults; CORS origins are accepted, '*' is not", async () => {
    const { server, port } = await listenUepHttpApi({ api: newApi(), objectsToken: "test-only-objects-token", allowedHosts: ["objects.uep.example"], objectsAllowedOrigins: ["https://wallet.example"] });
    try {
      const auth = { authorization: "Bearer test-only-objects-token" };
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: "objects.uep.example" })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: `OBJECTS.UEP.EXAMPLE:${port}`, origin: "https://wallet.example" })).status, 200);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: `127.0.0.1:${port}` })).status, 403);
      assert.equal((await rawRequest(port, "GET", "/v1/objects", { ...auth, host: "objects.uep.example", origin: `http://127.0.0.1:${port}` })).status, 403);
    } finally { server.close(); }
    const c = await listenUepHttpApi({ api: newApi(), cors: { allowedOrigins: ["*", "https://app.example"] } });
    try {
      assert.equal((await rawRequest(c.port, "GET", "/v1/objects", { host: `127.0.0.1:${c.port}`, origin: "https://app.example" })).status, 200);
      assert.equal((await rawRequest(c.port, "GET", "/v1/objects", { host: `127.0.0.1:${c.port}`, origin: "https://other.example" })).status, 403);
    } finally { c.server.close(); }
  });
});

describe("IoT service calls require signed actors", () => {
  it("hold / deliverTelemetry / settle without authorization are 401; requestService without reservation signature is 401", async () => {
    const { IoTM2MService } = await import("./iot-m2m.ts");
    const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m, iotM2M: new IoTM2MService(m) });
    for (const r of [api.iotHold("req-1"), api.iotSettle("req-1"), api.iotDeliverTelemetry("req-1", {} as any), api.iotRequestService({ idempotencyKey: "k", authorization: "", buyerId: "b", listingId: "l", machineId: "x", quantity: 1n })]) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "UNAUTHORIZED");
    }
    const unattached = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]) });
    const r = unattached.marketplaceTreasury(ASSET);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "PROVIDER_UNAVAILABLE");
  });
});
