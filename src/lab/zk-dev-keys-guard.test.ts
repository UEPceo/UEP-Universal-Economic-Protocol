/**
 * The pinned verifying keys are development keys only: refused in production
 * mode, a one-time warning outside development/test runs, and a
 * non-development pin file may not list them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_VK_PINS_FILE, developmentVkHashes, loadVkPins } from "./zk-vk-pins.ts";

const mod = new URL("./zk-vk-pins.ts", import.meta.url).href;

/** Run loadVkPins() in a clean child process with `env` (no node:test context). */
function loadIn(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); console.log("pins=" + m.loadVkPins().length);`], { env: { ...base, ...env }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("development verifying keys guard", () => {
  it("the bundled pin file is labelled DEV-TEST-KEYS and loads in test runs", () => {
    assert.ok(loadVkPins(DEFAULT_VK_PINS_FILE).length >= 2);
    assert.ok(developmentVkHashes().size >= 2);
  });

  it("production mode refuses the development keys", () => {
    for (const env of [{ NODE_ENV: "production" }, { UEP_ZK_KEY_MODE: "production" }] as Record<string, string>[]) {
      const r = loadIn(env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /VK_DEV_KEYS_REFUSED/);
    }
  });

  it("outside development/test runs the keys load with a warning; dev/test mode is silent", () => {
    const plain = loadIn({});
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /pins=\d+/);
    assert.match(plain.stderr, /UEP_ZK_DEV_KEYS/);
    for (const env of [{ UEP_ZK_KEY_MODE: "dev" }, { NODE_ENV: "test" }] as Record<string, string>[]) {
      const r = loadIn(env);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /UEP_ZK_DEV_KEYS/);
    }
  });

  it("a pin file not labelled DEV-TEST-KEYS may not list a development key", () => {
    const dir = mkdtempSync(join(tmpdir(), "uep-pins-"));
    try {
      const devSha = [...developmentVkHashes()][0]!;
      const mislabeled = join(dir, "mislabeled.json");
      writeFileSync(mislabeled, JSON.stringify({ format: "uep-zk-vk-pins", keys: "CEREMONY-2027", pins: [{ circuitTag: "t", depth: 4, domainId: "1", vkSha256: devSha }] }));
      assert.throws(() => loadVkPins(mislabeled), /VK_DEV_KEYS_MISLABELED/);
      const unlabeled = join(dir, "unlabeled.json");
      writeFileSync(unlabeled, JSON.stringify({ format: "uep-zk-vk-pins", pins: [{ circuitTag: "t", depth: 4, domainId: "1", vkSha256: devSha.toUpperCase() }] }));
      assert.throws(() => loadVkPins(unlabeled), /VK_DEV_KEYS_MISLABELED/);
      const other = join(dir, "other.json");
      writeFileSync(other, JSON.stringify({ format: "uep-zk-vk-pins", keys: "CEREMONY-2027", pins: [{ circuitTag: "t", depth: 4, domainId: "1", vkSha256: "ab".repeat(32) }] }));
      assert.equal(loadVkPins(other).length, 1);
      // Production mode accepts a non-development pin file.
      const r = loadIn({ NODE_ENV: "production", UEP_ZK_VK_PINS_FILE: other });
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
