/**
 * UEP-35.3 — Classic BFT configuration gate.
 *
 * BFT profile requires N = 3f+1. Non-classic N is rejected (not silently
 * downgraded to majority).
 */

import { bftParamsFromN, type BftParams } from "./uep34-bft-params.ts";

export type BftProfile = "LAB-MAJORITY" | "BFT-CLASSIC";

export type BftGateResult =
  | { ok: true; params: BftParams; profile: BftProfile }
  | { ok: false; reason: string; params: BftParams };

/**
 * Validate candidate count for a profile.
 * - LAB-MAJORITY: any n≥1; uses majorityThreshold semantics.
 * - BFT-CLASSIC: requires classic n=3f+1 and n≥4 (f≥1) for meaningful BFT.
 */
export function assertBftConfig(
  n: number,
  profile: BftProfile,
): BftGateResult {
  if (n < 1) {
    return {
      ok: false,
      reason: "N_TOO_SMALL",
      params: { n, f: 0, quorum: 0, classic: false },
    };
  }
  const params = bftParamsFromN(n);
  if (profile === "LAB-MAJORITY") {
    return { ok: true, params, profile };
  }
  // BFT-CLASSIC
  if (!params.classic) {
    return {
      ok: false,
      reason: `NON_CLASSIC_N:${n}_NOT_3F_PLUS_1`,
      params,
    };
  }
  if (params.f < 1) {
    return {
      ok: false,
      reason: "F_ZERO_NOT_ALLOWED_ON_BFT_PROFILE",
      params,
    };
  }
  if (params.quorum !== 2 * params.f + 1) {
    return { ok: false, reason: "QUORUM_MISMATCH", params };
  }
  return { ok: true, params, profile };
}

/** Convenience: throw if invalid. */
export function requireClassicBft(n: number): BftParams {
  const r = assertBftConfig(n, "BFT-CLASSIC");
  if (!r.ok) throw new Error(r.reason);
  return r.params;
}

export function classicQuorum(n: number): number {
  return requireClassicBft(n).quorum;
}
