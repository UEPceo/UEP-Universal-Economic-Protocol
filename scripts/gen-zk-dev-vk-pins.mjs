#!/usr/bin/env node
/**
 * Regenerates uep-core/vectors/UEP-ZK-DEV-VK-PINS.json from the built `uep-zk`
 * helper (`uep-zk dev-vk <depth>`, `uep-zk dev-vk-v6 <depth>`). The development keys come from the public
 * fixed seed DEV_SETUP_SEED (no ceremony, no secret): this only records the
 * SHA-256 of each serialized verifying key per (circuit tag, depth, domain).
 *
 * Pins for earlier circuit tags are kept so older artefacts stay identifiable;
 * an existing pin is never changed (a different hash for the same tuple aborts).
 *
 *   npm run build:uep-zk && node scripts/gen-zk-dev-vk-pins.mjs [--check]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "uep-core/vectors/UEP-ZK-DEV-VK-PINS.json");
const bin = process.env.UEP_ZK_BIN || path.join(process.env.CARGO_TARGET_DIR || path.join(root, "uep-core/target"), "release/uep-zk");
// [helper subcommand, depth]: v5 (kept, pins unchanged) and 0.5.83 v6.
const JOBS = [["dev-vk", 4], ["dev-vk", 32], ["dev-vk-v6", 4], ["dev-vk-v6", 64]];
const DOMAINS = ["1"];
const check = process.argv.includes("--check");

const doc = JSON.parse(fs.readFileSync(file, "utf8"));
if (doc.format !== "uep-zk-vk-pins" || doc.keys !== "DEV-TEST-KEYS") throw new Error("not the development pin file");
const pins = [...doc.pins];
let added = 0;
for (const [cmd, depth] of JOBS) {
  const r = spawnSync(bin, [cmd, String(depth)], { encoding: "utf8", maxBuffer: 64 << 20 });
  const hex = r.stdout.match(/^vk_hex=([0-9a-f]+)/m)?.[1];
  const tag = r.stdout.match(/^tag=(\S+)/m)?.[1];
  if (r.status !== 0 || !hex || !tag) throw new Error(`uep-zk ${cmd} ${depth} failed: ${r.stderr}`);
  const vkSha256 = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
  for (const domainId of DOMAINS) {
    const old = pins.find((p) => p.circuitTag === tag && p.depth === depth && String(p.domainId) === domainId);
    if (old) {
      if (old.vkSha256 !== vkSha256) throw new Error(`pin mismatch for ${tag} depth=${depth} domain=${domainId}`);
      continue;
    }
    if (check) { console.error(`missing pin: ${tag} depth=${depth} domain=${domainId}`); process.exitCode = 1; continue; }
    pins.push({ circuitTag: tag, depth, domainId, vkSha256 });
    added++;
  }
}
if (!check && added) {
  doc.pins = pins;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}
console.log(check ? (process.exitCode ? "pins: MISSING" : "pins: ok") : `pins: ${added} added`);
