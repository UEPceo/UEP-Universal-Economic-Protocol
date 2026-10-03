/**
 * CI check (docs/COMPATIBILITY.md): the ledger snapshot format may only change
 * together with a migration step and golden fixtures.
 *
 * Fails when
 *  - SNAPSHOT_FORMAT_VERSION and the migration registry disagree, or a format
 *    between the oldest migratable one and the current one has no step;
 *  - a format in that range has no golden fixture, or a step's fixture is
 *    missing or of another format;
 *  - the snapshot payload shape (top-level keys, policy keys) differs from
 *    src/testnet/fixtures/snapshots/FORMAT.json while the format version is
 *    the same (a shape change without a format bump), or the version differs
 *    from FORMAT.json (update FORMAT.json after adding the step and fixtures:
 *    `--write-lock`, only accepted when every other check passes).
 * The fixtures themselves are loaded by src/testnet/snapshot-fixtures.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { UepLedger, SNAPSHOT_FORMAT_VERSION } from "../src/testnet/ledger.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { OLDEST_MIGRATABLE_SNAPSHOT_FORMAT, SNAPSHOT_MIGRATIONS, UNMIGRATABLE_SNAPSHOT_FORMATS, migrationRegistryProblems } from "../src/testnet/snapshot-migrations.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(root, "src/testnet/fixtures/snapshots");
const lockPath = path.join(dir, "FORMAT.json");

type Lock = { formatVersion: number; payloadKeys: string[]; policyKeys: string[] };

export function currentShape(): Lock {
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null });
  const payload = ledger.snapshotPayload() as Record<string, unknown>;
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, payloadKeys: Object.keys(payload).sort(), policyKeys: Object.keys(payload.policy as object).sort() };
}

export function checkSnapshotCompat(opts: { current?: number; fixturesDir?: string; lock?: Lock | null; shape?: Lock } = {}): string[] {
  const current = opts.current ?? SNAPSHOT_FORMAT_VERSION;
  const fixturesDir = opts.fixturesDir ?? dir;
  const problems = [...migrationRegistryProblems(current)];
  const fixtures = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && f !== "FORMAT.json").map((f) => {
    const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), "utf8")) as { formatVersion?: unknown; expectedRejection?: unknown; chain?: Array<{ formatVersion?: unknown }> };
    if (!Number.isSafeInteger(fx.formatVersion) || !Array.isArray(fx.chain) || fx.chain.length === 0 || fx.chain.some((s) => s.formatVersion !== fx.formatVersion)) problems.push(`${f}: malformed fixture (formatVersion / chain)`);
    return { file: f, formatVersion: fx.formatVersion as number, rejected: fx.expectedRejection !== undefined };
  });
  for (let v = OLDEST_MIGRATABLE_SNAPSHOT_FORMAT; v <= current; v++) {
    if (!fixtures.some((f) => f.formatVersion === v && !f.rejected)) problems.push(`format ${v}: no golden fixture (src/testnet/fixtures/snapshots); generate one with scripts/fixtures/generate-snapshot-fixture.ts`);
  }
  for (const step of SNAPSHOT_MIGRATIONS) {
    for (const f of step.fixtures) {
      const hit = fixtures.find((x) => x.file === f);
      if (!hit) problems.push(`step ${step.from}->${step.to}: fixture ${f} is missing`);
      else if (hit.formatVersion !== step.from) problems.push(`step ${step.from}->${step.to}: fixture ${f} is format ${hit.formatVersion}`);
    }
  }
  for (const f of fixtures) {
    if (f.formatVersion > current) problems.push(`${f.file}: format ${f.formatVersion} is newer than SNAPSHOT_FORMAT_VERSION ${current}`);
    if (f.formatVersion < OLDEST_MIGRATABLE_SNAPSHOT_FORMAT && !f.rejected) problems.push(`${f.file}: format ${f.formatVersion} is not migratable; the fixture must declare expectedRejection`);
    if (f.formatVersion < OLDEST_MIGRATABLE_SNAPSHOT_FORMAT && !UNMIGRATABLE_SNAPSHOT_FORMATS[f.formatVersion]) problems.push(`${f.file}: format ${f.formatVersion} has no documented reason`);
  }
  const lock = opts.lock === undefined ? (fs.existsSync(lockPath) ? (JSON.parse(fs.readFileSync(lockPath, "utf8")) as Lock) : null) : opts.lock;
  const shape = opts.shape ?? currentShape();
  if (!lock) problems.push("FORMAT.json is missing (run with --write-lock)");
  else if (lock.formatVersion !== shape.formatVersion) problems.push(`SNAPSHOT_FORMAT_VERSION is ${shape.formatVersion} but FORMAT.json records ${lock.formatVersion}: add the migration step and fixtures, then run with --write-lock`);
  else {
    const diff = (a: string[], b: string[]) => a.filter((k) => !b.includes(k));
    const added = [...diff(shape.payloadKeys, lock.payloadKeys), ...diff(shape.policyKeys, lock.policyKeys).map((k) => `policy.${k}`)];
    const removed = [...diff(lock.payloadKeys, shape.payloadKeys), ...diff(lock.policyKeys, shape.policyKeys).map((k) => `policy.${k}`)];
    if (added.length || removed.length) problems.push(`snapshot payload shape changed without a format bump (added: ${added.join(", ") || "-"}; removed: ${removed.join(", ") || "-"}): bump SNAPSHOT_FORMAT_VERSION and add a migration step and fixtures`);
  }
  return problems;
}

if (import.meta.url === new URL(process.argv[1]!, "file://").href || process.argv[1]?.endsWith("check-snapshot-compat.ts")) {
  const write = process.argv.includes("--write-lock");
  const problems = checkSnapshotCompat(write ? { lock: currentShape() } : {});
  if (problems.length) {
    for (const p of problems) console.error(`snapshot-compat: ${p}`);
    process.exit(1);
  }
  if (write) fs.writeFileSync(lockPath, JSON.stringify(currentShape(), null, 2) + "\n");
  console.log(`snapshot-compat: format ${SNAPSHOT_FORMAT_VERSION}, ${SNAPSHOT_MIGRATIONS.length} migration step(s) from format ${OLDEST_MIGRATABLE_SNAPSHOT_FORMAT}, fixtures and FORMAT.json consistent${write ? " (FORMAT.json written)" : ""}`);
}
