import { fileURLToPath } from "node:url";
/**
 * UEP-35.9 — Launch 4 OS processes (one per node), coordinate via stdin JSON.
 * "4 machines" LAB model: 4 processes, isolated memory, TCP between them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateBootstrap, bootstrapForNode, type BootstrapFile } from "./uep35-process-node.ts";

export type ProcNode = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  port?: number;
  events: unknown[];
};

function send(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function waitEvent(
  node: ProcNode,
  predicate: (e: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
  fromIndex = 0,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (const e of node.events.slice(fromIndex)) {
        const rec = e as Record<string, unknown>;
        if (predicate(rec)) {
          clearInterval(timer);
          resolve(rec);
          return;
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting event for ${node.id}`));
      }
    }, 20);
  });
}

export class ProcessCluster {
  nodes: ProcNode[] = [];
  bootstrapPath = "";
  bootstrap!: BootstrapFile;
  leafMode: "local" | "structural" | "poseidon-zk" = "local";
  smtDepth?: number;
  leaderTimeoutMs = 0;

  async start(
    n = 4,
    opts?: {
      leafMode?: "local" | "structural" | "poseidon-zk";
      smtDepth?: number;
      leaderTimeoutMs?: number;
    },
  ): Promise<void> {
    this.leafMode = opts?.leafMode ?? "local";
    this.smtDepth = opts?.smtDepth;
    this.leaderTimeoutMs = opts?.leaderTimeoutMs ?? 0;

    this.bootstrap = generateBootstrap(n);
    // strip private keys from other nodes when writing? each process needs only its key
    // but bootstrap file has all keys — LAB only; production would use secret injection
    const dir = join(tmpdir(), `uep-35.9-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    this.bootstrapPath = join(dir, "bootstrap.json");
    writeFileSync(this.bootstrapPath, JSON.stringify(this.bootstrap, null, 2));

    // Resolved next to this module, so the cluster works from any cwd.
    const entry = fileURLToPath(new URL("./uep35-process-node.ts", import.meta.url));

    for (const bn of this.bootstrap.nodes) {
      // each process only receives its own private key
      const nodeBoot = bootstrapForNode(this.bootstrap, bn.id);
      const nodePath = join(dir, `bootstrap-${bn.id}.json`);
      writeFileSync(nodePath, JSON.stringify(nodeBoot, null, 2));
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          entry,
        ],
        {
          env: {
            ...process.env,
            UEP_PROCESS_NODE: "1",
            UEP_NODE_ID: bn.id,
            UEP_BOOTSTRAP: nodePath,
            UEP_LEAF_MODE: this.leafMode,
            ...(this.smtDepth !== undefined
              ? { UEP_SMT_DEPTH: String(this.smtDepth) }
              : {}),
            ...(this.leaderTimeoutMs > 0
              ? { UEP_LEADER_TIMEOUT_MS: String(this.leaderTimeoutMs) }
              : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const node: ProcNode = { id: bn.id, child, events: [] };
      child.stdout.setEncoding("utf8");
      let buf = "";
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            node.events.push(JSON.parse(line));
          } catch {
            /* ignore */
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        // surface errors for debugging
        node.events.push({ event: "stderr", text: c.toString() });
      });
      this.nodes.push(node);
    }

    // wait ready
    for (const node of this.nodes) {
      const ready = await waitEvent(node, (e) => e.event === "ready");
      node.port = ready.port as number;
    }

    // connect mesh: each node gets list of all peers
    const peers = this.nodes.map((n) => ({
      id: n.id,
      port: n.port!,
      host: "127.0.0.1",
    }));
    for (const node of this.nodes) {
      send(node.child, { cmd: "connect", peers });
    }
    for (const node of this.nodes) {
      await waitEvent(node, (e) => e.event === "connected");
    }
    await this.waitFullMesh(peers);
  }

  /**
   * v0.5.3: "connected" only means that the dial loop finished; a peer can
   * still be missing (simultaneous dials, slow accept). Wait until every node
   * reports every other node as a peer, re-sending `connect` to nodes that
   * miss one, so that tests never start a round on a partial mesh.
   */
  private async waitFullMesh(peers: Array<{ id: string; port: number; host: string }>, timeoutMs = 8000): Promise<void> {
    const t0 = Date.now();
    for (let round = 0; Date.now() - t0 < timeoutMs; round++) {
      const st = await this.peerStatus();
      const missing = this.nodes.filter((n) => {
        const have = new Set(st.get(n.id) ?? []);
        return this.nodes.some((o) => o.id !== n.id && !have.has(o.id));
      });
      if (missing.length === 0) return;
      if (round % 5 === 4) for (const n of missing) send(n.child, { cmd: "connect", peers });
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("PROCESS_CLUSTER_MESH_INCOMPLETE");
  }

  private async peerStatus(): Promise<Map<string, string[]>> {
    for (const node of this.nodes) send(node.child, { cmd: "status" });
    await new Promise((r) => setTimeout(r, 50));
    const out = new Map<string, string[]>();
    for (const n of this.nodes) {
      const st = [...n.events].reverse().find((e) => (e as { event?: string }).event === "status") as { peers?: string[] } | undefined;
      out.set(n.id, st?.peers ?? []);
    }
    return out;
  }

  async propose(
    nodeId: string,
    txs: Array<{
      id: string;
      from: string;
      to: string;
      amount: string;
      kind?: string;
      holdId?: string;
      obligationId?: string;
      providerId?: string;
      price?: string;
      auth?: unknown;
    }>,
  ): Promise<Record<string, unknown>> {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error("unknown node");
    // v0.5.3: only an event emitted after this command counts (not the outcome of an earlier proposal).
    const from = node.events.length;
    send(node.child, { cmd: "propose", txs });
    return waitEvent(node, (e) => e.event === "proposed" || e.event === "error", 8000, from);
  }

  /** Leader of the next height as each node reports it in its latest status. */
  statusLeaders(): string[] {
    return this.nodes.map((n) => {
      const st = [...n.events].reverse().find((e) => (e as { event?: string }).event === "status") as { leader?: string } | undefined;
      return st?.leader ?? "";
    });
  }

  /** UEP-36.4/36.5 — multi-batch DigestAggregate proposal across process mesh */
  async proposeAggregate(
    nodeId: string,
    batches: Array<Array<{ id: string; from: string; to: string; amount: string }>>,
  ): Promise<void> {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error("unknown node");
    send(node.child, { cmd: "propose-aggregate", batches });
    await waitEvent(node, (e) => e.event === "proposed" || e.event === "error");
  }

  async waitFinalized(timeoutMs = 10000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const node of this.nodes) send(node.child, { cmd: "status" });
      await new Promise((r) => setTimeout(r, 100));
      const statuses = this.nodes.map((n) => {
        const st = [...n.events].reverse().find(
          (e) => (e as { event?: string }).event === "status",
        ) as { finalized?: string[]; stateRoot?: string } | undefined;
        return st;
      });
      if (
        statuses.every(
          (s) => s && Array.isArray(s.finalized) && s.finalized.length >= 1,
        )
      ) {
        const roots = new Set(statuses.map((s) => s!.stateRoot));
        return roots.size === 1;
      }
    }
    return false;
  }


  async waitFinalizedAtLeast(minFinalized: number, timeoutMs = 10000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const node of this.nodes) send(node.child, { cmd: "status" });
      await new Promise((r) => setTimeout(r, 100));
      const statuses = this.nodes.map((n) => {
        const st = [...n.events].reverse().find(
          (e) => (e as { event?: string }).event === "status",
        ) as { finalized?: string[]; stateRoot?: string } | undefined;
        return st;
      });
      if (
        statuses.every(
          (s) => s && Array.isArray(s.finalized) && s.finalized.length >= minFinalized,
        )
      ) {
        const roots = new Set(statuses.map((s) => s!.stateRoot));
        return roots.size === 1;
      }
    }
    return false;
  }

  async waitRootChange(fromRoot: string, timeoutMs = 60000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const node of this.nodes) send(node.child, { cmd: "status" });
      await new Promise((r) => setTimeout(r, 150));
      const roots = this.statusRoots().filter(Boolean);
      if (roots.length === this.nodes.length && roots.every((r) => r !== fromRoot) && new Set(roots).size === 1) {
        return true;
      }
    }
    return false;
  }

  statusRoots(): string[] {
    return this.nodes.map((n) => {
      const st = [...n.events].reverse().find(
        (e) => (e as { event?: string }).event === "status",
      ) as { stateRoot?: string } | undefined;
      return st?.stateRoot ?? "";
    });
  }

  /**
   * UEP-35.11 — Logical partition: each node blocks the opposite group.
   * groupA and groupB must cover the scenario (e.g. 3+1 or 2+2).
   */
  async partition(groupA: string[], groupB: string[]): Promise<void> {
    const setA = new Set(groupA);
    const setB = new Set(groupB);
    for (const node of this.nodes) {
      const blocked = setA.has(node.id) ? groupB : setB.has(node.id) ? groupA : [];
      send(node.child, { cmd: "partition", blocked });
    }
    for (const node of this.nodes) {
      await waitEvent(node, (e) => e.event === "partitioned", 5000);
    }
  }

  async heal(): Promise<void> {
    for (const node of this.nodes) {
      send(node.child, { cmd: "heal" });
    }
    for (const node of this.nodes) {
      await waitEvent(node, (e) => e.event === "healed", 5000);
    }
    // Ask nodes with certs to resync
    for (const node of this.nodes) {
      send(node.child, { cmd: "resync" });
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const node of this.nodes) {
      // best-effort wait for resync event
      try {
        await waitEvent(node, (e) => e.event === "resync", 3000);
      } catch {
        /* some nodes may have nothing to resync */
      }
    }
  }

  /** Latest status snapshot after polling */
  async pollStatus(): Promise<
    Array<{
      nodeId: string;
      stateRoot: string;
      economicTip: string;
      sequence: number;
      treasury: string;
      balances: Record<string, string>;
      finalized: string[];
      blocked: string[];
    }>
  > {
    for (const node of this.nodes) send(node.child, { cmd: "status" });
    await new Promise((r) => setTimeout(r, 100));
    return this.nodes.map((n) => {
      const st = [...n.events].reverse().find(
        (e) => (e as { event?: string }).event === "status",
      ) as {
        nodeId?: string;
        stateRoot?: string;
        economicTip?: string;
        sequence?: number;
        treasury?: string;
        balances?: Record<string, string>;
        finalized?: string[];
        blocked?: string[];
      } | undefined;
      return {
        nodeId: n.id,
        stateRoot: st?.stateRoot ?? "",
        economicTip: st?.economicTip ?? "",
        sequence: st?.sequence ?? 0,
        treasury: st?.treasury ?? "0",
        balances: st?.balances ?? {},
        finalized: st?.finalized ?? [],
        blocked: st?.blocked ?? [],
      };
    });
  }

  async advanceView(reason = "MANUAL"): Promise<void> {
    for (const node of this.nodes) {
      send(node.child, { cmd: "advance-view", reason });
    }
    for (const node of this.nodes) {
      await waitEvent(node, (e) => e.event === "view-changed", 5000).catch(() => ({}));
    }
  }

    async stop(): Promise<void> {
    for (const node of this.nodes) {
      try {
        send(node.child, { cmd: "shutdown" });
      } catch {
        /* ignore */
      }
      node.child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 100));
    for (const node of this.nodes) {
      try {
        node.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.nodes = [];
    if (this.bootstrapPath && existsSync(this.bootstrapPath)) {
      try {
        unlinkSync(this.bootstrapPath);
      } catch {
        /* ignore */
      }
    }
  }
}
