/**
 * UEP-32.5b — Pinned verifying keys per network (not per-transaction VK choice).
 *
 * Testnet rule: envelope carries vk_id; nodes resolve vkHex from local pin.
 * Arbitrary vkHex in the wire must match the pin or be rejected.
 */

import type { NetworkProfile } from "./network-profile.ts";

export type PinnedVerifyingKey = {
  vkId: string;
  vkHex: string;
  networkId: string;
  /** Optional human label e.g. UEP-D32-VK-001 */
  label?: string;
  profile?: NetworkProfile;
};

function key(networkId: string, vkId: string): string {
  return `${networkId}::${vkId}`;
}

export class VerifyingKeyRegistry {
  private pins = new Map<string, PinnedVerifyingKey>();

  pin(entry: PinnedVerifyingKey): void {
    if (!entry.vkId || !entry.vkHex || !entry.networkId) {
      throw new Error("VK_PIN_INCOMPLETE");
    }
    this.pins.set(key(entry.networkId, entry.vkId), { ...entry });
  }

  get(networkId: string, vkId: string): PinnedVerifyingKey | undefined {
    return this.pins.get(key(networkId, vkId));
  }

  resolveHex(networkId: string, vkId: string): string | null {
    return this.get(networkId, vkId)?.vkHex ?? null;
  }

  list(networkId?: string): PinnedVerifyingKey[] {
    const all = [...this.pins.values()];
    return networkId ? all.filter((p) => p.networkId === networkId) : all;
  }

  /** True if this vkId is authorized for the network. */
  isPinned(networkId: string, vkId: string): boolean {
    return this.pins.has(key(networkId, vkId));
  }
}

/** Shared lab helper: pin prover artifact to both sequencer and replicas. */
export function pinProverArtifact(
  registry: VerifyingKeyRegistry,
  opts: {
    networkId: string;
    vkId: string;
    vkHex: string;
    label?: string;
    profile?: NetworkProfile;
  },
): void {
  registry.pin({
    networkId: opts.networkId,
    vkId: opts.vkId,
    vkHex: opts.vkHex,
    label: opts.label ?? opts.vkId,
    profile: opts.profile,
  });
}
