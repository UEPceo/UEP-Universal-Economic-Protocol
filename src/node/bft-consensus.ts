/**
 * UEP BFT consensus safety kernel (experimental; opt-in PeerNet transport and ledger-commit journal integration).
 *
 * Implements canonical, domain-bound proposals and phase votes, a fixed validator
 * set, n >= 3f+1 / quorum 2f+1, deterministic round leaders, anti-equivocation,
 * certified locks and signed round-change certificates. An optional synchronous
 * persistence hook allows a durable store to commit safety state before signatures
 * are released. Timeout orchestration, certified checkpoint sync and a transactional durable ledger backend remain separate work; do not call this production consensus yet.
 */
import { stableStringify, sha256Hex, signEd25519, verifyEd25519, publicKeyHexOf, type PrivateKeyLike } from "../core/ed25519.ts";

export type BftPhase = "prevote" | "precommit";
export type BftDomain = { networkId: string; domainId: string };
export type BftValidator = { id: string; publicKeyHex: string };
export type BftProposal = BftDomain & {
  height: number;
  round: number;
  proposerId: string;
  parentRoot: string;
  blockId: string;
  validRound?: number;
  validRoundCertificate?: BftCertificate;
  prevoteCertificate?: BftCertificate;
  roundChangeCertificate?: BftRoundChangeCertificate;
};
export type BftVote = BftDomain & {
  height: number;
  round: number;
  phase: BftPhase;
  voterId: string;
  blockId: string;
  /** Prevotes carry a higher-round POL when needed; precommits carry the same-round prevote quorum. */
  justificationCertificate: BftCertificate | null;
  signature: string;
};
export type BftCertificate = {
  height: number;
  round: number;
  phase: BftPhase;
  blockId: string;
  votes: BftVote[];
};
export type BftLock = { height: number; round: number; blockId: string; certificate: BftCertificate };
export type BftRoundChange = BftDomain & {
  height: number;
  targetRound: number;
  validatorId: string;
  lockedRound: number | null;
  lockedBlockId: string | null;
  validRoundCertificate: BftCertificate | null;
  signature: string;
};
export type BftRoundChangeCertificate = { height: number; targetRound: number; messages: BftRoundChange[] };
export type BftState = {
  version: 3;
  votes: [string, string][];
  committed: [string, string][];
  locks: [string, BftLock][];
  roundChanges: [string, string][];
};

const HEX_256 = /^[0-9a-f]{64}$/;
const validInt = (n: number) => Number.isSafeInteger(n) && n >= 0;

export class BftConsensusKernel {
  readonly validators: readonly BftValidator[];
  readonly faultTolerance: number;
  readonly quorum: number;
  readonly domain: BftDomain;
  private readonly validatorById: Map<string, BftValidator>;
  private readonly localVotes = new Map<string, string>();
  private readonly committed = new Map<string, string>();
  private readonly locks = new Map<string, BftLock>();
  private readonly roundChanges = new Map<string, string>();
  private readonly persistState?: (state: BftState) => void;

  constructor(
    domain: BftDomain,
    validators: BftValidator[],
    faultTolerance: number,
    persistState?: (state: BftState) => void,
  ) {
    if (!domain.networkId || !domain.domainId) throw new Error("BFT_DOMAIN_REQUIRED");
    if (!Number.isSafeInteger(faultTolerance) || faultTolerance < 0) throw new Error("BFT_FAULT_TOLERANCE");
    if (validators.length < 3 * faultTolerance + 1) throw new Error("BFT_VALIDATOR_SET_TOO_SMALL");
    if (validators.length !== new Set(validators.map(v => v.id)).size) throw new Error("BFT_DUPLICATE_VALIDATOR");
    if (validators.some(v => !v.id || !/^[0-9a-f]+$/.test(v.publicKeyHex))) throw new Error("BFT_VALIDATOR_INVALID");
    this.persistState = persistState;
    this.domain = Object.freeze({ ...domain });
    this.validators = Object.freeze(validators.map(v => Object.freeze({ ...v })).sort((a, b) => a.id.localeCompare(b.id)));
    this.validatorById = new Map(this.validators.map(v => [v.id, v]));
    this.faultTolerance = faultTolerance;
    this.quorum = 2 * faultTolerance + 1;
  }

  leader(height: number, round: number): string {
    if (!validInt(height) || height < 1 || !validInt(round)) throw new Error("BFT_POSITION_INVALID");
    return this.validators[(height - 1 + round) % this.validators.length]!.id;
  }

  proposalDigest(proposal: BftProposal): string {
    this.assertProposal(proposal);
    return stableStringify({ protocol: "uep-bft-v1", ...proposal });
  }

  signProposal(proposal: BftProposal, privateKey: PrivateKeyLike): string {
    return signEd25519(`uep-bft-proposal-v1:${this.proposalDigest(proposal)}`, privateKey);
  }

  verifyProposal(proposal: BftProposal, signature: string): boolean {
    try {
      this.assertProposal(proposal);
      const validator = this.validatorById.get(proposal.proposerId);
      if (!validator || this.leader(proposal.height, proposal.round) !== proposal.proposerId) return false;
      return verifyEd25519(`uep-bft-proposal-v1:${this.proposalDigest(proposal)}`, signature, validator.publicKeyHex);
    } catch { return false; }
  }

  createVote(proposal: BftProposal, phase: BftPhase, voterId: string, privateKey: PrivateKeyLike, proposalSignature: string): BftVote {
    this.assertProposal(proposal);
    if (!this.verifyProposal(proposal, proposalSignature)) throw new Error("BFT_PROPOSAL_SIGNATURE_INVALID");
    const validator = this.validatorById.get(voterId);
    if (!validator) throw new Error("BFT_UNKNOWN_VALIDATOR");
    if (publicKeyHexOf(privateKey) !== validator.publicKeyHex) throw new Error("BFT_SIGNING_KEY_MISMATCH");
    if (phase !== "prevote" && phase !== "precommit") throw new Error("BFT_PHASE_INVALID");
    const lock = this.locks.get(String(proposal.height));
    if (phase === "prevote" && lock && lock.blockId !== proposal.blockId) {
      const proof = proposal.validRoundCertificate;
      if (!proof || proposal.validRound === undefined || proposal.validRound <= lock.round ||
          proof.round !== proposal.validRound || proof.blockId !== proposal.blockId ||
          proof.phase !== "prevote" || !this.verifyCertificate(proof)) {
        throw new Error("BFT_LOCKED_CONFLICTING_PREVOTE");
      }
    }
    if (phase === "precommit") {
      const proof = proposal.prevoteCertificate;
      if (!proof || proof.phase !== "prevote" || proof.height !== proposal.height ||
          proof.round !== proposal.round || proof.blockId !== proposal.blockId || !this.verifyCertificate(proof)) {
        throw new Error("BFT_PRECOMMIT_REQUIRES_PREVOTE_QUORUM");
      }
      // The certificate alone is not enough: this validator must have accepted
      // the certificate into its lock state before it may sign a precommit.
      // This makes the safety transition explicit and prevents callers from
      // bypassing observePrevoteCertificate(). Durable persistence is a later
      // integration layer and must happen before this signing API is exposed.
      const currentLock = this.locks.get(String(proposal.height));
      if (!currentLock || currentLock.round !== proposal.round || currentLock.blockId !== proposal.blockId ||
          !this.verifyCertificate(currentLock.certificate) ||
          currentLock.certificate.phase !== "prevote" ||
          currentLock.certificate.round !== proof.round || currentLock.certificate.blockId !== proof.blockId) {
        throw new Error("BFT_PRECOMMIT_REQUIRES_REGISTERED_LOCK");
      }
    }
    const position = `${proposal.height}:${proposal.round}:${phase}:${voterId}`;
    const value = proposal.blockId;
    const prior = this.localVotes.get(position);
    if (prior && prior !== value) throw new Error("BFT_EQUIVOCATION");
    if (!prior) {
      const nextVotes = new Map(this.localVotes);
      nextVotes.set(position, value);
      // Write-ahead anti-equivocation: if durable storage fails, do not sign.
      this.persistState?.({ ...this.exportState(), votes: [...nextVotes] });
      this.localVotes.set(position, value);
    }
    const voteBase = { ...this.domain, height: proposal.height, round: proposal.round, phase, voterId, blockId: value,
      justificationCertificate: phase === "precommit" ? proposal.prevoteCertificate ?? null : proposal.validRoundCertificate ?? null };
    return { ...voteBase, signature: signEd25519(this.voteMessage(voteBase), privateKey) };
  }

  verifyVote(vote: BftVote): boolean {
    if (!vote || vote.networkId !== this.domain.networkId || vote.domainId !== this.domain.domainId ||
      !validInt(vote.height) || vote.height < 1 || !validInt(vote.round) ||
      (vote.phase !== "prevote" && vote.phase !== "precommit") || !HEX_256.test(vote.blockId)) return false;
    const validator = this.validatorById.get(vote.voterId);
    if (!validator) return false;
    const proof = vote.justificationCertificate;
    if (vote.phase === "precommit") {
      if (!proof || proof.phase !== "prevote" || proof.height !== vote.height || proof.round !== vote.round ||
          proof.blockId !== vote.blockId || !this.verifyCertificate(proof)) return false;
    } else if (proof !== null && (!proof || proof.phase !== "prevote" || proof.height !== vote.height ||
        proof.round >= vote.round || proof.blockId !== vote.blockId || !this.verifyCertificate(proof))) return false;
    const { signature: _signature, ...unsigned } = vote;
    return verifyEd25519(this.voteMessage(unsigned), vote.signature, validator.publicKeyHex);
  }

  certificate(height: number, round: number, blockId: string, votes: BftVote[]): BftCertificate {
    return this.voteCertificate(height, round, "precommit", blockId, votes);
  }

  voteCertificate(height: number, round: number, phase: BftPhase, blockId: string, votes: BftVote[]): BftCertificate {
    if (!validInt(height) || height < 1 || !validInt(round) || !HEX_256.test(blockId) ||
        (phase !== "prevote" && phase !== "precommit")) throw new Error("BFT_CERTIFICATE_INVALID");
    const unique = new Set<string>();
    const accepted = votes.filter(v => {
      if (v.height !== height || v.round !== round || v.phase !== phase || v.blockId !== blockId || unique.has(v.voterId) || !this.verifyVote(v)) return false;
      unique.add(v.voterId); return true;
    });
    if (accepted.length < this.quorum) throw new Error("BFT_QUORUM_NOT_MET");
    return { height, round, phase, blockId, votes: accepted };
  }

  verifyCertificate(certificate: BftCertificate): boolean {
    try {
      const verified = this.voteCertificate(certificate.height, certificate.round, certificate.phase, certificate.blockId, certificate.votes);
      return verified.votes.length >= this.quorum;
    } catch { return false; }
  }

  /** Persist the safety lock implied by a valid 2f+1 prevote certificate. */
  observePrevoteCertificate(certificate: BftCertificate): void {
    if (certificate.phase !== "prevote" || !this.verifyCertificate(certificate)) throw new Error("BFT_PREVOTE_CERTIFICATE_INVALID");
    const key = String(certificate.height);
    const current = this.locks.get(key);
    if (current && current.blockId !== certificate.blockId && certificate.round <= current.round) {
      throw new Error("BFT_LOCK_CONFLICT");
    }
    if (!current || certificate.round > current.round) {
      const nextLocks = new Map(this.locks);
      nextLocks.set(key, { height: certificate.height, round: certificate.round, blockId: certificate.blockId, certificate: structuredClone(certificate) });
      // A lock must be durable before callers can proceed to precommit signing.
      this.persistState?.({ ...this.exportState(), locks: [...nextLocks] });
      this.locks.set(key, { height: certificate.height, round: certificate.round, blockId: certificate.blockId, certificate: structuredClone(certificate) });
    }
  }

  getLock(height: number): BftLock | null {
    const lock = this.locks.get(String(height));
    return lock ? structuredClone(lock) : null;
  }

  createRoundChange(height: number, targetRound: number, validatorId: string, privateKey: PrivateKeyLike): BftRoundChange {
    if (!validInt(height) || height < 1 || !validInt(targetRound) || targetRound < 1) throw new Error("BFT_ROUND_CHANGE_POSITION_INVALID");
    const validator = this.validatorById.get(validatorId);
    if (!validator) throw new Error("BFT_UNKNOWN_VALIDATOR");
    if (publicKeyHexOf(privateKey) !== validator.publicKeyHex) throw new Error("BFT_SIGNING_KEY_MISMATCH");
    const lock = this.locks.get(String(height));
    if (lock && targetRound <= lock.round) throw new Error("BFT_ROUND_CHANGE_NOT_AHEAD_OF_LOCK");
    const base = { ...this.domain, height, targetRound, validatorId,
      lockedRound: lock?.round ?? null, lockedBlockId: lock?.blockId ?? null,
      validRoundCertificate: lock?.certificate ?? null };
    const position = `${height}:${targetRound}:${validatorId}`;
    const digest = sha256Hex(this.roundChangeMessage(base));
    const prior = this.roundChanges.get(position);
    if (prior && prior !== digest) throw new Error("BFT_ROUND_CHANGE_EQUIVOCATION");
    if (!prior) {
      const nextRoundChanges = new Map(this.roundChanges);
      nextRoundChanges.set(position, digest);
      // Persist the round-change intent before releasing its signature.
      this.persistState?.({ ...this.exportState(), roundChanges: [...nextRoundChanges] });
      this.roundChanges.set(position, digest);
    }
    return { ...base, signature: signEd25519(this.roundChangeMessage(base), privateKey) };
  }

  verifyRoundChange(message: BftRoundChange): boolean {
    try {
      if (!message || message.networkId !== this.domain.networkId || message.domainId !== this.domain.domainId ||
          !validInt(message.height) || message.height < 1 || !validInt(message.targetRound) || message.targetRound < 1) return false;
      const validator = this.validatorById.get(message.validatorId);
      if (!validator) return false;
      if (message.lockedRound === null) {
        if (message.lockedBlockId !== null || message.validRoundCertificate !== null) return false;
      } else {
        const cert = message.validRoundCertificate;
        if (!validInt(message.lockedRound) || message.lockedRound >= message.targetRound || !HEX_256.test(message.lockedBlockId ?? "") ||
            !cert || cert.phase !== "prevote" || cert.height !== message.height || cert.round !== message.lockedRound ||
            cert.blockId !== message.lockedBlockId || !this.verifyCertificate(cert)) return false;
      }
      return verifyEd25519(this.roundChangeMessage({ networkId: message.networkId, domainId: message.domainId,
        height: message.height, targetRound: message.targetRound, validatorId: message.validatorId,
        lockedRound: message.lockedRound, lockedBlockId: message.lockedBlockId,
        validRoundCertificate: message.validRoundCertificate }), message.signature, validator.publicKeyHex);
    } catch { return false; }
  }

  roundChangeCertificate(height: number, targetRound: number, messages: BftRoundChange[]): BftRoundChangeCertificate {
    if (!validInt(height) || height < 1 || !validInt(targetRound) || targetRound < 1) throw new Error("BFT_ROUND_CHANGE_CERTIFICATE_INVALID");
    const unique = new Set<string>();
    const accepted = messages.filter(m => {
      if (m.height !== height || m.targetRound !== targetRound || unique.has(m.validatorId) || !this.verifyRoundChange(m)) return false;
      unique.add(m.validatorId); return true;
    });
    if (accepted.length < this.quorum) throw new Error("BFT_ROUND_CHANGE_QUORUM_NOT_MET");
    return { height, targetRound, messages: accepted };
  }

  /** Determine the only safe value a new-round proposer may carry forward. */
  requiredProposalFromRoundChanges(certificate: BftRoundChangeCertificate): { blockId: string; validRound: number; validRoundCertificate: BftCertificate } | null {
    const verified = this.roundChangeCertificate(certificate.height, certificate.targetRound, certificate.messages);
    let highest: BftRoundChange | null = null;
    for (const message of verified.messages) {
      if (message.lockedRound === null || !message.validRoundCertificate) continue;
      if (!highest || message.lockedRound > highest.lockedRound!) highest = message;
      else if (message.lockedRound === highest.lockedRound && message.lockedBlockId !== highest.lockedBlockId) {
        throw new Error("BFT_CONFLICTING_LOCK_CERTIFICATES");
      }
    }
    if (!highest || highest.lockedRound === null || !highest.validRoundCertificate) return null;
    return { blockId: highest.lockedBlockId!, validRound: highest.lockedRound, validRoundCertificate: highest.validRoundCertificate };
  }

  recordCommit(certificate: BftCertificate): void {
    if (certificate.phase !== "precommit" || !this.verifyCertificate(certificate)) throw new Error("BFT_CERTIFICATE_INVALID");
    const key = String(certificate.height);
    const previous = this.committed.get(key);
    if (previous && previous !== certificate.blockId) throw new Error("BFT_CONFLICTING_COMMIT");
    if (previous !== certificate.blockId) {
      const nextCommitted = new Map(this.committed);
      nextCommitted.set(key, certificate.blockId);
      this.persistState?.({ ...this.exportState(), committed: [...nextCommitted] });
      this.committed.set(key, certificate.blockId);
    }
  }

  exportState(): BftState { return { version: 3, votes: [...this.localVotes], committed: [...this.committed], locks: [...this.locks], roundChanges: [...this.roundChanges] }; }

  loadState(state: BftState): void {
    if (!state || state.version !== 3 || !Array.isArray(state.votes) || !Array.isArray(state.committed) ||
        !Array.isArray(state.locks) || !Array.isArray(state.roundChanges)) throw new Error("BFT_STATE_INVALID");
    const votes = new Map<string, string>();
    for (const entry of state.votes) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") throw new Error("BFT_STATE_INVALID");
      const match = /^(\d+):(\d+):(prevote|precommit):([^:]+)$/.exec(entry[0]);
      if (!match || Number(match[1]) < 1 || !validInt(Number(match[2])) || !this.validatorById.has(match[4]!) || !HEX_256.test(entry[1])) {
        throw new Error("BFT_STATE_INVALID_VOTE");
      }
      const prior = votes.get(entry[0]);
      if (prior && prior !== entry[1]) throw new Error("BFT_STATE_EQUIVOCATION");
      votes.set(entry[0], entry[1]);
    }
    const commits = new Map<string, string>();
    for (const entry of state.committed) {
      if (!Array.isArray(entry) || entry.length !== 2 || !/^\d+$/.test(entry[0]) || !HEX_256.test(entry[1])) throw new Error("BFT_STATE_INVALID");
      const prior = commits.get(entry[0]);
      if (prior && prior !== entry[1]) throw new Error("BFT_STATE_CONFLICTING_COMMIT");
      commits.set(entry[0], entry[1]);
    }
    const locks = new Map<string, BftLock>();
    for (const entry of state.locks) {
      if (!Array.isArray(entry) || entry.length !== 2 || !/^\d+$/.test(entry[0]) || locks.has(entry[0])) {
        throw new Error("BFT_STATE_INVALID");
      }
      const lock = entry[1];
      if (!lock || lock.height !== Number(entry[0]) || !validInt(lock.round) || !HEX_256.test(lock.blockId) ||
          !lock.certificate || lock.certificate.phase !== "prevote" || lock.certificate.height !== lock.height ||
          lock.certificate.round !== lock.round || lock.certificate.blockId !== lock.blockId || !this.verifyCertificate(lock.certificate)) {
        throw new Error("BFT_STATE_INVALID_LOCK");
      }
      const committedBlock = commits.get(entry[0]);
      if (committedBlock && committedBlock !== lock.blockId) throw new Error("BFT_STATE_LOCK_CONFLICTS_WITH_COMMIT");
      locks.set(entry[0], structuredClone(lock));
    }
    const roundChanges = new Map<string, string>();
    for (const entry of state.roundChanges) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^(\d+):(\d+):([^:]+)$/.test(entry[0]) ||
          !HEX_256.test(entry[1]) || !this.validatorById.has(entry[0].split(":")[2]!)) throw new Error("BFT_STATE_INVALID_ROUND_CHANGE");
      const prior = roundChanges.get(entry[0]);
      if (prior && prior !== entry[1]) throw new Error("BFT_STATE_ROUND_CHANGE_EQUIVOCATION");
      roundChanges.set(entry[0], entry[1]);
    }
    // All data is validated before any live maps are changed.
    this.localVotes.clear(); for (const [k, v] of votes) this.localVotes.set(k, v);
    this.committed.clear(); for (const [k, v] of commits) this.committed.set(k, v);
    this.locks.clear(); for (const [k, v] of locks) this.locks.set(k, v);
    this.roundChanges.clear(); for (const [k, v] of roundChanges) this.roundChanges.set(k, v);
  }

  private roundChangeMessage(message: Omit<BftRoundChange, "signature">): string {
    return `uep-bft-round-change-v1:${stableStringify(message)}`;
  }

  private assertProposal(p: BftProposal): void {
    if (!p || p.networkId !== this.domain.networkId || p.domainId !== this.domain.domainId ||
      !validInt(p.height) || p.height < 1 || !validInt(p.round) || !p.proposerId ||
      !HEX_256.test(p.parentRoot) || !HEX_256.test(p.blockId)) throw new Error("BFT_PROPOSAL_INVALID");
    if (p.validRoundCertificate !== undefined) {
      if (!validInt(p.validRound ?? -1) || p.validRound! >= p.round || p.validRoundCertificate.phase !== "prevote" ||
          p.validRoundCertificate.height !== p.height || p.validRoundCertificate.round !== p.validRound ||
          p.validRoundCertificate.blockId !== p.blockId || !this.verifyCertificate(p.validRoundCertificate)) throw new Error("BFT_VALID_ROUND_PROOF_INVALID");
    } else if (p.validRound !== undefined) throw new Error("BFT_VALID_ROUND_PROOF_INVALID");
    if (p.prevoteCertificate !== undefined && (p.prevoteCertificate.phase !== "prevote" || p.prevoteCertificate.height !== p.height ||
        p.prevoteCertificate.round !== p.round || p.prevoteCertificate.blockId !== p.blockId || !this.verifyCertificate(p.prevoteCertificate))) {
      throw new Error("BFT_PREVOTE_CERTIFICATE_INVALID");
    }
    if (p.round === 0) {
      if (p.roundChangeCertificate !== undefined) throw new Error("BFT_UNEXPECTED_ROUND_CHANGE_CERTIFICATE");
    } else {
      const rc = p.roundChangeCertificate;
      if (!rc || rc.height !== p.height || rc.targetRound !== p.round) throw new Error("BFT_ROUND_CHANGE_CERTIFICATE_REQUIRED");
      const required = this.requiredProposalFromRoundChanges(rc);
      if (required && (p.blockId !== required.blockId || p.validRound !== required.validRound ||
          !p.validRoundCertificate || !this.verifyCertificate(p.validRoundCertificate))) throw new Error("BFT_PROPOSAL_IGNORES_HIGHEST_LOCK");
      if (!required && (p.validRound !== undefined || p.validRoundCertificate !== undefined)) throw new Error("BFT_UNJUSTIFIED_VALID_ROUND");
    }
  }

  private voteMessage(v: Omit<BftVote, "signature">): string {
    return `uep-bft-vote-v2:${stableStringify(v)}`;
  }
}
