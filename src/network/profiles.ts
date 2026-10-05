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
import { REFERENCE_BLOCK_TIME_MS } from "../core/height.ts";

export type NetworkProfile = {
  networkId: string;
  displayName: string;
  chainId: string;
  genesisHash: string;
  protocolVersion: string;
  rpcEndpoints: string[];
  bootstrapNodes: string[];
  assetRegistry: readonly AssetRecord[];
  simulation: boolean;
  /**
   * v0.5.1: block time (ms) the height-based windows are computed with. The
   * single-node height producer never seals blocks closer than this. Safe range
   * for the published windows: blocks of at least 3.34 s keep the worst-case
   * Earth-Mars round trip inside the MARS reservation window, at least 1.82 s
   * the one-way telemetry age; slower blocks only lengthen the windows.
   */
  referenceBlockTimeMs: number;
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
  referenceBlockTimeMs: REFERENCE_BLOCK_TIME_MS,
};

/** Public testnet treasury account identifier. Not a private key or credential. */
export const TREASURY_ID = new Fr(0x5545505f54524541n); // "UEP_TREA"
