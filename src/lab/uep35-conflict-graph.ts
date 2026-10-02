/**
 * UEP-35.5 / 35.6 / 35.6.1 — ConflictGraph
 *
 * Indexed wave partition via occupied key sets.
 * countConflictEdgesIndexed: real undirected conflict pairs via key indexes.
 */

import type { BatchTx } from "./uep35-batch-lab.ts";

export type StateAccessSet = {
  txId: string;
  reads: string[];
  writes: string[];
};

export function accessSetFromTx(tx: BatchTx): StateAccessSet {
  return {
    txId: tx.id,
    reads: [tx.from, tx.to],
    writes: [tx.from, tx.to],
  };
}

export function accessesConflict(a: StateAccessSet, b: StateAccessSet): boolean {
  const aw = new Set(a.writes);
  const ar = new Set(a.reads);
  const bw = new Set(b.writes);
  const br = new Set(b.reads);
  for (const w of aw) {
    if (bw.has(w) || br.has(w)) return true;
  }
  for (const w of bw) {
    if (ar.has(w)) return true;
  }
  return false;
}

/** Every TX once; each wave internally conflict-free. */
export function validateWaves(
  txs: BatchTx[],
  waves: BatchTx[][],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (const wave of waves) {
    for (let i = 0; i < wave.length; i++) {
      const a = wave[i]!;
      if (seen.has(a.id)) return { ok: false, reason: `DUPLICATE_TX:${a.id}` };
      seen.add(a.id);
      for (let j = i + 1; j < wave.length; j++) {
        if (accessesConflict(accessOf(a), accessOf(wave[j]!))) {
          return { ok: false, reason: `INTRA_WAVE_CONFLICT:${a.id}/${wave[j]!.id}` };
        }
      }
    }
  }
  if (seen.size !== txs.length) {
    return { ok: false, reason: `COVERAGE:${seen.size}/${txs.length}` };
  }
  for (const t of txs) {
    if (!seen.has(t.id)) return { ok: false, reason: `MISSING:${t.id}` };
  }
  return { ok: true };
}

export function partitionByConflictGraphLegacy(
  txs: BatchTx[],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): BatchTx[][] {
  const remaining = [...txs];
  const waves: BatchTx[][] = [];
  while (remaining.length) {
    const wave: BatchTx[] = [];
    const waveAccess: StateAccessSet[] = [];
    const next: BatchTx[] = [];
    for (const tx of remaining) {
      const acc = accessOf(tx);
      if (waveAccess.some((w) => accessesConflict(w, acc))) next.push(tx);
      else {
        wave.push(tx);
        waveAccess.push(acc);
      }
    }
    if (wave.length === 0) {
      wave.push(remaining[0]!);
      remaining.shift();
      remaining.splice(0, remaining.length, ...next);
    } else {
      remaining.splice(0, remaining.length, ...next);
    }
    waves.push(wave);
  }
  return waves;
}

export function partitionByConflictGraphIndexed(
  txs: BatchTx[],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): BatchTx[][] {
  const remaining = [...txs];
  const waves: BatchTx[][] = [];
  while (remaining.length) {
    const wave: BatchTx[] = [];
    const occWrites = new Set<string>();
    const occReads = new Set<string>();
    const next: BatchTx[] = [];
    for (const tx of remaining) {
      const acc = accessOf(tx);
      let conflict = false;
      for (const w of acc.writes) {
        if (occWrites.has(w) || occReads.has(w)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        for (const r of acc.reads) {
          if (occWrites.has(r)) {
            conflict = true;
            break;
          }
        }
      }
      if (conflict) next.push(tx);
      else {
        wave.push(tx);
        for (const w of acc.writes) occWrites.add(w);
        for (const r of acc.reads) occReads.add(r);
      }
    }
    if (wave.length === 0) {
      wave.push(remaining[0]!);
      remaining.shift();
      remaining.splice(0, remaining.length, ...next);
    } else {
      remaining.splice(0, remaining.length, ...next);
    }
    waves.push(wave);
  }
  return waves;
}

export function partitionByConflictGraph(
  txs: BatchTx[],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): BatchTx[][] {
  return partitionByConflictGraphIndexed(txs, accessOf);
}

/**
 * Real undirected conflict-edge count via key indexes (not n - waves).
 * Pairs are verified with accessesConflict to avoid false positives.
 */
export function countConflictEdgesIndexed(
  txs: BatchTx[],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): number {
  const access = txs.map(accessOf);
  const writeIndex = new Map<string, number[]>();
  const readIndex = new Map<string, number[]>();
  for (let i = 0; i < access.length; i++) {
    for (const k of access[i]!.writes) {
      const l = writeIndex.get(k) ?? [];
      l.push(i);
      writeIndex.set(k, l);
    }
    for (const k of access[i]!.reads) {
      const l = readIndex.get(k) ?? [];
      l.push(i);
      readIndex.set(k, l);
    }
  }
  const edges = new Set<string>();
  const tryPair = (i: number, j: number) => {
    if (i === j) return;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    if (accessesConflict(access[lo]!, access[hi]!)) edges.add(`${lo}-${hi}`);
  };
  for (const [, writers] of writeIndex) {
    for (let a = 0; a < writers.length; a++) {
      for (let b = a + 1; b < writers.length; b++) tryPair(writers[a]!, writers[b]!);
    }
  }
  for (const [key, writers] of writeIndex) {
    for (const w of writers) {
      for (const r of readIndex.get(key) ?? []) tryPair(w, r);
    }
  }
  return edges.size;
}

/** @deprecated name: use countConflictEdgesIndexed */
export function countConflictEdges(
  txs: BatchTx[],
  accessOf: (tx: BatchTx) => StateAccessSet = accessSetFromTx,
): number {
  return countConflictEdgesIndexed(txs, accessOf);
}

/** Proxy only when full edge enumeration is intentionally skipped (documented). */
export function conflictComplexityProxy(txs: BatchTx[], waves: BatchTx[][]): number {
  return Math.max(0, txs.length - waves.length);
}
