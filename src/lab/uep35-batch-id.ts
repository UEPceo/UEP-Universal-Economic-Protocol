/**
 * UEP-35.6.2 — BatchId semantics
 *
 * BatchId identifies **batch content / availability** (what was proposed),
 * NOT the post-execution StateRoot / ExecutionStateCommitment.
 *
 * Association for consensus:
 *   CommitCert / FinalityCert bind: epoch + height + batchId + stateRoot
 */

import { createHash } from "node:crypto";

export const BATCH_ID_SEMANTICS = {
  identifies: "content_availability" as const,
  doesNotIdentify: "execution_result_state_root" as const,
  formula:
    "SHA256(UEP-BATCH-ID|workerId|epoch|height|parents|txDigest|txCount|byteSize)[:32]",
};

export type BatchIdInputs = {
  workerId: string;
  epoch: number;
  height: number;
  parents: string[];
  txDigest: string;
  txCount: number;
  byteSize: number;
};

export function computeBatchId(input: BatchIdInputs): string {
  return createHash("sha256")
    .update(
      [
        "UEP-BATCH-ID",
        input.workerId,
        String(input.epoch),
        String(input.height),
        input.parents.join(","),
        input.txDigest,
        String(input.txCount),
        String(input.byteSize),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Two distinct semantic objects must not share batchId. */
export function batchIdCollisionCheck(
  a: BatchIdInputs,
  b: BatchIdInputs,
): boolean {
  return computeBatchId(a) === computeBatchId(b);
}
