/**
 * UEP-ADDR-003 — Payment Request / QR (hardened MAC).
 *
 * URI:
 *   uep:pay?v=1&net=...&dom=...&addr=...&asset=...&amt=...&exp=...&kid=...&mac=...
 *
 * MAC (v1 hardened):
 *   HMAC-SHA256(
 *     key  = merchantMacKey (32+ bytes recommended),
 *     msg  = "UEP-D_PAYMENT_REQ|" || canonical fields
 *   )
 *   mac = hex(HMAC)[0..32]   // 16 bytes, QR-friendly
 *
 * This binds the request to a merchant key under domain tag D_PAYMENT_REQ=7
 * (ADDR-001). It is not yet a public-key signature; kid identifies which key.
 * Without a valid key, MAC verification fails (no more keyless SHA-256).
 */

import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "./timing-safe.ts";
import { Fr } from "../core/field.ts";
import {
  decodeAddressV2,
  encodeAddressV2,
  type NetworkId,
  type DomainCode,
  type AddrType,
  DomainCodeName,
} from "./address-v2.ts";

export const PAYMENT_REQ_VERSION = 1;

/** Reserved domain tag from UEP-ADDR-001 (§2.1). */
export const D_PAYMENT_REQ = 7;

export type PaymentRequest = {
  version: number;
  networkId: NetworkId;
  domainCode: DomainCode;
  recipientAddress?: string;
  addressId: Fr;
  addrType?: AddrType;
  assetId: Fr;
  amount?: bigint;
  expiry?: number;
  memo?: string;
  orderId?: string;
  /** Key id for merchant MAC key (required when mac is set). */
  kid?: string;
  /** HMAC hex (32 chars = 16 bytes). */
  mac?: string;
};

export type MerchantMacKey = {
  kid: string;
  /** Secret key material (UTF-8 or hex). Never embed in QR. */
  key: string | Buffer;
};

function canonicalPayload(p: PaymentRequest): string {
  // Stable order; domain tag first so transcripts cannot be reinterpreted.
  const parts = [
    `dtag=${D_PAYMENT_REQ}`,
    `v=${p.version}`,
    `net=${p.networkId}`,
    `dom=${p.domainCode}`,
    `id=${p.addressId.toHex()}`,
    `asset=${p.assetId.toHex()}`,
    p.amount !== undefined ? `amt=${p.amount.toString()}` : "amt=",
    p.expiry !== undefined ? `exp=${p.expiry}` : "exp=",
    `memo=${p.memo ?? ""}`,
    `order=${p.orderId ?? ""}`,
    `kid=${p.kid ?? ""}`,
  ];
  return parts.join("&");
}

function macMessage(p: PaymentRequest): string {
  return `UEP-D_PAYMENT_REQ|${canonicalPayload(p)}`;
}

/**
 * Compute payment-request MAC. Requires merchant key (no keyless integrity).
 */
export function paymentRequestMac(p: PaymentRequest, merchant: MerchantMacKey): string {
  const keyBuf = typeof merchant.key === "string" ? Buffer.from(merchant.key, "utf8") : merchant.key;
  if (keyBuf.length < 16) {
    throw new Error("merchant MAC key must be at least 16 bytes");
  }
  const body = { ...p, kid: merchant.kid, mac: undefined };
  const digest = createHmac("sha256", keyBuf).update(macMessage(body), "utf8").digest("hex");
  return digest.slice(0, 32);
}

export function verifyPaymentRequestMac(
  p: PaymentRequest,
  merchant: MerchantMacKey,
): boolean {
  if (!p.mac || !p.kid) return false;
  if (p.kid !== merchant.kid) return false;
  let expect: string;
  try {
    expect = paymentRequestMac(p, merchant);
  } catch {
    return false;
  }
  return timingSafeEqualHex(p.mac, expect);
}

export function createPaymentRequest(opts: {
  networkId: NetworkId;
  domainCode?: DomainCode;
  addressId: Fr;
  assetId: Fr;
  amount?: bigint;
  expirySecondsFromNow?: number;
  memo?: string;
  orderId?: string;
  addrType?: AddrType;
  /** Required for signed/MAC'd requests (default path). */
  merchant?: MerchantMacKey;
  /** Explicitly create unsigned request (discouraged for QR amounts). */
  unsigned?: boolean;
}): PaymentRequest {
  const domainCode = opts.domainCode ?? DomainCodeName.earth;
  const recipientAddress = encodeAddressV2({
    networkId: opts.networkId,
    domainCode,
    addrType: opts.addrType,
    addressId: opts.addressId,
  });
  const pr: PaymentRequest = {
    version: PAYMENT_REQ_VERSION,
    networkId: opts.networkId,
    domainCode,
    recipientAddress,
    addressId: opts.addressId,
    addrType: opts.addrType,
    assetId: opts.assetId,
    amount: opts.amount,
    expiry:
      opts.expirySecondsFromNow !== undefined
        ? Math.floor(Date.now() / 1000) + opts.expirySecondsFromNow
        : undefined,
    memo: opts.memo,
    orderId: opts.orderId,
  };
  if (!opts.unsigned) {
    if (!opts.merchant) {
      throw new Error("merchant MAC key required (or pass unsigned: true)");
    }
    pr.kid = opts.merchant.kid;
    pr.mac = paymentRequestMac(pr, opts.merchant);
  }
  return pr;
}

export function encodePaymentRequestUri(p: PaymentRequest): string {
  const q = new URLSearchParams();
  q.set("v", String(p.version));
  q.set("net", p.networkId);
  q.set("dom", String(p.domainCode));
  if (p.recipientAddress) q.set("addr", p.recipientAddress);
  else q.set("id", p.addressId.toHex());
  q.set("asset", p.assetId.toHex());
  if (p.amount !== undefined) q.set("amt", p.amount.toString());
  if (p.expiry !== undefined) q.set("exp", String(p.expiry));
  if (p.memo) q.set("memo", p.memo);
  if (p.orderId) q.set("order", p.orderId);
  if (p.kid) q.set("kid", p.kid);
  if (p.mac) q.set("mac", p.mac);
  return `uep:pay?${q.toString()}`;
}

/**
 * Decode URI. If `merchant` is provided, MAC is verified and invalid → null.
 * If merchant is omitted, MAC is not verified (parse-only); wallets should always verify.
 */
export function decodePaymentRequestUri(
  uri: string,
  merchant?: MerchantMacKey,
): PaymentRequest | null {
  try {
    const s = uri.trim();
    if (!s.toLowerCase().startsWith("uep:pay?")) return null;
    const q = new URLSearchParams(s.slice(s.indexOf("?") + 1));
    const version = Number(q.get("v") ?? "0");
    if (version !== PAYMENT_REQ_VERSION) return null;
    const networkId = q.get("net") as NetworkId;
    if (!["dev", "local", "testnet", "main"].includes(networkId)) return null;
    const domainCode = Number(q.get("dom") ?? "0");
    const addrStr = q.get("addr");
    let addressId: Fr;
    let recipientAddress: string | undefined;
    if (addrStr) {
      const dec = decodeAddressV2(addrStr);
      if (!dec) return null;
      if (dec.networkId !== networkId) return null;
      if (dec.domainCode !== domainCode) return null;
      addressId = dec.addressId;
      recipientAddress = addrStr;
    } else {
      const id = q.get("id");
      if (!id) return null;
      addressId = new Fr(id);
    }
    const asset = q.get("asset");
    if (!asset) return null;
    const amt = q.get("amt");
    const exp = q.get("exp");
    const pr: PaymentRequest = {
      version,
      networkId,
      domainCode,
      recipientAddress,
      addressId,
      assetId: new Fr(asset),
      amount: amt != null && amt !== "" ? BigInt(amt) : undefined,
      expiry: exp != null && exp !== "" ? Number(exp) : undefined,
      memo: q.get("memo") || undefined,
      orderId: q.get("order") || undefined,
      kid: q.get("kid") || undefined,
      mac: q.get("mac") || undefined,
    };
    if (merchant) {
      if (!verifyPaymentRequestMac(pr, merchant)) return null;
    }
    return pr;
  } catch {
    return null;
  }
}

export function isPaymentRequestExpired(
  p: PaymentRequest,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  return p.expiry !== undefined && nowSec > p.expiry;
}

export function encodePaymentRequestJson(p: PaymentRequest): string {
  return JSON.stringify({
    v: p.version,
    net: p.networkId,
    dom: p.domainCode,
    addr: p.recipientAddress,
    id: p.addressId.toHex(),
    asset: p.assetId.toHex(),
    amt: p.amount?.toString(),
    exp: p.expiry,
    memo: p.memo,
    order: p.orderId,
    kid: p.kid,
    mac: p.mac,
  });
}
