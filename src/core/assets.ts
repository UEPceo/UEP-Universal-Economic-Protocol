/**
 * Asset registry. Examples, not a closed list. No universal UEP coin.
 * Status: IMPLEMENTED (local registry). Live issuer attestations: CONCEPTUAL.
 */
export type AssetStatus = "experimental" | "registered" | "deprecated";

export type AssetRecord = {
  assetId: string;
  symbol: string;
  name: string;
  issuer: string;
  decimals: number;
  network: string;
  metadata: string;
  status: AssetStatus;
  unit?: string;
};

export const TESTNET_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:test:eur",
    symbol: "tEUR",
    name: "Test Euro",
    issuer: "uep-testnet-faucet",
    decimals: 2,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not euros.",
    status: "experimental",
  },
  {
    assetId: "asset:test:btc",
    symbol: "tBTC",
    name: "Test Bitcoin",
    issuer: "uep-testnet-faucet",
    decimals: 8,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not bitcoin.",
    status: "experimental",
  },
  {
    assetId: "asset:test:energy",
    symbol: "tENERGY",
    name: "Test Energy",
    issuer: "uep-testnet-faucet",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental kilowatt-hour credit.",
    status: "experimental",
    unit: "kWh",
  },
  {
    assetId: "asset:test:data",
    symbol: "tDATA",
    name: "Test Data",
    issuer: "uep-testnet-faucet",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental data credit.",
    status: "experimental",
    unit: "GB",
  },
];

export const GLOBAL_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:global:eur",
    symbol: "EUR",
    name: "Euro",
    issuer: "unconfigured",
    decimals: 2,
    network: "uep-global-1",
    metadata: "Reserved. No live GLOBAL issuer.",
    status: "registered",
  },
];

export const INTERPLANETARY_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:ip:energy",
    symbol: "sENERGY",
    name: "Simulated Energy",
    issuer: "uep-interplanetary-sim",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "kWh",
  },
  {
    assetId: "asset:ip:compute",
    symbol: "sCOMPUTE",
    name: "Simulated Compute",
    issuer: "uep-interplanetary-sim",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "hours",
  },
];

export function assetsForNetwork(networkId: string): AssetRecord[] {
  if (networkId === "uep-testnet-1") return TESTNET_ASSETS;
  if (networkId === "uep-global-1") return GLOBAL_ASSETS;
  if (networkId === "uep-interplanetary-1") return INTERPLANETARY_ASSETS;
  return [];
}

export function findAsset(networkId: string, assetId: string): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => a.assetId === assetId);
}

export function formatAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}
