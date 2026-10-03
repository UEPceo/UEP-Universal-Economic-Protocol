/**
 * The CI check behind `npm run check:snapshot-compat` (docs/COMPATIBILITY.md):
 * a format change needs a migration step, golden fixtures and an updated
 * FORMAT.json; a shape change without a format bump is refused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSnapshotCompat, currentShape } from "../../scripts/check-snapshot-compat.ts";
import { SNAPSHOT_FORMAT_VERSION } from "./ledger.ts";

test("snapshot-compat check: the repository is consistent", () => {
  assert.deepEqual(checkSnapshotCompat(), []);
});

test("snapshot-compat check: a format bump without step, fixture and lock update fails", () => {
  const next = SNAPSHOT_FORMAT_VERSION + 1;
  const problems = checkSnapshotCompat({ current: next, shape: { ...currentShape(), formatVersion: next } });
  assert.ok(problems.some((p) => p.includes(`expected exactly one step ${SNAPSHOT_FORMAT_VERSION}->${next}`)), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes(`format ${next}: no golden fixture`)));
  assert.ok(problems.some((p) => p.includes(`but FORMAT.json records ${SNAPSHOT_FORMAT_VERSION}`)));
});

test("snapshot-compat check: a payload shape change without a format bump fails", () => {
  const shape = currentShape();
  const problems = checkSnapshotCompat({ shape: { ...shape, payloadKeys: [...shape.payloadKeys, "registryHash"] } });
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0]!, /shape changed without a format bump \(added: registryHash/);
  const policy = checkSnapshotCompat({ shape: { ...shape, policyKeys: shape.policyKeys.filter((k) => k !== "windowHeights") } });
  assert.match(policy[0]!, /removed: policy\.windowHeights/);
});
