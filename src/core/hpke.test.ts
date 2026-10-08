/**
 * v0.5.3: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
 * ChaCha20-Poly1305, checked against RFC 9180 Appendix A.2.1; relay payload
 * end-to-end encryption on top of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hpkeDeriveKeyPair, hpkeSetupRecipient, hpkeSetupSender, hpkeSeal, hpkeOpen, openRelayPayload, sealRelayPayload } from "./hpke.ts";
import { prepareBlob, unwrapChunk, CHUNK } from "../category/relay.ts";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
// RFC 9180, A.2.1 (mode 0, kem 32, kdf 1, aead 3).
const V = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  ikmE: hex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b"),
  pkEm: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
  skEm: "f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600",
  ikmR: hex("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df"),
  pkRm: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
  skRm: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
  enc: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
  sharedSecret: "0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7",
  keyScheduleContext: "00431df6cd95e11ff49d7013563baf7f11588c75a6611ee2a4404a49306ae4cfc5b69c5718a60cc5876c358d3f7fc31ddb598503f67be58ea1e798c0bb19eb9796",
  secret: "5b9cd775e64b437a2335cf499361b2e0d5e444d5cb41a8a53336d8fe402282c6",
  key: "ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91",
  baseNonce: "5c4d98150661b848853b547f",
  exporterSecret: "a3b010d4994890e2c6968a36f64470d3c824c8f5029942feb11e7a74b2921922",
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  encryptions: [
    [0, "436f756e742d30", "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28"],
    [1, "436f756e742d31", "6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c"],
    [2, "436f756e742d32", "71146bd6795ccc9c49ce25dda112a48f202ad220559502cef1f34271e0cb4b02b4f10ecac6f48c32f878fae86b"],
    [4, "436f756e742d34", "63357a2aa291f5a4e5f27db6baa2af8cf77427c7c1a909e0b37214dd47db122bb153495ff0b02e9e54a50dbe16"],
    [255, "436f756e742d323535", "18ab939d63ddec9f6ac2b60d61d36a7375d2070c9b683861110757062c52b8880a5f6b3936da9cd6c23ef2a95c"],
    [256, "436f756e742d323536", "7a4a13e9ef23978e2c520fd4d2e757514ae160cd0cd05e556ef692370ca53076214c0c40d4c728d6ed9e727a5b"],
  ] as const,
  exports: [
    ["", "4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e"],
    ["00", "8c1df14732580e5501b00f82b10a1647b40713191b7c1240ac80e2b68808ba69"],
    ["54657374436f6e74657874", "5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53"],
  ] as const,
};

test("RFC 9180 A.2.1: DeriveKeyPair, encapsulation and key schedule", () => {
  const e = hpkeDeriveKeyPair(V.ikmE);
  assert.equal(e.privateKey.toString("hex"), V.skEm);
  assert.equal(e.publicKey.toString("hex"), V.pkEm);
  const r = hpkeDeriveKeyPair(V.ikmR);
  assert.equal(r.privateKey.toString("hex"), V.skRm);
  assert.equal(r.publicKey.toString("hex"), V.pkRm);
  const s = hpkeSetupSender(r.publicKey, V.info, V.ikmE);
  assert.equal(s.enc.toString("hex"), V.enc);
  assert.equal(s.sharedSecret.toString("hex"), V.sharedSecret);
  const ks = s.context.schedule;
  assert.equal(ks.keyScheduleContext.toString("hex"), V.keyScheduleContext);
  assert.equal(ks.secret.toString("hex"), V.secret);
  assert.equal(ks.key.toString("hex"), V.key);
  assert.equal(ks.baseNonce.toString("hex"), V.baseNonce);
  assert.equal(ks.exporterSecret.toString("hex"), V.exporterSecret);
});

test("RFC 9180 A.2.1.1: encryptions at sequence numbers 0, 1, 2, 4, 255, 256 and A.2.1.2 exports", () => {
  const r = hpkeDeriveKeyPair(V.ikmR);
  const s = hpkeSetupSender(r.publicKey, V.info, V.ikmE).context;
  const rc = hpkeSetupRecipient(hex(V.enc), r.privateKey, V.info);
  let seq = 0;
  for (const [n, aad, ct] of V.encryptions) {
    while (seq < n) { const filler = s.seal(Buffer.from("x")); rc.open(filler); seq++; }
    const out = s.seal(V.pt, hex(aad));
    assert.equal(out.toString("hex"), ct, `sequence ${n}`);
    assert.deepEqual(rc.open(out, hex(aad)), V.pt);
    seq++;
  }
  for (const [ctx, value] of V.exports) assert.equal(s.export(hex(ctx), 32).toString("hex"), value);
});

test("single-shot seal / open; tampering, wrong aad or wrong key fail", () => {
  const r = hpkeDeriveKeyPair(Buffer.alloc(32, 7));
  const other = hpkeDeriveKeyPair(Buffer.alloc(32, 8));
  const { enc, ciphertext } = hpkeSeal(r.publicKey, Buffer.from("info"), Buffer.from("aad"), Buffer.from("hello"));
  assert.equal(hpkeOpen(enc, r.privateKey, Buffer.from("info"), Buffer.from("aad"), ciphertext).toString(), "hello");
  const bad = Buffer.from(ciphertext); bad[0]! ^= 1;
  assert.throws(() => hpkeOpen(enc, r.privateKey, Buffer.from("info"), Buffer.from("aad"), bad), /HPKE_OPEN_FAILED/);
  assert.throws(() => hpkeOpen(enc, r.privateKey, Buffer.from("info"), Buffer.from("other"), ciphertext), /HPKE_OPEN_FAILED/);
  assert.throws(() => hpkeOpen(enc, other.privateKey, Buffer.from("info"), Buffer.from("aad"), ciphertext), /HPKE_OPEN_FAILED/);
});

test("relay: the published fair-exchange key reveals only HPKE ciphertext; the recipient opens the payload", () => {
  const recipient = hpkeDeriveKeyPair(Buffer.alloc(32, 9));
  const ctx = { networkId: "uep-testnet-1", recipientId: "recipient-1" };
  const content = Buffer.alloc(5_000);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  const sealed = sealRelayPayload(recipient.publicKey, content, ctx);
  // The provider commits to and wraps the sealed payload exactly as before (fraud proofs unchanged).
  const k = Buffer.alloc(32, 3);
  const blob = prepareBlob(sealed, k, ctx.networkId, "order-1");
  const unwrapped = Buffer.concat(Array.from({ length: blob.commitment.leafCount }, (_, i) => unwrapChunk(blob.wrapped.subarray(i * CHUNK, (i + 1) * CHUNK), k, i, ctx.networkId, "order-1"))).subarray(0, sealed.length);
  assert.deepEqual(unwrapped, sealed, "anyone with the published key sees the sealed payload");
  assert.equal(unwrapped.includes(content.subarray(100, 132)), false, "but not the content");
  assert.deepEqual(openRelayPayload(recipient.privateKey, unwrapped, ctx), content);
  // Bound to the recipient id and network; chunks cannot be reordered or truncated.
  assert.throws(() => openRelayPayload(recipient.privateKey, unwrapped, { ...ctx, recipientId: "someone-else" }), /HPKE_OPEN_FAILED/);
  assert.throws(() => openRelayPayload(recipient.privateKey, unwrapped.subarray(0, unwrapped.length - 100), ctx), /HPKE_OPEN_FAILED|HPKE_RELAY_FORMAT/);
  const swapped = Buffer.from(unwrapped);
  const head = 4 + 1 + 32 + 4;
  unwrapped.copy(swapped, head, head + 1024, head + 2048);
  unwrapped.copy(swapped, head + 1024, head, head + 1024);
  assert.throws(() => openRelayPayload(recipient.privateKey, swapped, ctx), /HPKE_OPEN_FAILED/);
});
