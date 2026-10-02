import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import {
  signHeartbeat,
  verifyHeartbeat,
  HeartbeatMonitor,
} from "./uep34-heartbeat.ts";
import { bootFailoverLab } from "./uep34-failover-lab.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("UEP-34.1/34.3 heartbeat", () => {
  it("valid heartbeat verifies; tampered fails", () => {
    const id = createNodeIdentity("L");
    const hb = signHeartbeat(id, {
      networkId: "local",
      domainId: 1,
      epoch: 0,
      counter: 1,
      sequence: 3,
      stateRoot: "R",
      ts: 1,
    });
    assert.equal(
      verifyHeartbeat(hb, id.publicKeyHex, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        leaderNodeId: "L",
      }).ok,
      true,
    );
    const bad = { ...hb, signature: "00".repeat(64) };
    assert.equal(
      verifyHeartbeat(bad, id.publicKeyHex, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        leaderNodeId: "L",
      }).ok,
      false,
    );
  });

  it("monitor fires onSilence without feed", async () => {
    let fired = false;
    const m = new HeartbeatMonitor({
      timeoutMs: 50,
      leaderNodeId: "L",
      epoch: 0,
      onSilence: () => {
        fired = true;
      },
    });
    await sleep(80);
    m.stop();
    assert.equal(fired, true);
  });

  it("monitor does not fire if monotonic counters fed", async () => {
    let fired = false;
    const m = new HeartbeatMonitor({
      timeoutMs: 60,
      leaderNodeId: "L",
      epoch: 0,
      onSilence: () => {
        fired = true;
      },
    });
    await sleep(30);
    assert.equal(m.feed("L", 0, 1), true);
    await sleep(30);
    assert.equal(m.feed("L", 0, 2), true);
    await sleep(30);
    m.stop();
    assert.equal(fired, false);
  });

  it("rejects replay of same or lower counter", () => {
    const m = new HeartbeatMonitor({
      timeoutMs: 5000,
      leaderNodeId: "L",
      epoch: 0,
      onSilence: () => {},
    });
    assert.equal(m.feed("L", 0, 5), true);
    assert.equal(m.feed("L", 0, 5), false); // replay
    assert.equal(m.feed("L", 0, 4), false); // regression
    assert.equal(m.feed("L", 0, 6), true);
    m.stop();
  });

  it("lab: silence without pulse; pulse with counters keeps alive", async () => {
    const lab = bootFailoverLab({ n: 3, heartbeatTimeoutMs: 40 });
    const silences: string[] = [];
    lab.startSilenceMonitors(40, (nodeId) => {
      silences.push(nodeId);
    });
    for (let i = 0; i < 4; i++) {
      assert.equal(lab.pulseHeartbeat().ok, true);
      await sleep(25);
    }
    lab.stopMonitors();
    assert.equal(silences.length, 0);

    const lab2 = bootFailoverLab({ n: 3, heartbeatTimeoutMs: 40 });
    const sil2: string[] = [];
    lab2.startSilenceMonitors(40, (id) => sil2.push(id));
    await sleep(90);
    lab2.stopMonitors();
    assert.ok(sil2.length >= 1);
  });

  it("lab: replaying a captured heartbeat does not reset silence timer forever", async () => {
    const lab = bootFailoverLab({ n: 3, heartbeatTimeoutMs: 5000 });
    lab.startSilenceMonitors(5000, () => {});
    assert.equal(lab.pulseHeartbeat().ok, true); // counter=1
    const m = lab.nodes[1]!.monitor!;
    assert.equal(m.feed(lab.leaderId(), 0, 1), false); // replay
    lab.stopMonitors();
  });
});
