/**
 * Graph-based topology simulation (35.6.1).
 */

import { MockNetworkAdapter } from "./mock-adapter.ts";
import type { TransportType } from "./types.ts";

export type SimNode = {
  id: string;
  transport: TransportType;
  adapter: MockNetworkAdapter;
};

export type Edge = { a: string; b: string; up: boolean };

export type TopologyGraph = {
  nodes: SimNode[];
  edges: Edge[];
};

export function buildTopology(n: number): SimNode[] {
  const types: TransportType[] = ["fiber", "5g", "satellite", "intermittent", "starlink"];
  const nodes: SimNode[] = [];
  for (let i = 0; i < n; i++) {
    const transport = types[i % types.length]!;
    const latency =
      transport === "fiber" ? 5 : transport === "5g" ? 25 : transport === "starlink" ? 45 : transport === "satellite" ? 250 : 500;
    nodes.push({
      id: `node-${i}`,
      transport,
      adapter: new MockNetworkAdapter({
        adapterId: `node-${i}`,
        transport,
        latencyMs: latency,
        bandwidthMbps: transport === "fiber" ? 1000 : 100,
        availability: transport === "intermittent" ? 0.7 : 0.98,
        status: transport === "intermittent" && i % 3 === 0 ? "down" : "up",
      }),
    });
  }
  return nodes;
}

/** Line + some chords for multi-hop potential */
export function buildGraphTopology(n: number): TopologyGraph {
  const nodes = buildTopology(n);
  const edges: Edge[] = [];
  for (let i = 0; i < n - 1; i++) {
    edges.push({
      a: nodes[i]!.id,
      b: nodes[i + 1]!.id,
      up: nodes[i]!.adapter.connectivityStatus() !== "down" && nodes[i + 1]!.adapter.connectivityStatus() !== "down",
    });
  }
  for (let i = 0; i + 2 < n; i += 3) {
    edges.push({ a: nodes[i]!.id, b: nodes[i + 2]!.id, up: true });
  }
  return { nodes, edges };
}

export function deliveryRatio(graph: TopologyGraph): {
  edges: number;
  up: number;
  ratio: number;
} {
  const up = graph.edges.filter((e) => e.up).length;
  return { edges: graph.edges.length, up, ratio: graph.edges.length ? up / graph.edges.length : 0 };
}

export async function floodProbe(nodes: SimNode[]): Promise<{
  attempts: number;
  ok: number;
  failed: number;
}> {
  let attempts = 0;
  let ok = 0;
  let failed = 0;
  for (const n of nodes) {
    attempts++;
    const r = await n.adapter.send("broadcast", new TextEncoder().encode("ping"));
    if (r.ok) ok++;
    else failed++;
  }
  return { attempts, ok, failed };
}
