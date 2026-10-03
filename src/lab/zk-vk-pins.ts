/**
 * Pinned verifying keys for the lab spend circuit.
 *
 * Verifiers never take the verifying key from the proof or from the message
 * that carries it. The key is loaded from the development setup of the
 * circuit (`uep-zk dev-vk <depth>`) and accepted only if its SHA-256 matches
 * the pin for (circuit version, depth, domain) in
 * `uep-core/vectors/UEP-ZK-DEV-VK-PINS.json`.
 *
 * Config hook: `UEP_ZK_VK_PINS_FILE` points to another pin file (for example
 * the key set of a future ceremony). The keys here are DEV-TEST-KEYS.
 *
 * DEVELOPMENT KEYS ONLY. The pinned keys are not the output of a multi-party
 * trusted setup ceremony, so verification under them is not trustworthy: it
 * checks wiring, not soundness. Pinning guarantees which key is used, not that
 * the key is safe. Loading a DEV-TEST-KEYS pin file is refused when
 * `NODE_ENV=production` or `UEP_ZK_KEY_MODE=production`, and warns once
 * outside development/test runs. A non-development pin file that lists a
 * development key is refused (`VK_DEV_KEYS_MISLABELED`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runUepZk } from "./uep-zk-runner.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VK_PINS_FILE = join(__dirname, "../../uep-core/vectors/UEP-ZK-DEV-VK-PINS.json");

export type VkPin = { circuitTag: string; depth: number; domainId: string; vkSha256: string };
export type PinnedVk = { vkHex: string; vkSha256: string; circuitTag: string; depth: number };
export type PinnedVerifyResult = { ok: boolean; code?: "VK_NOT_PINNED" | "VK_PIN_MISMATCH" | "DOMAIN_MISMATCH" | "BAD_PUBLICS" | "INVALID_PROOF"; raw: string };

const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();

/** Label of the development pin file (`keys` field). */
export const DEV_VK_PINS_LABEL = "DEV-TEST-KEYS";

type PinDoc = { format?: string; keys?: string; pins?: VkPin[] };

function readPinDoc(file: string): PinDoc {
  const doc = JSON.parse(readFileSync(file, "utf8")) as PinDoc;
  if (doc.format !== "uep-zk-vk-pins" || !Array.isArray(doc.pins)) throw new Error("VK_PINS_INVALID: not a uep-zk-vk-pins file");
  return doc;
}

let devPinHashCache: Set<string> | undefined;
/** SHA-256 of every development key (from the bundled DEV-TEST-KEYS pin file). */
export function developmentVkHashes(): Set<string> {
  devPinHashCache ??= new Set(readPinDoc(DEFAULT_VK_PINS_FILE).pins!.map((p) => norm(p.vkSha256)));
  return devPinHashCache;
}

function keyMode(): string {
  return (process.env.UEP_ZK_KEY_MODE || process.env.NODE_ENV || "").toLowerCase();
}

let devWarned = false;
/**
 * Development keys are for development and tests only. Refused
 * in production mode; one process warning outside development/test runs.
 */
export function assertDevelopmentKeysAllowed(): void {
  const mode = keyMode();
  if (mode === "production" || mode === "prod") {
    throw new Error("VK_DEV_KEYS_REFUSED: the pinned verifying keys are development keys only and are refused in production mode; ZK verification is not trustworthy until a multi-party setup ceremony is held");
  }
  const devOrTest = ["development", "dev", "test"].includes(mode) || process.env.NODE_TEST_CONTEXT !== undefined;
  if (!devOrTest && !devWarned) {
    devWarned = true;
    process.emitWarning("UEP ZK verifying keys are DEVELOPMENT KEYS ONLY: proof verification under them is not trustworthy until a multi-party setup ceremony is held. Set UEP_ZK_KEY_MODE=dev or NODE_ENV=test to acknowledge.", { code: "UEP_ZK_DEV_KEYS" });
  }
}

export function loadVkPins(file: string = process.env.UEP_ZK_VK_PINS_FILE || DEFAULT_VK_PINS_FILE): VkPin[] {
  const doc = readPinDoc(file);
  const pins = doc.pins!.map((p) => ({ ...p, domainId: String(p.domainId), vkSha256: norm(p.vkSha256) }));
  if (doc.keys === DEV_VK_PINS_LABEL) {
    assertDevelopmentKeysAllowed();
  } else {
    const dev = developmentVkHashes();
    if (pins.some((p) => dev.has(p.vkSha256))) {
      throw new Error(`VK_DEV_KEYS_MISLABELED: pin file ${file} is not labelled ${DEV_VK_PINS_LABEL} but lists a development verifying key`);
    }
  }
  return pins;
}

const vkCache = new Map<number, PinnedVk>();

/** Verifying key of the development setup at `depth`, checked against its pin. Throws if unpinned. */
export function pinnedVk(depth: number, domainId: bigint = 1n): PinnedVk {
  const pins = loadVkPins();
  let vk = vkCache.get(depth);
  if (!vk) {
    const r = runUepZk(["dev-vk", String(depth)], { timeoutMs: 300_000 });
    const hex = r.stdout.match(/^vk_hex=([0-9a-f]+)/m)?.[1];
    const tag = r.stdout.match(/^tag=(\S+)/m)?.[1];
    if (!r.ok || !hex || !tag) throw new Error("VK_NOT_PINNED: cannot load the development verifying key: " + (r.stderr || r.stdout).slice(0, 200));
    vk = { vkHex: hex, vkSha256: createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex"), circuitTag: tag, depth };
    vkCache.set(depth, vk);
  }
  const pin = pins.find((p) => p.circuitTag === vk!.circuitTag && p.depth === depth && p.domainId === domainId.toString());
  if (!pin) throw new Error(`VK_NOT_PINNED: no pin for ${vk.circuitTag} depth=${depth} domain=${domainId}`);
  if (pin.vkSha256 !== vk.vkSha256) throw new Error(`VK_PIN_MISMATCH: verifying key hash ${vk.vkSha256} != pin ${pin.vkSha256}`);
  return vk;
}

/** SHA-256 (hex) of a serialized verifying key given as hex. */
export function vkSha256Hex(vkHex: string): string {
  return createHash("sha256").update(Buffer.from(norm(vkHex), "hex")).digest("hex");
}

/**
 * True iff `vkHex` hashes to a pin of the pin file for `domainId` (any depth).
 * Used to bind a node's configured domain to the keys it accepts (audit V50-11).
 */
export function isVkPinnedForDomain(vkHex: string, domainId: bigint | number): boolean {
  const sha = vkSha256Hex(vkHex);
  const dom = BigInt(domainId).toString();
  return loadVkPins().some((p) => p.vkSha256 === sha && p.domainId === dom);
}

/** Field element hex → bigint (accepts with or without 0x). */
function frHexToBigInt(h: string): bigint {
  return BigInt("0x" + (norm(h) || "0"));
}

/**
 * Verify a spend proof under the pinned verifying key for (depth, domain).
 * `carriedVkHex`, if a caller still has one from the artifact, is only compared:
 * a different key is rejected with VK_NOT_PINNED and is never used to verify.
 */
export function zkVerifyPinned(
  depth: number,
  domainId: bigint,
  proofHex: string,
  publicInputsHex: string[],
  carriedVkHex?: string | null,
): PinnedVerifyResult {
  if (publicInputsHex.length !== 13) return { ok: false, code: "BAD_PUBLICS", raw: "need exactly 13 public inputs" };
  let vk: PinnedVk;
  try {
    vk = pinnedVk(depth, domainId);
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, code: msg.startsWith("VK_PIN_MISMATCH") ? "VK_PIN_MISMATCH" : "VK_NOT_PINNED", raw: msg };
  }
  if (carriedVkHex && norm(carriedVkHex) !== vk.vkHex) {
    return { ok: false, code: "VK_NOT_PINNED", raw: "verifying key differs from the pinned key" };
  }
  if (frHexToBigInt(publicInputsHex[12]!) !== domainId) {
    return { ok: false, code: "DOMAIN_MISMATCH", raw: "domain_id public input differs from the verifier domain" };
  }
  const body =
    `vk_hex=${vk.vkHex}\nproof_hex=${norm(proofHex)}\n` +
    publicInputsHex.map((h, i) => `public_${i}=${h}`).join("\n") +
    "\n";
  const r = runUepZk(["verify-hex"], { stdin: body, timeoutMs: 120_000 });
  const raw = (r.stdout + r.stderr).trim();
  const ok = /^ok=true/m.test(r.stdout);
  return ok ? { ok: true, raw } : { ok: false, code: "INVALID_PROOF", raw };
}
