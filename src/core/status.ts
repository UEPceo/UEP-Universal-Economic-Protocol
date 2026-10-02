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
  hashBackend: "Poseidon BN254 t=3 alpha=5, UEP-26 domain composition (NOT Poseidon2)",
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
  "The protocol hash is Poseidon over BN254 (t=3, alpha=5, circomlib-compatible constants) with the UEP-26 domain composition, the same hash as the research spend circuit. It is not Poseidon2. Testnet only: no production proving keys or ceremony.";
