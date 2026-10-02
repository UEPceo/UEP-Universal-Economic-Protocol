/**
 * UEP-35.8 — Length-prefixed TCP mesh (LAB multi-host foundation).
 * Frame: [u32 BE length][utf8 JSON { from, kind, payloadB64 }]
 */

import net from "node:net";

export type TcpHandler = (fromPeerId: string, kind: string, payload: Uint8Array) => void;

type PeerConn = {
  peerId: string;
  socket: net.Socket;
  buf: Buffer;
};

function frame(from: string, kind: string, payload: Uint8Array): Buffer {
  const body = Buffer.from(
    JSON.stringify({
      from,
      kind,
      payloadB64: Buffer.from(payload).toString("base64"),
    }),
    "utf8",
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

export class TcpMeshEndpoint {
  readonly nodeId: string;
  private server: net.Server | null = null;
  private peers = new Map<string, PeerConn>();
  private handler: TcpHandler | null = null;
  private port = 0;
  /** UEP-35.11 — peers we refuse to send to / accept from */
  private blocked = new Set<string>();
  stats = { sent: 0, received: 0, bytesSent: 0, bytesRecv: 0, droppedBlocked: 0 };

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  onMessage(handler: TcpHandler): void {
    this.handler = handler;
  }

  async listen(host = "127.0.0.1", port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.wire(socket));
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(this.port);
        } else reject(new Error("no port"));
      });
    });
  }

  get listenPort(): number {
    return this.port;
  }

  async connectPeer(peerId: string, host: string, port: number): Promise<boolean> {
    const existing = this.peers.get(peerId);
    if (existing && existing.socket.writable && !existing.socket.destroyed) return true;
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const fail = () => {
        socket.destroy();
        resolve(false);
      };
      socket.setTimeout(4000);
      socket.once("timeout", fail);
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        const hello = frame(this.nodeId, "HELLO", new Uint8Array());
        socket.write(hello);
        this.wire(socket, peerId);
        resolve(this.peers.has(peerId));
      });
    });
  }

  /** Keep one live socket per peer. A duplicate close must not drop the survivor. */
  private adopt(conn: PeerConn): void {
    if (!conn.peerId || conn.peerId === this.nodeId) return;
    if (this.blocked.has(conn.peerId)) {
      conn.socket.destroy();
      return;
    }
    const prev = this.peers.get(conn.peerId);
    if (prev && prev !== conn) {
      const prevLive = prev.socket.writable && !prev.socket.destroyed;
      if (prevLive) {
        conn.socket.removeAllListeners();
        conn.socket.destroy();
        return;
      }
      prev.socket.removeAllListeners();
      prev.socket.destroy();
    }
    this.peers.set(conn.peerId, conn);
  }

  private dropIfCurrent(conn: PeerConn): void {
    if (conn.peerId && this.peers.get(conn.peerId) === conn) this.peers.delete(conn.peerId);
  }

  private wire(socket: net.Socket, knownPeer?: string): void {
    const conn: PeerConn = {
      peerId: knownPeer ?? "",
      socket,
      buf: Buffer.alloc(0),
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      for (;;) {
        if (conn.buf.length < 4) break;
        const n = conn.buf.readUInt32BE(0);
        if (n > 16_000_000) {
          socket.destroy();
          return;
        }
        if (conn.buf.length < 4 + n) break;
        const raw = conn.buf.subarray(4, 4 + n).toString("utf8");
        conn.buf = conn.buf.subarray(4 + n);
        try {
          const msg = JSON.parse(raw) as {
            from: string;
            kind: string;
            payloadB64: string;
          };
          if (!conn.peerId && msg.from) conn.peerId = msg.from;
          if (conn.peerId) this.adopt(conn);
          if (msg.kind === "HELLO") continue;
          const fromId = conn.peerId || msg.from;
          if (this.blocked.has(fromId)) {
            this.stats.droppedBlocked++;
            continue;
          }
          const payload = Buffer.from(msg.payloadB64, "base64");
          this.stats.received++;
          this.stats.bytesRecv += payload.length;
          this.handler?.(fromId, msg.kind, payload);
        } catch {
          /* drop malformed frame, keep socket */
        }
      }
    });
    socket.on("close", () => this.dropIfCurrent(conn));
    socket.on("error", () => this.dropIfCurrent(conn));
    if (knownPeer) this.adopt(conn);
  }

  blockPeer(peerId: string): void {
    this.blocked.add(peerId);
  }

  unblockPeer(peerId: string): void {
    this.blocked.delete(peerId);
  }

  clearBlocks(): void {
    this.blocked.clear();
  }

  blockedPeers(): string[] {
    return [...this.blocked];
  }

  send(peerId: string, kind: string, payload: Uint8Array): boolean {
    if (this.blocked.has(peerId)) {
      this.stats.droppedBlocked++;
      return false;
    }
    const p = this.peers.get(peerId);
    if (!p) return false;
    p.socket.write(frame(this.nodeId, kind, payload));
    this.stats.sent++;
    this.stats.bytesSent += payload.length;
    return true;
  }

  broadcast(kind: string, payload: Uint8Array, except?: string): string[] {
    const missed: string[] = [];
    for (const id of this.peers.keys()) {
      if (id === except) continue;
      if (!this.send(id, kind, payload)) missed.push(id);
    }
    return missed;
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  async close(): Promise<void> {
    for (const p of this.peers.values()) {
      p.socket.removeAllListeners();
      p.socket.destroy();
    }
    this.peers.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.unref();
    });
    this.server = null;
  }
}
