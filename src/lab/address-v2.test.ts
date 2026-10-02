import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  encodeAddressV2,
  decodeAddressV2,
  assertNetworkMatch,
  DomainCodeName,
  AddrTypeName,
  buildPayloadV2,
  ADDR_PAYLOAD_LEN,
  frToBytes32,
  bytes32ToFr,
} from "./address-v2.ts";
import { bech32mDecode, bech32mEncode, convertBits } from "./bech32m.ts";

describe("UEP-ADDR-002 Bech32m primitives", () => {
  it("roundtrips convertBits 8↔5", () => {
    const bytes = [1, 2, 3, 4, 5, 255, 0, 128];
    const five = convertBits(bytes, 8, 5, true)!;
    const back = convertBits(five, 5, 8, false)!;
    assert.deepEqual(back, bytes);
  });

  it("bech32m checksum rejects tampering", () => {
    const data = convertBits([1, 2, 3, 4], 8, 5, true)!;
    const enc = bech32mEncode("ueptest", data);
    const bad = enc.slice(0, -1) + (enc.endsWith("q") ? "p" : "q");
    assert.equal(bech32mDecode(bad), null);
  });
});

describe("UEP-ADDR-002 address codec", () => {
  const id = new Fr(
    "275ddb934b17949649b41f3dd6aaad6a23a3dbb661b2594c07d6671369998058",
  );

  it("payload is exactly 38 bytes", () => {
    const p = buildPayloadV2(DomainCodeName.earth, AddrTypeName.RECEIVE, id);
    assert.equal(p.length, ADDR_PAYLOAD_LEN);
    assert.equal(p[0], 1);
  });

  it("Fr 32-byte roundtrip", () => {
    assert.equal(bytes32ToFr(frToBytes32(id)).toHex(), id.toHex());
  });

  it("encode/decode roundtrip testnet/earth/receive", () => {
    const enc = encodeAddressV2({
      networkId: "testnet",
      domainCode: DomainCodeName.earth,
      addrType: AddrTypeName.RECEIVE,
      addressId: id,
    });
    assert.ok(enc.startsWith("ueptest1"));
    assert.equal(enc, enc.toLowerCase());
    const dec = decodeAddressV2(enc);
    assert.ok(dec);
    assert.equal(dec!.networkId, "testnet");
    assert.equal(dec!.domainCode, 1);
    assert.equal(dec!.addrType, 0);
    assert.equal(dec!.addressId.toHex(), id.toHex());
    assert.equal(dec!.version, 1);
  });

  it("network isolation: local ≠ testnet", () => {
    const enc = encodeAddressV2({
      networkId: "local",
      domainCode: DomainCodeName.earth,
      addressId: id,
    });
    const dec = decodeAddressV2(enc)!;
    assert.equal(dec.networkId, "local");
    assert.throws(() => assertNetworkMatch(dec, "testnet"));
  });

  it("rejects mixed case", () => {
    const enc = encodeAddressV2({
      networkId: "dev",
      domainCode: 0,
      addressId: Fr.from(1n),
    });
    const mixed = enc.slice(0, 4).toUpperCase() + enc.slice(4);
    assert.equal(decodeAddressV2(mixed), null);
  });

  it("different domain codes → different strings", () => {
    const a = encodeAddressV2({
      networkId: "main",
      domainCode: DomainCodeName.earth,
      addressId: id,
    });
    const b = encodeAddressV2({
      networkId: "main",
      domainCode: DomainCodeName.mars,
      addressId: id,
    });
    assert.notEqual(a, b);
    assert.ok(a.startsWith("uep1"));
    assert.equal(decodeAddressV2(b)!.domainCode, DomainCodeName.mars);
  });

  it("frozen test vector (version/domain/type/id)", () => {
    // Deterministic vector for regression
    const enc = encodeAddressV2({
      networkId: "testnet",
      domainCode: DomainCodeName.earth,
      addrType: AddrTypeName.RECEIVE,
      addressId: Fr.from(1n),
    });
    const dec = decodeAddressV2(enc)!;
    assert.equal(dec.addressId.n, 1n);
    // Re-encode must be stable
    assert.equal(
      encodeAddressV2({
        networkId: "testnet",
        domainCode: 1,
        addrType: 0,
        addressId: Fr.from(1n),
      }),
      enc,
    );
    // Snapshot the full string so packaging changes break the test
    assert.equal(
      enc,
      "ueptest1qyqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqwnptw",
    );
  });
});
