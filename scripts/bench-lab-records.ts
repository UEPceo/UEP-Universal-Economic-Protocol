/**
 * Consumer for the five lab benchmark records. They are measurements, not a
 * second runner. This checks they still parse and name a commitment.
 */
import fs from "node:fs";
const files = ["uep35.5-bench.json", "uep35.6-bench.json", "uep35.7.1-bench.json", "uep36.1.1-bench.json", "uep36.1.2-bench.json"];
for (const name of files) {
  const rows = JSON.parse(fs.readFileSync(new URL(`../uep-core/benchmarks/${name}`, import.meta.url), "utf8")) as { seqCommitment?: string }[];
  if (!rows.length || !rows[0].seqCommitment) throw new Error(`BENCH_RECORD_EMPTY: ${name}`);
  console.log(`${name} ${rows.length} rows`);
}
