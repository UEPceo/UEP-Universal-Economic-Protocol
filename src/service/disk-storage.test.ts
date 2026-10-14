import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorageProvider } from "./disk-storage.ts";
import { contentHash } from "./content-hash.ts";

test("disk storage keeps the body out of the record the snapshot would store", async () => {
  const root = await mkdtemp(join(tmpdir(), "uep-disk-"));
  try {
    const disk = new DiskStorageProvider(root, "disk-local", () => "h-4");
    const body = Buffer.from("delivery-bytes");
    const put = await disk.putObject({ objectId: "order-1/delivery", body, contentHash: contentHash(body) });
    assert.equal(put.contentHash, contentHash(body));
    assert.equal("body" in put, false);
    const got = await disk.getObject("order-1/delivery");
    assert.equal(got.body.toString(), "delivery-bytes");
    await assert.rejects(disk.putObject({ objectId: "order-1/other", body, contentHash: "00".repeat(32) }), /HASH|hash|mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
