import { fileURLToPath } from "node:url";
/**
 * UEP-38.14 — OS process cluster + respawn/catch-up.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateP4Bootstrap, type P4Bootstrap } from "./uep38-p4-process-node.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { labParty, proveWithoutApply } from "./uep38-zk-state-transition.ts";

/**
 * Process nodes only apply proofs under a pinned verifying key (UEP_P4_VK_HEX).
 * When the caller has not pinned one, pin the development key of the local
 * uep-zk prover for this tree depth (fixed-seed dev setup, no ceremony).
 */
function ensureDevVkPinned(depth: 4 | 32): void {
  if (process.env.UEP_P4_VK_HEX) return;
  const st = SmtEconomicState.genesis(
    { alice: 10000n, bob: 0n },
    { testOnlyDepth: depth, isTestFixture: true, leafMode: "poseidon-zk" },
  );
  const art = proveWithoutApply(st, labParty("alice"), 1000n);
  if (art.ok && art.vkHex) process.env.UEP_P4_VK_HEX = art.vkHex;
}

export type P4Proc = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  port?: number;
  events: Record<string, unknown>[];
};

function send(p: P4Proc, msg: unknown): void {
  p.child.stdin.write(JSON.stringify(msg) + "\n");
}

export function waitEvent(
  node: P4Proc,
  pred: (e: Record<string, unknown>) => boolean,
  timeoutMs = 60000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (const e of node.events) {
        if (pred(e)) {
          clearInterval(timer);
          resolve(e);
          return;
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout ${node.id}`));
      }
    }, 25);
  });
}

export class P4ProcessCluster {
  nodes: P4Proc[] = [];
  boot!: P4Bootstrap;
  dir = "";
  depth: 4 | 32 = 4;

  async start(n = 4, depth: 4 | 32 = 4, lateIds: string[] = []): Promise<void> {
    this.boot = generateP4Bootstrap(n);
    this.depth = depth;
    this.dir = join(tmpdir(), `uep-p4-${process.pid}`);
    mkdirSync(this.dir, { recursive: true });
    const bundled = join(process.cwd(), "uep-core/uep-26-spend-circuit/bin/uep-zk");
    const runBin = process.env.UEP_ZK_BIN || "/tmp/uep-zk";
    if (!process.env.UEP_ZK_BIN) {
      try {
        copyFileSync(bundled, runBin);
        chmodSync(runBin, 0o755);
        process.env.UEP_ZK_BIN = runBin;
      } catch {
        /* parent prove path may already have a binary */
      }
    }
    ensureDevVkPinned(depth);
    for (const bn of this.boot.nodes) {
      writeFileSync(join(this.dir, `boot-${bn.id}.json`), JSON.stringify(this.boot));
      this.nodes.push(this.spawnNode(bn.id));
    }
    for (const node of this.nodes) {
      const ready = await waitEvent(node, (e) => e.event === "ready" || e.event === "fatal", 120000);
      if (ready.event === "fatal") throw new Error(String(ready.error));
      node.port = ready.port as number;
    }
    await this.meshAll(lateIds);
  }

  async meshNode(id: string): Promise<void> {
    const node = this.nodes.find((n) => n.id === id);
    if (!node?.port) throw new Error("no node");
    for (const other of this.nodes) {
      if (other.id === id || !other.port) continue;
      send(node, { op: "connect", peerId: other.id, port: other.port });
      await waitEvent(node, (e) => e.event === "connected" && e.peerId === other.id, 15000);
      send(other, { op: "connect", peerId: node.id, port: node.port });
      await waitEvent(other, (e) => e.event === "connected" && e.peerId === node.id, 15000);
    }
  }

  private spawnNode(id: string): P4Proc {
    const bootPath = join(this.dir, `boot-${id}.json`);
    // Resolved next to this module, so the cluster works from any cwd (Node >= 22.6).
    const entry = fileURLToPath(new URL("./uep38-p4-process-node.ts", import.meta.url));
    const args = ["--experimental-strip-types", entry];
    const child = spawn(
      process.execPath,
      args,
      {
        env: {
          ...process.env,
          UEP_P4_PROCESS: "1",
          UEP_P4_NODE_ID: id,
          UEP_P4_BOOTSTRAP: bootPath,
          UEP_P4_DEPTH: String(this.depth),
          UEP_P4_DATA_DIR: join(this.dir, `data-${id}`),
          UEP_P4_CAROL: process.env.UEP_P4_CAROL ?? "",
          UEP_P4_ERIN: process.env.UEP_P4_ERIN ?? "",
          UEP_ZK_BIN: process.env.UEP_ZK_BIN ?? "/tmp/uep-zk",
          UEP_P4_VK_HEX: process.env.UEP_P4_VK_HEX ?? "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const node: P4Proc = { id, child, events: [] };
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
          node.events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          node.events.push({ event: "raw", text: line });
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      node.events.push({ event: "stderr", text: c.toString() });
    });
    return node;
  }

  private async meshAll(skip: string[] = []): Promise<void> {
    for (const a of this.nodes) {
      for (const b of this.nodes) {
        if (a.id === b.id || !b.port || skip.includes(a.id) || skip.includes(b.id)) continue;
        send(a, { op: "connect", peerId: b.id, port: b.port });
        await waitEvent(a, (e) => e.event === "connected" && e.peerId === b.id);
      }
    }
  }

  async waitHeight(height: number, timeoutMs = 30000): Promise<void> {
    await Promise.all(
      this.nodes.map((n) =>
        waitEvent(n, (e) => e.event === "applied" && Number(e.height) === height, timeoutMs),
      ),
    );
  }

  async replayNullifier(): Promise<void> {
    for (const n of this.nodes) send(n, { op: "replay-nullifier" });
  }

  async propose(amount: bigint, height = 1, fromId?: string): Promise<void> {
    const n = fromId ? this.nodes.find((x) => x.id === fromId) : this.nodes[0];
    if (!n) throw new Error("no proposer");
    send(n, { op: "propose", amount: amount.toString(), height });
  }

  async proposeBatch(amountA: bigint, amountB: bigint, height = 1, fromId?: string): Promise<void> {
    const n = fromId ? this.nodes.find((x) => x.id === fromId) : this.nodes[0];
    if (!n) throw new Error("no proposer");
    send(n, { op: "propose-batch", amountA: amountA.toString(), amountB: amountB.toString(), height });
  }

  async proposeMany(spends: { who: string; amount: bigint }[], height = 1, fromId?: string): Promise<void> {
    const n = fromId ? this.nodes.find((x) => x.id === fromId) : this.nodes[0];
    if (!n) throw new Error("no proposer");
    send(n, { op: "propose-many", height, spends: spends.map((s) => ({ who: s.who, amount: s.amount.toString() })) });
  }

  requestViewChange(nextView = 1): void {
    for (const n of this.nodes) send(n, { op: "viewchange", nextView });
  }

  async waitView(view: number, timeoutMs = 30000): Promise<void> {
    await Promise.all(
      this.nodes.map((n) =>
        waitEvent(n, (e) => e.event === "view_adopted" && Number(e.view) === view, timeoutMs),
      ),
    );
  }

  async waitApplied(idsOrTimeout?: string[] | number, timeoutMs = 30000): Promise<string[]> {
    const ids = Array.isArray(idsOrTimeout) ? idsOrTimeout : undefined;
    if (typeof idsOrTimeout === "number") timeoutMs = idsOrTimeout;
    const group = ids ? this.nodes.filter((n) => ids.includes(n.id)) : this.nodes;
    await Promise.all(group.map((n) => waitEvent(n, (e) => e.event === "applied", timeoutMs)));
    const roots: string[] = [];
    for (const n of group) {
      send(n, { op: "status" });
      const st = await waitEvent(n, (e) => e.event === "status");
      roots.push(String(st.root));
    }
    return roots;
  }

  /** Kill a node and replace it with a fresh process (genesis SMT, same keys). */
  async respawn(id: string): Promise<P4Proc> {
    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx < 0) throw new Error("no node");
    this.nodes[idx]!.child.kill("SIGTERM");
    const fresh = this.spawnNode(id);
    this.nodes[idx] = fresh;
    const ready = await waitEvent(fresh, (e) => e.event === "ready", 20000);
    fresh.port = ready.port as number;
    await this.meshNode(id);
    return fresh;
  }

  requestCatchup(id: string): void {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error("no node");
    send(n, { op: "catchup" });
  }

  flushCommits(id: string): void {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error("no node");
    send(n, { op: "flushcommits" });
  }

  async bootFromDisk(id: string): Promise<P4Proc> {
    const n = this.spawnNode(id);
    this.nodes = [n];
    const ready = await waitEvent(n, (e) => e.event === "ready", 15000);
    n.port = ready.port as number;
    return n;
  }

  stop(): void {
    for (const n of this.nodes) {
      try {
        n.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}
