/**
 * UEP-36.1.2 — Parallel-safe scheduling with true sequential equivalence.
 *
 * Path A (sequential): applyBatch(all txs in original order) → one height bump
 * Path B (scheduled): partition waves → applyTransfers each wave → one height bump
 *
 * Waves do NOT each increment consensus height.
 * NOT true concurrent execution.
 */

import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  partitionByConflictGraph,
  validateWaves,
} from "./uep35-conflict-graph.ts";
import type { LocalEconomicState } from "./uep35-local-state.ts";
import type { SmtEconomicState } from "./uep37-smt-economic-state.ts";

/** Any state with sequential/scheduled apply semantics (local SHA or SMT). */
export type SchedulableState = LocalEconomicState | SmtEconomicState;

/** Observable equality through LocalEconomicState.observableEquals (the method the lab has always called). */
const observableEqual = (a: SchedulableState, b: SchedulableState): boolean =>
  (a as LocalEconomicState).observableEquals(b as LocalEconomicState);

export type BatchBody = {
  batchId: string;
  txs: BatchTx[];
};

export type ParallelSafeScheduleResult = {
  waves: BatchTx[][];
  sequentialRoot: string;
  scheduledRoot: string;
  sequentialHeight: number;
  scheduledHeight: number;
  rootsMatch: boolean;
  fullStateEqual: boolean;
  waveCount: number;
  txCount: number;
};

/** @deprecated alias */
export function parallelWaveApply(
  initial: SchedulableState,
  txs: BatchTx[],
): ParallelSafeScheduleResult {
  return parallelSafeScheduleApply(initial, txs);
}

/**
 * Independent paths:
 * A) sequential original order, single logical height
 * B) conflict-free waves, single logical height after all waves
 */
export function parallelSafeScheduleApply(
  initial: SchedulableState,
  txs: BatchTx[],
): ParallelSafeScheduleResult {
  const waves = partitionByConflictGraph(txs);
  const v = validateWaves(txs, waves);
  if (!v.ok) throw new Error(v.reason);

  // A: sequential — original deterministic order
  const seq = initial.clone();
  const seqR = seq.applyBatch(txs);
  if (!seqR.ok) throw new Error(seqR.reason);
  const sequentialRoot = seqR.stateRoot;
  const sequentialHeight = seq.sequence;

  // B: scheduled waves — transfers only, then one commit
  const scheduled = initial.clone();
  for (const wave of waves) {
    if (wave.length === 0) continue;
    const r = scheduled.applyTransfers(wave);
    if (!r.ok) throw new Error(r.reason);
  }
  const scheduledRoot = scheduled.commitLogicalHeight();
  const scheduledHeight = scheduled.sequence;

  return {
    waves,
    sequentialRoot,
    scheduledRoot,
    sequentialHeight,
    scheduledHeight,
    rootsMatch: sequentialRoot === scheduledRoot,
    fullStateEqual: observableEqual(seq, scheduled),
    waveCount: waves.length,
    txCount: txs.length,
  };
}

export function fullStateRootsEqual(
  a: SchedulableState,
  b: SchedulableState,
): boolean {
  return observableEqual(a, b);
}

export function executeOrderedBatches(
  initial: SchedulableState,
  batches: BatchBody[],
): ParallelSafeScheduleResult {
  const txs: BatchTx[] = [];
  for (const b of batches) txs.push(...b.txs);
  return parallelSafeScheduleApply(initial, txs);
}

/**
 * Same TX set, different valid partitions → same root and height.
 * Uses greedy partition vs partition of reversed order (still valid coverage).
 */
export function sameTxsDifferentValidSchedules(
  initial: SchedulableState,
  txs: BatchTx[],
): { rootA: string; rootB: string; heightA: number; heightB: number; equal: boolean } {
  const wavesA = partitionByConflictGraph(txs);
  const wavesB = partitionByConflictGraph([...txs].reverse());
  const va = validateWaves(txs, wavesA);
  const vb = validateWaves(txs, wavesB);
  if (!va.ok) throw new Error(va.reason);
  if (!vb.ok) throw new Error(vb.reason);

  const a = initial.clone();
  for (const w of wavesA) {
    if (w.length) {
      const r = a.applyTransfers(w);
      if (!r.ok) throw new Error(r.reason);
    }
  }
  const rootA = a.commitLogicalHeight();

  const b = initial.clone();
  for (const w of wavesB) {
    if (w.length) {
      const r = b.applyTransfers(w);
      if (!r.ok) throw new Error(r.reason);
    }
  }
  const rootB = b.commitLogicalHeight();

  return {
    rootA,
    rootB,
    heightA: a.sequence,
    heightB: b.sequence,
    equal: observableEqual(a, b),
  };
}
