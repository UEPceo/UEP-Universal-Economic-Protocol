/**
 * v0.5.3: published test vectors for the cryptography the protocol relies on.
 * In-house code: RFC 9162 Merkle (roots, inclusion, consistency) and Poseidon
 * BN254. Platform primitives wrapped by the protocol (node:crypto): Ed25519
 * (RFC 8032), SHA-256 (FIPS 180-4), ChaCha20 (RFC 8439), HKDF (RFC 5869).
 * All keys below are the public RFC test keys, never real keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, hkdfSync } from "node:crypto";
import {
  merkleConsistencyProof,
  merkleLeafHash,
  merkleNodeHash,
  merklePath,
  merkleRoot,
  verifyMerkleConsistency,
  verifyMerklePath,
} from "./rfc9162-merkle.ts";
import { poseidon2 } from "./poseidon.ts";
import { signEd25519, verifyEd25519 } from "./ed25519.ts";
import { chacha20 } from "../category/relay-crypto.ts";

const hex = (s: string) => Buffer.from(s, "hex");
// RFC 6962 / certificate-transparency reference inputs.
const CT_LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(hex);
const CT_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
const LH = CT_LEAVES.map(merkleLeafHash);

test("RFC 9162 Merkle: reference roots for sizes 1..8", () => {
  for (let n = 1; n <= 8; n++) assert.equal(merkleRoot(LH.slice(0, n)).toString("hex"), CT_ROOTS[n - 1], `size ${n}`);
  assert.equal(LH[1]!.toString("hex"), "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7");
});

test("RFC 9162 section 2.1.5 examples: inclusion and consistency proofs (7-leaf tree)", () => {
  const [a, b, c, d, e, f, j] = LH as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
  const g = merkleNodeHash(a, b), h = merkleNodeHash(c, d), i = merkleNodeHash(e, f);
  const k = merkleNodeHash(g, h), l = merkleNodeHash(i, j);
  const seven = LH.slice(0, 7);
  const eq = (got: Buffer[], want: Buffer[]) => assert.deepEqual(got.map((x) => x.toString("hex")), want.map((x) => x.toString("hex")));
  eq(merklePath(seven, 0), [b, h, l]);
  eq(merklePath(seven, 3), [c, g, l]);
  eq(merklePath(seven, 4), [f, j, k]);
  eq(merklePath(seven, 6), [i, k]);
  eq(merkleConsistencyProof(seven, 3), [c, d, g, l]);
  eq(merkleConsistencyProof(seven, 4), [l]);
  eq(merkleConsistencyProof(seven, 6), [i, j, k]);
  const root7 = merkleRoot(seven);
  assert.ok(verifyMerkleConsistency(3, 7, merkleRoot(LH.slice(0, 3)), root7, [c, d, g, l]));
  assert.ok(verifyMerkleConsistency(4, 7, merkleRoot(LH.slice(0, 4)), root7, [l]));
  assert.ok(verifyMerkleConsistency(6, 7, merkleRoot(LH.slice(0, 6)), root7, [i, j, k]));
});

test("RFC 9162 Merkle: every inclusion and consistency proof verifies up to 40 leaves; tampering fails", () => {
  const leaves = Array.from({ length: 40 }, (_, x) => merkleLeafHash(Buffer.from([x, x ^ 0x5a])));
  for (let n = 1; n <= 40; n++) {
    const tree = leaves.slice(0, n);
    const root = merkleRoot(tree);
    for (let idx = 0; idx < n; idx++) {
      const p = merklePath(tree, idx);
      assert.ok(verifyMerklePath(tree[idx]!, idx, n, p, root));
      if (n > 1) assert.equal(verifyMerklePath(tree[idx]!, (idx + 1) % n, n, p, root), false);
    }
    for (let m = 1; m <= n; m++) {
      const first = merkleRoot(leaves.slice(0, m));
      const proof = merkleConsistencyProof(tree, m);
      assert.ok(verifyMerkleConsistency(m, n, first, root, proof), `consistency ${m}->${n}`);
      if (proof.length > 0) {
        const bad = proof.map((x, q) => (q === 0 ? merkleLeafHash(x) : x));
        assert.equal(verifyMerkleConsistency(m, n, first, root, bad), false);
      }
      if (m < n) assert.equal(verifyMerkleConsistency(m, n, merkleRoot(leaves.slice(1, m + 1)), root, proof), false);
    }
  }
  assert.equal(verifyMerkleConsistency(5, 4, LH[0]!, LH[0]!, []), false);
});

test("Poseidon BN254: circomlib / iden3 reference vector poseidon([1, 2])", () => {
  assert.equal(poseidon2(1n, 2n), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
});

test("Ed25519 (RFC 8032 section 7.1, tests 1 and 2) through the protocol wrappers", () => {
  const pkcs8 = (seed: string) => createPrivateKey({ key: hex("302e020100300506032b657004220420" + seed), format: "der", type: "pkcs8" });
  const cases = [
    { seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", msg: "", sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
    { seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", msg: "72", sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
  ];
  for (const t of cases) {
    assert.equal(signEd25519(hex(t.msg), pkcs8(t.seed)), t.sig);
    assert.ok(verifyEd25519(hex(t.msg), t.sig, t.pub));
    assert.equal(verifyEd25519(Buffer.concat([hex(t.msg), Buffer.from([1])]), t.sig, t.pub), false);
  }
});

test("SHA-256 (FIPS 180-4) and HKDF-SHA256 (RFC 5869 test case 1)", () => {
  assert.equal(createHash("sha256").update("abc").digest("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const okm = Buffer.from(hkdfSync("sha256", Buffer.alloc(22, 0x0b), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42));
  assert.equal(okm.toString("hex"), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
});

test("ChaCha20 (RFC 8439 section 2.4.2) through relay-crypto", () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, x) => x));
  const nonce = hex("000000000000004a00000000");
  const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const ct = chacha20(key, 1, nonce, pt);
  assert.equal(
    ct.toString("hex"),
    "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d",
  );
  assert.deepEqual(chacha20(key, 1, nonce, ct), pt);
});
