/**
 * v0.5.3 wallet helper: v2 accounts that only ever received (never spent)
 * move to the v3 id of the same key.
 *
 * Since v0.5.1 a mnemonic derives a v3 account id; the v2 id of the same
 * spend key stays valid for its notes. A wallet that only looks at the v3 id
 * does not see value held under the v2 id, and a v2 id that never spent is
 * not accepted as a recipient (it has not proven its key on the ledger). This
 * helper shows both balances and sweeps the v2 notes to the v3 id with
 * ordinary signed spends (the 0.1% protocol fee applies; no special path).
 * Notes too small to pay the fee floor stay where they are and are reported.
 */
import type { Fr } from "../core/field.ts";
import { maxPayableFromNote } from "../core/fee.ts";
import { withAccountIdV2, type IdentitySecrets } from "./kdf.ts";
import type { UepLedger } from "../testnet/ledger.ts";

export type WalletAccountBalances = {
  asset: string;
  v3: { accountId: Fr; balance: bigint };
  v2: { accountId: Fr; balance: bigint; notes: number };
  total: bigint;
};

export type V2MigrationResult = {
  asset: string;
  /** Transaction ids of the sweep spends, in order. */
  txIds: string[];
  /** Value that arrived at the v3 id. */
  moved: bigint;
  /** Protocol fees paid by the sweep. */
  fees: bigint;
  /** Value left under the v2 id in notes too small to pay the fee floor. */
  dust: bigint;
};

function v2Secrets(secrets: IdentitySecrets): IdentitySecrets {
  const v2 = withAccountIdV2(secrets);
  if (v2.accountId.eq(secrets.accountId)) throw new Error("WALLET_V2_SAME_ID: the identity is already its v2 form; derive it from the mnemonic or seed");
  return v2;
}

function v2Notes(ledger: UepLedger, id: Fr, asset: string) {
  const rec = ledger.assetRecord(asset);
  if (!rec) throw new Error("WALLET_ASSET_UNKNOWN");
  return ledger.notesOf(id).filter((n) => ledger.assetRecordByFr(n.assetId)?.assetId === rec.assetId);
}

/** Balances of the v3 id and of the v2 id of the same key, for one asset. */
export function walletAccountBalances(ledger: UepLedger, secrets: IdentitySecrets, asset: string): WalletAccountBalances {
  const v2 = v2Secrets(secrets);
  const v3Balance = ledger.balanceOfAsset(secrets.accountId, asset);
  const v2Balance = ledger.balanceOfAsset(v2.accountId, asset);
  return { asset, v3: { accountId: secrets.accountId, balance: v3Balance }, v2: { accountId: v2.accountId, balance: v2Balance, notes: v2Notes(ledger, v2.accountId, asset).length }, total: v3Balance + v2Balance };
}

/**
 * Sweep every v2 note of `asset` that can pay its fee to the v3 id of the
 * same key: one exact spend per note (no change), largest note first.
 * Each spend is signed with the spend key, which also proves the v2 id.
 */
export function migrateV2ToV3(ledger: UepLedger, secrets: IdentitySecrets, asset: string, opts: { maxSpends?: number } = {}): V2MigrationResult {
  const v2 = v2Secrets(secrets);
  const maxSpends = opts.maxSpends ?? 64;
  const out: V2MigrationResult = { asset, txIds: [], moved: 0n, fees: 0n, dust: 0n };
  for (let i = 0; i < maxSpends; i++) {
    const notes = v2Notes(ledger, v2.accountId, asset)
      .map((n) => ({ n, payable: maxPayableFromNote(n.amount, ledger.feeFloorOf(n.assetId)) }))
      .filter((x) => x.payable > 0n)
      .sort((a, b) => (a.n.amount > b.n.amount ? -1 : a.n.amount < b.n.amount ? 1 : 0));
    const next = notes[0];
    if (!next) break;
    const prepared = ledger.prepareSpend(v2, secrets.accountId, asset, next.payable);
    if ("error" in prepared) throw new Error(`WALLET_MIGRATION_PREPARE: ${prepared.error.code}: ${prepared.error.message}`);
    const applied = ledger.submit(prepared.tx);
    if ("error" in applied) throw new Error(`WALLET_MIGRATION_SUBMIT: ${applied.error.code}: ${applied.error.message}`);
    out.txIds.push(prepared.tx.txId.toHex());
    out.moved += prepared.tx.amount;
    out.fees += prepared.tx.fee;
  }
  out.dust = v2Notes(ledger, v2.accountId, asset).reduce((s, n) => s + n.amount, 0n);
  return out;
}
