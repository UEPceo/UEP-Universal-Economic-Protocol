import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentHash } from "./content-hash.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import {
  S3StorageAdapter,
  createMemoryS3Transport,
} from "./s3-adapter.ts";
import {
  IPFSStorageAdapter,
  createMemoryIpfsTransport,
} from "./ipfs-adapter.ts";
import {
  UepTelemetry,
  NoopExporter,
  FailingExporter,
  InMemoryExporter,
  METRICS,
} from "./observability.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { getCapabilities } from "./capabilities.ts";
import { UepApiError } from "./uep-api-types.ts";
import { MultiLeaderLab } from "../lab/uep36-multi-leader.ts";

describe("UEP-36.2 service layer", () => {
  it("capabilities: storage true; compute/relay/oracle false", () => {
    const c = getCapabilities();
    assert.equal(c.services.storage, true);
    assert.equal(c.services.compute, false);
    assert.equal(c.services.relay, false);
    assert.equal(c.services.oracle, false);
    assert.equal(c.observability.consensusCritical, false);
  });

  it("memory storage put/get/head/delete/list + hash verify", async () => {
    const s = new MemoryStorageProvider();
    const body = Buffer.from("hello-uep-36.2");
    const hash = contentHash(body);
    const rec = await s.putObject({ objectId: "obj1", body, contentHash: hash });
    assert.equal(rec.contentHash, hash);
    assert.equal(rec.backend, "memory");
    const got = await s.getObject("obj1");
    assert.equal(got.body.toString(), "hello-uep-36.2");
    const head = await s.headObject("obj1");
    assert.equal(head.size, body.byteLength);
    const list = await s.listObjects({ prefix: "obj" });
    assert.equal(list.length, 1);
    await s.deleteObject("obj1");
    await assert.rejects(() => s.getObject("obj1"));
  });

  it("content integrity: wrong hash rejected on put", async () => {
    const s = new MemoryStorageProvider();
    await assert.rejects(
      () =>
        s.putObject({
          objectId: "x",
          body: Buffer.from("a"),
          contentHash: "00".repeat(32),
        }),
      (e: unknown) => e instanceof UepApiError && e.code === "CONTENT_INTEGRITY_ERROR",
    );
  });

  it("path traversal and oversized rejected", async () => {
    const s = new MemoryStorageProvider();
    await assert.rejects(
      () => s.putObject({ objectId: "../etc/passwd", body: Buffer.from("x") }),
      (e: unknown) => e instanceof UepApiError && e.code === "PATH_TRAVERSAL",
    );
    const big = Buffer.alloc(16 * 1024 * 1024 + 1);
    await assert.rejects(
      () => s.putObject({ objectId: "big", body: big }),
      (e: unknown) => e instanceof UepApiError && e.code === "PAYLOAD_TOO_LARGE",
    );
  });

  it("idempotent put returns same record", async () => {
    const s = new MemoryStorageProvider();
    const body = Buffer.from("same");
    const a = await s.putObject({
      objectId: "id1",
      body,
      idempotencyKey: "k1",
    });
    const b = await s.putObject({
      objectId: "id1",
      body,
      idempotencyKey: "k1",
    });
    assert.equal(a.contentHash, b.contentHash);
    assert.equal(a.objectId, b.objectId);
  });

  it("S3 adapter success + unavailable", async () => {
    const s3 = new S3StorageAdapter({
      transport: createMemoryS3Transport(),
      providerId: "s3-lab",
    });
    const body = Buffer.from("s3-data");
    const rec = await s3.putObject({ objectId: "k1", body });
    assert.equal(rec.backend, "s3");
    assert.ok(rec.locator.startsWith("s3://"));
    const got = await s3.getObject("k1");
    assert.equal(got.body.toString(), "s3-data");
    s3.setUnavailable(true);
    await assert.rejects(
      () => s3.putObject({ objectId: "k2", body }),
      (e: unknown) => e instanceof UepApiError && e.code === "PROVIDER_UNAVAILABLE",
    );
  });

  it("IPFS adapter CID + contentHash identity", async () => {
    const ipfs = new IPFSStorageAdapter({
      transport: createMemoryIpfsTransport(),
    });
    const body = Buffer.from("ipfs-payload");
    const rec = await ipfs.putObject({ objectId: "doc1", body });
    assert.equal(rec.backend, "ipfs");
    assert.ok(rec.locator.startsWith("ipfs://"));
    assert.ok(rec.metadata.cid);
    const got = await ipfs.getObject("doc1");
    assert.equal(contentHash(got.body), rec.contentHash);
  });

  it("same contentHash across S3 and IPFS; different locators", async () => {
    const body = Buffer.from("shared-content-identity");
    const expected = contentHash(body);
    const s3 = new S3StorageAdapter({ transport: createMemoryS3Transport() });
    const ipfs = new IPFSStorageAdapter({
      transport: createMemoryIpfsTransport(),
    });
    const r1 = await s3.putObject({ objectId: "o", body });
    const r2 = await ipfs.putObject({ objectId: "o", body });
    assert.equal(r1.contentHash, expected);
    assert.equal(r2.contentHash, expected);
    assert.notEqual(r1.locator, r2.locator);
  });

  it("provider swappability: S3 record then IPFS same identity", async () => {
    const body = Buffer.from("migrate-me");
    const s3 = new S3StorageAdapter({ transport: createMemoryS3Transport() });
    const ipfs = new IPFSStorageAdapter({
      transport: createMemoryIpfsTransport(),
    });
    const a = await s3.putObject({ objectId: "m1", body });
    const b = await ipfs.putObject({ objectId: "m1", body, contentHash: a.contentHash });
    assert.equal(a.contentHash, b.contentHash);
  });

  it("API facade put/get + version mismatch", async () => {
    const mem = new MemoryStorageProvider("mem");
    const api = new UepServiceApi({
      storageProviders: new Map([["mem", mem]]),
      defaultStorageProviderId: "mem",
    });
    const body = Buffer.from("api-test");
    const put = await api.putObject({ objectId: "a1", body });
    assert.equal(put.ok, true);
    if (put.ok) assert.equal(put.data.contentHash, contentHash(body));
    const got = await api.getObject("a1");
    assert.equal(got.ok, true);
    const bad = await api.putObject(
      { objectId: "x", body: Buffer.from("z") },
      { apiVersion: "99.0.0" },
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, "VERSION_MISMATCH");
  });

  it("telemetry failure does not break storage", async () => {
    const tel = new UepTelemetry(new FailingExporter());
    const mem = new MemoryStorageProvider();
    const api = new UepServiceApi({
      storageProviders: new Map([["mem", mem]]),
      telemetry: tel,
    });
    const res = await api.putObject({
      objectId: "t1",
      body: Buffer.from("ok"),
    });
    assert.equal(res.ok, true);
  });

  it("storage unavailable: API fails cleanly; consensus lab still works", async () => {
    const mem = new MemoryStorageProvider();
    mem.setUnavailable(true);
    const api = new UepServiceApi({
      storageProviders: new Map([["mem", mem]]),
    });
    const res = await api.putObject({
      objectId: "x",
      body: Buffer.from("nope"),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "PROVIDER_UNAVAILABLE");

    // CORE consensus independent
    const lab = new MultiLeaderLab(4, 362, 2);
    assert.ok(lab.consensusHeight(1));
    assert.equal(lab.allHonestSameRoot(), true);
  });

  it("S3 down ≠ UEP down", async () => {
    const s3 = new S3StorageAdapter({ transport: createMemoryS3Transport() });
    s3.setUnavailable(true);
    await assert.rejects(() =>
      s3.putObject({ objectId: "x", body: Buffer.from("a") }),
    );
    const lab = new MultiLeaderLab(4, 363, 1);
    assert.ok(lab.consensusHeight(1));
  });

  it("IPFS down ≠ UEP down", async () => {
    const ipfs = new IPFSStorageAdapter({
      transport: createMemoryIpfsTransport(),
    });
    ipfs.setUnavailable(true);
    await assert.rejects(() =>
      ipfs.putObject({ objectId: "x", body: Buffer.from("a") }),
    );
    const lab = new MultiLeaderLab(4, 364, 1);
    assert.ok(lab.consensusHeight(1));
  });

  it("in-memory exporter records metrics without PII fields required", () => {
    const exp = new InMemoryExporter();
    const tel = new UepTelemetry(exp);
    tel.counter(METRICS.storageOps, 1, { op: "put" });
    const span = tel.startSpan("test", { objectId: "o1" });
    span.end("ok");
    assert.ok(exp.metrics.length >= 1);
    assert.ok(exp.spans.length >= 1);
  });

  it("provider health states", async () => {
    const mem = new MemoryStorageProvider();
    const h1 = await mem.health();
    assert.equal(h1.status, "HEALTHY");
    mem.setUnavailable(true);
    const h2 = await mem.health();
    assert.equal(h2.status, "UNAVAILABLE");
  });
});
