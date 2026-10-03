/**
 * Local bridge to the Rust `uep-zk` helper (Groth16 test keys).
 *
 * Status: IMPLEMENTED for local tooling — NOT production ceremony.
 * Default wallet spend path remains DevelopmentSpendProofProvider (UEP-25 MAC).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoseidonSpendRequestJson } from "./poseidon-spend-request.ts";
import { privateExecutableCopy } from "./uep-zk-runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export type UepZkDemoResult = {
  ok: boolean;
  setupMs?: number;
  proveMs?: number;
  verifyMs?: number;
  pkBytes?: number;
  vkBytes?: number;
  proofBytes?: number;
  circuitMetadataId?: string;
  publicSchemaId?: string;
  vkId?: string;
  artifactBundleId?: string;
  constraints?: number;
  tag?: string;
  raw: string;
};

function candidateBinaries(): string[] {
  const env = process.env.UEP_ZK_BIN;
  return [
    env,
    // Built from source by `npm run build:uep-zk` (no prebuilt binary is committed).
    process.env.CARGO_TARGET_DIR ? path.join(process.env.CARGO_TARGET_DIR, "release/uep-zk") : undefined,
    path.join(repoRoot, "uep-core/target/release/uep-zk"),
    path.join(repoRoot, "uep-core/uep-26-spend-circuit/bin/uep-zk"),
    path.join(repoRoot, "uep-core/uep-26-spend-circuit/target/release/uep-zk"),
    path.join(repoRoot, "uep-core/uep-26-spend-circuit/target/debug/uep-zk"),
    "uep-zk",
  ].filter(Boolean) as string[];
}

function isExecutable(c: string): boolean {
  try {
    fs.accessSync(c, fs.constants.X_OK);
  } catch {
    return false;
  }
  // Some mounted filesystems: X_OK can succeed while the kernel still refuses exec.
  // Probe with a cheap invocation; non-zero exit is fine if the process started.
  if (c.includes("/artifacts/")) {
    const probe = spawnSync(c, ["circuit-id"], { encoding: "utf8", timeout: 15_000 });
    // error ENOENT/EACCES → not runnable
    if (probe.error) return false;
    return true;
  }
  return true;
}

/** Private executable copy (mkdtemp dir, 0700) for mounts that forbid exec. */
function materializeUepZk(src: string): string | null {
  try {
    const dest = privateExecutableCopy(src);
    const probe = spawnSync(dest, ["circuit-id"], { encoding: "utf8", timeout: 15_000 });
    if (probe.error) return null;
    return dest;
  } catch {
    return null;
  }
}

/**
 * Prefer an already-executable path; if the only copy lives on a mount that forbids exec
 * (artifacts), copy it into a private temporary directory so the kernel can exec it.
 */
export function findUepZkBinary(): string | null {
  for (const c of candidateBinaries()) {
    if (c === "uep-zk") {
      const which = spawnSync("which", ["uep-zk"], { encoding: "utf8" });
      if (which.status === 0 && which.stdout.trim()) {
        const p = which.stdout.trim();
        if (isExecutable(p)) return p;
      }
      continue;
    }
    if (!fs.existsSync(c)) continue;
    // Never try to exec directly from artifacts/
    if (c.includes("/artifacts/")) {
      const m = materializeUepZk(c);
      if (m) return m;
      continue;
    }
    if (isExecutable(c)) return c;
  }
  const bundled = path.join(repoRoot, "uep-core/uep-26-spend-circuit/bin/uep-zk");
  if (fs.existsSync(bundled)) {
    return materializeUepZk(bundled);
  }
  return null;
}

export function runUepZk(args: string[]): { status: number; stdout: string; stderr: string } {
  const bin = findUepZkBinary();
  if (!bin) {
    return {
      status: 127,
      stdout: "",
      stderr:
        "uep-zk binary not found. Build: cargo build --release --bin uep-zk (in uep-26-spend-circuit)",
    };
  }
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function parseDemo(raw: string): UepZkDemoResult {
  const num = (k: string) => {
    const m = raw.match(new RegExp(`^${k}=(\\d+)`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const str = (k: string) => {
    const m = raw.match(new RegExp(`^${k}=(\\S+)`, "m"));
    return m ? m[1] : undefined;
  };
  return {
    ok: /ok=true/.test(raw),
    leaves: str("leaf_sender_new")
      ? {
          senderIndex: Number(str("leaf_sender_index") ?? 0),
          senderNew: str("leaf_sender_new")!,
          recipientIndex: Number(str("leaf_recipient_index") ?? 0),
          recipientNew: str("leaf_recipient_new")!,
          treasuryIndex: Number(str("leaf_treasury_index") ?? 0),
          treasuryNew: str("leaf_treasury_new")!,
          nullifierIndex: Number(str("leaf_nullifier_index") ?? 0),
          nullifier: str("leaf_nullifier")!,
        }
      : undefined,
    setupMs: num("setup_ms"),
    proveMs: num("prove_ms"),
    verifyMs: num("verify_ms"),
    pkBytes: num("pk_bytes"),
    vkBytes: num("vk_bytes"),
    proofBytes: num("proof_bytes"),
    constraints: num("constraints"),
    tag: str("tag"),
    circuitMetadataId: str("circuit_metadata_id"),
    publicSchemaId: str("public_schema_id"),
    vkId: str("vk_id"),
    artifactBundleId: str("artifact_bundle_id"),
    raw,
  };
}

export function zkCircuitId(): string {
  const r = runUepZk(["circuit-id"]);
  if (r.status !== 0) throw new Error(r.stderr || "circuit-id failed");
  return (r.stdout + r.stderr).trim();
}

export function zkDemoD4(): UepZkDemoResult {
  const r = runUepZk(["demo-d4"]);
  return parseDemo((r.stdout + "\n" + r.stderr).trim());
}

export function zkDemoD32(): UepZkDemoResult {
  const r = runUepZk(["demo-d32"]);
  return parseDemo((r.stdout + "\n" + r.stderr).trim());
}

export type ExportedGroth16Artifact = {
  ok: boolean;
  depth: number;
  tag?: string;
  vkId?: string;
  artifactBundleId?: string;
  vkHex: string;
  proofHex: string;
  publicInputsHex: string[];
  raw: string;
};

/** Prove honest Poseidon fixture D=4 and export vk/proof/publics as hex. */
export function zkProveExportD4(): ExportedGroth16Artifact {
  const r = runUepZk(["prove-export-d4"]);
  const raw = (r.stdout + "\n" + r.stderr).trim();
  if (r.status !== 0) {
    return {
      ok: false,
      depth: 4,
      vkHex: "",
      proofHex: "",
      publicInputsHex: [],
      raw,
    };
  }
  const str = (k: string) => {
    const m = raw.match(new RegExp(`^${k}=(\\S+)`, "m"));
    return m ? m[1]! : undefined;
  };
  const publics: string[] = [];
  for (let i = 0; i < 13; i++) {
    const v = str(`public_${i}`);
    if (v) publics.push(v);
  }
  return {
    ok: /ok=true/.test(raw) && publics.length === 13,
    depth: 4,
    tag: str("tag"),
    vkId: str("vk_id"),
    artifactBundleId: str("artifact_bundle_id"),
    vkHex: str("vk_hex") ?? "",
    proofHex: str("proof_hex") ?? "",
    publicInputsHex: publics,
    raw,
  };
}

/** Independent node-side verify: no secrets, only vk + proof + 13 publics (12 economic + domain_id). */
export function zkVerifyHex(
  vkHex: string,
  proofHex: string,
  publicInputsHex: string[],
): { ok: boolean; raw: string } {
  if (publicInputsHex.length !== 13) {
    return { ok: false, raw: "need exactly 13 public inputs" };
  }
  const body =
    `vk_hex=${vkHex}\nproof_hex=${proofHex}\n` +
    publicInputsHex.map((h, i) => `public_${i}=${h}`).join("\n") +
    "\n";
  const bin = findUepZkBinary();
  if (!bin) {
    return { ok: false, raw: "uep-zk binary not found" };
  }
  const r = spawnSync(bin, ["verify-hex"], {
    encoding: "utf8",
    input: body,
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const lines = (r.stdout ?? "").split(/\n/).map((s) => s.trim());
  return { ok: (r.status ?? 1) === 0 && lines.includes("ok=true"), raw: (r.stdout ?? "").trim() };
}


export type PoseidonSpendProofResult = {
  ok: boolean;
  depth?: number;
  vkHex?: string;
  proofHex?: string;
  vkId?: string;
  publicInputsHex: string[];
  bound?: Record<string, string>;
  setupMs?: number;
  proveMs?: number;
  verifyMs?: number;
  keys?: string;
  networkProfile?: string;
  /** Post-spend leaf updates for canonical state (from prover). */
  leaves?: {
    senderIndex: number;
    senderNew: string;
    recipientIndex: number;
    recipientNew: string;
    treasuryIndex: number;
    treasuryNew: string;
    nullifierIndex: number;
    nullifier: string;
  };
  raw: string;
  error?: string;
};

/** Prove a wallet economic spend via Poseidon circuit (public inputs bound to this spend). */
export function zkProveSpendJson(req: PoseidonSpendRequestJson): PoseidonSpendProofResult {
  const bin = findUepZkBinary();
  if (!bin) {
    return {
      ok: false,
      publicInputsHex: [],
      raw: "",
      error: "uep-zk binary not found",
    };
  }
  const r = spawnSync(bin, ["prove-spend-json"], {
    encoding: "utf8",
    input: JSON.stringify(req),
    maxBuffer: 40 * 1024 * 1024,
  });
  const raw = ((r.stdout ?? "") + "\n" + (r.stderr ?? "")).trim();
  const str = (k: string) => {
    const m = raw.match(new RegExp(`^${k}=(\\S+)`, "m"));
    return m ? m[1]! : undefined;
  };
  const publics: string[] = [];
  for (let i = 0; i < 13; i++) {
    const v = str(`public_${i}`);
    if (v) publics.push(v);
  }
  const ok = (r.status ?? 1) === 0 && /ok=true/.test(raw) && publics.length === 13;
  const num = (k: string) => {
    const m = raw.match(new RegExp(`^${k}=(\\d+)`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  return {
    ok,
    depth: Number(str("depth") ?? req.depth),
    vkHex: str("vk_hex"),
    proofHex: str("proof_hex"),
    vkId: str("vk_id"),
    publicInputsHex: publics,
    bound: {
      sender_id: str("bound_sender_id") ?? "",
      nullifier: str("bound_nullifier") ?? "",
      amount: str("bound_amount") ?? "",
    },
    leaves: str("leaf_sender_new")
      ? {
          senderIndex: Number(str("leaf_sender_index") ?? 0),
          senderNew: str("leaf_sender_new")!,
          recipientIndex: Number(str("leaf_recipient_index") ?? 0),
          recipientNew: str("leaf_recipient_new")!,
          treasuryIndex: Number(str("leaf_treasury_index") ?? 0),
          treasuryNew: str("leaf_treasury_new")!,
          nullifierIndex: Number(str("leaf_nullifier_index") ?? 0),
          nullifier: str("leaf_nullifier")!,
        }
      : undefined,
    setupMs: num("setup_ms"),
    proveMs: num("prove_ms"),
    verifyMs: num("verify_ms"),
    keys: str("keys"),
    networkProfile: str("network_profile"),
    raw,
    error: ok ? undefined : str("error") ?? raw.slice(0, 500),
  };
}


export function zkNoteCommit(owner: string, asset: string, amount: string, blinding: string): string {
  const r = runUepZk(["note-commit", owner, asset, amount, blinding]);
  const raw = (r.stdout + r.stderr).trim();
  const m = raw.match(/^leaf=(\S+)/m);
  if (!m) throw new Error("note-commit failed: " + raw.slice(0, 200));
  return m[1]!;
}

export function zkLowBits(value: string, depth: number): number {
  const r = runUepZk(["low-bits", value, String(depth)]);
  const raw = (r.stdout + r.stderr).trim();
  const m = raw.match(/^index=(\d+)/m);
  if (!m) throw new Error("low-bits failed: " + raw.slice(0, 200));
  return Number(m[1]);
}

/** State-tree index of the (account, asset) balance leaf (uep-zk `state-index`). */
export function zkStateIndex(account: string, asset: string, depth: number): number {
  const r = runUepZk(["state-index", account, asset, String(depth)]);
  const raw = (r.stdout + r.stderr).trim();
  const m = raw.match(/^index=(\d+)/m);
  if (!m) throw new Error("state-index failed: " + raw.slice(0, 200));
  return Number(m[1]);
}

export function zkHAccount(secret: string, salt: string): string {
  const r = runUepZk(["h-account", secret, salt]);
  const raw = (r.stdout + r.stderr).trim();
  const m = raw.match(/^account_id=(\S+)/m);
  if (!m) throw new Error("h-account failed: " + raw.slice(0, 200));
  return m[1]!;
}
