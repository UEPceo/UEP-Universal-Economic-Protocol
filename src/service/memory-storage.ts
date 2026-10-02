/**
 * In-process StorageProvider for tests and offline CORE operation.
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

export class MemoryStorageProvider implements StorageProvider {
  readonly capability = "storage" as const;
  readonly providerId: string;
  readonly info: ServiceProviderInfo;
  private store = new Map<string, { body: Buffer; record: StorageRecord }>();
  private idem = new IdempotencyStore();
  private forceUnavailable = false;

  constructor(providerId = "memory-local") {
    this.providerId = providerId;
    this.info = {
      providerId,
      displayName: "Memory Storage",
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
        message: "forced unavailable",
      };
    }
    return {
      status: "HEALTHY",
      providerId: this.providerId,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
  }

  private ensureUp(): void {
    if (this.forceUnavailable) {
      throw new UepApiError("PROVIDER_UNAVAILABLE", "memory storage unavailable", 503);
    }
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.ensureUp();
    assertSafeObjectId(input.objectId);
    assertBodySize(input.body);
    const body = Buffer.from(input.body);
    const hash = resolveContentHash(body, input.contentHash);

    if (input.idempotencyKey) {
      const prev = this.idem.check(input.idempotencyKey, input.objectId, hash);
      if (prev) {
        const existing = this.store.get(prev.objectId);
        if (existing && existing.record.contentHash === hash) {
          return existing.record;
        }
        throw new UepApiError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency replay target missing",
          409,
        );
      }
    }

    const now = new Date().toISOString();
    const existing = this.store.get(input.objectId);
    const record: StorageRecord = {
      objectId: input.objectId,
      contentHash: hash,
      size: body.byteLength,
      contentType: input.contentType ?? "application/octet-stream",
      providerId: this.providerId,
      backend: "memory",
      locator: `mem://${this.providerId}/${input.objectId}`,
      createdAt: existing?.record.createdAt ?? now,
      updatedAt: now,
      availability: "AVAILABLE",
      metadata: { ...(input.metadata ?? {}) },
    };
    this.store.set(input.objectId, { body, record });
    if (input.idempotencyKey) {
      this.idem.set(input.idempotencyKey, input.objectId, hash);
    }
    return record;
  }

  async getObject(objectId: string): Promise<GetObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const row = this.store.get(objectId);
    if (!row) throw new UepApiError("NOT_FOUND", "object not found", 404);
    assertDownloadedIntegrity(row.body, row.record.contentHash, row.record.size);
    return { record: row.record, body: Buffer.from(row.body) };
  }

  async headObject(objectId: string): Promise<HeadObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const row = this.store.get(objectId);
    if (!row) throw new UepApiError("NOT_FOUND", "object not found", 404);
    return row.record;
  }

  async deleteObject(objectId: string): Promise<void> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    if (!this.store.has(objectId)) {
      throw new UepApiError("NOT_FOUND", "object not found", 404);
    }
    this.store.delete(objectId);
  }

  async listObjects(query?: ListObjectsQuery): Promise<StorageRecord[]> {
    this.ensureUp();
    const prefix = query?.prefix ?? "";
    const limit = query?.limit ?? 1000;
    const out: StorageRecord[] = [];
    for (const [id, row] of this.store) {
      if (prefix && !id.startsWith(prefix)) continue;
      out.push(row.record);
      if (out.length >= limit) break;
    }
    return out;
  }
}
