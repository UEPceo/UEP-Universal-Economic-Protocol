/**
 * UEP-33.2 — Peer role authorization policy.
 */
import type { NodeRole } from "./node-identity.ts";

/**
 * localRole is the node accepting the connection.
 * remoteRole is claimed (and registry-backed) role of the peer.
 */
export function assertPeerRole(
  localRole: NodeRole,
  remoteRole: NodeRole,
): { ok: true } | { ok: false; reason: string } {
  if (localRole === "sequencer") {
    if (remoteRole === "replica" || remoteRole === "observer") return { ok: true };
    return { ok: false, reason: "ROLE_MISMATCH: sequencer only accepts replica/observer" };
  }
  if (localRole === "replica") {
    if (remoteRole === "sequencer") return { ok: true };
    return { ok: false, reason: "ROLE_MISMATCH: replica only accepts sequencer" };
  }
  if (localRole === "observer") {
    if (remoteRole === "sequencer") return { ok: true };
    return { ok: false, reason: "ROLE_MISMATCH: observer only accepts sequencer" };
  }
  return { ok: false, reason: "ROLE_MISMATCH: unknown local role" };
}
