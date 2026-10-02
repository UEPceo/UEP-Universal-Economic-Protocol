import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  createPaymentRequest,
  encodePaymentRequestUri,
  decodePaymentRequestUri,
  isPaymentRequestExpired,
  paymentRequestMac,
  verifyPaymentRequestMac,
  D_PAYMENT_REQ,
  type MerchantMacKey,
} from "./payment-request.ts";
import { DomainCodeName, decodeAddressV2 } from "./address-v2.ts";

const MERCHANT: MerchantMacKey = {
  kid: "m-cafe-1",
  key: "test-merchant-secret-key-32b!!",
};

const OTHER: MerchantMacKey = {
  kid: "m-other",
  key: "other-merchant-secret-key-32b!",
};

describe("UEP-ADDR-003 hardened payment MAC", () => {
  it("create → URI → decode with merchant verify", () => {
    const pr = createPaymentRequest({
      networkId: "testnet",
      domainCode: DomainCodeName.earth,
      addressId: Fr.from(42n),
      assetId: Fr.from(1n),
      amount: 2500n,
      expirySecondsFromNow: 600,
      memo: "coffee",
      orderId: "ord-1",
      merchant: MERCHANT,
    });
    assert.equal(pr.kid, "m-cafe-1");
    assert.equal(pr.mac?.length, 32);
    assert.ok(verifyPaymentRequestMac(pr, MERCHANT));
    const uri = encodePaymentRequestUri(pr);
    assert.ok(uri.includes("kid=m-cafe-1"));
    const dec = decodePaymentRequestUri(uri, MERCHANT);
    assert.ok(dec);
    assert.equal(dec!.amount, 2500n);
    assert.equal(dec!.memo, "coffee");
    assert.equal(decodeAddressV2(dec!.recipientAddress!)!.addressId.n, 42n);
  });

  it("rejects tampered amount", () => {
    const pr = createPaymentRequest({
      networkId: "local",
      addressId: Fr.from(7n),
      assetId: Fr.from(1n),
      amount: 100n,
      merchant: MERCHANT,
    });
    let uri = encodePaymentRequestUri(pr);
    uri = uri.replace("amt=100", "amt=999999");
    assert.equal(decodePaymentRequestUri(uri, MERCHANT), null);
  });

  it("rejects wrong merchant key", () => {
    const pr = createPaymentRequest({
      networkId: "dev",
      addressId: Fr.from(1n),
      assetId: Fr.from(1n),
      amount: 50n,
      merchant: MERCHANT,
    });
    const uri = encodePaymentRequestUri(pr);
    assert.equal(decodePaymentRequestUri(uri, OTHER), null);
    assert.equal(verifyPaymentRequestMac(pr, OTHER), false);
  });

  it("unsigned requests allowed but decode-without-key does not prove integrity", () => {
    const pr = createPaymentRequest({
      networkId: "main",
      addressId: Fr.from(9n),
      assetId: Fr.from(1n),
      amount: 1n,
      unsigned: true,
    });
    assert.equal(pr.mac, undefined);
    const uri = encodePaymentRequestUri(pr);
    const dec = decodePaymentRequestUri(uri);
    assert.ok(dec);
    assert.equal(dec!.amount, 1n);
  });

  it("domain tag constant is D_PAYMENT_REQ=7", () => {
    assert.equal(D_PAYMENT_REQ, 7);
  });

  it("expiry detection", () => {
    const pr = createPaymentRequest({
      networkId: "dev",
      addressId: Fr.from(1n),
      assetId: Fr.from(1n),
      expirySecondsFromNow: -10,
      unsigned: true,
    });
    assert.equal(isPaymentRequestExpired(pr), true);
  });

  it("mac stable for same key and fields", () => {
    const pr = createPaymentRequest({
      networkId: "main",
      domainCode: DomainCodeName.mars,
      addressId: Fr.from(99n),
      assetId: Fr.from(2n),
      amount: 1n,
      merchant: MERCHANT,
    });
    pr.expiry = 1_700_000_000;
    pr.mac = paymentRequestMac(pr, MERCHANT);
    assert.equal(paymentRequestMac(pr, MERCHANT), pr.mac);
  });
});
