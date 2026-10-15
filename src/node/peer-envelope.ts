/**
 * 0.5.81 item 9: authenticated peer envelope v2, replay guard and verifiable key rotation/revocation.
 *
 * v1 (0.5.80): signature over `uep-peer:<from>:<path>:<payload>`. Not bound to the network, epoch
 * or height, and replayable.
 * v2: signature over canonical JSON of
 *   { v: 2, networkId, domainId, epoch, from, path, height, nonce, payloadHash }
 * - networkId/domainId/epoch must equal the receiver's (cross-network and cross-epoch replay refused);
 * - `height` is the sender's own height; the receiver refuses envelopes more than `replayWindow`
 *   heights below the highest height it has accepted from that sender (height-based freshness,
 *   no wall clock; a lagging sender is not penalised for being behind the receiver);
 * - (from, nonce) is remembered for the window, so an envelope is accepted once.
 * BFT payloads (proposals, votes, certificates) additionally carry their own height/round binding.
 *
 * Key rotation needs the old key AND `threshold` other validators; revocation needs `threshold`
 * other validators. Statements are height-scoped and replay-checked by sequence number.
 */
import { canonicalJson } from "../core/canonical-json.ts";
import { sha256Hex, signEd25519, verifyEd25519, type PrivateKeyLike } from "../core/ed25519.ts";

export type PeerDomain = { networkId: string; domainId: string; epoch: number };
export type PeerEnvelopeV2 = { v: 2; from: string; networkId: string; domainId: string; epoch: number; height: number; nonce: string; signature: string; payload: unknown };

export const PEER_ENVELOPE_LIMITS = Object.freeze({ replayWindow: 64, maxNonceLength: 64, maxSeenPerPeer: 4096 });

const header = (e: Omit<PeerEnvelopeV2, "signature" | "payload">, path: string, payload: unknown) =>
  canonicalJson({ v: 2, networkId: e.networkId, domainId: e.domainId, epoch: e.epoch, from: e.from, path, height: e.height, nonce: e.nonce, payloadHash: sha256Hex(JSON.stringify(payload)) });

export function signPeerEnvelope(d: PeerDomain, from: string, path: string, height: number, nonce: string, payload: unknown, key: PrivateKeyLike): PeerEnvelopeV2 {
  const e = { v: 2 as const, from, networkId: d.networkId, domainId: d.domainId, epoch: d.epoch, height, nonce };
  return { ...e, signature: signEd25519("uep-peer-v2:" + header(e, path, payload), key), payload };
}

export class PeerReplayGuard {
  private readonly seen = new Map<string, Map<string, number>>();
  private readonly maxHeight = new Map<string, number>();
  readonly domain: PeerDomain;
  readonly window: number;
  constructor(domain: PeerDomain, window: number = PEER_ENVELOPE_LIMITS.replayWindow) { this.domain = domain; this.window = window; }

  /** Throws PEER_* on any failure; records the nonce only after the signature verified. */
  verify(env: PeerEnvelopeV2, path: string, _localHeight: number, keyOf: (from: string, height: number) => string | undefined): void {
    if (env.v !== 2) throw new Error("PEER_ENVELOPE_VERSION");
    if (env.networkId !== this.domain.networkId || env.domainId !== this.domain.domainId) throw new Error("PEER_DOMAIN_MISMATCH");
    if (env.epoch !== this.domain.epoch) throw new Error("PEER_EPOCH_MISMATCH");
    if (!Number.isSafeInteger(env.height) || env.height < 0) throw new Error("PEER_HEIGHT_INVALID");
    if (env.height + this.window < (this.maxHeight.get(env.from) ?? 0)) throw new Error("PEER_ENVELOPE_STALE");
    if (typeof env.nonce !== "string" || env.nonce.length === 0 || env.nonce.length > PEER_ENVELOPE_LIMITS.maxNonceLength) throw new Error("PEER_NONCE_INVALID");
    const key = keyOf(env.from, env.height);
    if (!key) throw new Error("PEER_AUTH");
    if (!verifyEd25519("uep-peer-v2:" + header(env, path, env.payload), String(env.signature ?? ""), key)) throw new Error("PEER_AUTH");
    let s = this.seen.get(env.from);
    if (!s) { s = new Map(); this.seen.set(env.from, s); }
    if (s.has(env.nonce)) throw new Error("PEER_REPLAY");
    s.set(env.nonce, env.height);
    if (env.height > (this.maxHeight.get(env.from) ?? 0)) this.maxHeight.set(env.from, env.height);
    const top = this.maxHeight.get(env.from)!;
    // Bound memory: drop nonces that fell out of the window, then the oldest if still over the cap.
    if (s.size > PEER_ENVELOPE_LIMITS.maxSeenPerPeer) {
      for (const [n, h] of s) if (h + this.window < top) s.delete(n);
      while (s.size > PEER_ENVELOPE_LIMITS.maxSeenPerPeer) s.delete(s.keys().next().value!);
    }
  }
}

export type KeyRotation = { kind: "rotate"; networkId: string; peerId: string; oldKeyHex: string; newKeyHex: string; fromHeight: number; sequence: number };
export type KeyRevocation = { kind: "revoke"; networkId: string; peerId: string; keyHex: string; fromHeight: number; sequence: number };
export type KeyStatement = (KeyRotation | KeyRevocation) & { signatures: { signer: string; signature: string }[] };

export const keyStatementMessage = (s: KeyRotation | KeyRevocation) =>
  "uep-peer-key-v1:" + canonicalJson({ kind: s.kind, networkId: s.networkId, peerId: s.peerId, ...(s.kind === "rotate" ? { oldKeyHex: s.oldKeyHex, newKeyHex: s.newKeyHex } : { keyHex: s.keyHex }), fromHeight: s.fromHeight, sequence: s.sequence });

export function signKeyStatement(s: KeyRotation | KeyRevocation, signer: string, key: PrivateKeyLike) {
  return { signer, signature: signEd25519(keyStatementMessage(s), key) };
}

/** Height-scoped peer keys. Deterministic: the same statements in the same order give the same keys. */
export class PeerKeyRegistry {
  private readonly history = new Map<string, { key: string | null; fromHeight: number }[]>();
  private readonly sequence = new Map<string, number>();
  readonly networkId: string;
  readonly threshold: number;
  constructor(networkId: string, genesis: Map<string, string>, threshold: number) {
    this.networkId = networkId; this.threshold = threshold;
    for (const [id, key] of genesis) this.history.set(id, [{ key, fromHeight: 0 }]);
  }

  keyAt(peerId: string, height: number): string | undefined {
    let out: string | null | undefined;
    for (const h of this.history.get(peerId) ?? []) if (h.fromHeight <= height) out = h.key;
    return out ?? undefined;
  }

  /** Verifies and applies a statement. Throws PEER_KEY_* on refusal (state unchanged). */
  apply(st: KeyStatement, currentHeight: number): void {
    if (st.networkId !== this.networkId) throw new Error("PEER_KEY_NETWORK");
    const hist = this.history.get(st.peerId);
    if (!hist) throw new Error("PEER_KEY_UNKNOWN_PEER");
    if (!Number.isSafeInteger(st.sequence) || st.sequence !== (this.sequence.get(st.peerId) ?? 0) + 1) throw new Error("PEER_KEY_SEQUENCE");
    if (!Number.isSafeInteger(st.fromHeight) || st.fromHeight <= currentHeight || st.fromHeight < hist[hist.length - 1]!.fromHeight) throw new Error("PEER_KEY_HEIGHT");
    const current = this.keyAt(st.peerId, Number.MAX_SAFE_INTEGER);
    const msg = keyStatementMessage(st);
    const validBy = new Set<string>();
    for (const { signer, signature } of st.signatures ?? []) {
      if (signer === st.peerId) continue;
      const k = this.keyAt(signer, currentHeight);
      if (k && verifyEd25519(msg, signature, k)) validBy.add(signer);
    }
    if (validBy.size < this.threshold) throw new Error("PEER_KEY_QUORUM");
    if (st.kind === "rotate") {
      if (!current || st.oldKeyHex !== current) throw new Error("PEER_KEY_OLD_MISMATCH");
      const self = st.signatures.find(s => s.signer === st.peerId);
      if (!self || !verifyEd25519(msg, self.signature, current)) throw new Error("PEER_KEY_OLD_SIGNATURE");
      if (!/^(302a300506032b6570032100)?[0-9a-f]{64}$/.test(st.newKeyHex) || st.newKeyHex === current) throw new Error("PEER_KEY_NEW_INVALID");
      hist.push({ key: st.newKeyHex, fromHeight: st.fromHeight });
    } else {
      if (!current || st.keyHex !== current) throw new Error("PEER_KEY_OLD_MISMATCH");
      hist.push({ key: null, fromHeight: st.fromHeight });
    }
    this.sequence.set(st.peerId, st.sequence);
  }
}
