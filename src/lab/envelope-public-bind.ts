/**
 * UEP-33.3 — Strict envelope ↔ Groth16 public-input binding.
 *
 * In ZK mode, state/nullifier roots MUST be canonical BN254 Fr hex (64 chars,
 * value < Fr modulus) and match PI[0..3] exactly. Non-field labels like
 * "GENESIS" are rejected when requireCanonicalRoots is true (ZK path).
 */

import { BN254_FR_MODULUS } from "../core/field.ts";
import type { NodeEnvelope } from "./node-protocol.ts";

export function normHex(h: string): string {
  return h.replace(/^0x/i, "").toLowerCase();
}

/** True iff s is exactly 64 lowercase hex digits encoding an element of Fr. */
export function isCanonicalFrHex(s: string | undefined | null): boolean {
  if (s === undefined || s === null) return false;
  const n = normHex(s);
  if (!/^[0-9a-f]{64}$/.test(n)) return false;
  try {
    const v = BigInt("0x" + n);
    return v < BN254_FR_MODULUS;
  } catch {
    return false;
  }
}

export function assertCanonicalFrHex(
  label: string,
  s: string | undefined | null,
): { ok: true; hex: string } | { ok: false; error: string } {
  if (!isCanonicalFrHex(s)) {
    return { ok: false, error: `MALFORMED_FIELD:${label}` };
  }
  return { ok: true, hex: normHex(s!) };
}

/**
 * Full binding for ZK acceptance.
 * Requires canonical Fr for roots + nullifier + tx commitment when present.
 */
export function assertEnvelopeMatchesPublicInputs(
  env: NodeEnvelope,
  opts?: { requireCanonicalRoots?: boolean },
): { ok: true } | { ok: false; error: string } {
  const requireCanon = opts?.requireCanonicalRoots !== false;
  const pi = env.publicInputsHex;
  if (!pi || pi.length !== 13) {
    return { ok: false, error: "ZK_PUBLIC_INPUTS_LEN" };
  }

  // All 12 public inputs must themselves be canonical Fr
  for (let i = 0; i < 13; i++) {
    if (!isCanonicalFrHex(pi[i])) {
      return { ok: false, error: `MALFORMED_FIELD:pi${i}` };
    }
  }

  if (requireCanon) {
    const checks: [string, string | undefined][] = [
      ["previousStateRoot", env.previousStateRoot],
      ["newStateRoot", env.newStateRoot],
      ["previousNullifierRoot", env.previousNullifierRoot],
      ["newNullifierRoot", env.newNullifierRoot],
    ];
    for (const [label, val] of checks) {
      const c = assertCanonicalFrHex(label, val);
      if (!c.ok) return c;
    }
    if (!isCanonicalFrHex(env.nullifier)) {
      return { ok: false, error: "MALFORMED_FIELD:nullifier" };
    }
    if (env.transactionCommitment !== undefined && env.transactionCommitment !== "") {
      if (!isCanonicalFrHex(env.transactionCommitment)) {
        return { ok: false, error: "MALFORMED_FIELD:transactionCommitment" };
      }
    }
  }

  const eq = (a: string | undefined, b: string | undefined, err: string) => {
    if (a === undefined || b === undefined) return { ok: false as const, error: err };
    if (normHex(a) !== normHex(b)) return { ok: false as const, error: err };
    return { ok: true as const };
  };

  let r = eq(env.previousStateRoot, pi[0], "ZK_PUBLIC_ROOT_MISMATCH_OLD");
  if (!r.ok) return r;
  r = eq(env.newStateRoot, pi[1], "ZK_PUBLIC_ROOT_MISMATCH_NEW");
  if (!r.ok) return r;
  r = eq(env.previousNullifierRoot, pi[2], "ZK_PUBLIC_NF_ROOT_MISMATCH_OLD");
  if (!r.ok) return r;
  r = eq(env.newNullifierRoot, pi[3], "ZK_PUBLIC_NF_ROOT_MISMATCH_NEW");
  if (!r.ok) return r;
  r = eq(env.nullifier, pi[10], "ZK_PUBLIC_NULLIFIER_MISMATCH");
  if (!r.ok) return r;
  if (env.transactionCommitment) {
    r = eq(env.transactionCommitment, pi[11], "ZK_PUBLIC_TX_COMMIT_MISMATCH");
    if (!r.ok) return r;
  }
  // the signed envelope domain must be the domain_id the proof was made for (PI[12]).
  if (!Number.isSafeInteger(env.domainId) || env.domainId < 0 || BigInt("0x" + normHex(pi[12]!)) !== BigInt(env.domainId)) {
    return { ok: false, error: "ZK_PUBLIC_DOMAIN_MISMATCH" };
  }

  return { ok: true };
}
