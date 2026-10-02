/**
 * UEP-34.4 — Formal lab BFT parameters (n = 3f+1, quorum = 2f+1).
 *
 * Still LAB: does not claim full async BFT safety under all partitions.
 */

export type BftParams = {
  n: number;
  f: number;
  quorum: number;
  /** n must equal 3f+1 for classic setting. */
  classic: boolean;
};

/**
 * Derive f and quorum from candidate count.
 * - If n = 3f+1 for some integer f ≥ 0 → classic BFT params.
 * - Else falls back to majority floor(n/2)+1 and marks classic=false.
 */
export function bftParamsFromN(n: number): BftParams {
  if (n < 1) throw new Error("N_TOO_SMALL");
  // Prefer classic: n = 3f+1
  if ((n - 1) % 3 === 0) {
    const f = (n - 1) / 3;
    return { n, f, quorum: 2 * f + 1, classic: true };
  }
  return {
    n,
    f: Math.floor((n - 1) / 3),
    quorum: Math.floor(n / 2) + 1,
    classic: false,
  };
}

export function majorityThreshold(n: number): number {
  return bftParamsFromN(n).quorum;
}
