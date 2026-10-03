/**
 * Preload (node --import) that runs a whole test suite with the poisoned clock
 * of scripts/poisoned-clock.mjs: `npm run test:poisoned-clock`. The process
 * fails if any transition touched a clock, a timer, the network or randomness,
 * even when the transition caught the error.
 */
import { installPoisonedClock, defaultTransitionClasses } from "./poisoned-clock.mjs";

const src = new URL("../src", import.meta.url).href;
const { violations } = installPoisonedClock(await defaultTransitionClasses(src));
process.on("exit", () => {
  if (violations.length === 0) return;
  const unique = [...new Set(violations)];
  console.error(`poisoned-clock: ${violations.length} violation(s) in transitions:\n  ${unique.join("\n  ")}`);
  process.exitCode = 1;
});
