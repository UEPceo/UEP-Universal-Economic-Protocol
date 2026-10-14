/**
 * Phase 4 harness quorum. Not the lab BFT and not a network.
 * A transaction is confirmed when `threshold` distinct voters sign its id.
 * A voter signs at most one transaction per nullifier.
 */
import { signEd25519, verifyEd25519, type PrivateKeyLike } from "../core/ed25519.ts";

export type QuorumVote = { voterId: string; publicKeyHex: string; signature: string };

export class TxQuorum {
  private readonly voters: Map<string, string>;
  private readonly threshold: number;
  private readonly confirmed = new Map<string, QuorumVote[]>();
  private readonly spent = new Set<string>();
  private readonly voted = new Map<string, string>();

  private readonly networkId: string;
  private readonly domainId: string;

  constructor(voters: Map<string, string>, threshold: number, domain: { networkId: string; domainId: string } = { networkId: "uep-testnet-1", domainId: "EARTH" }) {
    if (threshold < 1) throw new Error("QUORUM_THRESHOLD");
    this.voters = voters;
    this.threshold = threshold;
    this.networkId = domain.networkId;
    this.domainId = domain.domainId;
  }

  private message(txId: string): string {
    return `uep-quorum:${this.networkId}:${this.domainId}:${txId}`;
  }

  vote(voterId: string, txId: string, nullifiers: string[], privateKey: PrivateKeyLike): QuorumVote {
    const publicKeyHex = this.voters.get(voterId);
    if (!publicKeyHex) throw new Error("QUORUM_UNKNOWN_VOTER");
    for (const nullifier of nullifiers) {
      const prior = this.voted.get(`${voterId}:${nullifier}`);
      if (prior && prior !== txId) throw new Error("QUORUM_EQUIVOCATION");
      this.voted.set(`${voterId}:${nullifier}`, txId);
    }
    const signature = signEd25519(this.message(txId), privateKey);
    return { voterId, publicKeyHex, signature };
  }

  confirm(txId: string, nullifiers: string[], votes: QuorumVote[]): QuorumVote[] {
    if (nullifiers.some((id) => this.spent.has(id))) throw new Error("QUORUM_NULLIFIER_SPENT");
    const seen = new Set<string>();
    const accepted: QuorumVote[] = [];
    for (const vote of votes) {
      const expected = this.voters.get(vote.voterId);
      if (!expected || expected !== vote.publicKeyHex || seen.has(vote.voterId)) continue;
      if (!verifyEd25519(this.message(txId), vote.signature, vote.publicKeyHex)) continue;
      seen.add(vote.voterId);
      accepted.push(vote);
    }
    if (accepted.length < this.threshold) throw new Error("QUORUM_NOT_MET");
    return accepted;
  }

  markSpent(txId: string, nullifiers: string[], votes: QuorumVote[]): void {
    if (nullifiers.some((id) => this.spent.has(id))) throw new Error("QUORUM_NULLIFIER_SPENT");
    for (const id of nullifiers) this.spent.add(id);
    this.confirmed.set(txId, votes);
  }

  isConfirmed(txId: string): boolean {
    return this.confirmed.has(txId);
  }

  setVoter(id: string, publicKeyHex: string): boolean {
    const current = this.voters.get(id);
    if (current && current !== publicKeyHex) return false;
    this.voters.set(id, publicKeyHex);
    return true;
  }

  exportState(): { voted: [string, string][]; spent: string[]; confirmed: [string, QuorumVote[]][] } {
    return { voted: [...this.voted.entries()], spent: [...this.spent], confirmed: [...this.confirmed.entries()] };
  }

  loadState(state: { voted?: [string, string][]; spent?: string[]; confirmed?: [string, QuorumVote[]][] }): void {
    for (const [key, txId] of state.voted ?? []) this.voted.set(key, txId);
    for (const id of state.spent ?? []) this.spent.add(id);
    for (const [txId, votes] of state.confirmed ?? []) this.confirmed.set(txId, votes);
  }
}
