/**
 * UEP security policy layer (node / wallet).
 *
 * Status: IMPLEMENTED for local TESTNET policy checks.
 * These are **not** consensus-critical R1CS constraints. They gate
 * submission before a transaction enters the ledger path.
 *
 * Does not change Poseidon, SMT, fee formula, or SpendCircuit.
 *
 * v0.4.7: limits are evaluated per asset. Amount caps can be overridden per
 * asset (`assetLimits`), and the rolling volume is tracked per (account, asset):
 * units of different assets are never added together. The spend count per
 * account and window stays asset-independent (it counts transactions, not units).
 */

export type RiskTier = "experimental" | "registered" | "restricted" | "halted";

/** v0.4.7: per-asset overrides of the amount limits, in the asset's smallest unit. */
export type AssetLimits = {
  maxTransferAmount?: bigint;
  maxTransferPerWindow?: bigint;
  /** Smallest accepted spend amount for this asset (node-local; default: no minimum). */
  minTransferAmount?: bigint;
};

export type SecurityPolicyConfig = {
  /** Max amount (base units) per single spend. Default for assets without an override. */
  maxTransferAmount: bigint;
  /** Max amount per account and asset per rolling window. Default for assets without an override. */
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
  /** v0.4.7: per-asset amount limits (asset id -> overrides). */
  assetLimits: Record<string, AssetLimits>;
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
  | "FEE_TOO_LOW"
  /** v0.4.7: amount below the asset's `minTransferAmount`. */
  | "AMOUNT_TOO_SMALL";

export type SpendProbe = {
  accountHex: string;
  assetId: string;
  amount: bigint;
  fee: bigint;
  nowMs: number;
};

type WindowBucket = {
  windowStart: number;
  /** v0.4.7: rolling volume per asset id (never summed across assets). */
  volumeByAsset: Map<string, bigint>;
  txCount: number;
};

function normalizeAssetLimits(input: Record<string, AssetLimits> | undefined): Record<string, AssetLimits> {
  const out: Record<string, AssetLimits> = {};
  for (const [asset, limits] of Object.entries(input ?? {})) {
    const norm: AssetLimits = {};
    for (const k of ["maxTransferAmount", "maxTransferPerWindow", "minTransferAmount"] as const) {
      const v = (limits as Record<string, unknown> | undefined)?.[k];
      if (v === undefined || v === null) continue;
      const big = typeof v === "bigint" ? v : BigInt(v as string);
      if (big < 0n) throw new Error("INVALID_ASSET_LIMITS");
      norm[k] = big;
    }
    out[asset] = norm;
  }
  return out;
}

const DEFAULT_CONFIG: SecurityPolicyConfig = {
  maxTransferAmount: 10_000_000n,
  maxTransferPerWindow: 50_000_000n,
  windowMs: 60_000,
  maxTxPerWindow: 30,
  minFee: 0n,
  paused: false,
  assetTier: {
    "uep-test/teur": "experimental",
    "uep-test/tbtc": "experimental",
    "uep-test/tenergy": "experimental",
    "uep-test/tdata": "experimental",
    "uep-global/eur": "restricted",
  },
  blockedAccounts: new Set(),
  assetLimits: {},
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
      assetLimits: normalizeAssetLimits(config.assetLimits),
    };
  }

  /** v0.4.7: set or replace the amount limits of one asset. */
  setAssetLimits(assetId: string, limits: AssetLimits) {
    this.config.assetLimits = { ...this.config.assetLimits, ...normalizeAssetLimits({ [assetId]: limits }) };
  }

  /** v0.4.7: effective limits for one asset (per-asset override, else the global default). */
  limitsFor(assetId: string): { maxTransferAmount: bigint; maxTransferPerWindow: bigint; minTransferAmount: bigint } {
    const o = this.config.assetLimits[assetId] ?? {};
    return {
      maxTransferAmount: o.maxTransferAmount ?? this.config.maxTransferAmount,
      maxTransferPerWindow: o.maxTransferPerWindow ?? this.config.maxTransferPerWindow,
      minTransferAmount: o.minTransferAmount ?? 0n,
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
      b = { windowStart: nowMs, volumeByAsset: new Map(), txCount: 0 };
      this.windows.set(key, b);
    }
    return b;
  }

  /** v0.4.7: rolling volume of one account in one asset (current window). */
  windowVolume(accountHex: string, assetId: string, nowMs = Date.now()): bigint {
    const b = this.windows.get(accountHex.toLowerCase());
    if (!b || nowMs - b.windowStart >= this.config.windowMs) return 0n;
    return b.volumeByAsset.get(assetId) ?? 0n;
  }

  /**
   * v0.4.7: check a sequence of spends as if each were committed after the
   * previous one (used for atomic multi-note payments). Never mutates state.
   */
  checkSequence(probes: SpendProbe[]): PolicyVerdict {
    const saved = new Map<string, WindowBucket | undefined>();
    for (const p of probes) {
      const key = p.accountHex.toLowerCase();
      if (!saved.has(key)) {
        const b = this.windows.get(key);
        saved.set(key, b ? { ...b, volumeByAsset: new Map(b.volumeByAsset) } : undefined);
      }
    }
    try {
      for (const p of probes) {
        const v = this.check(p, true);
        if (!v.ok) return v;
      }
      return { ok: true };
    } finally {
      for (const [key, b] of saved) {
        if (b === undefined) this.windows.delete(key);
        else this.windows.set(key, b);
      }
    }
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
    const limits = this.limitsFor(probe.assetId);
    if (probe.amount > limits.maxTransferAmount) {
      return {
        ok: false,
        code: "AMOUNT_CAP",
        message: `Amount exceeds maxTransferAmount (${limits.maxTransferAmount}).`,
      };
    }
    if (probe.amount < limits.minTransferAmount) {
      return { ok: false, code: "AMOUNT_TOO_SMALL", message: `Amount is below minTransferAmount (${limits.minTransferAmount}) for ${probe.assetId}.` };
    }
    if (probe.fee < config.minFee) {
      return { ok: false, code: "FEE_TOO_LOW", message: "Fee below policy minimum." };
    }
    const b = this.bucket(acc, probe.nowMs);
    if (b.txCount >= config.maxTxPerWindow) {
      return { ok: false, code: "RATE_LIMIT", message: "Too many spends in the current window." };
    }
    const volume = b.volumeByAsset.get(probe.assetId) ?? 0n;
    if (volume + probe.amount > limits.maxTransferPerWindow) {
      return {
        ok: false,
        code: "WINDOW_VOLUME",
        message: "Rolling window volume cap exceeded.",
      };
    }
    if (commit) {
      b.txCount += 1;
      b.volumeByAsset.set(probe.assetId, volume + probe.amount);
    }
    return { ok: true };
  }
}

export const defaultSecurityPolicy = new SecurityPolicy();
