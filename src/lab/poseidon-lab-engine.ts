/**
 * UEP-29.4 Poseidon Lab Engine — sequential state transitions.
 *
 * Modes:
 * - structural: no Groth16 (chain roots via prove-spend-json still needs binary for ZK mode)
 * - zk: each TX requires uep-zk; FAIL if binary missing (no silent SKIP)
 *
 * Canonical economic identity: transitionId from 12 public inputs.
 */

import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { findUepZkBinary, zkProveSpendJson, zkVerifyHex } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";
import { normalizeFrHex } from "./zk-public-inputs.ts";
import { transitionIdFromPublics } from "./poseidon-ledger-lab.ts";

export type LabConfig = {
  depth: 4 | 32;
  networkId: string;
  domainId: string;
  profile: "dev" | "local" | "testnet";
  /** When true, every TX must produce a Groth16 proof; missing binary = throw. */
  requireProof: boolean;
  seedBase?: number;
};

export type LabAccount = {
  secret: Fr;
  salt: Fr;
  blinding: Fr;
  balance: bigint;
};

export type LabTxResult = {
  ok: boolean;
  transitionId?: string;
  oldStateRoot?: string;
  newStateRoot?: string;
  oldNullifierRoot?: string;
  newNullifierRoot?: string;
  nullifier?: string;
  amount?: string;
  fee?: string;
  setupMs?: number;
  proveMs?: number;
  verifyMs?: number;
  applyMs?: number;
  totalMs?: number;
  vkId?: string;
  error?: string;
};

export class PoseidonLabEngine {
  readonly config: LabConfig;
  private accounts = new Map<string, LabAccount>();
  private nullifiers = new Set<string>();
  private stateRoot: string | null = null;
  private nullifierRoot: string | null = null;
  private history: LabTxResult[] = [];
  private acceptedIds = new Set<string>();
  treasuryBalance = 0n;
  treasuryId = Fr.from(44n);
  assetId = Fr.from(1n);

  constructor(config: LabConfig) {
    this.config = config;
  }

  ensureZkBinary(): string {
    const bin = findUepZkBinary();
    if (!bin) {
      throw new Error(
        "uep-zk binary required. Build: cd uep-core/uep-26-spend-circuit && cargo build --release --bin uep-zk",
      );
    }
    return bin;
  }

  registerAccount(label: string, acc: LabAccount): void {
    this.accounts.set(label, acc);
  }

  getAccount(label: string): LabAccount {
    const a = this.accounts.get(label);
    if (!a) throw new Error(`unknown account ${label}`);
    return a;
  }

  get lastStateRoot(): string | null {
    return this.stateRoot;
  }

  get historyCount(): number {
    return this.history.length;
  }

  /**
   * Apply one spend. If requireProof, runs Groth16 and measures real setup/prove/verify from CLI.
   */
  spend(from: string, to: string, amount: bigint, seedOffset = 0): LabTxResult {
    const tAll = performance.now();
    const sender = this.getAccount(from);
    const recipient = this.getAccount(to);
    const fee = creatorFee(amount);
    if (sender.balance < amount + fee) {
      return { ok: false, error: "insufficient balance" };
    }

    if (this.config.requireProof) {
      this.ensureZkBinary();
    }

    if (!this.config.requireProof) {
      // Structural bookkeeping only (not ZK). Still tracks balances for lab conservation tests.
      sender.balance -= amount + fee;
      recipient.balance += amount;
      this.treasuryBalance += fee;
      const applyMs = performance.now() - tAll;
      const r: LabTxResult = {
        ok: true,
        amount: amount.toString(),
        fee: fee.toString(),
        applyMs,
        totalMs: applyMs,
        transitionId: `struct-${this.history.length}`,
      };
      this.history.push(r);
      return r;
    }

    const req = buildPoseidonSpendRequest({
      depth: this.config.depth,
      seed: (this.config.seedBase ?? 42) + seedOffset + this.history.length,
      senderSecret: sender.secret,
      senderSalt: sender.salt,
      recipientId: Fr.from(33n), // lab fixed recipient id (bob)
      treasuryId: this.treasuryId,
      assetId: this.assetId,
      amount,
      fee,
      senderOldBalance: sender.balance,
      recipientOldBalance: recipient.balance,
      treasuryOldBalance: 0n,
      noteBlinding: sender.blinding,
      recipientBlinding: recipient.blinding,
      treasuryBlinding: Fr.from(5n),
    }) as ReturnType<typeof buildPoseidonSpendRequest> & {
      network_profile?: string;
      existing_nullifiers?: string[];
    };
    req.network_profile = this.config.profile;
    req.existing_nullifiers = [...this.nullifiers].map((h) =>
      h.startsWith("0x") || h.startsWith("0X") ? h : "0x" + h,
    );

    const art = zkProveSpendJson(req);
    if (!art.ok || art.publicInputsHex.length !== 13) {
      return {
        ok: false,
        error: art.error ?? "prove failed",
        setupMs: art.setupMs,
        proveMs: art.proveMs,
        verifyMs: art.verifyMs,
        totalMs: performance.now() - tAll,
      };
    }

    const tApply = performance.now();
    // Independent verify-hex
    const v = zkVerifyHex(art.vkHex!, art.proofHex!, art.publicInputsHex);
    if (!v.ok) {
      return { ok: false, error: "independent verify-hex failed", totalMs: performance.now() - tAll };
    }

    const tid = transitionIdFromPublics(art.publicInputsHex);
    if (this.acceptedIds.has(tid)) {
      return { ok: false, error: "IDEMPOTENT_REPLAY", transitionId: tid };
    }

    // Root chaining: if we have a prior root, note it (prover builds minimal tree per TX in 29.4;
    // full multi-TX shared tree is still limited by per-request 3-leaf model + extras).
    const oldR = normalizeFrHex(art.publicInputsHex[0]!);
    const newR = normalizeFrHex(art.publicInputsHex[1]!);
    const nf = normalizeFrHex(art.publicInputsHex[10]!);
    if (this.nullifiers.has(nf)) {
      return { ok: false, error: "NULLIFIER_REPLAY", nullifier: nf };
    }

    this.nullifiers.add(nf);
    this.acceptedIds.add(tid);
    this.stateRoot = newR;
    this.nullifierRoot = normalizeFrHex(art.publicInputsHex[3]!);
    sender.balance -= amount + fee;
    recipient.balance += amount;
    this.treasuryBalance += fee;

    const applyMs = performance.now() - tApply;
    const r: LabTxResult = {
      ok: true,
      transitionId: tid,
      oldStateRoot: oldR,
      newStateRoot: newR,
      oldNullifierRoot: normalizeFrHex(art.publicInputsHex[2]!),
      newNullifierRoot: this.nullifierRoot,
      nullifier: nf,
      amount: amount.toString(),
      fee: fee.toString(),
      setupMs: art.setupMs,
      proveMs: art.proveMs,
      verifyMs: art.verifyMs,
      applyMs,
      totalMs: performance.now() - tAll,
      vkId: art.vkId,
    };
    this.history.push(r);
    return r;
  }

  totalBalances(): bigint {
    let s = this.treasuryBalance;
    for (const a of this.accounts.values()) s += a.balance;
    return s;
  }
}
