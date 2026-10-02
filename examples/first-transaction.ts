import { encodeStringToFr } from "../src/core/encoding.ts";
import { creatorFee } from "../src/core/fee.ts";
import { generateMnemonic, identityFromMnemonic } from "../src/identity/index.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { UepLedger } from "../src/testnet/ledger.ts";

const sender = await identityFromMnemonic(await generateMnemonic(128));
const recipient = await identityFromMnemonic(await generateMnemonic(128));
const ledger = new UepLedger({
  networkId: TESTNET.networkId,
  domainId: "EARTH",
  connected: true,
  allowFaucet: true,
});

const asset = "asset:test:eur";
const amount = 10_000n;
ledger.faucet(sender.accountId, asset, 100_000n);
const prepared = ledger.prepareSpend(sender, recipient.accountId, asset, amount);
if (!("tx" in prepared)) throw new Error(prepared.error.message);
const oldStateRoot = ledger.stateRoot().toHex();
const result = ledger.submit(prepared.tx, sender);
if (!("tx" in result)) throw new Error(result.error.message);

const tx = result.tx;
console.log(JSON.stringify({
  network: TESTNET.networkId,
  txId: tx.txId.toHex(),
  sender: tx.senderId.toHex(),
  recipient: tx.recipientId.toHex(),
  amount: amount.toString(),
  fee: creatorFee(amount).toString(),
  nullifier: tx.nullifier.toHex(),
  oldStateRoot,
  newStateRoot: ledger.stateRoot().toHex(),
  verification: "PASS — local reference testnet",
  asset,
  recipientBalance: ledger.balanceOf(recipient.accountId, encodeStringToFr(asset)).toString(),
}, null, 2));
