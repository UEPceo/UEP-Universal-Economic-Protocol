/**
 * UEP-ECON-05.2 — reusable economic invariant checker (LAB)
 */

import type { HoldRecord } from "./uep-econ-04.ts";
import type { ObligationRecord } from "./uep-econ-05.ts";

export type EconomicSurface = {
  balance: (id: string) => bigint;
  available?: (id: string) => bigint;
  held?: (id: string) => bigint;
  treasuryBalance: bigint;
  stateRoot: () => string;
  economicTipCommitment?: () => string;
  holds: Map<string, HoldRecord>;
  obligations: Map<string, ObligationRecord>;
  accounts?: Map<string, bigint>;
  balancesSnapshot?: () => Record<string, string>;
};

export type InvariantFinding = {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  detail: string;
};

const TERMINAL_HOLD = new Set(["RELEASED", "CONSUMED", "EXPIRED"]);
const TERMINAL_OBL = new Set([
  "SETTLED",
  "CANCELLED",
  "EXPIRED",
  "CLIENT_WINS",
  "PROVIDER_WINS",
]);

export function checkEconomicInvariants(
  e: EconomicSurface,
  opts?: { accountIds?: string[] },
): InvariantFinding[] {
  const findings: InvariantFinding[] = [];

  const ids =
    opts?.accountIds ??
    (e.balancesSnapshot
      ? Object.keys(e.balancesSnapshot()).filter((k) => !k.startsWith("__"))
      : e.accounts
        ? [...e.accounts.keys()]
        : []);

  for (const id of ids) {
    if (e.balance(id) < 0n) {
      findings.push({
        code: "NEG_BALANCE",
        severity: "CRITICAL",
        detail: `${id} balance ${e.balance(id)}`,
      });
    }
    if (e.available && e.available(id) < 0n) {
      findings.push({
        code: "NEG_AVAILABLE",
        severity: "CRITICAL",
        detail: `${id} available ${e.available(id)}`,
      });
    }
    if (e.held && e.held(id) < 0n) {
      findings.push({
        code: "NEG_HELD",
        severity: "CRITICAL",
        detail: `${id} held ${e.held(id)}`,
      });
    }
  }

  if (e.treasuryBalance < 0n) {
    findings.push({
      code: "NEG_TREASURY",
      severity: "CRITICAL",
      detail: String(e.treasuryBalance),
    });
  }

  for (const h of e.holds.values()) {
    if (h.locked < 0n || h.price < 0n || h.feeLocked < 0n) {
      findings.push({
        code: "NEG_LOCKED",
        severity: "CRITICAL",
        detail: h.holdId,
      });
    }
    if (h.status === "HELD" && h.locked !== h.price + h.feeLocked) {
      findings.push({
        code: "LOCKED_MISMATCH",
        severity: "HIGH",
        detail: `${h.holdId} locked=${h.locked}`,
      });
    }
  }

  // held(account) should equal sum of HELD locks for that client
  if (e.held) {
    const byClient = new Map<string, bigint>();
    for (const h of e.holds.values()) {
      if (h.status !== "HELD") continue;
      byClient.set(h.clientId, (byClient.get(h.clientId) ?? 0n) + h.locked);
    }
    for (const [cid, sum] of byClient) {
      if (e.held(cid) !== sum) {
        findings.push({
          code: "HELD_SUM_MISMATCH",
          severity: "HIGH",
          detail: `${cid} held=${e.held(cid)} sum=${sum}`,
        });
      }
    }
  }

  // obligation ↔ hold consistency for SETTLED
  for (const o of e.obligations.values()) {
    if (o.status === "SETTLED") {
      const h = e.holds.get(o.holdId);
      if (h && h.status !== "CONSUMED" && h.status !== "RELEASED") {
        findings.push({
          code: "SETTLED_HOLD_NOT_TERMINAL",
          severity: "HIGH",
          detail: `${o.obligationId} hold=${h.status}`,
        });
      }
    }
    if (o.status === "EXPIRED") {
      const h = e.holds.get(o.holdId);
      if (h && h.status === "HELD") {
        findings.push({
          code: "EXPIRED_OBL_HOLD_HELD",
          severity: "HIGH",
          detail: o.obligationId,
        });
      }
    }
  }

  return findings;
}

export function tipsAndRootsAgree(
  nodes: Array<{
    economic: EconomicSurface & { stateRoot: () => string };
  }>,
): { tipsAgree: boolean; rootsAgree: boolean; tip?: string; root?: string } {
  const tips = nodes.map((n) =>
    typeof n.economic.economicTipCommitment === "function"
      ? n.economic.economicTipCommitment()
      : n.economic.stateRoot(),
  );
  const roots = nodes.map((n) => n.economic.stateRoot());
  return {
    tipsAgree: tips.every((t) => t === tips[0]),
    rootsAgree: roots.every((r) => r === roots[0]),
    tip: tips[0],
    root: roots[0],
  };
}

export { TERMINAL_HOLD, TERMINAL_OBL };
