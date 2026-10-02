/**
 * Public UEP TESTNET profile.
 *
 * This repository intentionally exposes only the reproducible local testnet
 * profile. GLOBAL and INTERPLANETARY profiles are not public endpoints and are
 * not represented as live networks here.
 */
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { hTx } from "../core/hash.ts";
import { TESTNET_ASSETS, type AssetRecord } from "../core/assets.ts";

export type NetworkProfile = {
  networkId: string;
  displayName: string;
  chainId: string;
  genesisHash: string;
  protocolVersion: string;
  rpcEndpoints: string[];
  bootstrapNodes: string[];
  assetRegistry: AssetRecord[];
  simulation: boolean;
};

function genesis(networkId: string, chainId: string): string {
  return hTx(encodeStringToFr(networkId), encodeStringToFr(chainId)).toHex();
}

export const TESTNET: NetworkProfile = {
  networkId: "uep-testnet-1",
  displayName: "UEP TESTNET",
  chainId: "uep-testnet-1",
  genesisHash: genesis("uep-testnet-1", "uep-testnet-1"),
  protocolVersion: "UEP-25-public-reference",
  rpcEndpoints: ["local://uep-testnet-1"],
  bootstrapNodes: ["local-test-node"],
  assetRegistry: TESTNET_ASSETS,
  simulation: false,
};

/** Public testnet treasury account identifier. Not a private key or credential. */
export const TREASURY_ID = new Fr(0x5545505f54524541n); // "UEP_TREA"
