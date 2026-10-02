/**
 * UEP Phase A.1 — explicit security profiles for economic paths.
 */
export type UepSecurityProfile =
  | "LAB_LEGACY"
  | "LAB_SECURE"
  | "TESTNET"
  | "GLOBAL"
  | "INTERPLANETARY";

export function profileRequiresTxAuth(p: UepSecurityProfile): boolean {
  return p !== "LAB_LEGACY";
}

export function profileRequiresAccountKeyBinding(p: UepSecurityProfile): boolean {
  return p !== "LAB_LEGACY";
}

export function profileRequiresDomainBinding(p: UepSecurityProfile): boolean {
  return p !== "LAB_LEGACY";
}
