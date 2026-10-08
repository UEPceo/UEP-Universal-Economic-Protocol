/**
 * v0.5.3 (external review 2026-10-08): HPKE, RFC 9180, base mode, with the
 * single suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305
 * (kem_id 0x0020, kdf_id 0x0001, aead_id 0x0003). node:crypto only.
 * Checked against the RFC 9180 Appendix A.2.1 test vectors (hpke.test.ts).
 *
 * Use: end-to-end encryption of relay payloads to the recipient's X25519
 * key (sealRelayPayload / openRelayPayload below). The relay fair-exchange
 * key that is published after payment then only reveals HPKE ciphertext.
 *
 * Not a transition: the sender's ephemeral key is the only randomness
 * (one randomBytes(32) call in hpkeSetupSender, allowlisted in the
 * determinism lint); every other function is deterministic.
 */
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, timingSafeEqual } from "node:crypto";

export const HPKE_KEM_ID = 0x0020;
export const HPKE_KDF_ID = 0x0001;
export const HPKE_AEAD_ID = 0x0003;
const MODE_BASE = 0x00;
const NSECRET = 32;
const NENC = 32;
const NPK = 32;
const NSK = 32;
const NK = 32;
const NN = 12;
const NT = 16;
const NH = 32;

const enc8 = (s: string) => Buffer.from(s, "utf8");
function i2osp(n: number | bigint, w: number): Buffer {
  let v = BigInt(n);
  const out = Buffer.alloc(w);
  for (let i = w - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error("HPKE_I2OSP_OVERFLOW");
  return out;
}

const KEM_SUITE = Buffer.concat([enc8("KEM"), i2osp(HPKE_KEM_ID, 2)]);
const HPKE_SUITE = Buffer.concat([enc8("HPKE"), i2osp(HPKE_KEM_ID, 2), i2osp(HPKE_KDF_ID, 2), i2osp(HPKE_AEAD_ID, 2)]);

function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt.length ? salt : Buffer.alloc(NH)).update(ikm).digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length > 255 * NH) throw new Error("HPKE_EXPAND_TOO_LONG");
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    prev = createHmac("sha256", prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, length);
}

function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return extract(salt, Buffer.concat([enc8("HPKE-v1"), suite, enc8(label), ikm]));
}

function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
  return expand(prk, Buffer.concat([i2osp(length, 2), enc8("HPKE-v1"), suite, enc8(label), info]), length);
}

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function x25519Private(sk: Buffer) {
  if (sk.length !== NSK) throw new Error("HPKE_KEY_INVALID");
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, sk]), format: "der", type: "pkcs8" });
}

function x25519Public(pk: Buffer) {
  if (pk.length !== NPK) throw new Error("HPKE_KEY_INVALID");
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, pk]), format: "der", type: "spki" });
}

/** Raw X25519 public key of a raw private key. */
export function x25519PublicKeyOf(sk: Uint8Array): Buffer {
  const der = createPublicKey(x25519Private(Buffer.from(sk))).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - NPK));
}

function dh(sk: Buffer, pk: Buffer): Buffer {
  const out = diffieHellman({ privateKey: x25519Private(sk), publicKey: x25519Public(pk) });
  if (timingSafeEqual(out, Buffer.alloc(out.length))) throw new Error("HPKE_DH_ZERO");
  return out;
}

/** RFC 9180 DeriveKeyPair for X25519 (deterministic from `ikm`, at least 32 bytes). */
export function hpkeDeriveKeyPair(ikm: Uint8Array): { privateKey: Buffer; publicKey: Buffer } {
  if (ikm.length < NSK) throw new Error("HPKE_IKM_TOO_SHORT");
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "dkp_prk", Buffer.from(ikm));
  const sk = labeledExpand(KEM_SUITE, prk, "sk", Buffer.alloc(0), NSK);
  return { privateKey: sk, publicKey: x25519PublicKeyOf(sk) };
}

function extractAndExpand(dhOut: Buffer, kemContext: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dhOut);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, NSECRET);
}

export type HpkeKeySchedule = { key: Buffer; baseNonce: Buffer; exporterSecret: Buffer; keyScheduleContext: Buffer; secret: Buffer };

function keySchedule(sharedSecret: Buffer, info: Buffer): HpkeKeySchedule {
  const pskIdHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "info_hash", info);
  const ctx = Buffer.concat([Buffer.from([MODE_BASE]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", Buffer.alloc(0));
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", ctx, NK),
    baseNonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN),
    exporterSecret: labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH),
    keyScheduleContext: ctx,
    secret,
  };
}

/** An HPKE encryption context (one direction; sequence numbers advance per message). */
export class HpkeContext {
  private seq = 0n;
  private readonly ks: HpkeKeySchedule;
  readonly role: "sender" | "recipient";
  constructor(ks: HpkeKeySchedule, role: "sender" | "recipient") {
    this.ks = ks;
    this.role = role;
  }

  private nonce(): Buffer {
    const s = i2osp(this.seq, NN);
    const n = Buffer.alloc(NN);
    for (let i = 0; i < NN; i++) n[i] = this.ks.baseNonce[i]! ^ s[i]!;
    return n;
  }

  private increment(): void {
    if (this.seq >= (1n << BigInt(8 * NN)) - 1n) throw new Error("HPKE_MESSAGE_LIMIT");
    this.seq++;
  }

  seal(plaintext: Uint8Array, aad: Uint8Array = Buffer.alloc(0)): Buffer {
    if (this.role !== "sender") throw new Error("HPKE_ROLE");
    const c = createCipheriv("chacha20-poly1305", this.ks.key, this.nonce(), { authTagLength: NT });
    c.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
    const out = Buffer.concat([c.update(Buffer.from(plaintext)), c.final(), c.getAuthTag()]);
    this.increment();
    return out;
  }

  open(ciphertext: Uint8Array, aad: Uint8Array = Buffer.alloc(0)): Buffer {
    if (this.role !== "recipient") throw new Error("HPKE_ROLE");
    const ct = Buffer.from(ciphertext);
    if (ct.length < NT) throw new Error("HPKE_OPEN_FAILED");
    const d = createDecipheriv("chacha20-poly1305", this.ks.key, this.nonce(), { authTagLength: NT });
    d.setAAD(Buffer.from(aad), { plaintextLength: ct.length - NT });
    d.setAuthTag(ct.subarray(ct.length - NT));
    let pt: Buffer;
    try { pt = Buffer.concat([d.update(ct.subarray(0, ct.length - NT)), d.final()]); } catch { throw new Error("HPKE_OPEN_FAILED"); }
    this.increment();
    return pt;
  }

  export(exporterContext: Uint8Array, length: number): Buffer {
    return labeledExpand(HPKE_SUITE, this.ks.exporterSecret, "sec", Buffer.from(exporterContext), length);
  }

  /** Test access to the key schedule (RFC vectors). */
  get schedule(): Readonly<HpkeKeySchedule> {
    return this.ks;
  }
}

/**
 * SetupBaseS. `testOnlyEphemeralIkm` fixes the ephemeral key (RFC test
 * vectors only); otherwise it is derived from 32 fresh random bytes.
 */
export function hpkeSetupSender(recipientPublicKey: Uint8Array, info: Uint8Array, testOnlyEphemeralIkm?: Uint8Array): { enc: Buffer; context: HpkeContext; sharedSecret: Buffer } {
  const pkR = Buffer.from(recipientPublicKey);
  const eph = hpkeDeriveKeyPair(testOnlyEphemeralIkm ?? randomBytes(32));
  const enc = eph.publicKey;
  const sharedSecret = extractAndExpand(dh(eph.privateKey, pkR), Buffer.concat([enc, pkR]));
  return { enc, context: new HpkeContext(keySchedule(sharedSecret, Buffer.from(info)), "sender"), sharedSecret };
}

/** SetupBaseR. */
export function hpkeSetupRecipient(enc: Uint8Array, recipientPrivateKey: Uint8Array, info: Uint8Array): HpkeContext {
  if (enc.length !== NENC) throw new Error("HPKE_ENC_INVALID");
  const skR = Buffer.from(recipientPrivateKey);
  const pkR = x25519PublicKeyOf(skR);
  const sharedSecret = extractAndExpand(dh(skR, Buffer.from(enc)), Buffer.concat([Buffer.from(enc), pkR]));
  return new HpkeContext(keySchedule(sharedSecret, Buffer.from(info)), "recipient");
}

/** Single-shot seal (RFC 9180 section 6.1). */
export function hpkeSeal(recipientPublicKey: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): { enc: Buffer; ciphertext: Buffer } {
  const { enc, context } = hpkeSetupSender(recipientPublicKey, info);
  return { enc, ciphertext: context.seal(plaintext, aad) };
}

export function hpkeOpen(enc: Uint8Array, recipientPrivateKey: Uint8Array, info: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Buffer {
  return hpkeSetupRecipient(enc, recipientPrivateKey, info).open(ciphertext, aad);
}

// ---------------------------------------------------------------------------
// Relay payloads (uep.service.relay.v1): end-to-end chunk encryption.
// ---------------------------------------------------------------------------

/** Plaintext bytes per sealed chunk (a sealed chunk adds the 16-byte tag). */
export const RELAY_HPKE_CHUNK = 1008;
const RELAY_HPKE_MAGIC = Buffer.from("UEPH", "ascii");
const RELAY_HPKE_VERSION = 1;

function relayInfo(ctx: { networkId: string; recipientId: string }): Buffer {
  return Buffer.concat([enc8("uep.service.relay.v1/hpke"), Buffer.from([0]), enc8(ctx.networkId), Buffer.from([0]), enc8(ctx.recipientId)]);
}

/**
 * Seal `content` for the relay recipient: one HPKE context, the content cut
 * into RELAY_HPKE_CHUNK-byte chunks sealed in order with aad = index ||
 * total, so chunks cannot be reordered, dropped or truncated unnoticed. The
 * sealed blob (magic, version, enc, chunk count, sealed chunks; each sealed
 * chunk is exactly 1 KiB except the last) is what the sender hands to the
 * relay provider; prepareBlob() / the fraud proofs work on it unchanged.
 * `info` binds the network and the recipient id.
 */
export function sealRelayPayload(recipientPublicKey: Uint8Array, content: Uint8Array, ctx: { networkId: string; recipientId: string }, testOnlyEphemeralIkm?: Uint8Array): Buffer {
  const total = Math.max(1, Math.ceil(content.length / RELAY_HPKE_CHUNK));
  const { enc, context } = hpkeSetupSender(recipientPublicKey, relayInfo(ctx), testOnlyEphemeralIkm);
  const parts: Buffer[] = [RELAY_HPKE_MAGIC, Buffer.from([RELAY_HPKE_VERSION]), enc, i2osp(total, 4)];
  for (let i = 0; i < total; i++) {
    const chunk = content.subarray(i * RELAY_HPKE_CHUNK, (i + 1) * RELAY_HPKE_CHUNK);
    parts.push(context.seal(chunk, Buffer.concat([i2osp(i, 4), i2osp(total, 4)])));
  }
  return Buffer.concat(parts);
}

/** Open a sealed relay payload with the recipient's X25519 private key (HPKE_OPEN_FAILED on any change). */
export function openRelayPayload(recipientPrivateKey: Uint8Array, sealed: Uint8Array, ctx: { networkId: string; recipientId: string }): Buffer {
  const b = Buffer.from(sealed);
  const head = 4 + 1 + NENC + 4;
  if (b.length < head + NT || !b.subarray(0, 4).equals(RELAY_HPKE_MAGIC) || b[4] !== RELAY_HPKE_VERSION) throw new Error("HPKE_RELAY_FORMAT");
  const enc = b.subarray(5, 5 + NENC);
  const total = b.readUInt32BE(5 + NENC);
  const context = hpkeSetupRecipient(enc, recipientPrivateKey, relayInfo(ctx));
  const out: Buffer[] = [];
  let off = head;
  for (let i = 0; i < total; i++) {
    const len = i < total - 1 ? RELAY_HPKE_CHUNK + NT : b.length - off;
    if (len < NT || len > RELAY_HPKE_CHUNK + NT || off + len > b.length) throw new Error("HPKE_RELAY_FORMAT");
    out.push(context.open(b.subarray(off, off + len), Buffer.concat([i2osp(i, 4), i2osp(total, 4)])));
    off += len;
  }
  if (off !== b.length) throw new Error("HPKE_RELAY_FORMAT");
  return Buffer.concat(out);
}
