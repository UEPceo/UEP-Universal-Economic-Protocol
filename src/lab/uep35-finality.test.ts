import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity, NodeRegistry, registryFromIdentity } from "./node-identity.ts";
import {
  FinalityLedger,
  buildFinalityCertificate,
} from "./uep35-finality.ts";
import {
  ProposalBoard,
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
} from "./uep34-commit-cert.ts";
import { LabNode, NODE_PROTOCOL_VERSION, signEnvelope } from "./node-protocol.ts";

describe("UEP-35.0 finality model", () => {
  it("accepts single FINAL; rejects double-finality different digests", () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`f${i}`));
    const candidates = ids.map((x) => x.nodeId);
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;

    const leader = ids[0]!;
    const env = signEnvelope(leader, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
      ts: 1,
    });
    const prop = proposalFromEnvelope(env);
    const board = new ProposalBoard();
    board.register(prop);
    const votes = ids.map((id) => signCommitVote(id, prop.digest));
    const commitCert = assembleCommitCert(prop, votes);

    const fc = buildFinalityCertificate(prop, commitCert, {
      networkId: "local",
      domainId: 1,
      epoch: 0,
      finalizers: ids,
    });

    const ledger = new FinalityLedger();
    assert.equal(
      ledger.acceptFinal(fc, candidates, (id) => keys[id], {
        requireClassicBft: true,
      }).ok,
      true,
    );
    assert.equal(ledger.isFinal(1), true);

    // conflicting finality same seq
    const env2 = signEnvelope(leader, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "R-EVIL",
      transitionId: "t-evil",
      nullifier: "n-evil",
      ts: 2,
    });
    const prop2 = proposalFromEnvelope(env2);
    const votes2 = ids.map((id) => signCommitVote(id, prop2.digest));
    const cert2 = assembleCommitCert(prop2, votes2);
    const fc2 = buildFinalityCertificate(prop2, cert2, {
      networkId: "local",
      domainId: 1,
      epoch: 0,
      finalizers: ids,
    });
    const r2 = ledger.acceptFinal(fc2, candidates, (id) => keys[id], {
      requireClassicBft: true,
    });
    assert.equal(r2.ok, false);
    assert.equal((r2 as { reason: string }).reason, "DOUBLE_FINALITY");
  });

  it("idempotent FINAL same digest", () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`g${i}`));
    const candidates = ids.map((x) => x.nodeId);
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const leader = ids[0]!;
    const env = signEnvelope(leader, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
      ts: 1,
    });
    const prop = proposalFromEnvelope(env);
    const votes = ids.map((id) => signCommitVote(id, prop.digest));
    const commitCert = assembleCommitCert(prop, votes);
    const fc = buildFinalityCertificate(prop, commitCert, {
      networkId: "local",
      domainId: 1,
      epoch: 0,
      finalizers: ids,
    });
    const ledger = new FinalityLedger();
    assert.equal(ledger.acceptFinal(fc, candidates, (id) => keys[id]).ok, true);
    assert.equal(ledger.acceptFinal(fc, candidates, (id) => keys[id]).ok, true);
  });
});
