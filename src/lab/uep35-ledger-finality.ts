/**
 * UEP-35.3.1 — Finality → real ExecutionEngine economic apply.
 *
 * FinalityCertificate must be accepted first; then balances move through
 * ExecutionEngine.commitFinalizedStructural (same rules as commitProved).
 */

import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import {
  ExecutionEngine,
  type EngineConfig,
  type AccountState,
} from "./execution-engine.ts";
import type { FinalityCertificate } from "./uep35-finality.ts";
import { FinalityLedger } from "./uep35-finality.ts";

export type FinalizedSpend = {
  sequence: number;
  from: string;
  to: string;
  amount: bigint;
  nullifier: string;
  transitionId: string;
  stateRoot: string;
  proposalDigest: string;
  newNullifierRoot?: string;
};

export class FinalityBoundLedger {
  readonly engine: ExecutionEngine;
  readonly finality = new FinalityLedger();
  appliedSequences = new Set<number>();

  constructor(
    initial: Record<string, bigint>,
    engineConfig?: Partial<EngineConfig>,
  ) {
    this.engine = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 1,
      ...engineConfig,
    });
    let i = 0;
    for (const [label, balance] of Object.entries(initial)) {
      i++;
      this.engine.registerAccount(label, {
        id: Fr.from(BigInt(10_000 + i)),
        secret: Fr.from(BigInt(20_000 + i)),
        salt: Fr.from(BigInt(30_000 + i)),
        blinding: Fr.from(BigInt(40_000 + i)),
        balance,
      });
    }
  }

  total(): bigint {
    let s = 0n;
    for (const label of this.engine.listAccountLabels()) {
      s += this.engine.getAccount(label).balance;
    }
    return s + this.engine.treasuryBalance;
  }

  balance(label: string): bigint {
    return this.engine.getAccount(label).balance;
  }

  /**
   * Accept finality then apply real engine balance transfer (amount + fee to treasury).
   */
  applyOnFinal(
    fc: FinalityCertificate,
    tx: FinalizedSpend,
    candidates: string[],
    publicKeyOf: (id: string) => string | undefined,
  ): { ok: true; fee: bigint } | { ok: false; reason: string } {
    if (tx.sequence !== fc.sequence || tx.stateRoot !== fc.stateRoot) {
      return { ok: false, reason: "TX_CERT_MISMATCH" };
    }
    if (tx.proposalDigest !== fc.proposalDigest) {
      return { ok: false, reason: "TX_DIGEST_MISMATCH" };
    }
    const fr = this.finality.acceptFinal(fc, candidates, publicKeyOf, {
      requireClassicBft: true,
    });
    if (!fr.ok) return { ok: false, reason: fr.reason };

    if (this.appliedSequences.has(tx.sequence)) {
      return { ok: true, fee: creatorFee(tx.amount) };
    }

    const fee = creatorFee(tx.amount);
    const cr = this.engine.commitFinalizedStructural({
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      fee,
      nullifier: tx.nullifier,
      transitionId: tx.transitionId,
      newStateRoot: tx.stateRoot,
      newNullifierRoot: tx.newNullifierRoot,
    });
    if (!cr.ok) {
      return { ok: false, reason: cr.error ?? "ENGINE_COMMIT_FAILED" };
    }
    this.appliedSequences.add(tx.sequence);
    return { ok: true, fee };
  }
}
