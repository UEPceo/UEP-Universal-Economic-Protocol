/**
 * PERF-001 memory benchmark: compressed SMT vs the reference (uncompressed)
 * tree, depth 254 (account/nullifier trees), N random accounts (default 10k).
 *   npm run bench:smt -- [N]
 * Each variant runs in its own process with a cold hash memo; the hash memo
 * is cleared before the retained heap is measured. Checks equal roots.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Fr } from "../src/core/field.ts";
import { clearPoseidonMemo } from "../src/core/poseidon.ts";
import { ACCOUNT_DEPTH, SparseMerkleTree } from "../src/core/smt.ts";
import { ReferenceSparseMerkleTree } from "../src/core/fixtures/reference-smt.ts";

const N = Number(process.argv[2] ?? 10_000);
const variant = process.argv[3];

if (!variant) {
  const self = fileURLToPath(import.meta.url);
  const run = (v: string) => {
    const r = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", self, String(N), v], { encoding: "utf8", maxBuffer: 1 << 24 });
    if (r.status !== 0) throw new Error(`${v} failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const compressed = run("compressed");
  const reference = run("reference");
  const sameRoot = compressed.root === reference.root;
  console.log(JSON.stringify({ depth: ACCOUNT_DEPTH, accounts: N, compressed, reference, sameRoot, memoryRatio: +(reference.retainedMiB / Math.max(compressed.retainedMiB, 0.01)).toFixed(1), nodeRatio: +(reference.storedNodes / compressed.storedNodes).toFixed(1) }, null, 2));
  process.exit(sameRoot ? 0 : 1);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");
const ids = Array.from({ length: N }, (_, i) => Fr.fromBytesBE254(new Uint8Array(createHash("sha256").update(`acct-${i}`).digest())));
gc(); gc();
const before = process.memoryUsage().heapUsed;
const t0 = performance.now();
const tree = variant === "compressed" ? new SparseMerkleTree(ACCOUNT_DEPTH) : new ReferenceSparseMerkleTree(ACCOUNT_DEPTH);
ids.forEach((id, i) => tree.set(id, new Fr(BigInt(i + 1))));
const root = tree.root().toHex();
const insertMs = Math.round(performance.now() - t0);
clearPoseidonMemo();
gc(); gc();
const retained = process.memoryUsage().heapUsed - before;
console.log(JSON.stringify({ variant, storedNodes: tree.storedNodeCount(), retainedMiB: +(retained / 1048576).toFixed(2), insertMs, root }));
