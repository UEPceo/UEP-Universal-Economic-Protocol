/**
 * 0.5.84 store continuity, EXP-104 fixture: a child process that votes once and SIGKILLs itself at a
 * store write point between fsync and rename. It prints "SIGNED <signature>" only after createVote
 * returned, i.e. after the vote record is durable. Test-only keys come from <keys.json> (created by the
 * parent in a temporary directory and deleted afterwards).
 *   node --experimental-strip-types src/node/bft-store-continuity-signer.fixture.ts <backend> <stateDir> <keys.json> <point|none> <genesis|restart> <block>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import { BftDurableStateStore, createDurableBftConsensusKernel } from "./bft-durable-store.ts";
import { openUnifiedValidatorState } from "./unified-node-state.ts";
import type { BftConsensusKernel } from "./bft-consensus.ts";

const [backend, stateDir, keysFile, point, start, block] = process.argv.slice(2) as [string, string, string, string, string, string];
const { domain, validators, pems } = JSON.parse(readFileSync(keysFile, "utf8")) as { domain: { networkId: string; domainId: string }; validators: { id: string; publicKeyHex: string }[]; pems: string[] };
const keys = pems.map(p => createPrivateKey(p));
const continuity = start === "genesis" ? { init: "genesis" as const } : {};
const die = () => { process.kill(process.pid, "SIGKILL"); };
let armed = false;
let kernel: BftConsensusKernel;
if (backend === "legacy") {
  const path = join(stateDir, "bft-kernel.json");
  const orig = BftDurableStateStore.prototype.save;
  // Arm the fault inside save(): fsync of the temp file done, rename not yet done.
  BftDurableStateStore.prototype.save = function (this: BftDurableStateStore, st) {
    this.faultInjector = (p) => { if (armed && p === point) die(); };
    return orig.call(this, st);
  };
  kernel = createDurableBftConsensusKernel(domain, validators, 1, path, {}, continuity);
} else {
  const u = openUnifiedValidatorState(stateDir, domain, validators, 1, {}, {
    autoCompactFrames: 1, // every frame triggers a checkpoint: exercises checkpoint fsync -> rename
    faultInjector: (p) => { if (armed && p === point) die(); },
  }, continuity);
  kernel = u.kernel;
}
const proposal = { ...domain, height: 1, round: 0, proposerId: kernel.leader(1, 0), parentRoot: "0".repeat(64), blockId: block.repeat(64).slice(0, 64) };
const leaderIdx = validators.findIndex(v => v.id === proposal.proposerId);
const voter = validators.findIndex(v => v.id !== proposal.proposerId);
armed = point !== "none";
try {
  const vote = kernel.createVote(proposal, "prevote", validators[voter]!.id, keys[voter]!, kernel.signProposal(proposal, keys[leaderIdx]!));
  process.stdout.write(`SIGNED ${vote.signature}\n`);
} catch (e) {
  process.stdout.write(`REFUSED ${(e as Error).message}\n`);
}
