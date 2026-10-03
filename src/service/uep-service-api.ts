/**
 * UEP Service API facade — routes storage/ops without touching CORE consensus.
 */

import {
  UEP_API_VERSION,
  type ApiRequestMeta,
  type ApiResult,
  newRequestId,
  ok,
  fail,
  UepApiError,
} from "./uep-api-types.ts";
import type { StorageProvider, PutObjectInput, StorageRecord } from "./storage-provider.ts";
import { getCapabilities, type CapabilitiesDocument } from "./capabilities.ts";
import {
  globalTelemetry,
  METRICS,
  type UepTelemetry,
} from "./observability.ts";
import type { ProviderHealth } from "./provider-model.ts";
import { SpendInbox, type LabCompute, type LabRelay, type LabOracle, type SpendSubmitInput } from "./uep-service-backends.ts";
import { SpendQuorum, type Groth16SpendQueue } from "./groth16-spend-queue.ts";
import type { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import type { ActorAuth } from "../marketplace/identity.ts";

const UNAUTHENTICATED = /^(ACTOR_SIGNATURE_REQUIRED|ACTOR_SIGNATURE_INVALID|ACTOR_AUTH_ISSUED_AT_REQUIRED|ACTOR_AUTH_EXPIRED|IDENTITY_NOT_REGISTERED|LEGACY_ADMIN_ID_RESERVED|RESERVED_IDENTITY|ADMIN_NOT_CONFIGURED|RESERVATION_SIGNATURE_INVALID|SIGNATURE_REQUIRED)/;
const FORBIDDEN = /(FORBIDDEN|NOT_AUTHORIZED)/;

/** Map a marketplace / IoT error to an API error: 401 unauthenticated, 403 wrong actor, 404, else 400. */
function mapMarketplaceError(e: unknown): UepApiError {
  if (e instanceof UepApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (UNAUTHENTICATED.test(msg)) return new UepApiError("UNAUTHORIZED", msg, 401);
  if (FORBIDDEN.test(msg)) return new UepApiError("FORBIDDEN", msg, 403);
  if (/^(ORDER_NOT_FOUND|LISTING_NOT_FOUND|UNKNOWN_)/.test(msg)) return new UepApiError("NOT_FOUND", msg, 404);
  return new UepApiError("INVALID_REQUEST", msg, 400);
}
import type { IoTM2MService, IoTTelemetry } from "./iot-m2m.ts";

export type ServiceApiConfig = {
  storageProviders: Map<string, StorageProvider>;
  defaultStorageProviderId?: string;
  telemetry?: UepTelemetry;
  spends?: SpendInbox;
  compute?: LabCompute;
  relay?: LabRelay;
  oracle?: LabOracle;
  groth16?: Groth16SpendQueue;
  quorum?: SpendQuorum;
  marketplace?: DigitalServicesMarketplace;
  iotM2M?: IoTM2MService;
};

export class UepServiceApi {
  private storage: Map<string, StorageProvider>;
  private defaultStorageId: string;
  private tel: UepTelemetry;

  spends?: SpendInbox;
  compute?: LabCompute;
  relay?: LabRelay;
  oracle?: LabOracle;
  groth16?: Groth16SpendQueue;
  quorum?: SpendQuorum;
  marketplace?: DigitalServicesMarketplace;
  iotM2M?: IoTM2MService;

  constructor(cfg: ServiceApiConfig) {
    this.storage = cfg.storageProviders;
    this.defaultStorageId =
      cfg.defaultStorageProviderId ??
      [...cfg.storageProviders.keys()][0] ??
      "";
    this.tel = cfg.telemetry ?? globalTelemetry;
    this.spends = cfg.spends;
    this.compute = cfg.compute;
    this.relay = cfg.relay;
    this.oracle = cfg.oracle;
    this.groth16 = cfg.groth16;
    this.quorum = cfg.quorum;
    this.marketplace = cfg.marketplace;
    this.iotM2M = cfg.iotM2M;
  }

  capabilities(): CapabilitiesDocument {
    return getCapabilities({
      storageBackends: [...this.storage.keys()],
      compute: !!this.compute,
      relay: !!this.relay,
      oracle: !!this.oracle,
      spendSubmit: !!this.spends,
      iotM2M: !!this.iotM2M,
    });
  }

  private parseMeta(partial?: Partial<ApiRequestMeta>): ApiRequestMeta {
    const requestId = partial?.requestId ?? newRequestId();
    const apiVersion = partial?.apiVersion ?? UEP_API_VERSION;
    if (apiVersion.split(".")[0] !== UEP_API_VERSION.split(".")[0]) {
      throw new UepApiError(
        "VERSION_MISMATCH",
        `unsupported apiVersion ${apiVersion}`,
        400,
      );
    }
    return {
      requestId,
      apiVersion,
      idempotencyKey: partial?.idempotencyKey,
      timestamp: partial?.timestamp ?? new Date().toISOString(),
      authTokenPresent: partial?.authTokenPresent,
      callerId: partial?.callerId,
      auth: partial?.auth,
    };
  }

  private provider(id?: string): StorageProvider {
    const pid = id ?? this.defaultStorageId;
    const p = this.storage.get(pid);
    if (!p) {
      throw new UepApiError("NOT_FOUND", `storage provider ${pid}`, 404);
    }
    return p;
  }

  async putObject(
    input: PutObjectInput & { providerId?: string },
    meta?: Partial<ApiRequestMeta>,
  ): Promise<ApiResult<StorageRecord>> {
    let m: ApiRequestMeta;
    try {
      m = this.parseMeta(meta);
    } catch (e) {
      const rid = meta?.requestId ?? newRequestId();
      if (e instanceof UepApiError) return fail(rid, e);
      return fail(rid, new UepApiError("INTERNAL", String(e), 500));
    }
    const span = this.tel.startSpan("api.storage.put", {
      objectId: input.objectId,
    });
    const t0 = Date.now();
    try {
      const p = this.provider(input.providerId);
      const record = await p.putObject({
        ...input,
        idempotencyKey: input.idempotencyKey ?? m.idempotencyKey,
      });
      this.tel.counter(METRICS.storageOps, 1, { op: "put", provider: p.providerId });
      this.tel.histogram(METRICS.storageLatency, Date.now() - t0, {
        op: "put",
      });
      span.end("ok");
      return ok(m.requestId, record, p.providerId);
    } catch (e) {
      this.tel.counter(METRICS.storageErrors, 1, { op: "put" });
      span.end("error");
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(
        m.requestId,
        new UepApiError("INTERNAL", String(e), 500),
      );
    }
  }

  async getObject(
    objectId: string,
    providerId?: string,
    meta?: Partial<ApiRequestMeta>,
  ): Promise<ApiResult<{ record: StorageRecord; bodyBase64: string }>> {
    const m = this.parseMeta(meta);
    const span = this.tel.startSpan("api.storage.get", { objectId });
    try {
      const p = this.provider(providerId);
      const res = await p.getObject(objectId);
      this.tel.counter(METRICS.storageOps, 1, { op: "get" });
      span.end("ok");
      return ok(
        m.requestId,
        {
          record: res.record,
          bodyBase64: res.body.toString("base64"),
        },
        p.providerId,
      );
    } catch (e) {
      this.tel.counter(METRICS.storageErrors, 1, { op: "get" });
      span.end("error");
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(m.requestId, new UepApiError("INTERNAL", String(e), 500));
    }
  }

  async headObject(
    objectId: string,
    providerId?: string,
    meta?: Partial<ApiRequestMeta>,
  ): Promise<ApiResult<StorageRecord>> {
    const m = this.parseMeta(meta);
    try {
      const p = this.provider(providerId);
      const rec = await p.headObject(objectId);
      return ok(m.requestId, rec, p.providerId);
    } catch (e) {
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(m.requestId, new UepApiError("INTERNAL", String(e), 500));
    }
  }

  async deleteObject(
    objectId: string,
    providerId?: string,
    meta?: Partial<ApiRequestMeta>,
  ): Promise<ApiResult<{ deleted: true }>> {
    const m = this.parseMeta(meta);
    try {
      const p = this.provider(providerId);
      await p.deleteObject(objectId);
      return ok(m.requestId, { deleted: true }, p.providerId);
    } catch (e) {
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(m.requestId, new UepApiError("INTERNAL", String(e), 500));
    }
  }

  async listObjects(
    query?: { prefix?: string; limit?: number; providerId?: string },
    meta?: Partial<ApiRequestMeta>,
  ): Promise<ApiResult<StorageRecord[]>> {
    const m = this.parseMeta(meta);
    try {
      const p = this.provider(query?.providerId);
      const list = await p.listObjects(query);
      return ok(m.requestId, list, p.providerId);
    } catch (e) {
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(m.requestId, new UepApiError("INTERNAL", String(e), 500));
    }
  }

  async providerHealth(providerId?: string): Promise<ApiResult<ProviderHealth>> {
    const m = this.parseMeta();
    try {
      const p = this.provider(providerId);
      const h = await p.health();
      this.tel.counter(METRICS.providerAvailability, h.status === "HEALTHY" ? 1 : 0, {
        provider: p.providerId,
      });
      return ok(m.requestId, h, p.providerId);
    } catch (e) {
      if (e instanceof UepApiError) return fail(m.requestId, e);
      return fail(m.requestId, new UepApiError("INTERNAL", String(e), 500));
    }
  }

  /** v0.5.0: the signed actor authorization of a request, or a 401 error. Fail closed. */
  private requireAuth(m: ApiRequestMeta): ActorAuth {
    const a = m.auth;
    if (!a || typeof a !== "object" || typeof a.actorId !== "string" || !a.actorId || typeof a.signature !== "string" || !a.signature) {
      throw new UepApiError("UNAUTHORIZED", "signed actor authorization required", 401);
    }
    return { actorId: a.actorId, signature: a.signature, ...(typeof a.issuedAt === "number" ? { issuedAt: a.issuedAt } : {}) };
  }

  /** Run a marketplace / IoT call; authorization failures map to 401 / 403. */
  private guarded(m: ApiRequestMeta, available: unknown, what: string, fn: () => unknown): ApiResult<unknown> {
    if (!available) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", `${what} not attached`, 404));
    try {
      return ok(m.requestId, fn());
    } catch (e) {
      return fail(m.requestId, mapMarketplaceError(e));
    }
  }

  marketplacePublishListing(input: Parameters<DigitalServicesMarketplace["publishListing"]>[0], meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.publishListing(input, this.requireAuth(m)));
  }

  marketplaceListings(query?: Parameters<DigitalServicesMarketplace["searchListings"]>[0], meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    if (!this.marketplace) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "marketplace not attached", 404));
    return ok(m.requestId, this.marketplace.searchListings(query));
  }

  marketplaceCheckoutQuote(listingId: string, quantity: bigint, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    if (!this.marketplace) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "marketplace not attached", 404));
    try { return ok(m.requestId, this.marketplace.checkoutQuote(listingId, quantity)); }
    catch (e) { return fail(m.requestId, mapMarketplaceError(e)); }
  }

  /** The buyer's reservation signature (`signature`, over reservationMessage) authorizes the order. */
  marketplaceAcceptOrder(input: Parameters<DigitalServicesMarketplace["acceptOrder"]>[0], meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => {
      if (typeof input.signature !== "string" || !input.signature) throw new UepApiError("UNAUTHORIZED", "reservation signature required", 401);
      return this.marketplace!.acceptOrder({ ...input, idempotencyKey: input.idempotencyKey ?? m.idempotencyKey ?? "" });
    });
  }

  marketplaceGetOrder(orderId: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.getOrder(orderId, this.requireAuth(m)));
  }

  marketplaceFundOrder(orderId: string, amount: bigint, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.fundOrder(orderId, amount, this.requireAuth(m), m.idempotencyKey));
  }

  /** The provider is the authenticated actor (its "deliver" signature binds the delivery hash). */
  marketplaceDeliverOrder(orderId: string, body: Uint8Array | Buffer, expectedHash?: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => {
      const auth = this.requireAuth(m);
      return expectedHash
        ? this.marketplace!.deliverWithExpectedHash(orderId, auth, body, expectedHash, m.idempotencyKey)
        : this.marketplace!.deliver(orderId, auth, body, m.idempotencyKey);
    });
  }

  marketplaceSettleOrder(orderId: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.settle(orderId, this.requireAuth(m)));
  }

  marketplaceCancelOrder(orderId: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.cancel(orderId, this.requireAuth(m)));
  }

  /** Administrator-signed read (`read` over `treasury:<asset>`, with issuedAt). */
  marketplaceTreasury(asset: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.marketplace, "marketplace", () => this.marketplace!.treasurySnapshotAuthorized(asset, this.requireAuth(m)));
  }

  async submitSpend(input: SpendSubmitInput, meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.spends) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "spend submit not attached", 404));
    const r = await this.spends.submit(input);
    if (r.status === "REJECTED") return fail(m.requestId, new UepApiError("INVALID_REQUEST", r.reason ?? "REJECTED", 400));
    return ok(m.requestId, r);
  }

  async proveQueuedSpends(meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.groth16) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "groth16 queue not attached", 404));
    const r = await this.groth16.provePending();
    if (!r.ok) return fail(m.requestId, new UepApiError("PROVIDER_ERROR", r.reason ?? "PROVE_FAIL", 500));
    return ok(m.requestId, { final: false, spends: r.spends, proofs: this.groth16.proved });
  }

  async commitSpend(spendId: string, votes: { nodeId: string; signature: string }[], meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.quorum || !this.groth16) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "quorum not attached", 404));
    const row = this.groth16.proved.find((s) => s.spendId === spendId);
    if (!row) return fail(m.requestId, new UepApiError("NOT_FOUND", "spend not proved", 404));
    const art = this.groth16.proofOf(spendId);
    if (!art) return fail(m.requestId, new UepApiError("NOT_FOUND", "proof missing", 404));
    const c = this.quorum.commit(spendId, row.newRoot, art, votes);
    if (!c.ok) return fail(m.requestId, new UepApiError("FORBIDDEN", c.reason ?? "NO_QUORUM", 403));
    row.final = true;
    return ok(m.requestId, { spendId, final: true, quorum: votes.length });
  }

  async submitCompute(programId: string, body: Buffer, meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.compute) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "compute not attached", 404));
    return ok(m.requestId, await this.compute.submit(programId, body));
  }

  async pushRelay(id: string, body: string, meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.relay) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "relay not attached", 404));
    return ok(m.requestId, await this.relay.push(id, body));
  }

  async pullRelay(meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.relay) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "relay not attached", 404));
    return ok(m.requestId, await this.relay.pull());
  }

  async oracleQuote(feed: string, meta?: Partial<ApiRequestMeta>): Promise<ApiResult<unknown>> {
    const m = this.parseMeta(meta);
    if (!this.oracle) return fail(m.requestId, new UepApiError("PROVIDER_UNAVAILABLE", "oracle not attached", 404));
    try {
      return ok(m.requestId, await this.oracle.quote(feed));
    } catch (e) {
      return fail(m.requestId, new UepApiError("NOT_FOUND", e instanceof Error ? e.message : String(e), 404));
    }
  }
  /** The buyer's reservation signature (`authorization`) authorizes the request. */
  iotRequestService(input: Parameters<IoTM2MService["requestService"]>[0], meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.iotM2M, "iot-m2m", () => {
      if (typeof input.authorization !== "string" || !input.authorization) throw new UepApiError("UNAUTHORIZED", "reservation signature required", 401);
      return this.iotM2M!.requestService(input);
    });
  }

  iotHold(requestId: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.iotM2M, "iot-m2m", () => this.iotM2M!.hold(requestId, this.requireAuth(m)));
  }

  iotDeliverTelemetry(requestId: string, telemetry: IoTTelemetry, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.iotM2M, "iot-m2m", () => this.iotM2M!.deliverTelemetry(requestId, telemetry, this.requireAuth(m)));
  }

  /** Verification checks the machine signature on the telemetry; it moves no value. */
  iotVerifyTelemetry(requestId: string, telemetry: IoTTelemetry, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.iotM2M, "iot-m2m", () => this.iotM2M!.verifyTelemetry(requestId, telemetry));
  }

  iotSettle(requestId: string, meta?: Partial<ApiRequestMeta>): ApiResult<unknown> {
    const m = this.parseMeta(meta);
    return this.guarded(m, this.iotM2M, "iot-m2m", () => this.iotM2M!.settle(requestId, this.requireAuth(m)));
  }

}
