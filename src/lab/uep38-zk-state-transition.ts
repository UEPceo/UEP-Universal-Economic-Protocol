/**
 * UEP-38.0 — Phase 4 lab: SMT Poseidon state → SpendCircuit → Groth16.
 *
 * Aligns account IDs with circuit H_ACCOUNT / recipient Fr so
 * stateRoot() === public old/new_state_root of prove-spend-json.
 *
 * Holds stay on economicTip (Phase 2). This module covers TRANSFER notes only.
 */
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { SmtEconomicState, SMT_TREASURY_LABEL } from "./uep37-smt-economic-state.ts";
import { LAB_ZERO_BLINDING, CANONICAL_ASSET_ID } from "./uep37-leaf-encoding.ts";
import {
  zkHAccount,
  zkProveSpendJson,
  zkProveSpendJsonAsync,
  parseProvePublics,
  padFrHex,
} from "./uep-zk-runner.ts";
import type { PoseidonSpendRequestJson } from "./poseidon-spend-request.ts";

export const UEP38_VERSION = "38.35";

export type CircuitAlignedAccounts = {
  senderLabel: string;
  recipientLabel: string;
  treasuryLabel: string;
  senderSecret: string;
  senderSalt: string;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  senderBlinding: Fr;
  recipientBlinding: Fr;
  treasuryBlinding: Fr;
};

export function defaultAlignedAccounts(): CircuitAlignedAccounts {
  const senderSecret = padFrHex("7");
  const senderSalt = padFrHex("1");
  return {
    senderLabel: "alice",
    recipientLabel: "bob",
    treasuryLabel: SMT_TREASURY_LABEL,
    senderSecret,
    senderSalt,
    recipientId: Fr.from(33n),
    treasuryId: Fr.from(99n),
    assetId: CANONICAL_ASSET_ID,
    senderBlinding: LAB_ZERO_BLINDING,
    recipientBlinding: LAB_ZERO_BLINDING,
    treasuryBlinding: LAB_ZERO_BLINDING,
  };
}

export function carolAlignedAccounts(): CircuitAlignedAccounts {
  const base = defaultAlignedAccounts();
  return {
    ...base,
    senderLabel: "carol",
    recipientLabel: "dave",
    senderSecret: padFrHex("8"),
    senderSalt: padFrHex("2"),
    recipientId: Fr.from(34n),
  };
}

export function erinAlignedAccounts(): CircuitAlignedAccounts {
  const base = defaultAlignedAccounts();
  return {
    ...base,
    senderLabel: "erin",
    recipientLabel: "frank",
    senderSecret: padFrHex("9"),
    senderSalt: padFrHex("3"),
    recipientId: Fr.from(35n),
  };
}

export function labParty(who: string): CircuitAlignedAccounts {
  if (who === "carol") return carolAlignedAccounts();
  if (who === "erin") return erinAlignedAccounts();
  return defaultAlignedAccounts();
}

export function bindCircuitAccounts(
  st: SmtEconomicState,
  ids: CircuitAlignedAccounts,
): { senderId: Fr } {
  const senderHex = zkHAccount(ids.senderSecret, ids.senderSalt);
  const senderId = Fr.from("0x" + senderHex);
  st.bindAccountId(ids.senderLabel, senderId);
  st.bindAccountId(ids.recipientLabel, ids.recipientId);
  st.bindAccountId(ids.treasuryLabel, ids.treasuryId);
  if (ids.senderLabel === "alice") {
    const carol = carolAlignedAccounts();
    const carolHex = zkHAccount(carol.senderSecret, carol.senderSalt);
    st.bindAccountId(carol.senderLabel, Fr.from("0x" + carolHex));
    st.bindAccountId(carol.recipientLabel, carol.recipientId);
    st.setBlinding(carol.senderLabel, carol.senderBlinding);
    st.setBlinding(carol.recipientLabel, carol.recipientBlinding);
    const erin = erinAlignedAccounts();
    const erinHex = zkHAccount(erin.senderSecret, erin.senderSalt);
    st.bindAccountId(erin.senderLabel, Fr.from("0x" + erinHex));
    st.bindAccountId(erin.recipientLabel, erin.recipientId);
    st.setBlinding(erin.senderLabel, erin.senderBlinding);
    st.setBlinding(erin.recipientLabel, erin.recipientBlinding);
  }
  st.setBlinding(ids.senderLabel, ids.senderBlinding);
  st.setBlinding(ids.recipientLabel, ids.recipientBlinding);
  st.setBlinding(ids.treasuryLabel, ids.treasuryBlinding);
  return { senderId };
}

export function buildSpendJsonFromState(
  st: SmtEconomicState,
  ids: CircuitAlignedAccounts,
  amount: bigint,
): PoseidonSpendRequestJson {
  const fee = creatorFee(amount);
  const extra: Array<[number, string]> = st
    .listPoseidonLeaves()
    .map((L) => [L.index, L.leafHex]);
  return {
    depth: st.depth === 32 ? 32 : 4,
    seed: 2026,
    sender_secret: ids.senderSecret.startsWith("0x") ? ids.senderSecret : "0x" + ids.senderSecret,
    sender_salt: ids.senderSalt.startsWith("0x") ? ids.senderSalt : "0x" + ids.senderSalt,
    recipient_id: "0x" + ids.recipientId.toHex(),
    treasury_id: "0x" + ids.treasuryId.toHex(),
    asset_id: "0x" + ids.assetId.toHex(),
    amount: amount.toString(),
    fee: fee.toString(),
    sender_old_balance: st.balance(ids.senderLabel).toString(),
    recipient_old_balance: st.balance(ids.recipientLabel).toString(),
    treasury_old_balance: st.treasuryBalance.toString(),
    note_blinding: "0x" + ids.senderBlinding.toHex(),
    recipient_blinding: "0x" + ids.recipientBlinding.toHex(),
    treasury_blinding: "0x" + ids.treasuryBlinding.toHex(),
    extra_state_leaves: extra,
    network_profile: "DEV",
    domain_id: 1,
    expected_old_state_root: "0x" + st.stateRoot(),
  };
}

export function applyTransfer(
  st: SmtEconomicState,
  ids: CircuitAlignedAccounts,
  amount: bigint,
): { ok: boolean; reason?: string; newRoot: string } {
  const fee = creatorFee(amount);
  const r = st.applyTransfers([
    {
      id: `uep38-${st.appliedTxIds.size}-${amount}`,
      from: ids.senderLabel,
      to: ids.recipientLabel,
      amount,
    },
  ]);
  return { ok: r.ok, reason: r.reason, newRoot: st.stateRoot() };
}

export type SpendProofArtifact = {
  ok: boolean;
  vkHex: string;
  proofHex: string;
  publicInputsHex: string[];
  oldRootProof: string;
  newRootProof: string;
  stdout: string;
  stderr: string;
};

function publicsFromMap(pubs: Record<string, string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < 13; i++) {
    const v = pubs[`public_${i}`] ?? "";
    out.push(v.replace(/^0x/, "").toLowerCase());
  }
  return out;
}

export function proveWithoutApply(
  st: SmtEconomicState,
  ids: CircuitAlignedAccounts,
  amount: bigint,
): SpendProofArtifact {
  st.ensureAccount(ids.recipientLabel);
  st.ensureAccount(ids.senderLabel);
  bindCircuitAccounts(st, ids);
  const req = buildSpendJsonFromState(st, ids, amount);
  req.domain_id = 1;
  const proved = zkProveSpendJson(JSON.stringify(req), { timeoutMs: 120_000 });
  const pubs = parseProvePublics(proved.stdout);
  const inputs = publicsFromMap(pubs);
  return {
    ok: proved.ok && inputs.every((x) => x.length >= 16),
    vkHex: (pubs.vk_hex ?? "").replace(/^0x/, ""),
    proofHex: (pubs.proof_hex ?? "").replace(/^0x/, ""),
    publicInputsHex: inputs,
    oldRootProof: (pubs.old_state_root || pubs.public_0 || "").replace(/^0x/, "").toLowerCase(),
    newRootProof: (pubs.new_state_root || pubs.public_1 || "").replace(/^0x/, "").toLowerCase(),
    stdout: proved.stdout,
    stderr: proved.stderr,
  };
}


function artifactFromProve(proved: { ok: boolean; stdout: string; stderr: string }): SpendProofArtifact {
  const pubs = parseProvePublics(proved.stdout);
  const inputs = publicsFromMap(pubs);
  return {
    ok: proved.ok && inputs.every((x) => x.length >= 16),
    vkHex: (pubs.vk_hex ?? "").replace(/^0x/, ""),
    proofHex: (pubs.proof_hex ?? "").replace(/^0x/, ""),
    publicInputsHex: inputs,
    oldRootProof: (pubs.old_state_root || pubs.public_0 || "").replace(/^0x/, "").toLowerCase(),
    newRootProof: (pubs.new_state_root || pubs.public_1 || "").replace(/^0x/, "").toLowerCase(),
    stdout: proved.stdout,
    stderr: proved.stderr,
  };
}

export type BatchSpend = { who: string; ids: CircuitAlignedAccounts; amount: bigint };

/**
 * N disjoint spends. Intermediate roots are native; Groth16 processes start together.
 * Shared treasury is applied in order, so proof i starts from the root after i-1.
 */
export async function proveManyParallel(
  st: SmtEconomicState,
  spends: BatchSpend[],
): Promise<{ ok: boolean; arts: SpendProofArtifact[]; wallMs: number; finalRoot: string; reason?: string }> {
  if (spends.length === 0) return { ok: false, arts: [], wallMs: 0, finalRoot: st.stateRoot(), reason: "EMPTY_BATCH" };
  const snapshots: SmtEconomicState[] = [st];
  const cursor = st.clone();
  for (const s of spends) {
    const applied = applyTransfer(cursor, s.ids, s.amount);
    if (!applied.ok) return { ok: false, arts: [], wallMs: 0, finalRoot: st.stateRoot(), reason: applied.reason };
    snapshots.push(cursor.clone());
  }
  const reqs = spends.map((s, i) => buildSpendJsonFromState(snapshots[i]!, s.ids, s.amount));
  const t0 = Date.now();
  const proved: { ok: boolean; stdout: string; stderr: string }[] = new Array(reqs.length);
  let nextJob = 0;
  const workers = Math.min(2, reqs.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextJob < reqs.length) {
      const i = nextJob++;
      proved[i] = await zkProveSpendJsonAsync(JSON.stringify(reqs[i]), { timeoutMs: 180000 });
    }
  }));
  const wallMs = Date.now() - t0;
  const arts = proved.map(artifactFromProve);
  const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();
  let reason: string | undefined;
  if (!arts.every((a) => a.ok)) {
    reason = "PROVE_FAIL:" + proved.map((p, i) => `${i}:${p.ok}:${(p.stdout + p.stderr).slice(0, 180)}`).join(" || ");
  }
  for (let i = 0; i < spends.length && !reason; i++) {
    const before = norm(snapshots[i]!.stateRoot());
    const after = norm(snapshots[i + 1]!.stateRoot());
    if (norm(arts[i]!.oldRootProof) !== before || norm(arts[i]!.newRootProof) !== after) {
      reason = `ROOT_CHAIN i=${i} old ${norm(arts[i]!.oldRootProof)}!=${before} new ${norm(arts[i]!.newRootProof)}!=${after}`;
    }
  }
  return { ok: !reason, arts, wallMs, finalRoot: snapshots[snapshots.length - 1]!.stateRoot(), reason };
}

/** Two disjoint spends. Witnesses are chained natively; Groth16 runs in parallel. */
export async function proveTwoParallel(
  st: SmtEconomicState,
  first: CircuitAlignedAccounts,
  second: CircuitAlignedAccounts,
  amountA: bigint,
  amountB: bigint,
): Promise<{ ok: boolean; arts: SpendProofArtifact[]; wallMs: number; finalRoot: string; reason?: string }> {
  const mid = st.clone();
  const appliedA = applyTransfer(mid, first, amountA);
  if (!appliedA.ok) return { ok: false, arts: [], wallMs: 0, finalRoot: st.stateRoot(), reason: appliedA.reason };
  const reqA = buildSpendJsonFromState(st, first, amountA);
  const reqB = buildSpendJsonFromState(mid, second, amountB);
  const t0 = Date.now();
  const [rawA, rawB] = await Promise.all([
    zkProveSpendJsonAsync(JSON.stringify(reqA)),
    zkProveSpendJsonAsync(JSON.stringify(reqB)),
  ]);
  const wallMs = Date.now() - t0;
  const arts = [artifactFromProve(rawA), artifactFromProve(rawB)];
  const end = mid.clone();
  const appliedB = applyTransfer(end, second, amountB);
  if (!appliedB.ok) return { ok: false, arts, wallMs, finalRoot: mid.stateRoot(), reason: appliedB.reason };
  const ok = arts.every((a) => a.ok)
    && arts[0]!.oldRootProof === st.stateRoot().toLowerCase()
    && arts[0]!.newRootProof === appliedA.newRoot.toLowerCase()
    && arts[1]!.oldRootProof === appliedA.newRoot.toLowerCase()
    && arts[1]!.newRootProof === appliedB.newRoot.toLowerCase();
  return { ok, arts, wallMs, finalRoot: appliedB.newRoot };
}

export function proveTransition(
  st: SmtEconomicState,
  ids: CircuitAlignedAccounts,
  amount: bigint,
): {
  ok: boolean;
  oldRoot: string;
  newRootLocal: string;
  oldRootProof?: string;
  newRootProof?: string;
  rootsMatch: boolean;
  stdout: string;
  stderr: string;
  artifact?: SpendProofArtifact;
} {
  const oldRoot = st.stateRoot();
  const art = proveWithoutApply(st, ids, amount);
  const applied = applyTransfer(st, ids, amount);
  const oldMatch = art.oldRootProof === oldRoot.toLowerCase();
  const newMatch = art.newRootProof === applied.newRoot.toLowerCase();
  return {
    ok: art.ok && applied.ok && oldMatch && newMatch,
    oldRoot,
    newRootLocal: applied.newRoot,
    oldRootProof: art.oldRootProof,
    newRootProof: art.newRootProof,
    rootsMatch: oldMatch && newMatch,
    stdout: art.stdout,
    stderr: art.stderr + (applied.reason ?? ""),
    artifact: art,
  };
}
