/**
 * Domain profiles: fixed worst-case delay windows (ADR 0002, rule 2).
 *
 * A listing (the contract terms of its orders) declares the domain profile of
 * its counterparties when it is published. The profile adds a fixed delay
 * `delayHeights` to every window in which a counterparty message has to cross
 * the link (reservation TTL, cancellation grace, delivery dispute window,
 * dispute resolution window, IoT telemetry age). The profile is immutable
 * after publication and the delay is not configurable: it is computed ex ante
 * from published ephemerides, never from a live source.
 *
 *   delayHeights = ceil(MARGIN * 2 * oneWayLightTimeMax / REFERENCE_BLOCK_TIME)
 *
 * with MARGIN = 5/4 (25 %) over one round trip (request out, report back).
 *
 * Reference one-way light times:
 *  - EARTH: 0 (same domain; the base windows are the previous wall-clock
 *    defaults converted to heights).
 *  - MOON: 1.357 s, Earth–Moon distance at apogee (~406,700 km) / c.
 *  - MARS: 1,203.6 s (20.06 min), maximum Earth→Mars one-way light time
 *    between 2026-10-03 and 2028-12-03, computed offline from the public JPL
 *    DE442s planetary ephemeris kernel (minimum 338.3 s on 2027-02-20).
 *
 * Not covered: solar conjunction outages (about 46 days with a Sun–Earth–Mars
 * angle below 5 degrees around March 2028) and contact-plan gaps. Rules for
 * locks that cross a conjunction are an open decision; MARS windows cover
 * light time only.
 */
import { REFERENCE_BLOCK_TIME_MS } from "./height.ts";

export type DomainProfileId = "EARTH" | "MOON" | "MARS";

export type DomainProfile = {
  id: DomainProfileId;
  /** Worst-case one-way light time used for the window, in ms. */
  oneWayLightTimeMaxMs: number;
  /** Delay added to every counterparty window, in heights. */
  delayHeights: number;
  /** Where the light-time figure comes from. */
  reference: string;
};

/** Safety margin over one round trip, as a fraction (5/4 = 25 %). */
export const DELAY_MARGIN_NUMERATOR = 5;
export const DELAY_MARGIN_DENOMINATOR = 4;

/** ceil(5/4 * 2 * lightTimeMs / blockTimeMs), in integer arithmetic. */
export function delayHeightsFor(oneWayLightTimeMaxMs: number, blockTimeMs = REFERENCE_BLOCK_TIME_MS): number {
  if (!Number.isSafeInteger(oneWayLightTimeMaxMs) || oneWayLightTimeMaxMs < 0 || !Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) throw new Error("DOMAIN_DELAY_INVALID");
  const num = DELAY_MARGIN_NUMERATOR * 2 * oneWayLightTimeMaxMs;
  const den = DELAY_MARGIN_DENOMINATOR * blockTimeMs;
  return Math.ceil(num / den);
}

function profile(id: DomainProfileId, oneWayLightTimeMaxMs: number, reference: string): DomainProfile {
  return Object.freeze({ id, oneWayLightTimeMaxMs, delayHeights: delayHeightsFor(oneWayLightTimeMaxMs), reference });
}

/** Fixed profiles. EARTH 0, MOON 1 and MARS 602 delay heights at 5 s blocks. */
export const DOMAIN_PROFILES: Readonly<Record<DomainProfileId, DomainProfile>> = Object.freeze({
  EARTH: profile("EARTH", 0, "same domain"),
  MOON: profile("MOON", 1_357, "Earth-Moon distance at apogee (~406,700 km) / c"),
  MARS: profile("MARS", 1_203_600, "max Earth->Mars one-way light time 2026-10-03..2028-12-03, JPL DE442s (offline)"),
});

export const DEFAULT_DOMAIN_PROFILE: DomainProfileId = "EARTH";

export function isDomainProfileId(value: unknown): value is DomainProfileId {
  return value === "EARTH" || value === "MOON" || value === "MARS";
}

export function domainProfile(id: DomainProfileId | undefined): DomainProfile {
  const key = id ?? DEFAULT_DOMAIN_PROFILE;
  if (!isDomainProfileId(key)) throw new Error("DOMAIN_PROFILE_INVALID");
  return DOMAIN_PROFILES[key];
}
