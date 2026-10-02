/**
 * UEP-ADDR-002 — Bech32m address codec (reference implementation).
 * Does not change SpendCircuit. Legacy UepAddressV1 remains in address.ts.
 */
import { Fr } from "../core/field.ts";
import { bech32mDecode, bech32mEncode, convertBits } from "./bech32m.ts";

export const ADDR_V2_VERSION = 1;
export const ADDR_PAYLOAD_LEN = 38;

export type NetworkId = "dev" | "local" | "testnet" | "main";

export type AddrType = 0 | 1 | 2 | 3;

export const AddrTypeName = {
  RECEIVE: 0 as AddrType,
  STATIC: 1 as AddrType,
  PAYMENT_REQ: 2 as AddrType,
  CONTRACT: 3 as AddrType,
};

export type DomainCode = number;

export const DomainCodeName: Record<string, DomainCode> = {
  unspecified: 0,
  earth: 1,
  mars: 2,
  orbit: 3,
};

const NETWORK_TO_HRP: Record<NetworkId, string> = {
  dev: "uepdev",
  local: "ueplocal",
  testnet: "ueptest",
  main: "uep",
};

const HRP_TO_NETWORK: Record<string, NetworkId> = {
  uepdev: "dev",
  ueplocal: "local",
  ueptest: "testnet",
  uep: "main",
};

export type DecodedAddressV2 = {
  networkId: NetworkId;
  domainCode: DomainCode;
  addrType: AddrType;
  addressId: Fr;
  version: number;
};

function u32Be(n: number): number[] {
  if (n < 0 || n > 0xffffffff) throw new Error("domain_code out of u32 range");
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function readU32Be(b: number[], o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** 32-byte big-endian Fr → number[] */
export function frToBytes32(fr: Fr): number[] {
  const hex = fr.toHex().replace(/^0x/i, "").padStart(64, "0");
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function bytes32ToFr(bytes: number[]): Fr {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  const hex = bytes.map((x) => x.toString(16).padStart(2, "0")).join("");
  return new Fr(hex);
}

export function buildPayloadV2(
  domainCode: DomainCode,
  addrType: AddrType,
  addressId: Fr,
  version = ADDR_V2_VERSION,
): number[] {
  if (version !== 1) throw new Error("only version 1 supported");
  if (addrType < 0 || addrType > 255) throw new Error("addr_type");
  return [version, ...u32Be(domainCode), addrType, ...frToBytes32(addressId)];
}

export function parsePayloadV2(bytes: number[]): Omit<DecodedAddressV2, "networkId"> {
  if (bytes.length !== ADDR_PAYLOAD_LEN) {
    throw new Error(`payload length ${bytes.length} ≠ ${ADDR_PAYLOAD_LEN}`);
  }
  const version = bytes[0]!;
  if (version !== 1) throw new Error(`unsupported address version ${version}`);
  const domainCode = readU32Be(bytes, 1);
  const addrType = bytes[5]! as AddrType;
  const addressId = bytes32ToFr(bytes.slice(6, 38));
  return { version, domainCode, addrType, addressId };
}

export function encodeAddressV2(opts: {
  networkId: NetworkId;
  domainCode: DomainCode;
  addrType?: AddrType;
  addressId: Fr;
}): string {
  const hrp = NETWORK_TO_HRP[opts.networkId];
  if (!hrp) throw new Error(`unknown network ${opts.networkId}`);
  const payload = buildPayloadV2(
    opts.domainCode,
    opts.addrType ?? AddrTypeName.RECEIVE,
    opts.addressId,
  );
  const five = convertBits(payload, 8, 5, true);
  if (!five) throw new Error("convertBits failed");
  return bech32mEncode(hrp, five);
}

export function decodeAddressV2(address: string): DecodedAddressV2 | null {
  try {
    const dec = bech32mDecode(address.trim());
    if (!dec) return null;
    const networkId = HRP_TO_NETWORK[dec.hrp];
    if (!networkId) return null;
    const eight = convertBits(dec.data, 5, 8, false);
    if (!eight || eight.length !== ADDR_PAYLOAD_LEN) return null;
    const fields = parsePayloadV2(eight);
    return { networkId, ...fields };
  } catch {
    return null;
  }
}

/** Reject if decoded network ≠ expected active profile. */
export function assertNetworkMatch(
  decoded: DecodedAddressV2,
  active: NetworkId,
): void {
  if (decoded.networkId !== active) {
    throw new Error(
      `network mismatch: address is ${decoded.networkId}, active is ${active}`,
    );
  }
}

/** domain_code → Fr for lab / future circuit binding. */
export function domainCodeToFr(code: DomainCode): Fr {
  return Fr.from(BigInt(code));
}
