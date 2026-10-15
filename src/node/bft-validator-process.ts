/**
 * One BFT validator in its own OS process (item 3 harness, 0.5.81). Experimental.
 *
 * Own keys, own state directory (durable kernel store + certified commit log), PeerNet for
 * validator traffic, and a separate control port on 127.0.0.1 used only by the test harness
 * to ask this validator to propose, sync, report its state, or (when configured byzantine)
 * send conflicting proposals. The control port is not part of the protocol.
 *
 *   node --experimental-strip-types src/node/bft-validator-process.ts <config.json>
 */
import { createServer } from "node:http";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signEd25519 } from "../core/ed25519.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { createDurableBftConsensusKernel } from "./bft-durable-store.ts";
import type { BftProposal, BftValidator } from "./bft-consensus.ts";
import { txFromWire, txToWire } from "./certified-commit.ts";
import { PeerNet, type Peer } from "./peer-net.ts";

type Config = {
  id: string; voterPem: string; stateDir: string; peerPort: number; controlPort: number;
  validators: BftValidator[]; faultTolerance: number; peers: Peer[];
  genesisFile: string; trust: { authorities: string[]; faucetPublicKeys: string[] };
};

const decode = (_k: string, v: unknown) => v && typeof v === "object" && "$b" in v && typeof (v as { $b: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;
const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Config;
const key = createPrivateKey(cfg.voterPem);
const me = cfg.validators.find(v => v.id === cfg.id)!;
const genesis = JSON.parse(readFileSync(cfg.genesisFile, "utf8"), decode);
const ledger = UepLedger.restore(genesis, cfg.trust);
const voters = new Map(cfg.validators.map(v => [v.id, v.publicKeyHex]));
const net = new PeerNet(cfg.id, ledger, key, me.publicKeyHex, cfg.peers, voters, 2, cfg.stateDir);
const domain = { networkId: ledger.networkId, domainId: ledger.domainId };
const kernel = createDurableBftConsensusKernel(domain, cfg.validators, cfg.faultTolerance, join(cfg.stateDir, "bft-kernel.json"));
net.configureBftConsensus(kernel);
await net.recoverBftCommits();
await net.listen(cfg.peerPort);

const reply = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body, encode));
};
const readBody = (req: import("node:http").IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let s = ""; req.on("data", c => { s += c; }); req.on("end", () => resolve(s ? JSON.parse(s, decode) : {}));
});

const state = () => ({
  id: cfg.id, stateRoot: net.ledger.stateRoot().toHex(), txCount: net.ledger.txs.length,
  committed: kernel.exportState().committed,
  status: Object.fromEntries(kernel.exportState().committed.map(([h]) => [h, net.bftCommitStatus(Number(h))])),
  expectedHeight: (net as unknown as { committer: { expectedHeight(): number } }).committer.expectedHeight(),
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const body = req.method === "POST" ? await readBody(req) : {};
    if (url.pathname === "/ctl/state") return reply(res, 200, state());
    if (url.pathname === "/ctl/sync") return reply(res, 200, { applied: await net.bftSync(), ...state() });
    if (url.pathname === "/ctl/propose") {
      const tx = txFromWire(body.tx as never);
      const height = state().expectedHeight;
      const round = Number(body.round ?? 0);
      const proposal: BftProposal = { ...domain, height, round, proposerId: cfg.id, parentRoot: net.ledger.stateRoot().toHex(), blockId: tx.txId.toHex() };
      const cert = await net.bftPropose(proposal, tx);
      return reply(res, 200, { height, blockId: cert.blockId, votes: cert.votes.length });
    }
    if (url.pathname === "/ctl/equivocate") {
      // Byzantine behaviour: two signed proposals for the same height/round with different blocks,
      // each sent to a different half of the peers. Honest validators must never certify both.
      const txs = (body.txs as never[]).map(w => txFromWire(w));
      const height = state().expectedHeight;
      const parentRoot = net.ledger.stateRoot().toHex();
      const out: unknown[] = [];
      for (const [i, peer] of cfg.peers.entries()) {
        const tx = txs[i % 2]!;
        const proposal: BftProposal = { ...domain, height, round: 0, proposerId: cfg.id, parentRoot, blockId: tx.txId.toHex() };
        const payload = { proposal, proposalSignature: kernel.signProposal(proposal, key), tx: txToWire(tx) };
        const signature = signEd25519(`uep-peer:${cfg.id}:/bft/proposal:${JSON.stringify(payload)}`, key);
        const r = await fetch(peer.url + "/bft/proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: cfg.id, payload, signature }, encode) }).then(x => x.json()).catch(() => null);
        out.push({ peer: peer.id, block: proposal.blockId, vote: !!(r as { vote?: unknown } | null)?.vote });
      }
      return reply(res, 200, { height, out });
    }
    return reply(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    return reply(res, 409, { error: (error as Error).message });
  }
}).listen(cfg.controlPort, "127.0.0.1", () => console.log(`uep-bft-validator ${cfg.id} peer=${cfg.peerPort} control=${cfg.controlPort}`));
