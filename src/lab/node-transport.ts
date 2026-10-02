/**
 * UEP-31.1 / 32 — TCP transport (star: replicas → sequencer).
 * Framing: 4-byte BE length + UTF-8 JSON.
 * Envelope auth: Ed25519 via LabNode.apply (registry pubkey).
 */

import net from "node:net";
import type { NodeEnvelope, NodeIdentity } from "./node-protocol.ts";
import { LabNode } from "./node-protocol.ts";
import type { HandshakeMessage } from "./node-handshake.ts";

export type TransportMessage =
  | { type: "envelope"; envelope: NodeEnvelope }
  | { type: "hello"; nodeId: string; sequence: number; stateRoot: string }
  | { type: "catchup_req"; fromSequence: number }
  | { type: "catchup_res"; envelopes: NodeEnvelope[] }
  | HandshakeMessage;

function encodeMsg(msg: TransportMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

type OnMessage = (msg: TransportMessage) => void;

export class NodeTransport {
  readonly nodeId: string;
  port = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private buffers = new WeakMap<net.Socket, Buffer>();
  private onMessage: OnMessage | null = null;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  setHandler(handler: OnMessage): void {
    this.onMessage = handler;
  }

  async listen(preferredPort = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = net.createServer((socket) => this.wire(socket));
    this.port = await new Promise<number>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(preferredPort, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
    return this.port;
  }

  async connect(host: string, port: number): Promise<void> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect timeout ${host}:${port}`));
      }, 2000);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    this.wire(socket);
  }

  private wire(socket: net.Socket): void {
    this.sockets.add(socket);
    this.buffers.set(socket, Buffer.alloc(0));
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      let buf = Buffer.concat([this.buffers.get(socket) ?? Buffer.alloc(0), chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > 8_000_000) {
          socket.destroy();
          return;
        }
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        try {
          const msg = JSON.parse(body.toString("utf8")) as TransportMessage;
          this.onMessage?.(msg);
        } catch {
          /* drop */
        }
      }
      this.buffers.set(socket, buf);
    });
    const cleanup = () => this.sockets.delete(socket);
    socket.on("close", cleanup);
    socket.on("error", () => {
      cleanup();
      socket.destroy();
    });
  }

  broadcast(msg: TransportMessage): void {
    const wire = encodeMsg(msg);
    for (const s of this.sockets) {
      if (!s.destroyed) {
        try {
          s.write(wire);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const s of [...this.sockets]) s.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        setTimeout(resolve, 200);
      });
    }
    this.server = null;
  }
}

export class NetworkLabNode {
  readonly lab: LabNode;
  readonly transport: NodeTransport;
  readonly isSequencer: boolean;

  constructor(opts: { lab: LabNode; isSequencer: boolean }) {
    this.lab = opts.lab;
    this.isSequencer = opts.isSequencer;
    this.transport = new NodeTransport(opts.lab.identity.nodeId);
    this.transport.setHandler((msg) => this.onMsg(msg));
  }

  get port(): number {
    return this.transport.port;
  }

  async start(): Promise<number> {
    return this.transport.listen(0);
  }

  async connectToSequencer(seqPort: number): Promise<void> {
    await this.transport.connect("127.0.0.1", seqPort);
  }

  private onMsg(msg: TransportMessage): void {
    if (msg.type === "envelope") {
      this.lab.apply(msg.envelope);
      return;
    }
    if (msg.type === "catchup_req" && this.isSequencer) {
      const envs = this.lab.log.filter((e) => e.sequence > msg.fromSequence);
      this.transport.broadcast({ type: "catchup_res", envelopes: envs });
      return;
    }
    if (msg.type === "catchup_res") {
      try {
        this.lab.catchUp(msg.envelopes);
      } catch {
        /* ignore */
      }
    }
  }

  commitAndBroadcast(input: {
    previousStateRoot: string;
    newStateRoot: string;
    transitionId: string;
    nullifier: string;
    newNullifierRoot?: string;
  }): { ok: true; envelope: NodeEnvelope } | { ok: false; error: string } {
    if (!this.isSequencer) return { ok: false, error: "NOT_SEQUENCER" };
    try {
      const env = this.lab.propose(input);
      const r = this.lab.apply(env);
      if (!r.ok) return { ok: false, error: r.error };
      this.transport.broadcast({ type: "envelope", envelope: env });
      return { ok: true, envelope: env };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  requestCatchUp(): void {
    this.transport.broadcast({
      type: "catchup_req",
      fromSequence: this.lab.sequence,
    });
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
