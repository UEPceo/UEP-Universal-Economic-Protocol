/**
 * Test-only options (`testOnly*`): escape hatches for tests and offline
 * simulations (a local height counter, the millisecond test clock, a zero
 * reservation deposit, no spend proof, unbounded height advance).
 *
 * v0.5.1 rules:
 *  - Under NODE_ENV=production every `testOnly*` option (and the deprecated
 *    `now` alias of `testOnlyNowMs`) is rejected: TEST_ONLY_OPTION_IN_PRODUCTION.
 *  - Boolean flags must be the boolean `true` (or `false` / absent).
 *  - Options that come from outside the process (JSON-parsed configuration,
 *    request bodies, environment files) go through assertNoTestOnlyOptions()
 *    or parseUntrustedOptions(), which reject any such key at any depth. An
 *    in-process object literal and a JSON-parsed object look the same at run
 *    time, so this check belongs at the boundary that parsed the input.
 *
 * Configuration-time only: called from constructors and factories, never
 * from a state transition.
 */

/** True when NODE_ENV is "production" (read once per call; configuration time only). */
export function isProductionEnvironment(): boolean {
  return typeof process !== "undefined" && process.env.NODE_ENV === "production";
}

/**
 * Validate one test-only option. Returns true when it is set. Throws
 * TEST_ONLY_OPTION_INVALID for a wrong type and TEST_ONLY_OPTION_IN_PRODUCTION
 * under NODE_ENV=production.
 */
export function testOnlyOption(name: string, value: unknown, kind: "boolean" | "function" | "number" = "boolean"): boolean {
  if (value === undefined || value === false) return false;
  const ok = kind === "boolean" ? value === true : kind === "function" ? typeof value === "function" : typeof value === "number";
  if (!ok) throw new Error(`TEST_ONLY_OPTION_INVALID: ${name} must be a ${kind}`);
  if (isProductionEnvironment()) throw new Error(`TEST_ONLY_OPTION_IN_PRODUCTION: ${name} is a test-only option and is rejected under NODE_ENV=production`);
  return true;
}

const TEST_ONLY_KEY = /^(?:testOnly[A-Z0-9_]|now$)/;

/**
 * Reject test-only keys in options that came from outside the process. Walks
 * plain objects and arrays (depth-limited); throws TEST_ONLY_OPTION_UNTRUSTED
 * with the key path.
 */
export function assertNoTestOnlyOptions(options: unknown, origin = "untrusted options"): void {
  const walk = (v: unknown, path: string, depth: number): void => {
    if (v === null || typeof v !== "object") return;
    if (depth > 32) throw new Error(`TEST_ONLY_OPTION_UNTRUSTED: ${origin} nest too deeply`);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    for (const key of Object.keys(v)) {
      if (TEST_ONLY_KEY.test(key)) throw new Error(`TEST_ONLY_OPTION_UNTRUSTED: ${origin} may not set ${path ? `${path}.` : ""}${key}`);
      walk((v as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(options, "", 0);
}

/** JSON.parse configuration text and reject any test-only key in it. */
export function parseUntrustedOptions<T = unknown>(json: string, origin = "JSON options"): T {
  const parsed = JSON.parse(json) as T;
  assertNoTestOnlyOptions(parsed, origin);
  return parsed;
}
