/**
 * Snapshot trust for a fixed cluster. Each node signs with its own snapshot key and mints with its own
 * faucet key, so a snapshot served by a peer verifies only if the cluster's pinned keys are trusted.
 * A key that is not pinned in the peer list is never trusted: a peer cannot announce its own authority.
 * Limit: one valid authority signature is enough (threshold 1), so catch-up trusts the serving peer.
 */
import type { Peer } from "./peer-net.ts";

export type ClusterTrust = { authorities: string[]; faucetPublicKeys: string[] };

const HEX = /^[0-9a-f]+$/i;

export function clusterTrust(own: { snapshotPublicKeyHex: string; faucetPublicKeyHex: string }, peers: Peer[]): ClusterTrust {
  const authorities = new Set<string>([own.snapshotPublicKeyHex]);
  const faucets = new Set<string>([own.faucetPublicKeyHex]);
  for (const peer of peers) {
    for (const [name, key] of [["snapshotPublicKeyHex", peer.snapshotPublicKeyHex], ["faucetPublicKeyHex", peer.faucetPublicKeyHex]] as const) {
      if (key !== undefined && (typeof key !== "string" || !HEX.test(key))) throw new Error(`PEER_KEY_INVALID: ${peer.id}.${name}`);
    }
    if (peer.snapshotPublicKeyHex) authorities.add(peer.snapshotPublicKeyHex);
    if (peer.faucetPublicKeyHex) faucets.add(peer.faucetPublicKeyHex);
  }
  for (const key of faucets) if (authorities.has(key)) throw new Error("PEER_KEY_REUSED: a faucet key is also a snapshot authority key");
  return { authorities: [...authorities], faucetPublicKeys: [...faucets] };
}
