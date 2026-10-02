/**
 * UEP-009 deterministic asynchronous reconciliation.
 *
 * Conflict key: nullifier (primary). Two spends of the same note conflict.
 * Experimental winner rule: min(TxID) lexicographic on the field element.
 *
 * ADVERSARIAL NOTE: min(TxID) is grindable if the sender can influence TxID
 * (e.g. by iterating blinding / nonce). This rule is inherited from Testnet-0
 * and is NOT considered final. A production rule should bind TxID to a
 * verifiable random beacon or use a commit-reveal / fee-priority that does
 * not reward grinding.
 *
 * Properties demonstrated by tests:
 *   - order independence
 *   - idempotence
 *   - no double spend (at most one SETTLED per nullifier)
 *   - invalidated fees are not treasury income
 *
 * Status: IMPLEMENTED / TESTED (native). Distributed deployment: CONCEPTUAL.
 */
import { Fr } from "./field.ts";
import { Domain, hFold } from "./hash.ts";
import type { TxPhase, UepTransaction } from "./transaction.ts";

export type Settlement = {
  txId: Fr;
  status: "SETTLED" | "INVALIDATED";
  fee: bigint;
  nullifier: Fr;
};

export function compareTxId(a: Fr, b: Fr): number {
  if (a.n === b.n) return 0;
  return a.n < b.n ? -1 : 1;
}

/**
 * Reconcile a batch. Arrival order is ignored. Duplicates (same txId) collapse.
 * Winner per nullifier = min(txId). Settled fee is credited; losers pay 0.
 */
export function reconcile(txs: UepTransaction[]): Settlement[] {
  const unique = new Map<string, UepTransaction>();
  for (const tx of txs) unique.set(tx.txId.toHex(), tx);

  const groups = new Map<string, UepTransaction[]>();
  for (const tx of unique.values()) {
    const key = tx.nullifier.toHex();
    const g = groups.get(key);
    if (g) g.push(tx);
    else groups.set(key, [tx]);
  }

  const out: Settlement[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => compareTxId(a.txId, b.txId));
    const winner = group[0]!;
    for (const tx of group) {
      const isWinner = tx.txId.eq(winner.txId);
      out.push({
        txId: tx.txId,
        status: isWinner ? "SETTLED" : "INVALIDATED",
        fee: isWinner ? tx.fee : 0n,
        nullifier: tx.nullifier,
      });
    }
  }
  out.sort((a, b) => compareTxId(a.txId, b.txId));
  return out;
}

export function applySettlements(txs: UepTransaction[], settlements: Settlement[]): UepTransaction[] {
  const map = new Map(settlements.map((s) => [s.txId.toHex(), s]));
  return txs.map((tx) => {
    const s = map.get(tx.txId.toHex());
    if (!s) return tx;
    const phase: TxPhase = s.status === "SETTLED" ? "SETTLED" : "INVALIDATED";
    return { ...tx, phase, inConflict: false };
  });
}

export function markConflicts(txs: UepTransaction[]): UepTransaction[] {
  const counts = new Map<string, number>();
  for (const tx of txs) {
    const k = tx.nullifier.toHex();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return txs.map((tx) => ({
    ...tx,
    inConflict:
      (counts.get(tx.nullifier.toHex()) ?? 0) > 1 &&
      tx.phase !== "SETTLED" &&
      tx.phase !== "INVALIDATED",
  }));
}

/** Deterministic digest of a settlement set using the protocol hash, not SHA-256. */
export function settlementRoot(settlements: Settlement[]): Fr {
  if (settlements.length === 0) return hFold(Domain.Transaction, [Fr.zero()]);
  const parts: Fr[] = [];
  for (const s of settlements) {
    parts.push(s.txId);
    parts.push(new Fr(s.status === "SETTLED" ? 1 : 0));
    parts.push(new Fr(s.fee));
  }
  return hFold(Domain.Transaction, parts);
}
