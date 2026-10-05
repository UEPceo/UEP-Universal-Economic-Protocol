/**
 * Deprecation warnings for compatibility shims (docs/COMPATIBILITY.md).
 *
 * Each deprecated input is accepted and converted deterministically, and a
 * Node.js `DeprecationWarning` with a stable code is emitted once per process
 * and code. `node --no-deprecation` silences them; `--throw-deprecation`
 * turns them into errors (useful to find remaining legacy callers).
 * Emitting a warning has no effect on state.
 */
const emitted = new Set<string>();

/** Stable codes of the v0.5.1 compatibility shims. */
export const DEPRECATIONS = Object.freeze({
  ASSET_ALIAS: "UEP_DEP_ASSET_ALIAS",
  MS_OPTION: "UEP_DEP_MS_OPTION",
  NOW_OPTION: "UEP_DEP_NOW_OPTION",
  IOT_NOW_IGNORED: "UEP_DEP_IOT_NOW",
  SPEND_NOW_MS: "UEP_DEP_SPEND_NOW_MS",
  POLICY_WINDOW_MS: "UEP_DEP_POLICY_WINDOW_MS",
  ISSUED_AT_MS: "UEP_DEP_ISSUED_AT_MS",
  SNAPSHOT_MIGRATED: "UEP_DEP_SNAPSHOT_FORMAT",
} as const);

export type DeprecationCode = (typeof DEPRECATIONS)[keyof typeof DEPRECATIONS];

export function deprecate(code: DeprecationCode, message: string): void {
  if (emitted.has(code)) return;
  emitted.add(code);
  const p = (globalThis as { process?: { emitWarning?: (m: string, o: { type: string; code: string }) => void } }).process;
  p?.emitWarning?.(message, { type: "DeprecationWarning", code });
}

/** Codes emitted so far in this process (for tests). */
export function emittedDeprecations(): string[] {
  return [...emitted].sort();
}

/**
 * Values at or above this bound are taken as legacy Unix-millisecond
 * timestamps, below it as block heights. 10^11 ms is March 1973; 10^11
 * heights at 5 s blocks are about 15,800 years.
 */
export const LEGACY_MS_THRESHOLD = 100_000_000_000;

export function looksLikeLegacyMs(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= LEGACY_MS_THRESHOLD;
}
