/**
 * AddressEncoder — modular because the core has not frozen an address format.
 * Current encoding: uep:<networkId>:<accountIdHex>
 * Status: LEGACY LAB ONLY — production wallets must use address-v2 (UEP-ADDR-002 Bech32m).
 */
import { Fr } from "./field.ts";

export const ADDRESS_VERSION = 1;

export type DecodedAddress = {
  networkId: string;
  accountId: Fr;
};

export interface AddressEncoder {
  encode(networkId: string, accountId: Fr): string;
  decode(address: string): DecodedAddress | null;
}

export const UepAddressV1: AddressEncoder = {
  encode(networkId: string, accountId: Fr): string {
    return `uep:${networkId}:${accountId.toHex()}`;
  },
  decode(address: string): DecodedAddress | null {
    const raw = address.trim();
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    if (parts[0] !== "uep") return null;
    const networkId = parts[1] ?? "";
    const hex = parts[2] ?? "";
    if (!networkId || !/^[0-9a-f]{64}$/.test(hex)) return null;
    return { networkId, accountId: new Fr(hex) };
  },
};

export function shortId(hex: string, n = 6): string {
  if (hex.length <= n * 2 + 1) return hex;
  return hex.slice(0, n) + "…" + hex.slice(-n);
}
