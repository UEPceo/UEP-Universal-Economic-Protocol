/**
 * Reproducible local UEP TESTNET smoke test.
 *
 * This is an in-process reference testnet. It does not connect to a public
 * network and it does not use a production ZK proving/verifying ceremony.
 */
import assert from "node:assert/strict";
import { encodeStringToFr } from "../src/core/encoding.ts";
import { identityFromMnemonic, generateMnemonic } from "../src/identity/index.ts";
import { UepLedger } from "../src/testnet/ledger.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { encodeAccountAddress, parseAccountAddress } from "../src/core/address.ts";
import { creatorFee } from "../src/core/fee.ts";
import { HeightProducer } from "../src/service/height-producer.ts";

async function main() {
  console.log("UEP TESTNET smoke (public reference implementation)");
  console.log("network:", TESTNET.networkId);

  const alice = await identityFromMnemonic(await generateMnemonic(128));
  const bob = await identityFromMnemonic(await generateMnemonic(128));

  const node = new UepLedger({
    networkId: TESTNET.networkId,
    domainId: "EARTH",
    connected: true,
    allowFaucet: true,
  });
  // v0.5.1 (ADR 0002): heights come from real time through the producer, outside the transitions.
  const producer = new HeightProducer({ ledger: node }).start();

  const asset = "uep-test/tenergy";
  node.faucet(alice.accountId, asset, 1_000_000n);

  const sendAmount = 250_000n;
  const prepared = node.prepareSpend(alice, bob.accountId, asset, sendAmount);
  if (!("tx" in prepared)) throw new Error(prepared.error.message);

  // Signed spend: verified with the public key only, no secret sent to the node.
  const submitted = node.submit(prepared.tx);
  if (!("tx" in submitted)) throw new Error(submitted.error.message);

  const fee = creatorFee(sendAmount);
  const aliceBal = node.balanceOf(alice.accountId, encodeStringToFr(asset));
  const bobBal = node.balanceOf(bob.accountId, encodeStringToFr(asset));

  assert.equal(bobBal, sendAmount);
  assert.equal(aliceBal, 1_000_000n - sendAmount - fee);

  // v0.4.5: v2 address (UEP-ADDR-002): Bech32m, versioned, network-bound, key-derived.
  const addr = encodeAccountAddress(TESTNET.networkId, bob.accountId);
  assert.ok(parseAccountAddress(addr, TESTNET.networkId).eq(bob.accountId));

  console.log("TX ID:       ", submitted.tx.txId.toHex());
  console.log("sender:      ", alice.accountId.toHex());
  console.log("recipient:   ", bob.accountId.toHex());
  console.log("amount:      ", sendAmount.toString());
  console.log("fee:         ", fee.toString());
  console.log("nullifier:   ", submitted.tx.nullifier.toHex());
  console.log("state root:  ", node.stateRoot().toHex());
  console.log("bob address: ", addr);
  const status = producer.status();
  producer.stop();
  assert.ok(status.running && status.aheadBy === 0 && status.blockTimeMs === 5000);
  console.log("height:      ", node.height, `(producer: one block per ${status.blockTimeMs} ms of real time)`);
  console.log("verification: PASS (local reference path)");
  console.log("SMOKE OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
