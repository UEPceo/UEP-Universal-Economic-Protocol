/** UEP-35.7.1 LAB benchmark — not network TPS */
import { writeFileSync, mkdirSync } from "node:fs";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

function txs(n: number, seed: number): BatchTx[] {
  const out: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `b${seed}-${i}`,
      from: `s${i % 3}`,
      to: `r${i % 4}`,
      amount: 1n,
    });
  }
  return out;
}

function run(nNodes: number, seed: number) {
  // Only classic BFT sizes for full finality path
  const classic = nNodes === 4 || nNodes === 7 || nNodes === 10;
  const c = new MultiNodeCluster(nNodes, seed);
  const t0 = performance.now();
  c.proposeFrom(c.nodes[0]!.id, txs(8, seed));
  c.tick(25, 60);
  const wall = performance.now() - t0;
  return {
    nodes: nNodes,
    environment: "LAB / single-process / SimulatedNetwork",
    classicBftSize: classic,
    wallClockMs: wall,
    messages: c.net.stats.sent,
    delivered: c.net.stats.delivered,
    bytes: c.net.stats.bytes,
    proposals: c.stats.proposals,
    votes: c.stats.votes,
    commits: c.stats.commits,
    finalities: c.stats.finalities,
    honestSameRoot: c.allHonestSameStateRoot(),
    conflictingFinality: c.anyConflictingFinality(),
    note: "consensusBytes approx messages with PROPOSAL/VOTE/CERT; data plane includes headers/bodies",
  };
}

const results = {
  benchmarkVersion: "35.7.1",
  seed: 20260928,
  generatedAtIso: new Date().toISOString(),
  note: "LAB only — not production network TPS",
  runs: [4, 8, 16, 32].map((n) => run(n, 20260928 + n)),
};

mkdirSync(new URL("../../uep-core/benchmarks", import.meta.url).pathname, {
  recursive: true,
});
const path =
  new URL("../../uep-core/benchmarks/uep35.7.1-bench.json", import.meta.url).pathname;
writeFileSync(path, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
