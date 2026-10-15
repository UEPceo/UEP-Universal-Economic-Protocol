/**
 * 0.5.83 Block B: leader equivocation evidence.
 *
 * Evidence = two proposals for the same (height, round) by the same proposer,
 * both carrying a valid proposer signature, with different blockId. It is
 * self-contained: any validator can re-verify it with the validator set alone.
 * The store appends each new piece of evidence to a JSONL file (fsync) so it
 * survives restarts; duplicates (same proposer, height, round) are ignored.
 *
 * Status: EXPERIMENTAL. Evidence is recorded and acted on (round change); it
 * does not slash or remove the validator (no native token, no stake): removal
 * would be a validator-set change by governance, which is out of scope.
 */
import { appendFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync } from "node:fs";
import type { BftConsensusKernel, BftProposal } from "./bft-consensus.ts";

export type SignedProposal = { proposal: BftProposal; signature: string };
export type EquivocationEvidence = { kind: "uep-bft-equivocation-v1"; proposerId: string; height: number; round: number; a: SignedProposal; b: SignedProposal };

export function makeEquivocationEvidence(a: SignedProposal, b: SignedProposal): EquivocationEvidence {
  // Canonical order (by blockId) so the same pair always gives the same evidence.
  const [x, y] = a.proposal.blockId <= b.proposal.blockId ? [a, b] : [b, a];
  return { kind: "uep-bft-equivocation-v1", proposerId: x.proposal.proposerId, height: x.proposal.height, round: x.proposal.round, a: structuredClone(x), b: structuredClone(y) };
}

/** True when `ev` proves that its proposer signed two different blocks for one (height, round). */
export function verifyEquivocationEvidence(kernel: BftConsensusKernel, ev: EquivocationEvidence): boolean {
  if (!ev || ev.kind !== "uep-bft-equivocation-v1" || !ev.a || !ev.b) return false;
  const { a, b } = ev;
  if (a.proposal.proposerId !== ev.proposerId || b.proposal.proposerId !== ev.proposerId) return false;
  if (a.proposal.height !== ev.height || b.proposal.height !== ev.height || a.proposal.round !== ev.round || b.proposal.round !== ev.round) return false;
  if (a.proposal.blockId === b.proposal.blockId) return false;
  return kernel.verifyProposal(a.proposal, a.signature) && kernel.verifyProposal(b.proposal, b.signature);
}

export class EquivocationEvidenceStore {
  readonly #items = new Map<string, EquivocationEvidence>();
  readonly #path?: string;

  constructor(path?: string, kernel?: BftConsensusKernel) {
    this.#path = path;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let ev: EquivocationEvidence;
        try { ev = JSON.parse(line); } catch { continue; } // a torn last line after a crash is dropped
        if (kernel && !verifyEquivocationEvidence(kernel, ev)) continue;
        this.#items.set(EquivocationEvidenceStore.key(ev), ev);
      }
    }
  }

  static key(ev: Pick<EquivocationEvidence, "proposerId" | "height" | "round">): string { return `${ev.proposerId}:${ev.height}:${ev.round}`; }

  has(proposerId: string, height: number, round: number): boolean { return this.#items.has(`${proposerId}:${height}:${round}`); }

  /** Returns true when the evidence is new (and persisted). */
  add(ev: EquivocationEvidence): boolean {
    const k = EquivocationEvidenceStore.key(ev);
    if (this.#items.has(k)) return false;
    if (this.#path) {
      appendFileSync(this.#path, JSON.stringify(ev) + "\n", { mode: 0o600 });
      const fd = openSync(this.#path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.#items.set(k, ev);
    return true;
  }

  all(): EquivocationEvidence[] { return [...this.#items.values()]; }
}
