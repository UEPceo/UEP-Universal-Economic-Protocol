/**
 * UEP-37.6/37.7 — Deterministic single proposer per consensus height + view.
 *
 * Base schedule: leader(height) = sortedIds[(height - 1) % N]
 * With view (silent-leader timeout):
 *   leader(height, view) = sortedIds[(height - 1 + view) % N]
 *
 * view starts at 0; each timeout increments view for the *current* height only.
 * When the height finalizes, view resets to 0 for the next height.
 *
 * LAB only — not full HotStuff/PBFT view-change with QC.
 */

export const LEADER_SCHEDULE_VERSION = "37.7";

export function sortedNodeIds(nodeIds: string[]): string[] {
  return [...nodeIds].sort();
}

/** Scheduled leader for height and view (height >= 1, view >= 0). */
export function scheduledLeader(
  height: number,
  nodeIds: string[],
  view = 0,
): string {
  if (nodeIds.length === 0) throw new Error("no nodes for leader schedule");
  if (height < 1) throw new Error("height must be >= 1");
  if (view < 0) throw new Error("view must be >= 0");
  const sorted = sortedNodeIds(nodeIds);
  const idx = (height - 1 + view) % sorted.length;
  return sorted[idx]!;
}

export function isScheduledLeader(
  nodeId: string,
  height: number,
  nodeIds: string[],
  view = 0,
): boolean {
  return scheduledLeader(height, nodeIds, view) === nodeId;
}

export type ViewChangeReason =
  | "SILENT_LEADER_TIMEOUT"
  | "MANUAL"
  | "LEADER_BYZANTINE";

export type ViewChangeRecord = {
  height: number;
  fromView: number;
  toView: number;
  previousLeader: string;
  newLeader: string;
  reason: ViewChangeReason;
  tick: number;
};
