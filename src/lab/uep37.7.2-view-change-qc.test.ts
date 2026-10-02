/**
 * UEP-37.7.2 — View-Change QC unit + adversarial tests
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import {
  VIEW_CHANGE_QC_VERSION,
  viewChangeTargetDigest,
  viewChangeQuorum,
  signViewChangeVote,
  verifyViewChangeVote,
  assembleViewChangeQC,
  verifyViewChangeQC,
  canAdoptViewChangeQC,
  type ViewChangeTarget,
} from "./uep37-view-change-qc.ts";

function nodes(n: number) {
  return Array.from({ length: n }, (_, i) => createNodeIdentity(`mn-${i}`));
}

function target(over: Partial<ViewChangeTarget> = {}): ViewChangeTarget {
  return {
    networkId: "uep-lab",
    domainId: 1,
    epoch: 0,
    height: 1,
    nextView: 1,
    reason: "SILENT_LEADER_TIMEOUT",
    ...over,
  };
}

describe("UEP-37.7.2 ViewChange QC", () => {
  it("version and quorum N=4 → classic 3", () => {
    assert.equal(VIEW_CHANGE_QC_VERSION, "37.7.2");
    const p = viewChangeQuorum(4);
    assert.equal(p.classic, true);
    assert.equal(p.quorum, 3);
  });

  it("valid signature verifies", () => {
    const [a] = nodes(1);
    const t = target();
    const vote = signViewChangeVote(a!, t);
    assert.equal(verifyViewChangeVote(vote, t, a!.publicKeyHex), true);
  });

  it("invalid signature rejected", () => {
    const [a, b] = nodes(2);
    const t = target();
    const vote = signViewChangeVote(a!, t);
    vote.signature = signViewChangeVote(b!, t).signature; // wrong key for nodeId a
    assert.equal(verifyViewChangeVote(vote, t, a!.publicKeyHex), false);
  });

  it("unknown signer rejected at assemble", () => {
    const ns = nodes(4);
    const t = target();
    const outsider = createNodeIdentity("evil");
    const votes = [
      signViewChangeVote(ns[0]!, t),
      signViewChangeVote(ns[1]!, t),
      signViewChangeVote(outsider, t),
    ];
    const pk = (id: string) =>
      [...ns, outsider].find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(
      t,
      votes,
      ns.map((x) => x.nodeId),
      pk,
    );
    // only 2 valid in-set → insufficient
    assert.equal(r.ok, false);
  });

  it("duplicate vote counts once", () => {
    const ns = nodes(4);
    const t = target();
    const v0 = signViewChangeVote(ns[0]!, t);
    const votes = [v0, { ...v0 }, signViewChangeVote(ns[1]!, t)];
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(
      t,
      votes,
      ns.map((x) => x.nodeId),
      pk,
    );
    assert.equal(r.ok, false); // only 2 unique
  });

  it("vote for different nextView does not mix into QC", () => {
    const ns = nodes(4);
    const t1 = target({ nextView: 1 });
    const t2 = target({ nextView: 2 });
    const votes = [
      signViewChangeVote(ns[0]!, t1),
      signViewChangeVote(ns[1]!, t2),
      signViewChangeVote(ns[2]!, t1),
    ];
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(
      t1,
      votes,
      ns.map((x) => x.nodeId),
      pk,
    );
    assert.equal(r.ok, false); // only 2 for t1
  });

  it("vote wrong network not accepted when expected set", () => {
    const ns = nodes(4);
    const t = target({ networkId: "other-net" });
    const votes = ns.slice(0, 3).map((n) => signViewChangeVote(n, t));
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const qc = assembleViewChangeQC(
      t,
      votes,
      ns.map((x) => x.nodeId),
      pk,
    );
    assert.equal(qc.ok, true);
    if (!qc.ok) return;
    const v = verifyViewChangeQC(qc.qc, ns.map((x) => x.nodeId), pk, {
      networkId: "uep-lab",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "NETWORK_MISMATCH");
  });

  it("QC insufficient with 2 of 3 required", () => {
    const ns = nodes(4);
    const t = target();
    const votes = ns.slice(0, 2).map((n) => signViewChangeVote(n, t));
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(
      t,
      votes,
      ns.map((x) => x.nodeId),
      pk,
    );
    assert.equal(r.ok, false);
  });

  it("QC valid with 3 of 4", () => {
    const ns = nodes(4);
    const t = target();
    const votes = ns.slice(0, 3).map((n) => signViewChangeVote(n, t));
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const ids = ns.map((x) => x.nodeId);
    const r = assembleViewChangeQC(t, votes, ids, pk);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const v = verifyViewChangeQC(r.qc, ids, pk);
    assert.equal(v.ok, true);
  });

  it("cannot adopt without QC path: single vote is not adoption", () => {
    const ns = nodes(4);
    const t = target();
    const vote = signViewChangeVote(ns[0]!, t);
    // Single vote is not a QC
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(t, [vote], ns.map((x) => x.nodeId), pk);
    assert.equal(r.ok, false);
  });

  it("stale view rejected by canAdopt", () => {
    const ns = nodes(4);
    const t = target({ nextView: 1 });
    const votes = ns.slice(0, 3).map((n) => signViewChangeVote(n, t));
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(t, votes, ns.map((x) => x.nodeId), pk);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const adopt = canAdoptViewChangeQC(r.qc, {
      height: 1,
      heightView: 1, // already at view 1
      networkId: "uep-lab",
      domainId: 1,
      epoch: 0,
    });
    assert.equal(adopt.ok, false);
  });

  it("adversarial: Byzantine alone cannot force view", () => {
    const ns = nodes(4);
    const byz = ns[3]!;
    const t = target({ nextView: 99, reason: "MANUAL" });
    const pk = (id: string) => ns.find((x) => x.nodeId === id)?.publicKeyHex;
    const r = assembleViewChangeQC(
      t,
      [signViewChangeVote(byz, t)],
      ns.map((x) => x.nodeId),
      pk,
    );
    assert.equal(r.ok, false);
  });

  it("digest is deterministic", () => {
    const t = target();
    assert.equal(viewChangeTargetDigest(t), viewChangeTargetDigest({ ...t }));
  });
});
