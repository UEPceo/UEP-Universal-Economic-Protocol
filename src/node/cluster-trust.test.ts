import test from "node:test";
import assert from "node:assert/strict";
import { clusterTrust } from "./cluster-trust.ts";
import type { Peer } from "./peer-net.ts";

const own = { snapshotPublicKeyHex: "aa01", faucetPublicKeyHex: "bb01" };

test("trust is the local keys plus the keys the peer list pins", () => {
  const peers: Peer[] = [
    { id: "node-1", url: "http://127.0.0.1:1", snapshotPublicKeyHex: "aa02", faucetPublicKeyHex: "bb02" },
    { id: "node-2", url: "http://127.0.0.1:2", snapshotPublicKeyHex: "aa03", faucetPublicKeyHex: "bb03" },
  ];
  assert.deepEqual(clusterTrust(own, peers), { authorities: ["aa01", "aa02", "aa03"], faucetPublicKeys: ["bb01", "bb02", "bb03"] });
});

test("a peer without pinned keys adds no trust", () => {
  const peers: Peer[] = [{ id: "node-1", url: "http://127.0.0.1:1", publicKeyHex: "cc01" }];
  assert.deepEqual(clusterTrust(own, peers), { authorities: ["aa01"], faucetPublicKeys: ["bb01"] });
});

test("a repeated key is listed once", () => {
  const peers: Peer[] = [{ id: "node-1", url: "http://127.0.0.1:1", snapshotPublicKeyHex: "aa01", faucetPublicKeyHex: "bb01" }];
  assert.deepEqual(clusterTrust(own, peers), { authorities: ["aa01"], faucetPublicKeys: ["bb01"] });
});

test("a pinned key that is not hex is refused", () => {
  assert.throws(() => clusterTrust(own, [{ id: "node-1", url: "http://127.0.0.1:1", snapshotPublicKeyHex: "not hex" }]), /PEER_KEY_INVALID/);
});

test("a faucet key that is also a snapshot authority is refused", () => {
  assert.throws(() => clusterTrust(own, [{ id: "node-1", url: "http://127.0.0.1:1", faucetPublicKeyHex: "aa01" }]), /PEER_KEY_REUSED/);
});
