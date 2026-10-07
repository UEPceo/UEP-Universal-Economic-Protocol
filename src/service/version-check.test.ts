/** From 0.5.3 on, the package version is numeric semver only (scripts/check-version.mjs, run in CI). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without types
import { NUMERIC_SEMVER, versionProblems } from "../../scripts/check-version.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

test("version: the repository version is numeric semver and package-lock.json / CHANGELOG agree", () => {
  assert.deepEqual(versionProblems(root), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.5.3");
});

test("version: suffixes, pre-releases and mismatches are refused", () => {
  for (const ok of ["0.5.3", "1.0.0", "10.20.30"]) assert.ok(NUMERIC_SEMVER.test(ok), ok);
  for (const bad of ["0.5.3-public-iot-m2m", "v0.5.3", "0.5", "0.5.3-rc.1", "0.5.3+build", "01.2.3", "0.5.3 "]) assert.ok(!NUMERIC_SEMVER.test(bad), bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uep-version-"));
  try {
    const write = (v: string, lockV = v, head = v) => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: v }));
      fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ version: lockV, packages: { "": { version: lockV } } }));
      fs.writeFileSync(path.join(dir, "CHANGELOG.md"), `# Changelog\n\n## ${head} — test\n\n## 0.5.2-public-iot-m2m — historical\n`);
    };
    write("0.5.3");
    assert.deepEqual(versionProblems(dir), []);
    write("0.5.3-public-iot-m2m");
    assert.ok(versionProblems(dir).some((p: string) => p.includes("not numeric semver")));
    write("0.5.3", "0.5.2");
    assert.ok(versionProblems(dir).some((p: string) => p.includes("package-lock.json")));
    write("0.5.3", "0.5.3", "0.5.3-public-iot-m2m");
    assert.ok(versionProblems(dir).some((p: string) => p.includes("CHANGELOG")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
