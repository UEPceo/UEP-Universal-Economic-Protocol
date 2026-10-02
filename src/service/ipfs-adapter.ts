/**
 * IPFS HTTP StorageAdapter — configurable endpoint. No permanent availability claim.
 */

import { createHash } from "node:crypto";
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
import { contentHash } from "./content-hash.ts";

export type IpfsTransport = {
  add: (body: Buffer) => Promise<{ cid: string }>;
  cat: (cid: string) => Promise<Buffer | null>;
  pin?: (cid: string) => Promise<void>;
  unpin?: (cid: string) => Promise<void>;
};

export type IpfsAdapterConfig = {
  providerId?: string;
  timeoutMs?: number;
  transport: IpfsTransport;
};

/** LAB CID: sha256 of content prefixed (not real multihash — labeled lab-cid) */
export function labCid(body: Buffer): string {
  const h = createHash("sha256").update(body).digest("hex");
  return `labcid${h.slice(0, 46)}`;
}

export class IPFSStorageAdapter implements StorageProvider {
  readonly capability = "storage" as const;
  readonly providerId: string;
  readonly info: ServiceProviderInfo;
  private transport: IpfsTransport;
  private timeoutMs: number;
  private byId = new Map<string, StorageRecord>();
  private byCid = new Map<string, Buffer>();
  private idem = new IdempotencyStore();
  private forceUnavailable = false;

  constructor(cfg: IpfsAdapterConfig) {
    this.providerId = cfg.providerId ?? "ipfs-http";
    this.transport = cfg.transport;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.info = {
      providerId: this.providerId,
      displayName: "IPFS HTTP Storage",
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
      throw new UepApiError("PROVIDER_UNAVAILABLE", "IPFS unavailable", 503);
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
      if (prev && this.byId.has(prev.objectId)) {
        const r = this.byId.get(prev.objectId)!;
        if (r.contentHash === hash) return r;
        throw new UepApiError("IDEMPOTENCY_CONFLICT", "idempotency conflict", 409);
      }
    }

    let cid: string;
    try {
      const res = await this.transport.add(body);
      cid = res.cid;
    } catch (e) {
      throw new UepApiError("PROVIDER_ERROR", "IPFS add failed", 502, {
        cause: String(e),
      });
    }

    this.byCid.set(cid, body);
    if (this.transport.pin) {
      try {
        await this.transport.pin(cid);
      } catch {
        /* pin optional */
      }
    }

    const now = new Date().toISOString();
    const existing = this.byId.get(input.objectId);
    const record: StorageRecord = {
      objectId: input.objectId,
      contentHash: hash,
      size: body.byteLength,
      contentType: input.contentType ?? "application/octet-stream",
      providerId: this.providerId,
      backend: "ipfs",
      locator: `ipfs://${cid}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      availability: this.transport.pin ? "PINNED" : "AVAILABLE",
      metadata: {
        ...(input.metadata ?? {}),
        cid,
      },
    };
    this.byId.set(input.objectId, record);
    if (input.idempotencyKey) {
      this.idem.set(input.idempotencyKey, input.objectId, hash);
    }
    return record;
  }

  async getObject(objectId: string): Promise<GetObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const rec = this.byId.get(objectId);
    if (!rec) throw new UepApiError("NOT_FOUND", "IPFS object not found", 404);
    const cid = rec.metadata.cid ?? rec.locator.replace("ipfs://", "");
    let body = this.byCid.get(cid) ?? null;
    if (!body) {
      try {
        body = await this.transport.cat(cid);
      } catch {
        throw new UepApiError("PROVIDER_ERROR", "IPFS cat failed", 502);
      }
    }
    if (!body) throw new UepApiError("NOT_FOUND", "IPFS content missing", 404);
    assertDownloadedIntegrity(body, rec.contentHash, rec.size);
    return { record: rec, body: Buffer.from(body) };
  }

  async headObject(objectId: string): Promise<HeadObjectResult> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const rec = this.byId.get(objectId);
    if (!rec) throw new UepApiError("NOT_FOUND", "IPFS object not found", 404);
    return rec;
  }

  async deleteObject(objectId: string): Promise<void> {
    this.ensureUp();
    assertSafeObjectId(objectId);
    const rec = this.byId.get(objectId);
    if (!rec) throw new UepApiError("NOT_FOUND", "IPFS object not found", 404);
    const cid = rec.metadata.cid;
    if (cid && this.transport.unpin) {
      try {
        await this.transport.unpin(cid);
      } catch {
        /* ignore */
      }
    }
    this.byId.delete(objectId);
  }

  async listObjects(query?: ListObjectsQuery): Promise<StorageRecord[]> {
    this.ensureUp();
    const prefix = query?.prefix ?? "";
    const limit = query?.limit ?? 1000;
    const out: StorageRecord[] = [];
    for (const [id, rec] of this.byId) {
      if (prefix && !id.startsWith(prefix)) continue;
      out.push(rec);
      if (out.length >= limit) break;
    }
    return out;
  }
}

export function createMemoryIpfsTransport(): IpfsTransport {
  const store = new Map<string, Buffer>();
  return {
    async add(body) {
      const cid = labCid(body);
      store.set(cid, Buffer.from(body));
      return { cid };
    },
    async cat(cid) {
      const b = store.get(cid);
      return b ? Buffer.from(b) : null;
    },
    async pin() {
      /* no-op */
    },
    async unpin() {
      /* no-op */
    },
  };
}
