/**
 * S3-compatible StorageAdapter — logic isolated from UEP CORE.
 * Works conceptually with S3 / R2 / MinIO. Tests use injected transport.
 */

import type { ProviderHealth, ServiceProviderInfo } from "./provider-model.ts";
import {
  type StorageProvider,
  type PutObjectInput,
  type PutObjectResult,
  type GetObjectResult,
  type HeadObjectResult,
  type ListObjectsQuery,
  type StorageRecord,
  assertSafeObjectId,
  assertBodySize,
  resolveContentHash,
  assertDownloadedIntegrity,
  IdempotencyStore,
} from "./storage-provider.ts";
import { UepApiError } from "./uep-api-types.ts";

export type S3Transport = {
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  get: (key: string) => Promise<Buffer | null>;
  head: (key: string) => Promise<{ size: number; contentType: string } | null>;
  delete: (key: string) => Promise<boolean>;
  list: (prefix: string, limit: number) => Promise<string[]>;
};

export type S3AdapterConfig = {
  providerId?: string;
  bucket?: string;
  timeoutMs?: number;
  maxRetries?: number;
  transport: S3Transport;
};

export class S3StorageAdapter implements StorageProvider {
  readonly capability = "storage" as const;
  readonly providerId: string;
  readonly info: ServiceProviderInfo;
  private bucket: string;
  private timeoutMs: number;
  private maxRetries: number;
  private transport: S3Transport;
  private meta = new Map<string, StorageRecord>();
  private idem = new IdempotencyStore();
  private forceUnavailable = false;

  constructor(cfg: S3AdapterConfig) {
    this.providerId = cfg.providerId ?? "s3-compat";
    this.bucket = cfg.bucket ?? "uep";
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.transport = cfg.transport;
    this.info = {
      providerId: this.providerId,
      displayName: "S3-Compatible Storage",
      capabilities: ["storage"],
      version: "36.2",
    };
  }

  setUnavailable(v: boolean): void {
    this.forceUnavailable = v;
  }

  async health(): Promise<ProviderHealth> {
    if (this.forceUnavailable) {
      return {
        status: "UNAVAILABLE",
        providerId: this.providerId,
        checkedAt: new Date().toISOString(),
        message: "s3 unavailable",
      };
    }
    const t0 = Date.now();
    try {
      await this.withTimeout(this.transport.list("", 1));
      return {
        status: "HEALTHY",
        providerId: this.providerId,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      };
    } catch {
      return {
        status: "DEGRADED",
        providerId: this.providerId,
        checkedAt: new Date().toISOString(),
        message: "health check failed",
      };
    }
  }

  private ensureUp(): void {
    if (this.forceUnavailable) {
      throw new UepApiError("PROVIDER_UNAVAILABLE", "S3 unavailable", 503);
    }
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(
            () => rej(new UepApiError("PROVIDER_TIMEOUT", "S3 timeout", 504)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        return await this.withTimeout(fn());
      } catch (e) {
        last = e;
        if (i === this.maxRetries) break;
        // bounded linear backoff (no jitter — LAB); prevents tight retry storms
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        if (e instanceof UepApiError && e.code === "PROVIDER_TIMEOUT") continue;
      }
    }
    if (last instanceof UepApiError) throw last;
    throw new UepApiError("PROVIDER_ERROR", "S3 operation failed", 502, {
      cause: String(last),
    });
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.ensureUp();
    assertSafeObjectId(input.objectId);
    assertBodySize(input.body);
    const body = Buffer.from(input.body);
    const hash = resolveContentHash(body, input.contentHash);

    if (input.idempotencyKey) {
      const prev = this.idem.check(input.idempotencyKey, input.objectId, hash);
      if (prev && this.meta.has(prev.objectId)) {
        const r = this.meta.get(prev.objectId)!;
        if (r.contentHash === hash) return r;
        throw new UepApiError("IDEMPOTENCY_CONFLICT", "idempotency conflict", 409);
      }
    }

    const contentType = input.contentType ?? "application/octet-stream";
    await this.withRetry(() =>
      this.transport.put(input.objectId, body, contentType),
    );

    const now = new Date().toISOString();
    const existing = this.meta.get(input.objectId);
    const record: StorageRecord = {
      objectId: input.objectId,
      contentHash: hash,
      size: body.byteLength,
      contentType,
      providerId: this.providerId,
      backend: "s3",
      locator: `s3://${this.bucket}/${input.objectId}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      availability: "AVAILABLE",
      metadata: { ...(input.metadata ?? {}) },
    };
    this.meta.set(input.objectId, record);
    if (input.idempotencyKey) {
      this.idem.set(input.idempotencyKey, input.objectId, hash);
    }
    return record;
  }

  async getObject(objectId: string): Promise<GetObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const body = await this.withRetry(() => this.transport.get(objectId));
    if (!body) throw new UepApiError("NOT_FOUND", "S3 object not found", 404);
    const rec = this.meta.get(objectId);
    if (rec) {
      assertDownloadedIntegrity(body, rec.contentHash, rec.size);
      return { record: rec, body };
    }
    // no local meta — still return with computed hash
    const { contentHash: ch } = await import("./content-hash.ts");
    const hash = ch(body);
    const record: StorageRecord = {
      objectId,
      contentHash: hash,
      size: body.byteLength,
      contentType: "application/octet-stream",
      providerId: this.providerId,
      backend: "s3",
      locator: `s3://${this.bucket}/${objectId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      availability: "AVAILABLE",
      metadata: {},
    };
    return { record, body };
  }

  async headObject(objectId: string): Promise<HeadObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const h = await this.withRetry(() => this.transport.head(objectId));
    if (!h) throw new UepApiError("NOT_FOUND", "S3 object not found", 404);
    const rec = this.meta.get(objectId);
    if (rec) return rec;
    return {
      objectId,
      contentHash: "",
      size: h.size,
      contentType: h.contentType,
      providerId: this.providerId,
      backend: "s3",
      locator: `s3://${this.bucket}/${objectId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      availability: "AVAILABLE",
      metadata: {},
    };
  }

  async deleteObject(objectId: string): Promise<void> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const ok = await this.withRetry(() => this.transport.delete(objectId));
    if (!ok && !this.meta.has(objectId)) {
      throw new UepApiError("NOT_FOUND", "S3 object not found", 404);
    }
    this.meta.delete(objectId);
  }

  async listObjects(query?: ListObjectsQuery): Promise<StorageRecord[]> {
    this.ensureUp();
    const keys = await this.withRetry(() =>
      this.transport.list(query?.prefix ?? "", query?.limit ?? 1000),
    );
    return keys.map(
      (k) =>
        this.meta.get(k) ?? {
          objectId: k,
          contentHash: "",
          size: 0,
          contentType: "application/octet-stream",
          providerId: this.providerId,
          backend: "s3" as const,
          locator: `s3://${this.bucket}/${k}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          availability: "UNKNOWN" as const,
          metadata: {},
        },
    );
  }
}

/** In-memory S3-compatible transport for LAB tests */
export function createMemoryS3Transport(): S3Transport {
  const data = new Map<string, { body: Buffer; contentType: string }>();
  return {
    async put(key, body, contentType) {
      data.set(key, { body: Buffer.from(body), contentType });
    },
    async get(key) {
      const r = data.get(key);
      return r ? Buffer.from(r.body) : null;
    },
    async head(key) {
      const r = data.get(key);
      if (!r) return null;
      return { size: r.body.byteLength, contentType: r.contentType };
    },
    async delete(key) {
      return data.delete(key);
    },
    async list(prefix, limit) {
      const out: string[] = [];
      for (const k of data.keys()) {
        if (prefix && !k.startsWith(prefix)) continue;
        out.push(k);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}
