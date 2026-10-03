/**
 * Run the uep-zk helper built from source.
 *
 * The binary is executed in place. Only when the filesystem forbids exec
 * (EACCES/EPERM) is it copied, once per process, into a private directory
 * created with mkdtemp (mode 0700, unpredictable name) and removed on exit.
 */
import {
  copyFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  constants as fsConstants,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function findBundledUepZk(): string | null {
  const candidates = [
    process.env.UEP_ZK_BIN,
    // Built from source by `npm run build:uep-zk` (no prebuilt binary is committed).
    process.env.CARGO_TARGET_DIR ? join(process.env.CARGO_TARGET_DIR, "release/uep-zk") : undefined,
    join(__dirname, "../../uep-core/target/release/uep-zk"),
    join(__dirname, "../../uep-core/uep-26-spend-circuit/bin/uep-zk"),
    join(process.cwd(), "uep-core/uep-26-spend-circuit/bin/uep-zk"),
    // No shared /tmp fallback: a stale copy there could be an older circuit.
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const runnableCache = new Map<string, string>();
let privateDirs: string[] = [];
let exitHookInstalled = false;

/** Copy `src` into a fresh private directory (mkdtemp, 0700) and return the copy's path. */
export function privateExecutableCopy(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "uep-zk-"));
  chmodSync(dir, 0o700);
  const dest = join(dir, "uep-zk");
  copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
  chmodSync(dest, 0o700);
  privateDirs.push(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const d of privateDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      privateDirs = [];
    });
  }
  return dest;
}

/** Path to execute for `src`: in place when possible, else a private copy (V47-07). */
export function runnableUepZk(src: string): string {
  const hit = runnableCache.get(src);
  if (hit) return hit;
  const probe = spawnSync(src, ["circuit-id"], { encoding: "utf8", timeout: 15_000 });
  const code = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  const path = code === "EACCES" || code === "EPERM" ? privateExecutableCopy(src) : src;
  runnableCache.set(src, path);
  return path;
}

export function runUepZk(
  args: string[],
  opts?: { timeoutMs?: number; stdin?: string },
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const src = findBundledUepZk();
  if (!src) {
    return { ok: false, stdout: "", stderr: "uep-zk binary not found", status: 127 };
  }
  const r = spawnSync(runnableUepZk(src), args, {
    encoding: "utf8",
    input: opts?.stdin,
    timeout: opts?.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

export function padFrHex(hex: string): string {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  return h.padStart(64, "0");
}

export function zkNoteCommit(
  owner: string,
  asset: string,
  amount: string,
  blinding: string,
): string | null {
  const r = runUepZk([
    "note-commit",
    padFrHex(owner),
    padFrHex(asset),
    padFrHex(amount),
    padFrHex(blinding),
  ]);
  if (!r.ok) return null;
  const m = r.stdout.match(/leaf=([0-9a-fA-F]+)/);
  return m ? m[1]!.toLowerCase().padStart(64, "0") : null;
}

/** Poseidon SMT root: depth + list of index:leafHex */
export function zkSmtRoot(
  depth: number,
  leaves: Array<{ index: number | bigint; leafHex: string }>,
): string {
  const args = ["smt-root", String(depth)];
  for (const L of leaves) {
    args.push(`${L.index}:${padFrHex(L.leafHex)}`);
  }
  const r = runUepZk(args);
  if (!r.ok) throw new Error(`smt-root failed: ${r.stderr || r.stdout}`);
  const m = r.stdout.match(/root=([0-9a-fA-F]+)/);
  if (!m) throw new Error(`smt-root parse: ${r.stdout}`);
  return m[1]!.toLowerCase().padStart(64, "0");
}

export function zkSmtPath(
  depth: number,
  focusIndex: number | bigint,
  leaves: Array<{ index: number | bigint; leafHex: string }>,
): {
  depth: number;
  index: string;
  leaf: string;
  root: string;
  siblings: string[];
  indexBits: boolean[];
} {
  const args = ["smt-path", String(depth), String(focusIndex)];
  for (const L of leaves) {
    args.push(`${L.index}:${padFrHex(L.leafHex)}`);
  }
  const r = runUepZk(args);
  if (!r.ok) throw new Error(`smt-path failed: ${r.stderr || r.stdout}`);
  const g = (k: string) => {
    const m = r.stdout.match(new RegExp(k + "=([^\\n]+)"));
    if (!m) throw new Error(`smt-path missing ${k}`);
    return m[1]!;
  };
  return {
    depth: Number(g("depth")),
    index: g("index"),
    leaf: g("leaf").toLowerCase().padStart(64, "0"),
    root: g("root").toLowerCase().padStart(64, "0"),
    siblings: g("siblings").split(",").map((s) => s.toLowerCase().padStart(64, "0")),
    indexBits: g("index_bits").split("").map((c) => c === "1"),
  };
}

export function verifyBundledBinarySha256(expected?: string): boolean {
  const src = findBundledUepZk();
  if (!src) return false;
  const actual = createHash("sha256").update(readFileSync(src)).digest("hex");
  if (expected) return actual === expected;
  const shaFile = src + ".sha256";
  if (!existsSync(shaFile)) return false;
  const exp = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0]!;
  return exp === actual;
}

export function zkHAccount(secretHex: string, saltHex: string): string {
  const r = runUepZk(["h-account", padFrHex(secretHex), padFrHex(saltHex)]);
  if (!r.ok) throw new Error(`h-account failed: ${r.stderr || r.stdout}`);
  const m =
    r.stdout.match(/account_id=([0-9a-fA-F]+)/) ||
    r.stdout.match(/account=([0-9a-fA-F]+)/);
  if (!m) throw new Error(`h-account parse: ${r.stdout}`);
  return m[1]!.toLowerCase().padStart(64, "0");
}

export function zkProveSpendJson(
  json: string,
  opts?: { timeoutMs?: number },
): { ok: boolean; stdout: string; stderr: string } {
  const r = runUepZk(["prove-spend-json"], {
    timeoutMs: opts?.timeoutMs ?? 120_000,
    stdin: json,
  });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

export function parseProvePublics(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function zkProveSpendJsonAsync(
  json: string,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const src = findBundledUepZk();
  if (!src) return Promise.resolve({ ok: false, stdout: "", stderr: "uep-zk binary not found" });
  const runPath = runnableUepZk(src);
  return new Promise((resolve) => {
    const child = spawn(runPath, ["prove-spend-json"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts?.timeoutMs ?? 120_000);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.stdin.write(json);
    child.stdin.end();
  });
}
