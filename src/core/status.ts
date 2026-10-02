/**
 * Honesty labels required by the UEP project rules.
 * Never upgrade a label without a reproducible test.
 */
export type ImplementationStatus =
  | "CONCEPTUAL"
  | "SIMULATED"
  | "IMPLEMENTED"
  | "TESTED"
  | "BENCHMARKED";

export const PROTOCOL = {
  walletVersion: "0.1.0",
  /**
   * Requested reference was uep-crypto-core-v0.4.zip — that archive was not
   * in the project artifacts. The wallet is bound to the latest present core:
   * UEP-25 prototype + Testnet-0 alpha.
   */
  coreName: "UEP-25 prototype",
  coreMilestone: "UEP-25",
  requestedCore: "uep-crypto-core-v0.4 (archive not present)",
  hashBackend: "UEP-25 algebraic placeholder (NOT Poseidon, NOT Poseidon2)",
  hashStatus: "IMPLEMENTED" as ImplementationStatus,
  poseidon2Status: "CONCEPTUAL" as ImplementationStatus,
  groth16Status: "TESTED" as ImplementationStatus, // Rust core; wallet provider still NOT WIRED
  novaStatus: "CONCEPTUAL" as ImplementationStatus,
  zkSpendStatus: "CONCEPTUAL" as ImplementationStatus,
  smtStatus: "IMPLEMENTED" as ImplementationStatus,
  uep009Status: "IMPLEMENTED" as ImplementationStatus,
  globalNetworkStatus: "CONCEPTUAL" as ImplementationStatus,
  interplanetaryStatus: "SIMULATED" as ImplementationStatus,
  securityPolicyStatus: "TESTED" as ImplementationStatus,
  oracleStatus: "SIMULATED" as ImplementationStatus,
  liquidityStatus: "TESTED" as ImplementationStatus,
} as const;

export const HASH_DISCLAIMER =
  "This wallet uses the UEP-25 domain-separated algebraic hash placeholder. It is deterministic and circuit-shaped, but it is NOT Poseidon and NOT Poseidon2. UEP-26 froze Poseidon (not Poseidon2); the live wallet still uses the UEP-25 algebraic placeholder until a coordinated migration.";
