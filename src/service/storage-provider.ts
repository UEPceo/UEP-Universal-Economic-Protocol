/**
 * StorageProvider abstraction — UEP-STORAGE-001.
 * Storage is NOT consensus state.
 */

import type { ServiceProvider, ProviderHealth } from "./provider-model.ts";
import { contentHash, verifyContentHash } from "./content-hash.ts";
import { UepApiError } from "./uep-api-types.ts";

export type StorageBackend = "memory" | "s3" | "ipfs" | "other";

export type StorageAvailability =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "UNKNOWN"
  | "PINNED"
  | "UNPINNED";

/** Content identity ≠ storage location */
export type StorageRecord = {
  objectId: string;
  contentHash: string;
  size: number;
  contentType: string;
  providerId: string;
  backend: StorageBackend;
  /** Provider-specific locator (s3://…, ipfs://CID, mem://…) */
  locator: string;
  createdAt: string;
  updatedAt: string;
  availability: StorageAvailability;
  metadata: Record<string, string>;
};

export type PutObjectInput = {
  objectId: string;
  body: Uint8Array | Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  /** Client-supplied expected hash; if omitted, computed */
  contentHash?: string;
  idempotencyKey?: string;
};

export type PutObjectResult = StorageRecord;

export type GetObjectResult = {
  record: StorageRecord;
  body: Buffer;
};

export type HeadObjectResult = StorageRecord;

export type ListObjectsQuery = {
  prefix?: string;
  limit?: number;
};

export interface StorageProvider extends ServiceProvider {
  readonly capability: "storage";
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(objectId: string): Promise<GetObjectResult>;
  headObject(objectId: string): Promise<HeadObjectResult>;
  deleteObject(objectId: string): Promise<void>;
  listObjects(query?: ListObjectsQuery): Promise<StorageRecord[]>;
}

export const MAX_OBJECT_BYTES = 16 * 1024 * 1024; // 16 MiB lab default
export const MAX_IDEMPOTENCY_ENTRIES = 10_000;
export const MAX_IDEMPOTENCY_KEY_LEN = 256;
const HASH_HEX_RE = /^[0-9a-f]{64}$/i;

export function assertSafeObjectId(objectId: string): void {
  if (!objectId || typeof objectId !== "string") {
    throw new UepApiError("INVALID_REQUEST", "objectId required");
  }
  if (objectId.includes("..") || objectId.includes("\\") || objectId.startsWith("/")) {
    throw new UepApiError("PATH_TRAVERSAL", "unsafe objectId");
  }
  if (objectId.length > 512) {
    throw new UepApiError("INVALID_REQUEST", "objectId too long");
  }
}

export function assertBodySize(body: Uint8Array | Buffer): void {
  if (body.byteLength > MAX_OBJECT_BYTES) {
    throw new UepApiError("PAYLOAD_TOO_LARGE", `max ${MAX_OBJECT_BYTES} bytes`);
  }
}

/** Validate optional client contentHash: if present (incl. empty), must be 64 hex and match. */
export function resolveContentHash(
  body: Uint8Array | Buffer,
  expected?: string,
): string {
  const actual = contentHash(body);
  if (expected !== undefined && expected !== null) {
    if (typeof expected !== "string" || !HASH_HEX_RE.test(expected)) {
      throw new UepApiError(
        "INVALID_REQUEST",
        "contentHash must be 64 hex characters when provided",
        400,
        { expected },
      );
    }
    if (expected.toLowerCase() !== actual) {
      throw new UepApiError(
        "CONTENT_INTEGRITY_ERROR",
        "provided contentHash does not match body",
        400,
        { expected, actual },
      );
    }
  }
  return actual;
}

export function assertDownloadedIntegrity(
  body: Buffer,
  expectedHash: string,
  expectedSize?: number,
): void {
  if (expectedSize !== undefined && body.byteLength !== expectedSize) {
    throw new UepApiError(
      "CONTENT_INTEGRITY_ERROR",
      "size mismatch",
      400,
      { expectedSize, actualSize: body.byteLength },
    );
  }
  const v = verifyContentHash(body, expectedHash);
  if (!v.ok) {
    throw new UepApiError("CONTENT_INTEGRITY_ERROR", "hash mismatch", 400, {
      expected: expectedHash,
      actual: v.actual,
    });
  }
}

export type IdempotencyRecord = {
  objectId: string;
  contentHash: string;
};

/**
 * Idempotency: key → {objectId, contentHash}.
 * Same key + same content → REPLAY (return existing).
 * Same key + different content → CONFLICT.
 * Bounded with FIFO eviction.
 */
export class IdempotencyStore {
  private map = new Map<string, IdempotencyRecord>();
  private order: string[] = [];
  readonly maxEntries: number;

  constructor(maxEntries = MAX_IDEMPOTENCY_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  size(): number {
    return this.map.size;
  }

  lookup(idempotencyKey: string): IdempotencyRecord | undefined {
    return this.map.get(idempotencyKey);
  }

  /**
   * Returns existing record if replay, null if first, throws on conflict.
   */
  check(
    idempotencyKey: string,
    objectId: string,
    contentHash: string,
  ): IdempotencyRecord | null {
    if (idempotencyKey.length === 0) {
      throw new UepApiError("INVALID_REQUEST", "idempotencyKey empty");
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
      throw new UepApiError("INVALID_REQUEST", "idempotencyKey too long");
    }
    const prev = this.map.get(idempotencyKey);
    if (!prev) return null;
    if (prev.objectId === objectId && prev.contentHash === contentHash) {
      return prev; // REPLAY
    }
    throw new UepApiError(
      "IDEMPOTENCY_CONFLICT",
      "idempotency key reused with different objectId or content",
      409,
      { previous: prev, objectId, contentHash },
    );
  }

  set(idempotencyKey: string, objectId: string, contentHash: string): void {
    if (!this.map.has(idempotencyKey)) {
      this.order.push(idempotencyKey);
      while (this.order.length > this.maxEntries) {
        const old = this.order.shift();
        if (old) this.map.delete(old);
      }
    }
    this.map.set(idempotencyKey, { objectId, contentHash });
  }
}

export type { ProviderHealth };
