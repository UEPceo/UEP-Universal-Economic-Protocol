/**
 * UEP-ECON-05.2 — full economic surface snapshot/restore (LAB durable store sim)
 */

import type { HoldRecord } from "./uep-econ-04.ts";
import type { ObligationRecord } from "./uep-econ-05.ts";
import type { LocalEconomicState } from "./uep35-local-state.ts";
import type { SmtEconomicState } from "./uep37-smt-economic-state.ts";

export type EconomicFullSnapshot = {
  version: "ECON-05.2.7";
  height: number;
  /** Immutable conservation baseline */
  genesisSupply: string;
  treasury: string;
  accounts: Record<string, string>;
  holds: HoldRecord[];
  obligations: ObligationRecord[];
  appliedTxIds: string[];
  appliedTxRollingRoot: string;
  authNonces: string[];
  retiredHoldIds: string[];
  stateRoot: string;
  economicTip: string;
  nullifierRoot?: string;
};

type Econ = LocalEconomicState | SmtEconomicState;

export function snapshotEconomic(e: Econ): EconomicFullSnapshot {
  const accounts: Record<string, string> = e.balancesSnapshot();
  const tip =
    typeof (e as { economicTipCommitment?: () => string }).economicTipCommitment ===
    "function"
      ? (e as { economicTipCommitment: () => string }).economicTipCommitment()
      : e.stateRoot();
  const genesis =
    typeof (e as { genesisSupply?: bigint }).genesisSupply === "bigint"
      ? (e as { genesisSupply: bigint }).genesisSupply
      : 0n;
  return {
    version: "ECON-05.2.7",
    height: e.sequence,
    genesisSupply: genesis.toString(),
    treasury: e.treasuryBalance.toString(),
    accounts,
    holds: [...e.holds.values()].map((h) => ({ ...h })),
    obligations: [...e.obligations.values()].map((o) => ({ ...o })),
    appliedTxIds: [...e.appliedTxIds],
    appliedTxRollingRoot:
      (e as { appliedTxRollingRoot?: string }).appliedTxRollingRoot ??
      e.appliedTxCommitment(),
    authNonces: [...e.authNonces],
    retiredHoldIds: [...((e as { retiredHoldIds?: Set<string> }).retiredHoldIds ?? [])],
    stateRoot: e.stateRoot(),
    economicTip: tip,
    nullifierRoot:
      typeof (e as { nullifierRoot?: () => string }).nullifierRoot === "function"
        ? (e as { nullifierRoot: () => string }).nullifierRoot()
        : undefined,
  };
}

/** Restore into an existing state object (mutates). LAB only. */
export function restoreEconomic(e: Econ, snap: EconomicFullSnapshot): void {
  const x = e as unknown as {
    accounts: Map<string, bigint>;
    treasury: bigint;
    height: number;
    holds: Map<string, HoldRecord>;
    obligations: Map<string, ObligationRecord>;
    appliedTxIds: Set<string>;
    authNonces: Set<string>;
    rootHistory: string[];
  };
  x.accounts = new Map(
    Object.entries(snap.accounts).map(([k, v]) => [k, BigInt(v)]),
  );
  x.treasury = BigInt(snap.treasury);
  x.height = snap.height;
  if ("genesisSupply" in x) {
    (x as { genesisSupply: bigint }).genesisSupply = BigInt(
      snap.genesisSupply ?? "0",
    );
  }
  x.holds = new Map(snap.holds.map((h) => [h.holdId, { ...h }]));
  x.obligations = new Map(
    snap.obligations.map((o) => [o.obligationId, { ...o }]),
  );
  x.appliedTxIds = new Set(snap.appliedTxIds);
  if ("appliedTxRollingRoot" in x && snap.appliedTxRollingRoot) {
    (x as { appliedTxRollingRoot: string }).appliedTxRollingRoot =
      snap.appliedTxRollingRoot;
  }
  x.authNonces = new Set(snap.authNonces);
  if ("retiredHoldIds" in x) {
    (x as { retiredHoldIds: Set<string> }).retiredHoldIds = new Set(
      snap.retiredHoldIds ?? [],
    );
  }
  const supply = BigInt(snap.genesisSupply ?? "0");
  let observed = BigInt(snap.treasury);
  for (const v of Object.values(snap.accounts)) observed += BigInt(v);
  if (observed !== supply) {
    throw new Error(
      `SNAPSHOT_SUPPLY_MISMATCH observed=${observed} genesis=${supply}`,
    );
  }
  if (!x.rootHistory) x.rootHistory = [];
  if (x.rootHistory.length === 0) x.rootHistory.push(snap.stateRoot);
  else x.rootHistory[x.rootHistory.length - 1] = snap.stateRoot;
}

function j(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function economicSurfacesEqual(a: Econ, b: Econ): boolean {
  const sa = snapshotEconomic(a);
  const sb = snapshotEconomic(b);
  return (
    sa.stateRoot === sb.stateRoot &&
    sa.economicTip === sb.economicTip &&
    sa.treasury === sb.treasury &&
    sa.height === sb.height &&
    sa.genesisSupply === sb.genesisSupply &&
    j(sa.accounts) === j(sb.accounts) &&
    j(sa.holds) === j(sb.holds) &&
    j(sa.obligations) === j(sb.obligations) &&
    j([...sa.appliedTxIds].sort()) === j([...sb.appliedTxIds].sort())
  );
}
