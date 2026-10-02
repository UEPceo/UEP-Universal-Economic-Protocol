/**
 * Poseidon over the BN254 scalar field, width 3 (two inputs), alpha = 5.
 *
 * Same permutation and parameters as `uep-core/uep-21-poseidon` (arkworks-native-gadgets
 * 1.2 with the circomlib-compatible BN254 x5_3 constants) and the UEP-26 spend circuit:
 * state = [0, a, b]; per round add the round constants, apply x^5 (all lanes in the
 * 4 + 4 full rounds, lane 0 in the 57 partial rounds), multiply by the MDS matrix;
 * output state[0].
 *
 * Not Poseidon2. Checked against the uep-21 vectors in `src/core/poseidon.test.ts`.
 */
import { BN254_FR_MODULUS } from "./field.ts";
import {
  POSEIDON_FULL_ROUNDS,
  POSEIDON_MDS,
  POSEIDON_PARTIAL_ROUNDS,
  POSEIDON_ROUND_CONSTANTS,
  POSEIDON_WIDTH,
} from "./poseidon-bn254-params.ts";

const P = BN254_FR_MODULUS;
const RC: bigint[] = POSEIDON_ROUND_CONSTANTS.map((x) => BigInt(x));
const M: bigint[][] = POSEIDON_MDS.map((row) => row.map((x) => BigInt(x)));
const [M00, M01, M02] = M[0]!;
const [M10, M11, M12] = M[1]!;
const [M20, M21, M22] = M[2]!;
const HALF = POSEIDON_FULL_ROUNDS / 2;
const ROUNDS = POSEIDON_FULL_ROUNDS + POSEIDON_PARTIAL_ROUNDS;

if (RC.length !== ROUNDS * POSEIDON_WIDTH) throw new Error("POSEIDON_PARAMS_INVALID");

function pow5(x: bigint): bigint {
  const x2 = (x * x) % P;
  const x4 = (x2 * x2) % P;
  return (x4 * x) % P;
}

/** Poseidon permutation output state[0] for inputs (a, b); a and b must be canonical (< p). */
export function poseidon2(a: bigint, b: bigint): bigint {
  if (a < 0n || a >= P || b < 0n || b >= P) throw new Error("POSEIDON_INPUT_NOT_CANONICAL");
  // Lazy reduction: values may exceed p between steps; every S-box and MDS output is reduced.
  let s0 = 0n;
  let s1 = a;
  let s2 = b;
  for (let r = 0; r < ROUNDS; r++) {
    const k = r * 3;
    s0 = pow5(s0 + RC[k]!);
    if (r < HALF || r >= HALF + POSEIDON_PARTIAL_ROUNDS) {
      s1 = pow5(s1 + RC[k + 1]!);
      s2 = pow5(s2 + RC[k + 2]!);
    } else {
      s1 += RC[k + 1]!;
      s2 += RC[k + 2]!;
    }
    const t0 = (M00 * s0 + M01 * s1 + M02 * s2) % P;
    const t1 = (M10 * s0 + M11 * s1 + M12 * s2) % P;
    const t2 = (M20 * s0 + M21 * s1 + M22 * s2) % P;
    s0 = t0;
    s1 = t1;
    s2 = t2;
  }
  return s0;
}

/**
 * Bounded memo of domain hashes. Poseidon is a pure function, so caching changes
 * only speed: Merkle paths, snapshot restores and replays recompute the same nodes.
 */
const MEMO_MAX = 1 << 18;
const memo = new Map<string, bigint>();

/** UEP-26 domain composition: H(d, a, b) = Poseidon(Poseidon(d, a), b). */
export function poseidonDomainHash(domain: number, a: bigint, b: bigint): bigint {
  const key = domain + ":" + a.toString(36) + ":" + b.toString(36);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const out = poseidon2(poseidon2(BigInt(domain), a), b);
  if (memo.size >= MEMO_MAX) {
    // Drop the oldest quarter (Map keeps insertion order).
    let n = MEMO_MAX >> 2;
    for (const k of memo.keys()) {
      memo.delete(k);
      if (--n === 0) break;
    }
  }
  memo.set(key, out);
  return out;
}
