/**
 * UEP-API-001.1 — local HTTP adapter over UepServiceApi.
 * LAB. Not consensus. A dead provider returns an error and does not halt the node.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { UepServiceApi } from "./uep-service-api.ts";
import { UEP_API_VERSION } from "./uep-api-types.ts";

export const UEP_HTTP_API_VERSION = "1.1.0";

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
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function objectsAuthorized(opts: HttpApiOptions, host: string, req: IncomingMessage): boolean {
  if (opts.objectsToken) {
    const got = String(req.headers.authorization ?? "");
    const want = `Bearer ${opts.objectsToken}`;
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return LOOPBACK_HOSTS.has(host);
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
        }, { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
        send(res, result.ok ? 201 : 400, result);
        return;
      }
      if (req.method === "GET" && path === "/v1/marketplace/listings") {
        const result = opts.api.marketplaceListings({
          category: (url.searchParams.get("category") as any) || undefined,
          asset: url.searchParams.get("asset") || undefined,
          providerId: url.searchParams.get("providerId") || undefined,
        }, { callerId: req.headers["x-uep-caller-id"] as string | undefined });
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      if (req.method === "GET" && path === "/v1/marketplace/quote") {
        const listingId = url.searchParams.get("listingId") ?? "";
        const quantity = BigInt(url.searchParams.get("quantity") ?? "0");
        const result = opts.api.marketplaceCheckoutQuote(listingId, quantity, { callerId: req.headers["x-uep-caller-id"] as string | undefined });
        send(res, result.ok ? 200 : 400, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/marketplace/orders") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const result = opts.api.marketplaceAcceptOrder({ listingId: String(body.listingId ?? ""), buyerId: String(body.buyerId ?? ""), quantity: BigInt(String(body.quantity ?? "0")), orderId: body.orderId ? String(body.orderId) : undefined }, { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
        send(res, result.ok ? 201 : 400, result);
        return;
      }
      const mOrderGet = path.match(/^\/v1\/marketplace\/orders\/([^/]+)$/);
      if (mOrderGet && req.method === "GET") {
        const result = opts.api.marketplaceGetOrder(decodeURIComponent(mOrderGet[1]!), { callerId: req.headers["x-uep-caller-id"] as string | undefined });
        send(res, result.ok ? 200 : 404, result);
        return;
      }
      const mOrder = path.match(/^\/v1\/marketplace\/orders\/([^/]+)\/(fund|deliver|settle|cancel)$/);
      if (mOrder && req.method === "POST") {
        const orderId = decodeURIComponent(mOrder[1]!);
        const action = mOrder[2]!;
        if (action === "fund") {
          const body = JSON.parse((await readBody(req)).toString() || "{}");
          const result = opts.api.marketplaceFundOrder(orderId, BigInt(String(body.amount ?? "0")), { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
          send(res, result.ok ? 200 : 400, result);
          return;
        }
        if (action === "deliver") {
          const providerId = url.searchParams.get("providerId") ?? "";
          const expectedHash = url.searchParams.get("expectedHash") ?? undefined;
          const result = opts.api.marketplaceDeliverOrder(orderId, providerId, await readBody(req), expectedHash, { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
          send(res, result.ok ? 200 : 400, result);
          return;
        }
        if (action === "settle") {
          const result = opts.api.marketplaceSettleOrder(orderId, { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
          send(res, result.ok ? 200 : 400, result);
          return;
        }
        const result = opts.api.marketplaceCancelOrder(orderId, { callerId: req.headers["x-uep-caller-id"] as string | undefined, idempotencyKey: req.headers["idempotency-key"] as string | undefined });
        send(res, result.ok ? 200 : 400, result);
        return;
      }
      const mTreasury = path.match(/^\/v1\/marketplace\/treasury\/([^/]+)$/);
      if (mTreasury && req.method === "GET") {
        const result = opts.api.marketplaceTreasury(decodeURIComponent(mTreasury[1]!), { callerId: req.headers["x-uep-caller-id"] as string | undefined });
        send(res, result.ok ? 200 : 404, result);
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
