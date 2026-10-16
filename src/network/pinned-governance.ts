/**
 * 0.5.84 item 4: pinned governance key set per network (public data only).
 *
 * config/governance/<networkId>.json holds the KeySet produced by the key ceremony
 * (scripts/governance-ceremony.mjs verify), the activation height, the rotation policy and a
 * manifest hash. loadPinnedGovernance re-verifies everything from the public transcript:
 * the manifest hash, the transcript hash, every proof-of-possession signature and that the
 * pinned keys are exactly the ones the transcript proves.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeySet } from "../core/asset-registry.ts";

export type PinnedGovernance = {
  format: "uep-governance-set"; version: 1; networkId: string; networkKind: "lab" | "testnet" | "mainnet";
  ceremonyId: string; ceremonyDate: string; governance: KeySet; effectiveHeight: number;
  rotationPolicy: { intervalMonths: number; intervalHeights: number; signaturesRequired: number; note?: string };
  lossProcedure: string; custody: string; transcriptHash: string; transcript: string; manifestHash: string;
};
type Sub = { participantId: string; publicKeyHex: string; popSignatureHex: string };
type Ceremony = { networkId: string; ceremonyId: string; threshold: number; participants: { id: string }[] };

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const governanceManifestHash = (set: Omit<PinnedGovernance, "manifestHash"> & { manifestHash?: string }) => {
  const { manifestHash: _ignored, ...rest } = set;
  return sha(`uep-governance-set-v1:${stable(rest)}`);
};
const popMessage = (c: Ceremony, participantId: string) =>
  `uep-governance-ceremony-pop-v1:${stable({ networkId: c.networkId, ceremonyId: c.ceremonyId, threshold: c.threshold, participants: c.participants.map(p => p.id), participantId })}`;

export function verifyPinnedGovernance(set: PinnedGovernance, transcript: { ceremony: Ceremony; submissions: Sub[] }): PinnedGovernance {
  const fail = (m: string) => { throw new Error(`GOVERNANCE_SET_INVALID: ${m}`); };
  if (set.format !== "uep-governance-set" || set.version !== 1) fail("format");
  if (governanceManifestHash(set) !== set.manifestHash) fail("manifest hash");
  if (sha(`uep-governance-ceremony-transcript-v1:${stable(transcript)}`) !== set.transcriptHash) fail("transcript hash");
  const c = transcript.ceremony;
  if (c.networkId !== set.networkId || c.ceremonyId !== set.ceremonyId || c.threshold !== set.governance.threshold) fail("ceremony fields");
  const ks = set.governance;
  if (!Number.isSafeInteger(ks.threshold) || ks.threshold < 1 || ks.threshold > ks.keys.length || new Set(ks.keys).size !== ks.keys.length) fail("threshold / keys");
  if (ks.keys.length !== c.participants.length) fail("key count");
  c.participants.forEach((p, i) => {
    const s = transcript.submissions.find(x => x.participantId === p.id);
    if (!s || s.publicKeyHex !== ks.keys[i]) fail(`key ${p.id} not proven by the transcript`);
    const pk = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(s!.publicKeyHex, "hex")]), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(popMessage(c, p.id)), pk, Buffer.from(s!.popSignatureHex, "hex"))) fail(`proof of possession ${p.id}`);
  });
  if (!Number.isSafeInteger(set.effectiveHeight) || set.effectiveHeight < 0) fail("effectiveHeight");
  if (set.rotationPolicy.signaturesRequired !== ks.threshold) fail("rotation quorum");
  return set;
}

export function loadPinnedGovernance(networkId: string, root = process.cwd()): PinnedGovernance {
  const set = JSON.parse(readFileSync(join(root, "config/governance", `${networkId}.json`), "utf8")) as PinnedGovernance;
  const transcript = JSON.parse(readFileSync(join(root, set.transcript), "utf8"));
  return verifyPinnedGovernance(set, transcript);
}
