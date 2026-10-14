/**
 * Disk StorageProvider. Large bytes stay in files. The Marketplace snapshot
 * keeps the content hash, not the body. Not consensus state.
 */
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
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

export class DiskStorageProvider implements StorageProvider {
  readonly capability = "storage" as const;
  readonly providerId: string;
  readonly info: ServiceProviderInfo;
  private readonly root: string;
  private readonly observedAt: () => string;
  private readonly idem = new IdempotencyStore();
  private index = new Map<string, StorageRecord>();

  constructor(root: string, providerId = "disk-local", observedAt: () => string = () => "0") {
    this.root = root;
    this.providerId = providerId;
    this.observedAt = observedAt;
    this.info = { providerId, displayName: "Disk Storage", capabilities: ["storage"], version: "1" };
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(readFileSync(join(root, name), "utf8")) as StorageRecord;
        this.index.set(record.objectId, record);
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: this.observedAt(), message: "disk" };
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    assertSafeObjectId(input.objectId);
    assertBodySize(input.body);
    const body = Buffer.from(input.body);
    const hash = resolveContentHash(body, input.contentHash);
    if (input.idempotencyKey) {
      const prev = this.idem.check(input.idempotencyKey, input.objectId, hash);
      if (prev) {
        const existing = this.index.get(prev.objectId);
        if (existing && existing.contentHash === hash) return existing;
        throw new UepApiError("IDEMPOTENCY_CONFLICT", "idempotency replay target missing", 409);
      }
    }
    const name = createHash("sha256").update(input.objectId).digest("hex");
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, name), body);
    const existing = this.index.get(input.objectId);
    const stamp = this.observedAt();
    const record: StorageRecord = {
      objectId: input.objectId,
      contentHash: hash,
      size: body.byteLength,
      contentType: input.contentType ?? "application/octet-stream",
      providerId: this.providerId,
      backend: "other",
      locator: `disk://${this.providerId}/${name}`,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      availability: "AVAILABLE",
      metadata: { ...(input.metadata ?? {}) },
    };
    this.index.set(input.objectId, record);
    await writeFile(join(this.root, `${name}.json`), JSON.stringify(record));
    if (input.idempotencyKey) this.idem.set(input.idempotencyKey, input.objectId, hash);
    return record;
  }

  async getObject(objectId: string): Promise<GetObjectResult> {
    assertSafeObjectId(objectId);
    const record = this.index.get(objectId);
    if (!record) throw new UepApiError("NOT_FOUND", "object not found", 404);
    const name = record.locator.split("/").pop()!;
    const body = await readFile(join(this.root, name));
    assertDownloadedIntegrity(body, record.contentHash, record.size);
    return { record, body };
  }

  async headObject(objectId: string): Promise<HeadObjectResult> {
    const record = this.index.get(objectId);
    if (!record) throw new UepApiError("NOT_FOUND", "object not found", 404);
    return record;
  }

  async deleteObject(objectId: string): Promise<void> {
    assertSafeObjectId(objectId);
    const record = this.index.get(objectId);
    this.index.delete(objectId);
    if (!record) return;
    const name = record.locator.split("/").pop()!;
    await unlink(join(this.root, name)).catch(() => undefined);
    await unlink(join(this.root, `${name}.json`)).catch(() => undefined);
  }

  async listObjects(query: ListObjectsQuery = {}): Promise<StorageRecord[]> {
    const prefix = query.prefix ?? "";
    return [...this.index.values()].filter((r) => r.objectId.startsWith(prefix)).slice(0, query.limit ?? 100);
  }
}
