import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateObservation,
  type NetworkObservation,
} from "./uep-net-adapt/types.ts";
import { MockNetworkAdapter } from "./uep-net-adapt/mock-adapter.ts";
import { StarlinkAdapter } from "./uep-net-adapt/starlink-adapter.ts";
import { selectRelay, type RelayCapability } from "./uep-net-adapt/relay.ts";
import { DtnBridge } from "./uep-net-adapt/dtn-bridge.ts";
import { buildTopology, floodProbe } from "./uep-net-adapt/topology-sim.ts";
import { UepWorker } from "./uep35-worker.ts";
import { BatchDag } from "./uep35-dag.ts";

describe("UEP-35.6 NetworkAdapter + Starlink + DTN", () => {
  it("rejects impossible / stale telemetry", () => {
    const base: NetworkObservation = {
      transport: "starlink",
      latencyMs: 40,
      jitterMs: 1,
      packetLoss: 0,
      bandwidthMbps: 100,
      availability: 0.99,
      timestamp: Date.now(),
      source: "t",
      confidence: "SELF_REPORTED",
    };
    assert.equal(validateObservation({ ...base, latencyMs: -1 }).ok, false);
    assert.equal(validateObservation({ ...base, bandwidthMbps: 9e9 }).ok, false);
    assert.equal(
      validateObservation({ ...base, timestamp: Date.now() - 48 * 3600_000 }).ok,
      false,
    );
  });

  it("relay selection is policy-dependent and reproducible", () => {
    const mk = (
      id: string,
      latencyMs: number,
      bandwidthMbps: number,
      availability: number,
    ): RelayCapability => ({
      relayId: id,
      transport: "mock",
      trust: "MEASURED",
      observation: {
        transport: "mock",
        latencyMs,
        jitterMs: 1,
        packetLoss: 0.01,
        bandwidthMbps,
        availability,
        timestamp: Date.now(),
        source: id,
        confidence: "MEASURED",
      },
    });
    const relays = [
      mk("A", 40, 100, 0.99),
      mk("B", 200, 500, 0.95),
      mk("C", 600, 20, 0.999),
    ];
    const lat = selectRelay(relays, "latency_sensitive");
    const thr = selectRelay(relays, "throughput_sensitive");
    const rel = selectRelay(relays, "reliability_sensitive");
    assert.equal(lat?.relayId, "A");
    assert.equal(thr?.relayId, "B");
    assert.equal(rel?.relayId, "C");
  });

  it("Starlink intermittent: queue then transport-accept; not economic rollback", async () => {
    const star = new StarlinkAdapter({ provider: "mock", initialUp: false });
    const dtn = new DtnBridge(star);
    const r1 = await dtn.send({
      id: "m1",
      payload: new TextEncoder().encode("hello"),
      createdAt: Date.now(),
    });
    assert.equal(r1, "QUEUED");
    assert.equal(dtn.pendingCount(), 1);
    star.setLinkUp(true);
    await dtn.retry();
    assert.equal(dtn.getState("m1"), "ACCEPTED_BY_TRANSPORT");
    // transport accept ≠ remote ACK / economic finality
    assert.notEqual(dtn.getState("m1"), "ACKNOWLEDGED");
  });

  it("topology flood 20 nodes", async () => {
    const nodes = buildTopology(20);
    const r = await floodProbe(nodes);
    assert.equal(r.attempts, 20);
    assert.ok(r.ok + r.failed === 20);
  });

  it("data plane: header without body; wrong digest recovery", () => {
    const a = new UepWorker({ workerId: "a", epoch: 0 });
    const b = new UepWorker({ workerId: "b", epoch: 0 });
    a.admit({ id: "x", from: "u", to: "v", amount: 1n });
    const p = a.produceBatch()!;
    assert.equal(b.announceHeader(p.header).ok, true);
    assert.equal(b.dag.hasBody(p.header.batchId), false);
    const bad = [{ ...p.txs[0]!, amount: 99n }];
    assert.equal(b.ingestRecovery(p.header, bad).ok, false);
    const resp = a.respondBatch(p.header.batchId, "rq");
    assert.equal(resp.ok, true);
    if (resp.ok) assert.equal(b.ingestRecovery(resp.header, resp.txs).ok, true);
  });
});
