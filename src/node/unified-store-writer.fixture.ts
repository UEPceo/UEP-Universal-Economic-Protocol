/**
 * 0.5.84 item 1 test fixture: a child process that appends frames to a unified store as fast as it
 * can until it is killed with SIGKILL by the parent test. Each frame carries a paired record set
 * (economic head n, bft marker n) so the parent can check that a frame is all-or-nothing.
 *   node --experimental-strip-types src/node/unified-store-writer.fixture.ts <dir> <compactEvery>
 */
import { UnifiedStateStore } from "./unified-state-store.ts";

const [dir, every] = process.argv.slice(2);
const ctx = { networkId: "uep-test", domainId: "d", validatorSetHash: "ab".repeat(32) };
const store = UnifiedStateStore.open(dir!, ctx, { autoCompactFrames: Number(every ?? 0) });
let n = store.economicHead?.height ?? 0;
process.stdout.write(`ready ${n}\n`);
for (;;) {
  n += 1;
  const root = `${n}`.padStart(64, "0");
  store.append([
    { kind: "economic", head: { height: n, stateRoot: root, txCount: n } },
    { kind: "bft", state: { version: 3, votes: [], committed: [[String(n), root]], locks: [], roundChanges: [] } as never },
  ]);
}
