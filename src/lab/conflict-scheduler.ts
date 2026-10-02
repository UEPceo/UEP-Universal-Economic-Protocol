/**
 * UEP-30.2 — Conflict / dependency scheduler for parallel prove waves.
 *
 * Two spends conflict if they share a sender OR (optionally) the same recipient
 * when we require exclusive note locks. Default: conflict on sender only
 * (recipient can receive from many in parallel at prove-time; commit stays serial).
 *
 * Waves: maximal sets of non-conflicting intents that may prove in parallel
 * against the same committed root snapshot.
 */

import type { SpendIntent } from "./execution-engine.ts";

export type PendingJob = {
  intent: SpendIntent;
  fee: bigint;
  seq: number;
};

export type ConflictMode = {
  /** Same sender → conflict (always true for ZK leaf correctness). */
  lockSender: boolean;
  /** Same recipient → conflict (stricter; default false). */
  lockRecipient: boolean;
  /** Same pair of accounts either direction → conflict. */
  lockUndirectedPair: boolean;
};

export const DEFAULT_CONFLICT_MODE: ConflictMode = {
  lockSender: true,
  lockRecipient: false,
  lockUndirectedPair: false,
};

export function jobsConflict(a: PendingJob, b: PendingJob, mode: ConflictMode): boolean {
  if (a.seq === b.seq) return false;
  if (mode.lockSender && a.intent.from === b.intent.from) return true;
  if (mode.lockRecipient && a.intent.to === b.intent.to) return true;
  if (mode.lockUndirectedPair) {
    const a1 = a.intent.from;
    const a2 = a.intent.to;
    const b1 = b.intent.from;
    const b2 = b.intent.to;
    if ((a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1)) return true;
  }
  return false;
}

/**
 * Partition jobs into waves preserving global intake order fairness:
 * greedy — scan by seq ascending, add to current wave if no conflict with members.
 * When blocked, start a new wave.
 */
export function partitionIntoWaves(
  jobs: PendingJob[],
  mode: ConflictMode = DEFAULT_CONFLICT_MODE,
): PendingJob[][] {
  const sorted = [...jobs].sort((x, y) => x.seq - y.seq);
  const waves: PendingJob[][] = [];
  let remaining = sorted;
  while (remaining.length) {
    const wave: PendingJob[] = [];
    const next: PendingJob[] = [];
    for (const j of remaining) {
      const clashes = wave.some((w) => jobsConflict(w, j, mode));
      if (!clashes) wave.push(j);
      else next.push(j);
    }
    if (wave.length === 0) {
      // safety: force progress
      wave.push(remaining[0]!);
      remaining = remaining.slice(1);
    } else {
      remaining = next;
    }
    waves.push(wave);
  }
  return waves;
}

export type ScheduleStats = {
  jobCount: number;
  waveCount: number;
  maxWaveSize: number;
  conflictPairs: number;
};

export function scheduleStats(jobs: PendingJob[], mode: ConflictMode = DEFAULT_CONFLICT_MODE): ScheduleStats {
  const waves = partitionIntoWaves(jobs, mode);
  let conflictPairs = 0;
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) {
      if (jobsConflict(jobs[i]!, jobs[j]!, mode)) conflictPairs++;
    }
  }
  return {
    jobCount: jobs.length,
    waveCount: waves.length,
    maxWaveSize: waves.reduce((m, w) => Math.max(m, w.length), 0),
    conflictPairs,
  };
}
