/**
 * UEP network profiles — prevent silent non-ZK on testnet paths.
 */

export type NetworkProfile = "DEV-STRUCTURAL" | "DEV-ZK" | "TESTNET-ZK";

export type ProfilePolicy = {
  profile: NetworkProfile;
  /** Engine may run without SNARK. */
  allowRequireProofFalse: boolean;
  /** Replica must Groth16-verify before apply. */
  requireZkVerifyOnAccept: boolean;
  /** Envelope must carry proof + public inputs when applying transitions. */
  requireProofOnEnvelope: boolean;
};

const POLICIES: Record<NetworkProfile, ProfilePolicy> = {
  "DEV-STRUCTURAL": {
    profile: "DEV-STRUCTURAL",
    allowRequireProofFalse: true,
    requireZkVerifyOnAccept: false,
    requireProofOnEnvelope: false,
  },
  "DEV-ZK": {
    profile: "DEV-ZK",
    allowRequireProofFalse: true, // tests may mix
    requireZkVerifyOnAccept: true,
    requireProofOnEnvelope: true,
  },
  "TESTNET-ZK": {
    profile: "TESTNET-ZK",
    allowRequireProofFalse: false,
    requireZkVerifyOnAccept: true,
    requireProofOnEnvelope: true,
  },
};

export function getProfilePolicy(profile: NetworkProfile): ProfilePolicy {
  return POLICIES[profile];
}

/** Throws if requireProof=false under TESTNET-ZK. */
export function assertEngineProofPolicy(
  profile: NetworkProfile,
  requireProof: boolean,
): void {
  const p = getProfilePolicy(profile);
  if (!p.allowRequireProofFalse && !requireProof) {
    throw new Error(
      `PROFILE_VIOLATION: ${profile} forbids requireProof=false`,
    );
  }
}
