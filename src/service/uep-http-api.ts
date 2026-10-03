/**
 * UEP-API-001.1 — local HTTP adapter over UepServiceApi.
 * LAB. Not consensus. A dead provider returns an error and does not halt the node.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { UepServiceApi } from "./uep-service-api.ts";
import { UEP_API_VERSION, httpStatusOf, type ApiRequestMeta } from "./uep-api-types.ts";

export const UEP_HTTP_API_VERSION = "1.2.1";

export type EconomicReadModel = {
  tip: () => { stateRoot: string; height: number; treasury?: string };
  balance: (accountId: string) => string;
};

export type HttpApiOptions = {
  api: UepServiceApi;
  economic?: EconomicReadModel;
  host?: string;
  port?: number;
  /**
   * Bearer token for the object routes (/v1/objects). Without a token the
   * object routes only answer on a loopback host; on any other host they
   * return 401 OBJECTS_AUTH_REQUIRED.
   */
  objectsToken?: string;
  /** CORS allowlist (see applyCors). Overrides UEP_HTTP_CORS_ORIGINS. */
  cors?: { allowedOrigins: string[] };
  /**
   * v0.5.1 (audit V50-12, DNS rebinding): host names accepted in the `Host`
   * header of the object routes. Default: `127.0.0.1`, `localhost`, `::1` and
   * the bind host when it is not a wildcard (`0.0.0.0`, `::`). Overrides
   * UEP_HTTP_ALLOWED_HOSTS (comma-separated). A port in `Host`, when present,
   * must be the listening port. Anything else is 403 OBJECTS_HOST_NOT_ALLOWED,
   * with or without a bearer token.
   */
  allowedHosts?: string[];
  /**
   * v0.5.1 (audit V50-12): exact origins accepted in the `Origin` header of the
   * object routes. A request without `Origin` (non-browser clients) passes this
   * check. Default: the same-origin loopback origins of the listening port
   * (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`)
   * plus the exact origins of the CORS allowlist (`*` is never honoured here).
   * Anything else, including `Origin: null`, is 403 OBJECTS_ORIGIN_NOT_ALLOWED.
   */
  objectsAllowedOrigins?: string[];
};

/**
 * v0.5.0 signed actor headers. Every marketplace call that changes or reads
 * private state carries the actor's Ed25519 signature over the canonical
 * action message (src/marketplace/identity.ts `actionMessage`):
 *   x-uep-actor-id   registered identity id
 *   x-uep-signature  hex signature
 *   x-uep-issued-at  unix ms, required for reads (order, treasury)
 * `x-uep-caller-id` is not an authorization and is ignored.
 */
export const ACTOR_ID_HEADER = "x-uep-actor-id";
export const ACTOR_SIGNATURE_HEADER = "x-uep-signature";
export const ACTOR_ISSUED_AT_HEADER = "x-uep-issued-at";
const ALLOWED_REQUEST_HEADERS = ["content-type", "idempotency-key", ACTOR_ID_HEADER, ACTOR_SIGNATURE_HEADER, ACTOR_ISSUED_AT_HEADER, "authorization"];

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function metaOf(req: IncomingMessage): Partial<ApiRequestMeta> {
  const actorId = header(req, ACTOR_ID_HEADER);
  const signature = header(req, ACTOR_SIGNATURE_HEADER);
  const issuedAtRaw = header(req, ACTOR_ISSUED_AT_HEADER);
  const issuedAt = issuedAtRaw !== undefined && /^[0-9]{1,16}$/.test(issuedAtRaw) ? Number(issuedAtRaw) : undefined;
  return {
    idempotencyKey: header(req, "idempotency-key"),
    auth: actorId && signature ? { actorId, signature, ...(issuedAt !== undefined ? { issuedAt } : {}) } : undefined,
  };
}

/**
 * CORS allowlist. Default: none (no CORS headers; browsers only reach the API
 * same-origin). `cors.allowedOrigins` or the env var UEP_HTTP_CORS_ORIGINS
 * (comma-separated) lists exact origins. "*" is honoured only if listed
 * explicitly, and credentials are never allowed.
 */
function allowedOrigins(opts: HttpApiOptions): string[] {
  if (opts.cors?.allowedOrigins) return opts.cors.allowedOrigins;
  return (process.env.UEP_HTTP_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

function applyCors(opts: HttpApiOptions, req: IncomingMessage, res: ServerResponse): void {
  const origin = header(req, "origin");
  if (!origin) return;
  const list = allowedOrigins(opts);
  const allow = list.includes(origin) ? origin : list.includes("*") ? "*" : undefined;
  if (!allow) return;
  res.setHeader("access-control-allow-origin", allow);
  if (allow !== "*") res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", ALLOWED_REQUEST_HEADERS.join(", "));
  res.setHeader("access-control-max-age", "600");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

function normalizeHostName(h: string): string {
  const v = h.trim().toLowerCase();
  return v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
}

/** Parse a `Host` header into name and optional port. Undefined when malformed. */
export function parseHostHeader(raw: string | undefined): { name: string; port?: number } | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v || /[\s/@?#\\]/.test(v)) return undefined;
  let name: string;
  let portRaw: string | undefined;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end < 0) return undefined;
    name = v.slice(1, end);
    const rest = v.slice(end + 1);
    if (rest && !rest.startsWith(":")) return undefined;
    portRaw = rest ? rest.slice(1) : undefined;
  } else {
    const parts = v.split(":");
    if (parts.length > 2) return undefined; // bare IPv6 without brackets is not a valid Host
    name = parts[0]!;
    portRaw = parts[1];
  }
  if (!name) return undefined;
  if (portRaw === undefined) return { name };
  if (!/^[0-9]{1,5}$/.test(portRaw)) return undefined;
  const port = Number(portRaw);
  return port >= 1 && port <= 65535 ? { name, port } : undefined;
}

function allowedHostNames(opts: HttpApiOptions, bindHost: string): Set<string> {
  const configured = opts.allowedHosts ?? (process.env.UEP_HTTP_ALLOWED_HOSTS ? process.env.UEP_HTTP_ALLOWED_HOSTS.split(",") : undefined);
  if (configured) return new Set(configured.map(normalizeHostName).filter(Boolean));
  const out = new Set(LOOPBACK_HOSTS);
  const b = normalizeHostName(bindHost);
  if (!WILDCARD_HOSTS.has(b)) out.add(b);
  return out;
}

function allowedObjectOrigins(opts: HttpApiOptions, localPort: number | undefined): Set<string> {
  if (opts.objectsAllowedOrigins) return new Set(opts.objectsAllowedOrigins);
  const out = new Set(allowedOrigins(opts).filter((o) => o !== "*"));
  if (localPort) for (const h of ["127.0.0.1", "localhost", "[::1]"]) out.add(`http://${h}:${localPort}`);
  return out;
}

/**
 * V50-12: the object routes check the request's `Host` and `Origin` against
 * allowlists before any authorization, so a page served from another name
 * that resolves to this listener (DNS rebinding) is refused. Fail closed: a
 * missing, repeated or malformed `Host`, a port other than the listening port,
 * or an `Origin` outside the allowlist is rejected.
 */
function objectsRequestOriginCheck(opts: HttpApiOptions, bindHost: string, req: IncomingMessage): { ok: true } | { ok: false; code: "OBJECTS_HOST_NOT_ALLOWED" | "OBJECTS_ORIGIN_NOT_ALLOWED"; message: string } {
  const rawHost = req.headers.host;
  const localPort = req.socket.localPort;
  const host = typeof rawHost === "string" ? parseHostHeader(rawHost) : undefined;
  if (!host || !allowedHostNames(opts, bindHost).has(host.name) || (host.port !== undefined && host.port !== localPort)) {
    return { ok: false, code: "OBJECTS_HOST_NOT_ALLOWED", message: "Host header is not in the allowlist of the object routes" };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== "string" || !allowedObjectOrigins(opts, localPort).has(origin)) {
      return { ok: false, code: "OBJECTS_ORIGIN_NOT_ALLOWED", message: "Origin is not in the allowlist of the object routes" };
    }
  }
  return { ok: true };
}

function objectsAuthorized(opts: HttpApiOptions, host: string, req: IncomingMessage): boolean {
  if (opts.objectsToken) {
    const got = String(req.headers.authorization ?? "");
    const want = `Bearer ${opts.objectsToken}`;
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return LOOPBACK_HOSTS.has(normalizeHostName(host));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  res.writeHead(status, {
    "content-type": "application/json",
    "x-uep-api": UEP_HTTP_API_VERSION,
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += b.length;
    if (n > limit) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function createUepHttpApi(opts: HttpApiOptions): Server {
  const host = opts.host ?? "127.0.0.1";
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;
      applyCors(opts, req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "x-uep-api": UEP_HTTP_API_VERSION });
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/v1/capabilities") {
        send(res, 200, opts.api.capabilities());
        return;
      }
      if (req.method === "GET" && path === "/v1/health") {
        const h = await opts.api.providerHealth();
        send(res, h.ok ? 200 : 503, h);
        return;
      }
      if (req.method === "GET" && path === "/v1/economic/tip") {
        if (!opts.economic) {
          send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "economic read model not attached" } });
          return;
        }
        send(res, 200, { ok: true, apiVersion: UEP_API_VERSION, data: opts.economic.tip() });
        return;
      }
      const acct = path.match(/^\/v1\/economic\/accounts\/([^/]+)$/);
      if (req.method === "GET" && acct) {
        if (!opts.economic) {
          send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "economic read model not attached" } });
          return;
        }
        send(res, 200, { ok: true, data: { accountId: decodeURIComponent(acct[1]!), balance: opts.economic.balance(decodeURIComponent(acct[1]!)) } });
        return;
      }
      const obj = path.match(/^\/v1\/objects\/([^/]+)$/);
      if (obj || path === "/v1/objects") {
        const check = objectsRequestOriginCheck(opts, host, req);
        if (!check.ok) {
          send(res, 403, { ok: false, error: { code: check.code, message: check.message } });
          return;
        }
      }
      if ((obj || path === "/v1/objects") && !objectsAuthorized(opts, host, req)) {
        send(res, 401, { ok: false, error: { code: "OBJECTS_AUTH_REQUIRED", message: "object routes need a bearer token on this host" } });
        return;
      }
      if (obj && req.method === "PUT") {
        const body = await readBody(req);
        const result = await opts.api.putObject({
          objectId: decodeURIComponent(obj[1]!),
          body,
          contentType: req.headers["content-type"],
        });
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      if (obj && req.method === "GET") {
        const result = await opts.api.getObject(decodeURIComponent(obj[1]!));
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      if (obj && req.method === "DELETE") {
        const result = await opts.api.deleteObject(decodeURIComponent(obj[1]!));
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      if (req.method === "GET" && path === "/v1/objects") {
        const result = await opts.api.listObjects({ prefix: url.searchParams.get("prefix") ?? undefined });
        send(res, result.ok ? 200 : 500, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/marketplace/listings") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const result = opts.api.marketplacePublishListing({
          listingId: body.listingId ? String(body.listingId) : undefined,
          providerId: String(body.providerId ?? ""),
          title: String(body.title ?? ""),
          description: String(body.description ?? ""),
          category: String(body.category ?? "API") as any,
          asset: String(body.asset ?? ""),
          unitPrice: BigInt(String(body.unitPrice ?? "0")),
          capacity: BigInt(String(body.capacity ?? "0")),
        }, metaOf(req));
        send(res, httpStatusOf(result, 201), result);
        return;
      }
      if (req.method === "GET" && path === "/v1/marketplace/listings") {
        const result = opts.api.marketplaceListings({
          category: (url.searchParams.get("category") as any) || undefined,
          asset: url.searchParams.get("asset") || undefined,
          providerId: url.searchParams.get("providerId") || undefined,
        }, metaOf(req));
        send(res, httpStatusOf(result), result);
        return;
      }
      if (req.method === "GET" && path === "/v1/marketplace/quote") {
        const listingId = url.searchParams.get("listingId") ?? "";
        const quantity = BigInt(url.searchParams.get("quantity") ?? "0");
        const result = opts.api.marketplaceCheckoutQuote(listingId, quantity, metaOf(req));
        send(res, httpStatusOf(result), result);
        return;
      }
      if (req.method === "POST" && path === "/v1/marketplace/orders") {
        // Authorized by the buyer's reservation signature (body.signature).
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const meta = metaOf(req);
        const result = opts.api.marketplaceAcceptOrder({
          listingId: String(body.listingId ?? ""),
          buyerId: String(body.buyerId ?? ""),
          quantity: BigInt(String(body.quantity ?? "0")),
          idempotencyKey: String(body.idempotencyKey ?? meta.idempotencyKey ?? ""),
          signature: String(body.signature ?? ""),
          orderId: body.orderId ? String(body.orderId) : undefined,
        }, meta);
        send(res, httpStatusOf(result, 201), result);
        return;
      }
      const mOrderGet = path.match(/^\/v1\/marketplace\/orders\/([^/]+)$/);
      if (mOrderGet && req.method === "GET") {
        const result = opts.api.marketplaceGetOrder(decodeURIComponent(mOrderGet[1]!), metaOf(req));
        send(res, httpStatusOf(result), result);
        return;
      }
      const mOrder = path.match(/^\/v1\/marketplace\/orders\/([^/]+)\/(fund|deliver|settle|cancel)$/);
      if (mOrder && req.method === "POST") {
        const orderId = decodeURIComponent(mOrder[1]!);
        const action = mOrder[2]!;
        const meta = metaOf(req);
        if (action === "fund") {
          const body = JSON.parse((await readBody(req)).toString() || "{}");
          const result = opts.api.marketplaceFundOrder(orderId, BigInt(String(body.amount ?? "0")), meta);
          send(res, httpStatusOf(result), result);
          return;
        }
        if (action === "deliver") {
          const expectedHash = url.searchParams.get("expectedHash") ?? undefined;
          const result = opts.api.marketplaceDeliverOrder(orderId, await readBody(req), expectedHash, meta);
          send(res, httpStatusOf(result), result);
          return;
        }
        if (action === "settle") {
          const result = opts.api.marketplaceSettleOrder(orderId, meta);
          send(res, httpStatusOf(result), result);
          return;
        }
        const result = opts.api.marketplaceCancelOrder(orderId, meta);
        send(res, httpStatusOf(result), result);
        return;
      }
      const mTreasury = path.match(/^\/v1\/marketplace\/treasury\/([^/]+)$/);
      if (mTreasury && req.method === "GET") {
        const result = opts.api.marketplaceTreasury(decodeURIComponent(mTreasury[1]!), metaOf(req));
        send(res, httpStatusOf(result), result);
        return;
      }
      if (req.method === "POST" && path === "/v1/spends/commit") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const result = await opts.api.commitSpend(String(body.spendId ?? ""), body.votes ?? []);
        send(res, result.ok ? 200 : 403, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/spends/prove") {
        const result = await opts.api.proveQueuedSpends();
        send(res, result.ok ? 200 : 400, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/spends") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const result = await opts.api.submitSpend(body);
        send(res, result.ok ? 202 : 400, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/compute/jobs") {
        const programId = url.searchParams.get("programId") ?? "";
        const result = await opts.api.submitCompute(programId, await readBody(req));
        send(res, result.ok ? 202 : 400, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/relay/envelopes") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const result = await opts.api.pushRelay(String(body.id ?? ""), String(body.body ?? ""));
        send(res, result.ok ? 202 : 400, result);
        return;
      }
      if (req.method === "GET" && path === "/v1/relay/envelopes") {
        const result = await opts.api.pullRelay();
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      const quote = path.match(/^\/v1\/oracle\/quotes\/([^/]+)$/);
      if (req.method === "GET" && quote) {
        const result = await opts.api.oracleQuote(decodeURIComponent(quote[1]!));
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: path } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 500, { ok: false, error: { code: message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INTERNAL", message } });
    }
  });
}

export function listenUepHttpApi(opts: HttpApiOptions): Promise<{ server: Server; port: number }> {
  const server = createUepHttpApi(opts);
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}
