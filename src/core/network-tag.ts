/**
 * v0.5.4: network tag. Binds networkId, protocol and version before a
 * transaction or snapshot is accepted. Does not change fee or hash parameters.
 */
import { sha256Hex } from "./ed25519.ts";

export const PROTOCOL_ID = "UEP-25-prototype";
export const ACCEPTED_TX_VERSIONS = [1, 2] as const;
export const NETWORK_TAG_DOMAIN = "UEP-NET-TAG-V1";

const NETWORK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertNetworkId(networkId: string): void {
  if (typeof networkId !== "string" || !NETWORK_ID_RE.test(networkId)) {
    throw new Error("NETWORK_ID_INVALID: networkId must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
}

export function assertProtocolVersion(protocol: string, version: number): void {
  if (protocol !== PROTOCOL_ID) throw new Error(`PROTOCOL_INVALID: expected ${PROTOCOL_ID}`);
  if (!ACCEPTED_TX_VERSIONS.includes(version as 1 | 2)) throw new Error("TX_VERSION_INVALID: accepted versions are 1 and 2");
}

/** Domain-separated tag. Same inputs always produce the same tag. */
export function networkTag(networkId: string, protocol = PROTOCOL_ID, version = 1): string {
  assertNetworkId(networkId);
  assertProtocolVersion(protocol, version);
  return sha256Hex(`${NETWORK_TAG_DOMAIN}\n${networkId}\n${protocol}\n${version}`);
}
