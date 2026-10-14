/**
 * Marketplace load sizes. 20_000 stays the CI default.
 * 50k, 100k and 500k are opt-in (UEP_SCALE or --users).
 * Fee, asset and protocol parameters are not scaled.
 */
export const SCALE_SIZES = [20_000, 50_000, 100_000, 500_000] as const;
export type ScaleSize = (typeof SCALE_SIZES)[number];

export const DEFAULT_SCALE: ScaleSize = 20_000;

const ALLOWED = new Set<number>(SCALE_SIZES);

export function parseScaleUsers(raw: string | undefined, fallback: ScaleSize = DEFAULT_SCALE): ScaleSize {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!ALLOWED.has(n)) {
    throw new Error(`SCALE_SIZE_INVALID: ${raw} is not one of ${SCALE_SIZES.join(", ")}`);
  }
  return n as ScaleSize;
}

/**
 * Sizes for the scanned node test. Default is 20k.
 * This module must not read the environment: the determinism lint scans src/marketplace.
 * 50k, 100k and 500k are selected by scripts/marketplace-20k-simulation.mjs (--users).
 */
export function selectedScaleSizes(raw?: string): ScaleSize[] {
  if (raw === undefined || raw === "" || raw === "20k") return [20_000];
  if (raw === "all") return [...SCALE_SIZES];
  return [parseScaleUsers(raw.replace(/k$/i, (m) => (m ? "000" : "")))];
}

export function listingPlan(users: number) {
  const providers = 200;
  const perProvider = 5;
  const listings = providers * perProvider;
  // Round-robin uses each listing users/listings times. Capacity 100 covers 20k–100k;
  // larger runs raise it so a listing is not exhausted before the run ends.
  const capacity = BigInt(Math.max(100, Math.ceil(users / listings)));
  return { providers, perProvider, listings, capacity };
}
