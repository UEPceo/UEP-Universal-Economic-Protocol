/**
 * CI check: the package version is numeric semver only (MAJOR.MINOR.PATCH,
 * no pre-release or build suffix), package-lock.json agrees, and the newest
 * CHANGELOG entry is headed by the same version. Historical CHANGELOG entries
 * (before 0.5.3) keep their old names and are not checked.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NUMERIC_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function versionProblems(root) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const v = pkg.version;
  if (typeof v !== "string" || !NUMERIC_SEMVER.test(v)) problems.push(`package.json version ${JSON.stringify(v)} is not numeric semver (MAJOR.MINOR.PATCH)`);
  if (lock.version !== v) problems.push(`package-lock.json version ${JSON.stringify(lock.version)} differs from package.json ${JSON.stringify(v)}`);
  if (lock.packages?.[""]?.version !== v) problems.push(`package-lock.json packages[""].version ${JSON.stringify(lock.packages?.[""]?.version)} differs from package.json ${JSON.stringify(v)}`);
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const head = changelog.split("\n").find((l) => l.startsWith("## "));
  const headVersion = head?.slice(3).split(/\s/)[0];
  if (headVersion !== v) problems.push(`newest CHANGELOG heading ${JSON.stringify(head)} does not start with the package version ${v}`);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = versionProblems(root);
  for (const p of problems) console.error(`check-version: ${p}`);
  if (problems.length) process.exit(1);
  const v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  console.log(`check-version: ${v} is numeric semver; package-lock.json and CHANGELOG agree`);
}
