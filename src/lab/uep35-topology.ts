/**
 * UEP-35.10 — Multi-host topology configuration.
 * Maps logical nodes → host:port (localhost LAB or real machines).
 */

export type HostEndpoint = {
  nodeId: string;
  host: string;
  dataPort: number;
  /** Bind address for listeners (0.0.0.0 for multi-machine) */
  bindHost?: string;
};

export type TopologyFile = {
  version: "35.10";
  networkId: string;
  domainId: number;
  endpoints: HostEndpoint[];
};

export function localhostTopology(n: number, basePort = 0): TopologyFile {
  const endpoints: HostEndpoint[] = [];
  for (let i = 0; i < n; i++) {
    endpoints.push({
      nodeId: `mn-${i}`,
      host: "127.0.0.1",
      dataPort: basePort > 0 ? basePort + i : 0, // 0 = ephemeral
      bindHost: "127.0.0.1",
    });
  }
  return {
    version: "35.10",
    networkId: "lab-mn",
    domainId: 1,
    endpoints,
  };
}

/** Example multi-machine topology (documentation / future deploy). */
export function exampleFourMachinesTopology(): TopologyFile {
  return {
    version: "35.10",
    networkId: "lab-mn",
    domainId: 1,
    endpoints: [
      { nodeId: "mn-0", host: "10.0.0.1", dataPort: 7100, bindHost: "0.0.0.0" },
      { nodeId: "mn-1", host: "10.0.0.2", dataPort: 7100, bindHost: "0.0.0.0" },
      { nodeId: "mn-2", host: "10.0.0.3", dataPort: 7100, bindHost: "0.0.0.0" },
      { nodeId: "mn-3", host: "10.0.0.4", dataPort: 7100, bindHost: "0.0.0.0" },
    ],
  };
}

export function validateTopology(t: TopologyFile): { ok: true } | { ok: false; reason: string } {
  if (t.version !== "35.10") return { ok: false, reason: "BAD_VERSION" };
  if (!t.endpoints.length) return { ok: false, reason: "EMPTY" };
  const ids = new Set<string>();
  for (const e of t.endpoints) {
    if (ids.has(e.nodeId)) return { ok: false, reason: "DUP_NODE" };
    ids.add(e.nodeId);
    if (!e.host || e.dataPort < 0) return { ok: false, reason: "BAD_ENDPOINT" };
  }
  return { ok: true };
}

export function peerListFor(
  topology: TopologyFile,
  selfId: string,
): Array<{ id: string; host: string; port: number }> {
  return topology.endpoints
    .filter((e) => e.nodeId !== selfId)
    .map((e) => ({ id: e.nodeId, host: e.host, port: e.dataPort }));
}
