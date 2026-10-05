/**
 * Category replay and height guards (v0.5.2).
 * Keys come from Marketplace identities; KeyRegistry / PoP are not kept.
 * Time is Marketplace height (ADR 0002); modules never read a wall clock.
 */
import { canonicalJson } from "../core/canonical-json.ts";

/** One-shot nonce ledger. `check` then `consume` so a failed action does not burn the nonce. */
export class ReplayGuard {
  private seen = new Set<string>();

  private key(scope: string, signer: string, nonce: string | number | bigint): string {
    return canonicalJson([scope, signer, typeof nonce === "bigint" ? nonce.toString(10) : nonce]);
  }

  check(scope: string, signer: string, nonce: string | number | bigint): void {
    if (this.seen.has(this.key(scope, signer, nonce))) throw new Error("REPLAY");
  }

  consume(scope: string, signer: string, nonce: string | number | bigint): void {
    const k = this.key(scope, signer, nonce);
    if (this.seen.has(k)) throw new Error("REPLAY");
    this.seen.add(k);
  }
}

/**
 * Height monotonicity guard. Replaces the incoming MonotonicClock: the height
 * comes from the Marketplace TransitionClock via the category escrow port.
 */
export class HeightGuard {
  private last = Number.NEGATIVE_INFINITY;

  check(height: number): void {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("HEIGHT_INVALID");
    if (height < this.last) throw new Error("HEIGHT_REGRESSION");
    this.last = height;
  }
}
