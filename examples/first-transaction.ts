import { encodeStringToFr } from "../src/core/encoding.ts";
import { creatorFee } from "../src/core/fee.ts";
import { generateMnemonic, identityFromMnemonic } from "../src/identity/index.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { UepLedger } from "../src/testnet/ledger.ts";
import { encodeAccountAddress } from "../src/core/address.ts";

const sender = await identityFromMnemonic(await generateMnemonic(128));
const recipient = await identityFromMnemonic(await generateMnemonic(128));
const ledger = new UepLedger({
  networkId: TESTNET.networkId,
  domainId: "EARTH",
  connected: true,
  allowFaucet: true,
});

const asset = "uep-test/teur";
const amount = 10_000n;
// v0.4.5: accounts are key-derived; addresses are Bech32m v2 (UEP-ADDR-002).
const senderAddress = encodeAccountAddress(TESTNET.networkId, sender.accountId);
const recipientAddress = encodeAccountAddress(TESTNET.networkId, recipient.accountId);
ledger.faucet(senderAddress, asset, 100_000n);
const prepared = ledger.prepareSpend(sender, recipientAddress, asset, amount);
if (!("tx" in prepared)) throw new Error(prepared.error.message);
const oldStateRoot = ledger.stateRoot().toHex();
// v0.5.0: the spend is signed locally with the sender's key-derived spend key;
// the node verifies it with the public key only (no secret is submitted).
const result = ledger.submit(prepared.tx);
if (!("tx" in result)) throw new Error(result.error.message);

const tx = result.tx;
console.log(JSON.stringify({
  network: TESTNET.networkId,
  txId: tx.txId.toHex(),
  sender: tx.senderId.toHex(),
  senderAddress,
  recipient: tx.recipientId.toHex(),
  recipientAddress,
  amount: amount.toString(),
  fee: creatorFee(amount).toString(),
  nullifier: tx.nullifier.toHex(),
  oldStateRoot,
  newStateRoot: ledger.stateRoot().toHex(),
  verification: "PASS — local reference testnet",
  asset,
  recipientBalance: ledger.balanceOf(recipient.accountId, encodeStringToFr(asset)).toString(),
}, null, 2));
