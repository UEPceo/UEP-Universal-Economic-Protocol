#!/usr/bin/env node
/**
 * 0.5.84 item 4: governance key-ceremony tooling (public material only).
 *
 * This tool NEVER generates, reads or stores a private key. Each participant creates their own
 * Ed25519 key on their own offline device, signs the proof-of-possession (PoP) message printed by
 * `pop-message`, and hands over only { participantId, publicKeyHex, popSignatureHex }.
 *
 *   node scripts/governance-ceremony.mjs plan <ceremony.json>
 *   node scripts/governance-ceremony.mjs pop-message <ceremony.json> <participantId>
 *   node scripts/governance-ceremony.mjs verify <ceremony.json> <submissions.json> [--out governance.json]
 *   node scripts/governance-ceremony.mjs self-test      (ephemeral in-memory keys, nothing written)
 *
 * ceremony.json: { "format": "uep-governance-ceremony", "version": 1, "networkId", "networkKind",
 *   "ceremonyId", "threshold", "participants": [{ "id", "role" }], "decisions": { ... } }
 * Output of verify: the governance KeySet { keys, threshold } for config (public keys) and a
 * transcript hash that every participant should check out of band.
 * See docs/GOVERNANCE-KEY-CEREMONY.md.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const HEX32 = /^[0-9a-f]{64}$/;
const REQUIRED_DECISIONS = ["participants", "threshold", "custody", "venue", "witnesses", "rotationPolicy", "lossProcedure", "effectiveHeight"];

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function checkCeremony(c) {
  const problems = [];
  if (!c || c.format !== "uep-governance-ceremony" || c.version !== 1) problems.push("format/version");
  if (typeof c?.networkId !== "string" || !c.networkId) problems.push("networkId");
  if (!["testnet", "mainnet", "lab"].includes(c?.networkKind)) problems.push("networkKind");
  if (typeof c?.ceremonyId !== "string" || !c.ceremonyId) problems.push("ceremonyId");
  const ids = (c?.participants ?? []).map(p => p.id);
  if (!ids.length || new Set(ids).size !== ids.length) problems.push("participants (non-empty, unique ids)");
  const n = ids.length, m = c?.threshold;
  if (!Number.isSafeInteger(m) || m < 1 || m > n) problems.push("threshold (1..N)");
  else if (c.networkKind === "mainnet" && !(m * 2 > n && n >= 3)) problems.push("mainnet threshold must be a strict majority with N >= 3");
  const missing = REQUIRED_DECISIONS.filter(k => c?.decisions?.[k] === undefined || c.decisions[k] === null || c.decisions[k] === "TBD");
  return { problems, missing };
}

export function popMessage(c, participantId) {
  return `uep-governance-ceremony-pop-v1:${stable({ networkId: c.networkId, ceremonyId: c.ceremonyId, threshold: c.threshold, participants: c.participants.map(p => p.id), participantId })}`;
}

const pubKey = (hex) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(hex, "hex")]), format: "der", type: "spki" });

export function verifySubmissions(c, subs) {
  const { problems } = checkCeremony(c);
  if (problems.length) throw new Error(`CEREMONY_INVALID: ${problems.join(", ")}`);
  const errors = [];
  const keys = new Map();
  for (const s of subs) {
    if (!c.participants.some(p => p.id === s.participantId)) { errors.push(`${s.participantId}: not a participant`); continue; }
    if (keys.has(s.participantId)) { errors.push(`${s.participantId}: duplicate submission`); continue; }
    if (!HEX32.test(s.publicKeyHex ?? "")) { errors.push(`${s.participantId}: publicKeyHex must be 32-byte hex`); continue; }
    if ([...keys.values()].includes(s.publicKeyHex)) { errors.push(`${s.participantId}: public key reused`); continue; }
    let ok = false;
    try { ok = verify(null, Buffer.from(popMessage(c, s.participantId)), pubKey(s.publicKeyHex), Buffer.from(s.popSignatureHex ?? "", "hex")); } catch { ok = false; }
    if (!ok) { errors.push(`${s.participantId}: proof-of-possession signature does not verify`); continue; }
    keys.set(s.participantId, s.publicKeyHex);
  }
  const missing = c.participants.map(p => p.id).filter(id => !keys.has(id));
  if (missing.length) errors.push(`missing submissions: ${missing.join(", ")}`);
  if (errors.length) throw new Error(`CEREMONY_SUBMISSIONS_INVALID:\n  ${errors.join("\n  ")}`);
  const governance = { keys: c.participants.map(p => keys.get(p.id)), threshold: c.threshold };
  const transcript = { ceremony: c, submissions: [...subs].sort((a, b) => a.participantId.localeCompare(b.participantId)) };
  return { governance, transcriptHash: sha(`uep-governance-ceremony-transcript-v1:${stable(transcript)}`) };
}

function selfTest() {
  // Ephemeral keys in memory only (TEST-ONLY); never written, never printed.
  const c = { format: "uep-governance-ceremony", version: 1, networkId: "uep-selftest", networkKind: "testnet", ceremonyId: "selftest", threshold: 2,
    participants: [{ id: "p1", role: "test" }, { id: "p2", role: "test" }, { id: "p3", role: "test" }], decisions: {} };
  const subs = c.participants.map(p => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
    return { participantId: p.id, publicKeyHex: raw, popSignatureHex: sign(null, Buffer.from(popMessage(c, p.id)), privateKey).toString("hex") };
  });
  const out = verifySubmissions(c, subs);
  if (out.governance.keys.length !== 3 || out.governance.threshold !== 2) throw new Error("self-test: governance");
  const bad = structuredClone(subs); bad[1].popSignatureHex = bad[0].popSignatureHex;
  let rejected = false; try { verifySubmissions(c, bad); } catch { rejected = true; }
  if (!rejected) throw new Error("self-test: forged PoP accepted");
  const reused = structuredClone(subs); reused[2].publicKeyHex = reused[0].publicKeyHex;
  rejected = false; try { verifySubmissions(c, reused); } catch { rejected = true; }
  if (!rejected) throw new Error("self-test: reused key accepted");
  const missing = checkCeremony(c).missing;
  if (missing.length !== REQUIRED_DECISIONS.length) throw new Error("self-test: decisions check");
  console.log("governance-ceremony self-test: ok (PoP verify, forged PoP rejected, reused key rejected, open decisions listed); no key written");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (process.argv.some(x => /^--(generate|keygen|private)/.test(x))) { console.error("This tool never generates or handles private keys. Each participant generates their own key offline."); process.exit(2); }
  const load = (p) => JSON.parse(readFileSync(p, "utf8"));
  if (cmd === "self-test") selfTest();
  else if (cmd === "plan") {
    const { problems, missing } = checkCeremony(load(a));
    console.log(JSON.stringify({ problems, openDecisions: missing }, null, 2));
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "pop-message") console.log(popMessage(load(a), b));
  else if (cmd === "verify") {
    const out = verifySubmissions(load(a), load(b));
    const i = process.argv.indexOf("--out");
    if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(out.governance, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
  } else { console.error("usage: plan | pop-message | verify | self-test (see header)"); process.exit(2); }
}
