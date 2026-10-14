import { createHash } from "node:crypto";
/**
 * Client-supplied note opening (audit I1, v0.5.8).
 *
 * The ledger does not invent a commitment. The wallet or issuer builds the
 * note here and passes it to faucet(), prepareIssuerMint() and
 * mintWithIssuerSignatures(). The blinding is an argument, never OS entropy
 * inside the transition. Two replicas that receive the same opening record
 * the same note.
 */
import { Fr } from "../core/field.ts";
import { makeNote, type Note } from "../core/note.ts";

/** Deterministic client opening. Same seed, same blinding, on every replica. */
export function clientBlinding(seed: bigint): Fr {
  if (seed < 0n) throw new Error("CLIENT_BLINDING_INVALID");
  return new Fr(seed);
}

export function openClientNote(owner: Fr, assetId: Fr, amount: bigint, blinding: Fr): Note {
  return makeNote(owner, assetId, amount, blinding);
}

/** Wallet default for a spend output when the caller does not pass an opening. Embedded in the tx; replicas apply the tx and do not re-derive it. */
export function walletOutputBlinding(noteCounter: bigint, tag: bigint, domain: bigint = 0n): Fr {
  if (domain === 0n) return new Fr((noteCounter + 1n) * 16n + tag);
  const digest = createHash("sha256").update(`uep-blind-v1|${domain.toString(16)}|${noteCounter}|${tag}`).digest("hex");
  return new Fr(digest);
}
