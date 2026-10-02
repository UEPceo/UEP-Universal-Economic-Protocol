/**
 * UEP-ECON-05.1 adversarial economic simulation (LAB)
 */
import { createHash } from "node:crypto";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { buildAcceptWithHold, markDelivered } from "./uep-econ-05.ts";
import { buildHoldConsumeTx, buildHoldOpenTx } from "./uep-econ-04.ts";

export type SimConfig = {
  civs: number;
  nodes: number;
  seed: number;
  holdsPerClient: number;
  priceMin: bigint;
  priceMax: bigint;
  deliverWithin: number;
  useSmt: boolean;
  smtDepth: number;
};

export type SimMetrics = {
  version: string;
  seed: number;
  civs: number;
  nodes: number;
  heights: number;
  wallMs: number;
  tipsAgree: boolean;
  rootsAgree: boolean;
  conservationOk: boolean;
  initialSupply: string;
  finalSupply: string;
  treasury: string;
  holdsOpened: number;
  holdsConsumed: number;
  holdsExpired: number;
  holdsStillHeld: number;
  settled: number;
  rejectReplayOpen: number;
  rejectReplayConsume: number;
  rejectBeforeDelivery: number;
  rejectOvercommit: number;
  rejectTerminalConsume: number;
  scenarios: Record<string, string>;
  totalHeld: string;
  totalAvailable: string;
};

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tipOf(e: {
  economicTipCommitment?: () => string;
  stateRoot: () => string;
}): string {
  return typeof e.economicTipCommitment === "function"
    ? e.economicTipCommitment()
    : e.stateRoot();
}

function totalBalances(e: {
  balancesSnapshot: () => Record<string, string>;
  treasuryBalance: bigint;
}): bigint {
  let s = 0n;
  for (const [k, v] of Object.entries(e.balancesSnapshot())) {
    if (k.startsWith("__")) continue;
    s += BigInt(v);
  }
  return s + e.treasuryBalance;
}

export function runAdversarialSim(cfg: SimConfig): SimMetrics {
  const t0 = performance.now();
  const rnd = mulberry32(cfg.seed);
  const initialBalances: Record<string, bigint> = { s0: 100n, r0: 0n };
  const startBal = 100_000n;
  for (let i = 0; i < cfg.civs; i++) initialBalances[`civ${i}`] = startBal;

  const cluster = new MultiNodeCluster(cfg.nodes, 5100 + (cfg.seed % 500), {
    useSmtState: cfg.useSmt,
    smtDepth: cfg.smtDepth,
    initialBalances,
  });
  cluster.requireEconomicCommitment = true;

  const e0 = () => cluster.node("mn-0").economic;
  const initialSupply = totalBalances(e0());
  let holdsOpened = 0;
  let holdsConsumed = 0;
  let rejectReplayOpen = 0;
  let rejectReplayConsume = 0;
  let rejectBeforeDelivery = 0;
  let rejectOvercommit = 0;
  let rejectTerminalConsume = 0;
  const scenarios: Record<string, string> = {};
  let txSeq = 0;

  type T = {
    client: string;
    provider: string;
    holdId: string;
    obligationId: string;
    price: bigint;
    holdTxId: string;
    consumeTxId?: string;
    digest: string;
  };
  const active: T[] = [];

  const tickUntil = (minSeq: number) => {
    for (let t = 0; t < 100; t++) {
      cluster.tick(12, 4);
      if (cluster.nodes.every((n) => n.economic.sequence >= minSeq)) break;
    }
  };

  const propose = (txs: { txs: import("./uep35-batch-lab.ts").BatchTx[] }[]) => {
    return cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), txs);
  };

  // Open holds. First ~40% of slots: open → deliver → consume immediately
  // (avoids deliverWithin racing sequential height bumps). Rest left to expire.
  const totalSlots = cfg.civs * cfg.holdsPerClient;
  const settleSlots = Math.floor(totalSlots * 0.4);
  let slot = 0;
  for (let c = 0; c < cfg.civs; c++) {
    for (let h = 0; h < cfg.holdsPerClient; h++) {
      const client = `civ${c}`;
      const provider = `civ${(c + 1 + h) % cfg.civs}`;
      const price =
        cfg.priceMin +
        BigInt(Math.floor(rnd() * Number(cfg.priceMax - cfg.priceMin + 1n)));
      const digest = createHash("sha256")
        .update(`s-${c}-${h}-${cfg.seed}`)
        .digest("hex")
        .slice(0, 16);
      const longTtl = slot < settleSlots ? 10_000 : cfg.deliverWithin;
      const { obligation, holdTx } = buildAcceptWithHold({
        offerId: `off-${c}-${h}`,
        clientId: client,
        providerId: provider,
        price,
        expectedResultDigest: digest,
        clientNonce: `n-${c}-${h}-${txSeq++}`,
        holdTxId: `hold-${c}-${h}-${txSeq}`,
        currentHeight: e0().sequence,
        deliverWithinHeights: longTtl,
      });
      for (const n of cluster.nodes) {
        n.economic.obligations.set(obligation.obligationId, { ...obligation });
      }
      const r = propose([{ txs: [holdTx] }]);
      if (!r) rejectOvercommit++;
      else {
        tickUntil(e0().sequence + 1);
        holdsOpened++;
        const tracked = {
          client,
          provider,
          holdId: holdTx.holdId!,
          obligationId: obligation.obligationId,
          price,
          holdTxId: holdTx.id,
          digest,
          consumeTxId: undefined as string | undefined,
        };
        active.push(tracked);
        if (slot < settleSlots) {
          for (const n of cluster.nodes) {
            const o = n.economic.obligations.get(tracked.obligationId);
            if (o && o.status === "OPEN") markDelivered(o, tracked.digest, e0().sequence);
          }
          const consume = buildHoldConsumeTx({
            txId: `c-${slot}-${txSeq++}`,
            clientId: tracked.client,
            providerId: tracked.provider,
            holdId: tracked.holdId,
            price: tracked.price,
          });
          (consume as { obligationId?: string }).obligationId = tracked.obligationId;
          tracked.consumeTxId = consume.id;
          const cr = propose([{ txs: [consume] }]);
          if (cr) {
            tickUntil(e0().sequence + 1);
            holdsConsumed++;
          }
        }
      }
      slot++;
    }
  }

  // Replay open
  if (active[0]) {
    const a = active[0];
    const dup = buildHoldOpenTx({
      txId: a.holdTxId,
      clientId: a.client,
      providerId: a.provider,
      obligationId: a.obligationId,
      holdNonce: "x",
      price: a.price,
    });
    (dup as { id: string }).id = a.holdTxId;
    const r = propose([{ txs: [dup] }]);
    if (!r) rejectReplayOpen++;
    scenarios.replay_hold_open = r ? "FAIL_ACCEPTED" : "REJECTED";
  }

  const settleN = Math.floor(active.length * 0.4);

  // Replay consume
  if (active[0]?.consumeTxId) {
    const a = active[0];
    const replay = buildHoldConsumeTx({
      txId: a.consumeTxId,
      clientId: a.client,
      providerId: a.provider,
      holdId: a.holdId,
      price: a.price,
    });
    (replay as { obligationId?: string }).obligationId = a.obligationId;
    const r = propose([{ txs: [replay] }]);
    if (!r) rejectReplayConsume++;
    scenarios.replay_hold_consume = r ? "FAIL_ACCEPTED" : "REJECTED";
  }

  // Consume before delivery
  if (active[settleN]) {
    const a = active[settleN];
    for (const n of cluster.nodes) {
      const o = n.economic.obligations.get(a.obligationId);
      if (o) o.status = "OPEN";
    }
    const consume = buildHoldConsumeTx({
      txId: `early-${txSeq++}`,
      clientId: a.client,
      providerId: a.provider,
      holdId: a.holdId,
      price: a.price,
    });
    (consume as { obligationId?: string }).obligationId = a.obligationId;
    const r = propose([{ txs: [consume] }]);
    if (!r) rejectBeforeDelivery++;
    scenarios.consume_before_delivery = r ? "FAIL_ACCEPTED" : "REJECTED";
  }

  // Advance heights for expiry
  for (let i = 0; i < cfg.deliverWithin + 3; i++) {
    const civ = `civ${i % cfg.civs}`;
    const avail =
      typeof (e0() as { available?: (id: string) => bigint }).available ===
      "function"
        ? (e0() as { available: (id: string) => bigint }).available(civ)
        : e0().balance(civ);
    if (avail < 2000n) break;
    const r = propose([
      {
        txs: [
          {
            id: `pad-${txSeq++}`,
            from: civ,
            to: `civ${(i + 1) % cfg.civs}`,
            amount: 500n,
          },
        ],
      },
    ]);
    if (r) tickUntil(e0().sequence + 1);
    else break;
  }

  // Fire expiries
  for (const n of cluster.nodes) n.economic.applyTransfers([]);

  // Terminal consume
  for (const a of active.slice(settleN, settleN + 3)) {
    for (const n of cluster.nodes) {
      const h = n.economic.holds.get(a.holdId);
      if (h && h.status === "HELD") h.status = "EXPIRED";
    }
    const consume = buildHoldConsumeTx({
      txId: `term-${txSeq++}`,
      clientId: a.client,
      providerId: a.provider,
      holdId: a.holdId,
      price: a.price,
    });
    (consume as { obligationId?: string }).obligationId = a.obligationId;
    const r = propose([{ txs: [consume] }]);
    if (!r) rejectTerminalConsume++;
  }
  scenarios.consume_terminal = "CHECKED";

  // Mixed batch
  {
    const r = propose([
      {
        txs: [
          { id: `mix-ok-${txSeq++}`, from: "civ0", to: "civ1", amount: 300n },
          {
            id: `mix-bad-${txSeq++}`,
            from: "civ1",
            to: "civ0",
            amount: 99_000_000n,
          },
        ],
      },
    ]);
    scenarios.mixed_batch = r ? "OK" : "NO_PROPOSAL";
    if (r) tickUntil(e0().sequence + 1);
  }

  let holdsExpired = 0;
  let holdsStillHeld = 0;
  let settled = 0;
  for (const h of e0().holds.values()) {
    if (h.status === "EXPIRED") holdsExpired++;
    if (h.status === "HELD") holdsStillHeld++;
    if (h.status === "CONSUMED") settled++;
  }

  const tips = cluster.nodes.map((n) => tipOf(n.economic));
  const tipsAgree = tips.every((t) => t === tips[0]);
  const finalSupply = totalBalances(e0());
  const stateCons =
    typeof (e0() as { conservationOk?: () => boolean }).conservationOk === "function"
      ? (e0() as { conservationOk: () => boolean }).conservationOk()
      : finalSupply === initialSupply;
  let totalHeld = 0n;
  for (const h of e0().holds.values()) {
    if (h.status === "HELD") totalHeld += h.locked;
  }
  let totalAvailable = 0n;
  for (let i = 0; i < cfg.civs; i++) {
    const id = `civ${i}`;
    totalAvailable +=
      typeof (e0() as { available?: (x: string) => bigint }).available ===
      "function"
        ? (e0() as { available: (x: string) => bigint }).available(id)
        : e0().balance(id);
  }

  return {
    version: "ECON-05.1-ADV",
    seed: cfg.seed,
    civs: cfg.civs,
    nodes: cfg.nodes,
    heights: e0().sequence,
    wallMs: Math.round(performance.now() - t0),
    tipsAgree,
    rootsAgree: cluster.allHonestSameStateRoot(),
    conservationOk: finalSupply === initialSupply && stateCons,
    initialSupply: initialSupply.toString(),
    finalSupply: finalSupply.toString(),
    treasury: e0().treasuryBalance.toString(),
    holdsOpened,
    holdsConsumed,
    holdsExpired,
    holdsStillHeld,
    settled,
    rejectReplayOpen,
    rejectReplayConsume,
    rejectBeforeDelivery,
    rejectOvercommit,
    rejectTerminalConsume,
    scenarios,
    totalHeld: totalHeld.toString(),
    totalAvailable: totalAvailable.toString(),
  };
}

export function runDefaultAdvSim(): SimMetrics {
  return runAdversarialSim({
    civs: 16,
    nodes: 4,
    seed: 42,
    holdsPerClient: 2,
    priceMin: 500n,
    priceMax: 1500n,
    deliverWithin: 4,
    useSmt: true,
    smtDepth: 8,
  });
}
