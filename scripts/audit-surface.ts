import { spawnSync } from "node:child_process";

const steps = [
  ["npm", ["run", "sandbox"]],
  ["npm", ["run", "simulate:scenario"]],
  ["npm", ["run", "example:service"]],
  ["npm", ["run", "test:marketplace"]],
];
for (const [cmd, args] of steps as Array<[string, string[]]>) {
  const run = spawnSync(cmd, args, { stdio: "inherit" });
  if (run.status !== 0) throw new Error(`AUDIT_SURFACE_FAIL ${args.join(" ")}`);
}
console.log("AUDIT SURFACE OK");
