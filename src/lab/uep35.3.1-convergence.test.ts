import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import { bootDissemMesh, DissemNode } from "./uep35-dissemination.ts";
import {
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
} from "./uep34-commit-cert.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import { buildFinalityCertificate } from "./uep35-finality.ts";
import { FinalityBoundLedger } from "./uep35-ledger-finality.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeProp(
  leader: ReturnType<typeof createNodeIdentity>,
  seq: number,
  root: string,
  tid: string,
  nf: string,
) {
  const env = signEnvelope(leader, {
    protocolVersion: NODE_PROTOCOL_VERSION,
    networkId: "local",
    domainId: 1,
    sequence: seq,
    previousStateRoot: seq === 1 ? "GENESIS" : `R${seq - 1}`,
    newStateRoot: root,
    transitionId: tid,
    nullifier: nf,
    ts: seq,
  });
  return proposalFromEnvelope(env);
}

describe("UEP-35.3.1 convergence & recovery", () => {
  it("1. catch-up after partition: B receives missed seq 2,3", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`c${i}`));
    const keys: Record<string, string> = {};
    const idMap = new Map(ids.map((id) => [id.nodeId, id]));
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      identities: idMap,
    });
    try {
      const A = mesh[0]!;
      const B = mesh[1]!;
      // Partition B
      B.enterPartition();
      // A advances 1,2,3 with distributed votes among non-partitioned
      // When B is partitioned, votes from B won't arrive — need all 4 for quorum?
      // n=4 quorum=3 — if B partitioned, A,C,D still 3 nodes can form cert
      for (const seq of [1, 2, 3]) {
        const prop = makeProp(ids[0]!, seq, `R${seq}`, `t${seq}`, `n${seq}`);
        A.broadcast({ type: "proposal", proposal: prop });
        await sleep(80);
        // Manually finalize if cert formed
        const cert = A.getCommitCert(prop.digest);
        if (cert) {
          const fc = buildFinalityCertificate(prop, cert, {
            networkId: "local",
            domainId: 1,
            epoch: 0,
            finalizers: ids,
          });
          A.broadcast({ type: "finality_cert", cert: fc });
          await sleep(40);
        }
      }
      // B still empty
      assert.equal(B.finality.isFinal(3), false);
      // Heal + catch-up
      B.healAndCatchup();
      await sleep(150);
      // A also re-broadcasts catchup response path: requestCatchup relays to peers
      // Ensure A has finals
      assert.equal(A.finality.isFinal(1), true);
      // B should converge after catch-up
      assert.equal(B.finality.isFinal(1), true, "B missing final 1");
      assert.equal(B.finality.isFinal(2), true, "B missing final 2");
      assert.equal(B.finality.isFinal(3), true, "B missing final 3");
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });

  it("2. deduplication: 100x same messages → no unbounded growth", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`d${i}`));
    const keys: Record<string, string> = {};
    const idMap = new Map(ids.map((id) => [id.nodeId, id]));
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      identities: idMap,
    });
    try {
      const prop = makeProp(ids[0]!, 1, "R1", "t1", "n1");
      for (let i = 0; i < 100; i++) {
        mesh[0]!.broadcast({ type: "proposal", proposal: prop });
      }
      await sleep(80);
      const cert = mesh[0]!.getCommitCert(prop.digest);
      assert.ok(cert);
      const fc = buildFinalityCertificate(prop, cert!, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        finalizers: ids,
      });
      for (let i = 0; i < 100; i++) {
        mesh[0]!.broadcast({ type: "finality_cert", cert: fc });
        mesh[0]!.broadcast({ type: "commit_cert", cert: cert! });
      }
      await sleep(50);
      // duplicates counted, log should not have 300 entries of same
      assert.ok(mesh[0]!.stats.duplicates > 50, String(mesh[0]!.stats.duplicates));
      assert.equal(mesh[0]!.finality.isFinal(1), true);
      // seen set size bounded relative to unique msgs
      assert.ok(mesh[0]!.stats.applied < 50, String(mesh[0]!.stats.applied));
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });

  it("3. out-of-order FINAL 3 then 1 then 2 → coherent", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`o${i}`));
    const keys: Record<string, string> = {};
    const idMap = new Map(ids.map((id) => [id.nodeId, id]));
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      identities: idMap,
    });
    try {
      const props = [1, 2, 3].map((seq) =>
        makeProp(ids[0]!, seq, `R${seq}`, `t${seq}`, `n${seq}`),
      );
      for (const p of props) {
        mesh[0]!.broadcast({ type: "proposal", proposal: p });
      }
      await sleep(120);
      const fcs = props.map((p) => {
        const cert = mesh[0]!.getCommitCert(p.digest)!;
        assert.ok(cert, p.digest);
        return buildFinalityCertificate(p, cert, {
          networkId: "local",
          domainId: 1,
          epoch: 0,
          finalizers: ids,
        });
      });
      // Out of order: 3, 1, 2
      mesh[1]!.broadcast({ type: "finality_cert", cert: fcs[2]! });
      mesh[1]!.broadcast({ type: "finality_cert", cert: fcs[0]! });
      mesh[1]!.broadcast({ type: "finality_cert", cert: fcs[1]! });
      await sleep(80);
      for (const n of mesh) {
        assert.equal(n.finality.isFinal(1), true, n.cfg.nodeId);
        assert.equal(n.finality.isFinal(2), true, n.cfg.nodeId);
        assert.equal(n.finality.isFinal(3), true, n.cfg.nodeId);
        assert.equal(n.finality.lastFinalSequence(), 3);
      }
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });

  it("4. distributed vote aggregation forms CommitCert", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`v${i}`));
    const keys: Record<string, string> = {};
    const idMap = new Map(ids.map((id) => [id.nodeId, id]));
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      identities: idMap,
    });
    try {
      const prop = makeProp(ids[0]!, 1, "R1", "t1", "n1");
      // Only broadcast proposal — nodes auto-vote via identity
      mesh[0]!.broadcast({ type: "proposal", proposal: prop });
      await sleep(100);
      // All nodes should have formed or received cert
      let found = 0;
      for (const n of mesh) {
        if (n.getCommitCert(prop.digest)) found++;
      }
      assert.ok(found >= 1, `certs found=${found}`);
      // At least quorum path worked without pre-built cert
      assert.ok(mesh[0]!.getCommitCert(prop.digest));
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });

  it("5. finality → ExecutionEngine real balances + fee/treasury", () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`l${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const candidates = ids.map((x) => x.nodeId);
    const prop = makeProp(ids[0]!, 1, "ROOT-ECON", "te", "ne");
    const votes = ids.map((id) => signCommitVote(id, prop.digest));
    const cert = assembleCommitCert(prop, votes);
    const fc = buildFinalityCertificate(prop, cert, {
      networkId: "local",
      domainId: 1,
      epoch: 0,
      finalizers: ids,
    });
    const ledger = new FinalityBoundLedger({ alice: 1000n, bob: 0n });
    const total0 = ledger.total();
    const r = ledger.applyOnFinal(
      fc,
      {
        sequence: 1,
        from: "alice",
        to: "bob",
        amount: 100n,
        nullifier: "ne",
        transitionId: "te",
        stateRoot: "ROOT-ECON",
        proposalDigest: prop.digest,
      },
      candidates,
      (id) => keys[id],
    );
    assert.equal(r.ok, true, (r as { reason?: string }).reason);
    // fee = creatorFee(100) = 1 (10 bps) typically
    const fee = (r as { fee: bigint }).fee;
    assert.equal(ledger.balance("alice"), 1000n - 100n - fee);
    assert.equal(ledger.balance("bob"), 100n);
    assert.equal(ledger.engine.treasuryBalance, fee);
    assert.equal(ledger.total(), total0); // conservation including treasury
    assert.equal(ledger.engine.stateRoot, "ROOT-ECON");
    // nullifier set
    assert.ok(ledger.engine.exportNullifiers().includes("ne"));
    // idempotent
    assert.equal(
      ledger.applyOnFinal(
        fc,
        {
          sequence: 1,
          from: "alice",
          to: "bob",
          amount: 100n,
          nullifier: "ne",
          transitionId: "te",
          stateRoot: "ROOT-ECON",
          proposalDigest: prop.digest,
        },
        candidates,
        (id) => keys[id],
      ).ok,
      true,
    );
    assert.equal(ledger.balance("alice"), 1000n - 100n - fee);
  });

  it("6. BFT-CLASSIC rejects N=5 node mesh (cannot use majority 3/5)", () => {
    const ids = [0, 1, 2, 3, 4].map((i) => createNodeIdentity(`n5-${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    assert.throws(
      () =>
        new DissemNode({
          nodeId: ids[0]!.nodeId,
          networkId: "local",
          domainId: 1,
          candidates: ids.map((x) => x.nodeId),
          publicKeyOf: (id) => keys[id],
          bftProfile: "BFT-CLASSIC",
        }),
      /BFT_CONFIG|NON_CLASSIC/,
    );
  });
});
