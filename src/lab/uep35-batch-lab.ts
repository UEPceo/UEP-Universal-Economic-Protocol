/**
 * UEP-35.4 — Batch intake + parallel structural execution lab.
 *
 * Goal: measure and structure multi-TX waves without changing Poseidon/ZK params.
 * LAB only: structural apply via ExecutionEngine; optional later ZK batch aggregation.
 */

import { Fr } from "../core/field.ts";
import {
  ExecutionEngine,
  type EngineConfig,
  type SpendIntent,
  type CommitResult,
} from "./execution-engine.ts";

export type BatchTx = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  /** Optional holder authorization (UEP Phase A / S2-3). */
  auth?: {
    publicKeyHex: string;
    nonce: string;
    signature: string;
  };
  /** ECON-04 protocol kind (default transfer). */
  kind?: "transfer" | "hold_open" | "hold_release" | "hold_consume";
  holdId?: string;
  obligationId?: string;
  providerId?: string;
  price?: bigint;
  /** bind tx to a network/domain when profile requires it. */
  networkId?: string;
  domainId?: number;
};

export type BatchResult = {
  batchId: string;
  accepted: number;
  rejected: number;
  commits: CommitResult[];
  wallMs: number;
  totalTransferred: bigint;
};

/**
 * Submit a batch of intents: enqueue all, then run structural waves.
 */
export async function runStructuralBatch(
  engine: ExecutionEngine,
  batchId: string,
  txs: BatchTx[],
): Promise<BatchResult> {
  const t0 = performance.now();
  let accepted = 0;
  let rejected = 0;
  for (const tx of txs) {
    const intent: SpendIntent = {
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
    };
    const r = engine.enqueue(intent);
    if (r.ok) accepted++;
    else rejected++;
  }
  const { commits } = await engine.runScheduled();
  let totalTransferred = 0n;
  for (const c of commits) {
    if (c.ok) {
      const tx = txs.find((t) => t.id === c.intentId);
      if (tx) totalTransferred += tx.amount;
    }
  }
  return {
    batchId,
    accepted,
    rejected,
    commits,
    wallMs: performance.now() - t0,
    totalTransferred,
  };
}

export function seedLabEngine(
  labels: Array<{ label: string; balance: bigint; id?: bigint }>,
  config?: Partial<EngineConfig>,
): ExecutionEngine {
  const engine = new ExecutionEngine({
    depth: 4,
    profile: "local",
    requireProof: false,
    proveConcurrency: 4,
    oneInFlightPerSender: false,
    ...config,
  });
  let i = 0;
  for (const a of labels) {
    i++;
    engine.registerAccount(a.label, {
      id: Fr.from(a.id ?? BigInt(1000 + i)),
      secret: Fr.from(BigInt(2000 + i)),
      salt: Fr.from(BigInt(3000 + i)),
      blinding: Fr.from(BigInt(4000 + i)),
      balance: a.balance,
    });
  }
  return engine;
}

/**
 * Conflict-aware micro-batching: partition by sender so parallel waves stay safe.
 */
export function partitionBySender(txs: BatchTx[]): BatchTx[][] {
  const waves: BatchTx[][] = [];
  const used = new Set<string>();
  let remaining = [...txs];
  while (remaining.length) {
    const wave: BatchTx[] = [];
    const senders = new Set<string>();
    const next: BatchTx[] = [];
    for (const tx of remaining) {
      if (senders.has(tx.from)) next.push(tx);
      else {
        senders.add(tx.from);
        wave.push(tx);
      }
    }
    waves.push(wave);
    remaining = next;
  }
  return waves;
}
