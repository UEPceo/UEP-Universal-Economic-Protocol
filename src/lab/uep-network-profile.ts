/**
 * UEP-NET-001 — network profile.
 * A profile names the network. It is not a testnet and it is not a ceremony.
 */
export const UEP_NET_PROFILE_ID = "UEP-NET-001";

export type NetworkKind = "LAB" | "TESTNET";

export type NetworkProfile = {
  profileId: string;
  kind: NetworkKind;
  networkId: string;
  domainId: string;
  domainNumber: number;
  depth: 32;
  hash: "BN254-Poseidon-t3-alpha5";
  circuitId: "UEP-27-SPEND-POSEIDON-D32-v3-feefloor";
  keys: "DEV-TEST-KEYS";
  ceremony: false;
  testnetAllowed: false;
  feeBps: 10;
  genesisLabel: string;
};

export const LAB_PROFILE: NetworkProfile = {
  profileId: UEP_NET_PROFILE_ID,
  kind: "LAB",
  networkId: "uep-lab-1",
  domainId: "lab-earth-0",
  domainNumber: 1,
  depth: 32,
  hash: "BN254-Poseidon-t3-alpha5",
  circuitId: "UEP-27-SPEND-POSEIDON-D32-v3-feefloor",
  keys: "DEV-TEST-KEYS",
  ceremony: false,
  testnetAllowed: false,
  feeBps: 10,
  genesisLabel: "empty Poseidon SMT, lab fixture accounts",
};

export function activateProfile(profile: NetworkProfile): { ok: true; profile: NetworkProfile } | { ok: false; reason: string } {
  if (profile.kind === "TESTNET" || profile.testnetAllowed) {
    if (!profile.ceremony || profile.keys === "DEV-TEST-KEYS") {
      return { ok: false, reason: "TESTNET_BLOCKED_NO_CEREMONY" };
    }
  }
  if (profile.networkId.length < 3 || profile.domainId.length < 3) {
    return { ok: false, reason: "PROFILE_INCOMPLETE" };
  }
  return { ok: true, profile };
}

export function assertSameNetwork(profile: NetworkProfile, networkId: string, domainId: string): { ok: boolean; reason?: string } {
  if (networkId !== profile.networkId) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (domainId !== profile.domainId) return { ok: false, reason: "DOMAIN_MISMATCH" };
  return { ok: true };
}
