/**
 * UEP security policy layer (node / wallet).
 *
 * Status: IMPLEMENTED for local TESTNET policy checks.
 * These are **not** consensus-critical R1CS constraints. They gate
 * submission before a transaction enters the ledger path.
 *
 * Does not change Poseidon, SMT, fee formula, or SpendCircuit.
 */

export type RiskTier = "experimental" | "registered" | "restricted" | "halted";

export type SecurityPolicyConfig = {
  /** Max amount (base units) per single spend. */
  maxTransferAmount: bigint;
  /** Max amount per account per rolling window. */
  maxTransferPerWindow: bigint;
  /** Window length in ms. */
  windowMs: number;
  /** Max spends per account per window. */
  maxTxPerWindow: number;
  /** Reject if fee below protocol minimum (0 allowed on testnet). */
  minFee: bigint;
  /** Global pause — rejects all spends when true. */
  paused: boolean;
  /** Per-asset overrides. */
  assetTier: Record<string, RiskTier>;
  /** Blocklist of account hex ids (lowercase). */
  blockedAccounts: Set<string>;
};

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; code: PolicyRejectCode; message: string };

export type PolicyRejectCode =
  | "PAUSED"
  | "AMOUNT_CAP"
  | "RATE_LIMIT"
  | "WINDOW_VOLUME"
  | "ASSET_HALTED"
  | "ASSET_RESTRICTED"
  | "ACCOUNT_BLOCKED"
  | "FEE_TOO_LOW";

export type SpendProbe = {
  accountHex: string;
  assetId: string;
  amount: bigint;
  fee: bigint;
  nowMs: number;
};

type WindowBucket = {
  windowStart: number;
  volume: bigint;
  txCount: number;
};

const DEFAULT_CONFIG: SecurityPolicyConfig = {
  maxTransferAmount: 10_000_000n,
  maxTransferPerWindow: 50_000_000n,
  windowMs: 60_000,
  maxTxPerWindow: 30,
  minFee: 0n,
  paused: false,
  assetTier: {
    "asset:test:eur": "experimental",
    "asset:test:btc": "experimental",
    "asset:test:energy": "experimental",
    "asset:test:data": "experimental",
    "asset:global:eur": "restricted",
  },
  blockedAccounts: new Set(),
};

export class SecurityPolicy {
  config: SecurityPolicyConfig;
  private windows = new Map<string, WindowBucket>();

  constructor(config: Partial<SecurityPolicyConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      assetTier: { ...DEFAULT_CONFIG.assetTier, ...(config.assetTier ?? {}) },
      blockedAccounts: new Set(config.blockedAccounts ?? DEFAULT_CONFIG.blockedAccounts),
    };
  }

  setPaused(paused: boolean) {
    this.config.paused = paused;
  }

  setAssetTier(assetId: string, tier: RiskTier) {
    this.config.assetTier[assetId] = tier;
  }

  blockAccount(accountHex: string) {
    this.config.blockedAccounts.add(accountHex.toLowerCase());
  }

  unblockAccount(accountHex: string) {
    this.config.blockedAccounts.delete(accountHex.toLowerCase());
  }

  private bucket(accountHex: string, nowMs: number): WindowBucket {
    const key = accountHex.toLowerCase();
    let b = this.windows.get(key);
    if (!b || nowMs - b.windowStart >= this.config.windowMs) {
      b = { windowStart: nowMs, volume: 0n, txCount: 0 };
      this.windows.set(key, b);
    }
    return b;
  }

  /**
   * Pre-submit check. Does not mutate window state unless `commit` is true.
   */
  check(probe: SpendProbe, commit = false): PolicyVerdict {
    const { config } = this;
    if (config.paused) {
      return { ok: false, code: "PAUSED", message: "Network spend path is paused by policy." };
    }
    const acc = probe.accountHex.toLowerCase();
    if (config.blockedAccounts.has(acc)) {
      return { ok: false, code: "ACCOUNT_BLOCKED", message: "Account is blocked by policy." };
    }
    const tier = config.assetTier[probe.assetId] ?? "experimental";
    if (tier === "halted") {
      return { ok: false, code: "ASSET_HALTED", message: `Asset ${probe.assetId} is halted.` };
    }
    if (tier === "restricted") {
      return {
        ok: false,
        code: "ASSET_RESTRICTED",
        message: `Asset ${probe.assetId} is restricted on this node.`,
      };
    }
    if (probe.amount > config.maxTransferAmount) {
      return {
        ok: false,
        code: "AMOUNT_CAP",
        message: `Amount exceeds maxTransferAmount (${config.maxTransferAmount}).`,
      };
    }
    if (probe.fee < config.minFee) {
      return { ok: false, code: "FEE_TOO_LOW", message: "Fee below policy minimum." };
    }
    const b = this.bucket(acc, probe.nowMs);
    if (b.txCount >= config.maxTxPerWindow) {
      return { ok: false, code: "RATE_LIMIT", message: "Too many spends in the current window." };
    }
    if (b.volume + probe.amount > config.maxTransferPerWindow) {
      return {
        ok: false,
        code: "WINDOW_VOLUME",
        message: "Rolling window volume cap exceeded.",
      };
    }
    if (commit) {
      b.txCount += 1;
      b.volume += probe.amount;
    }
    return { ok: true };
  }
}

export const defaultSecurityPolicy = new SecurityPolicy();
