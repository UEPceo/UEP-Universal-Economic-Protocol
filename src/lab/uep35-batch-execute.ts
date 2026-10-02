/**
 * UEP-35.5 — Batch → deterministic sequential / parallel execution oracle.
 * Parallel waves MUST match sequential results (balances, fees, accept set).
 */

import { Fr } from "../core/field.ts";
import {
  ExecutionEngine,
  type CommitResult,
  type EngineConfig,
} from "./execution-engine.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { seedLabEngine } from "./uep35-batch-lab.ts";
import { partitionByConflictGraph } from "./uep35-conflict-graph.ts";
import { createHash } from "node:crypto";

export type ExecutionSnapshot = {
  balances: Record<string, string>;
  treasury: string;
  stateRoot: string | null;
  acceptedIds: string[];
  rejectedIds: string[];
  commitment: string;
};

function snapshot(engine: ExecutionEngine, labels: string[], commits: CommitResult[]): ExecutionSnapshot {
  const balances: Record<string, string> = {};
  for (const l of labels) {
    balances[l] = engine.getAccount(l).balance.toString();
  }
  const acceptedIds = commits.filter((c) => c.ok).map((c) => c.intentId).sort();
  const rejectedIds = commits.filter((c) => !c.ok).map((c) => c.intentId).sort();
  const commitment = executionStateCommitment({
    balances,
    treasury: engine.treasuryBalance.toString(),
    stateRoot: engine.stateRoot,
    acceptedIds,
  });
  return {
    balances,
    treasury: engine.treasuryBalance.toString(),
    stateRoot: engine.stateRoot,
    acceptedIds,
    rejectedIds,
    commitment,
  };
}

/**
 * Deterministic commitment over post-batch economic state (LAB).
 * Does NOT change Poseidon/SMT parameters — interface only.
 *
 * Semantics:
 * - pre-state: engine before batch
 * - post-state: balances + treasury after batch
 * - batch result: acceptedIds ordered
 * - commitment: SHA-256 of canonical encoding (ExecutionStateCommitment)
 */
export function executionStateCommitment(input: {
  balances: Record<string, string>;
  treasury: string;
  stateRoot: string | null;
  acceptedIds: string[];
}): string {
  const h = createHash("sha256");
  h.update("UEP-35.5-ESC|");
  const keys = Object.keys(input.balances).sort();
  for (const k of keys) {
    h.update(`${k}=${input.balances[k]};`);
  }
  h.update(`treasury=${input.treasury};`);
  h.update(`root=${input.stateRoot ?? "null"};`);
  h.update(`accepted=${input.acceptedIds.join(",")};`);
  return h.digest("hex");
}

async function runBatchOnEngine(
  engine: ExecutionEngine,
  txs: BatchTx[],
  mode: "sequential" | "parallel",
): Promise<{ commits: CommitResult[]; snap: ExecutionSnapshot; labels: string[] }> {
  const labels = [
    ...new Set(txs.flatMap((t) => [t.from, t.to])),
  ];
  // ensure accounts exist
  for (const l of labels) {
    try {
      engine.getAccount(l);
    } catch {
      engine.registerAccount(l, {
        id: Fr.from(BigInt(Math.abs(hashStr(l)) % 1_000_000 + 1)),
        secret: Fr.from(1n),
        salt: Fr.from(2n),
        blinding: Fr.from(3n),
        balance: 1_000_000n,
      });
    }
  }

  if (mode === "sequential") {
    for (const tx of txs) {
      engine.enqueue({ id: tx.id, from: tx.from, to: tx.to, amount: tx.amount });
      await engine.runScheduled();
    }
  } else {
    const waves = partitionByConflictGraph(txs);
    for (const wave of waves) {
      for (const tx of wave) {
        engine.enqueue({
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
        });
      }
      await engine.runScheduled();
    }
  }
  // Collect by re-reading — runScheduled already committed; rebuild commit list from transition
  // We need commits from last runs — re-execute pattern: return empty commits if not tracked.
  // Better: track during run.
  return { commits: [], snap: snapshot(engine, labels, []), labels };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export type BatchExecResult = {
  mode: "sequential" | "parallel";
  commits: CommitResult[];
  snapshot: ExecutionSnapshot;
  waves: number;
};

/**
 * Clone account state into a fresh engine for isolated sequential/parallel runs.
 */
export function cloneSeededEngine(
  accounts: Array<{ label: string; balance: bigint }>,
  cfg?: Partial<EngineConfig>,
): ExecutionEngine {
  return seedLabEngine(
    accounts.map((a, i) => ({
      label: a.label,
      balance: a.balance,
      id: BigInt(50_000 + i),
    })),
    {
      proveConcurrency: 4,
      oneInFlightPerSender: false,
      requireProof: false,
      depth: 4,
      profile: "local",
      ...cfg,
    },
  );
}

async function executeTracked(
  engine: ExecutionEngine,
  txs: BatchTx[],
  mode: "sequential" | "parallel",
): Promise<BatchExecResult> {
  const allCommits: CommitResult[] = [];
  let waves = 0;
  const labels = [...new Set(txs.flatMap((t) => [t.from, t.to]))];

  if (mode === "sequential") {
    waves = txs.length;
    for (const tx of txs) {
      const r = engine.enqueue({
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
      });
      if (!r.ok) {
        allCommits.push({
          ok: false,
          intentId: tx.id,
          error: r.error,
          commitMs: 0,
        });
        continue;
      }
      const { commits } = await engine.runScheduled();
      allCommits.push(...commits);
    }
  } else {
    const parts = partitionByConflictGraph(txs);
    waves = parts.length;
    for (const wave of parts) {
      for (const tx of wave) {
        const r = engine.enqueue({
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
        });
        if (!r.ok) {
          allCommits.push({
            ok: false,
            intentId: tx.id,
            error: r.error,
            commitMs: 0,
          });
        }
      }
      const { commits } = await engine.runScheduled();
      allCommits.push(...commits);
    }
  }

  return {
    mode,
    commits: allCommits,
    snapshot: snapshot(engine, labels, allCommits),
    waves,
  };
}

export async function sequentialExecution(
  accounts: Array<{ label: string; balance: bigint }>,
  txs: BatchTx[],
): Promise<BatchExecResult> {
  return executeTracked(cloneSeededEngine(accounts), txs, "sequential");
}

export async function parallelExecution(
  accounts: Array<{ label: string; balance: bigint }>,
  txs: BatchTx[],
): Promise<BatchExecResult> {
  return executeTracked(cloneSeededEngine(accounts), txs, "parallel");
}

export function snapshotsEqual(a: ExecutionSnapshot, b: ExecutionSnapshot): boolean {
  return a.commitment === b.commitment;
}
