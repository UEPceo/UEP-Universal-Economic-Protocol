/**
 * UEP-32.3/32.4 — TCP transport with on-wire Ed25519 handshake.
 *
 * Flow (replica → sequencer):
 *   connect → HELLO → CHALLENGE → AUTH → auth_ok
 *   then envelopes / catchup only on authenticated sockets.
 *
 * listenHost: "127.0.0.1" (lab) or "0.0.0.0" (multi-host ready).
 */

import net from "node:net";
import type { NodeEnvelope } from "./node-protocol.ts";
import { LabNode } from "./node-protocol.ts";
import type { NodeIdentity, NodeRegistry, NodeRole } from "./node-identity.ts";
import {
  createHello,
  createAuth,
  HandshakeResponder,
  verifyAuthOk,
  type HandshakeMessage,
  type HelloMsg,
  type ChallengeMsg,
  type AuthMsg,
} from "./node-handshake.ts";

export const MAX_FRAME_BYTES = 8_000_000;
export const MAX_SOCKET_BUFFER = 16_000_000;
export const MAX_CONNECTIONS = 64;
export const MAX_CATCHUP_BATCH = 100;
export const FRAME_IDLE_MS = 30_000;

/** Normalize catch-up batch size: integer in [1, MAX_CATCHUP_BATCH]. */
export function clampCatchupBatch(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return MAX_CATCHUP_BATCH;
  }
  const n = Math.trunc(requested);
  if (n < 1) return 1;
  if (n > MAX_CATCHUP_BATCH) return MAX_CATCHUP_BATCH;
  return n;
}

export type WireMessage =
  | { type: "envelope"; envelope: NodeEnvelope }
  | { type: "catchup_req"; fromSequence: number; maxBatch?: number }
  | {
      type: "catchup_res";
      envelopes: NodeEnvelope[];
      fromSequence: number;
      toSequence: number;
      hasMore: boolean;
    }
  | HandshakeMessage;

function encodeMsg(msg: WireMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

type SocketState = {
  socket: net.Socket;
  authenticated: boolean;
  peerNodeId?: string;
  /** responder side */
  hs?: HandshakeResponder;
  /** initiator: waiting for challenge */
  pendingAuth?: boolean;
  /** initiator: nonce of the challenge being answered */
  challengeNonce?: string;
  buffer: Buffer;
};

export type AuthTransportConfig = {
  identity: NodeIdentity;
  registry: NodeRegistry;
  networkId: string;
  domainId: number;
  role: NodeRole;
  listenHost?: string; // default 127.0.0.1; use 0.0.0.0 for multi-host
  /** If true, only authenticated peers receive/process envelopes */
  requireAuth?: boolean;
};

export class AuthNodeTransport {
  readonly cfg: AuthTransportConfig;
  port = 0;
  private server: net.Server | null = null;
  private states = new Set<SocketState>();
  private onEnvelope: ((env: NodeEnvelope) => void) | null = null;
  private onCatchupReq: ((from: number) => NodeEnvelope[]) | null = null;
  private onCatchupRes: ((envs: NodeEnvelope[]) => void) | null = null;
  private onAuthOk: ((peerNodeId: string) => void) | null = null;

  constructor(cfg: AuthTransportConfig) {
    this.cfg = {
      listenHost: "127.0.0.1",
      requireAuth: true,
      ...cfg,
    };
  }

  setEnvelopeHandler(h: (env: NodeEnvelope) => void): void {
    this.onEnvelope = h;
  }
  setCatchupHandlers(
    onReq: (from: number) => NodeEnvelope[],
    onRes: (envs: NodeEnvelope[]) => void,
  ): void {
    this.onCatchupReq = onReq;
    this.onCatchupRes = onRes;
  }
  setAuthOkHandler(h: (peerNodeId: string) => void): void {
    this.onAuthOk = h;
  }

  async listen(preferredPort = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = net.createServer((socket) => this.wireInbound(socket));
    this.port = await new Promise<number>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(
        preferredPort,
        this.cfg.listenHost ?? "127.0.0.1",
        () => {
          const addr = this.server!.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("no address"));
        },
      );
    });
    return this.port;
  }

  /**
   * Connect to peer and complete initiator handshake.
   * Resolves when auth_ok received (or requireAuth=false and connected).
   */
  async connectAndAuth(host: string, port: number): Promise<string> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect timeout ${host}:${port}`));
      }, 3000);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });

    const st: SocketState = {
      socket,
      authenticated: false,
      pendingAuth: true,
      buffer: Buffer.alloc(0),
    };
    this.states.add(st);
    this.attachData(st);

    // Send HELLO
    const hello = createHello(this.cfg.identity, {
      networkId: this.cfg.networkId,
      domainId: this.cfg.domainId,
      role: this.cfg.role,
      sequence: 0,
      stateRoot: "GENESIS",
    });
    this.write(st, hello);

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("handshake timeout"));
      }, 3000);
      const prev = this.onAuthOk;
      this.onAuthOk = (peerId) => {
        clearTimeout(timeout);
        this.onAuthOk = prev;
        prev?.(peerId);
        resolve(peerId);
      };
      // Also resolve if auth_ok handled in processMsg sets authenticated
      const check = setInterval(() => {
        if (st.authenticated && st.peerNodeId) {
          clearInterval(check);
          clearTimeout(timeout);
          this.onAuthOk = prev;
          resolve(st.peerNodeId);
        }
      }, 20);
      socket.once("close", () => {
        clearInterval(check);
        clearTimeout(timeout);
        if (!st.authenticated) reject(new Error("socket closed during handshake"));
      });
    });
  }

  private wireInbound(socket: net.Socket): void {
    if (this.states.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const st: SocketState = {
      socket,
      authenticated: false,
      hs: new HandshakeResponder(
        this.cfg.registry,
        this.cfg.networkId,
        this.cfg.domainId,
        this.cfg.identity,
        this.cfg.role,
      ),
      buffer: Buffer.alloc(0),
    };
    this.states.add(st);
    this.attachData(st);
  }

  private attachData(st: SocketState): void {
    st.socket.setNoDelay(true);
    // Idle framing timeout
    let idle = setTimeout(() => st.socket.destroy(), FRAME_IDLE_MS);
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => st.socket.destroy(), FRAME_IDLE_MS);
    };
    st.socket.on("data", (chunk) => {
      bumpIdle();
      st.buffer = Buffer.concat([st.buffer, chunk]);
      if (st.buffer.length > MAX_SOCKET_BUFFER) {
        st.socket.destroy();
        return;
      }
      while (st.buffer.length >= 4) {
        const len = st.buffer.readUInt32BE(0);
        if (len > MAX_FRAME_BYTES) {
          st.socket.destroy();
          return;
        }
        if (st.buffer.length < 4 + len) break;
        const body = st.buffer.subarray(4, 4 + len);
        st.buffer = st.buffer.subarray(4 + len);
        try {
          const msg = JSON.parse(body.toString("utf8")) as WireMessage;
          this.processMsg(st, msg);
        } catch {
          /* drop */
        }
      }
    });
    const cleanup = () => this.states.delete(st);
    st.socket.on("close", cleanup);
    st.socket.on("error", () => {
      cleanup();
      st.socket.destroy();
    });
  }

  private write(st: SocketState, msg: WireMessage): void {
    if (!st.socket.destroyed) {
      try {
        st.socket.write(encodeMsg(msg));
      } catch {
        /* ignore */
      }
    }
  }

  private processMsg(st: SocketState, msg: WireMessage): void {
    // Handshake path
    if (msg.type === "hello" && st.hs) {
      const r = st.hs.onHello(msg as HelloMsg);
      this.write(st, r);
      return;
    }
    if (msg.type === "challenge" && st.pendingAuth) {
      const nonce = (msg as ChallengeMsg).nonce;
      st.challengeNonce = nonce;
      const auth = createAuth(this.cfg.identity, nonce);
      this.write(st, auth);
      return;
    }
    if (msg.type === "auth" && st.hs) {
      const r = st.hs.onAuth(msg as AuthMsg);
      this.write(st, r);
      if (r.type === "auth_ok") {
        st.authenticated = true;
        st.peerNodeId = r.authenticatedNodeId;
        this.onAuthOk?.(r.authenticatedNodeId);
      } else {
        st.socket.destroy();
      }
      return;
    }
    if (msg.type === "auth_ok") {
      if (!st.pendingAuth || !st.challengeNonce) {
        st.socket.destroy();
        return;
      }
      const vr = verifyAuthOk(
        this.cfg.registry,
        msg as import("./node-handshake.ts").AuthOkMsg,
        st.challengeNonce,
        this.cfg.networkId,
        this.cfg.domainId,
      );
      if (!vr.ok) {
        st.socket.destroy();
        return;
      }
      st.authenticated = true;
      st.peerNodeId = msg.responderNodeId;
      st.pendingAuth = false;
      st.challengeNonce = undefined;
      this.onAuthOk?.(msg.responderNodeId);
      return;
    }
    if (msg.type === "auth_reject") {
      st.socket.destroy();
      return;
    }

    // App messages require auth when configured
    if (this.cfg.requireAuth && !st.authenticated) {
      return;
    }

    if (msg.type === "envelope") {
      this.onEnvelope?.(msg.envelope);
      return;
    }
    if (msg.type === "catchup_req") {
      const maxBatch = clampCatchupBatch(msg.maxBatch);
      const envs = this.onCatchupReq?.(msg.fromSequence) ?? [];
      const batch = envs.slice(0, maxBatch);
      const fromSequence = msg.fromSequence;
      const toSequence =
        batch.length > 0 ? batch[batch.length - 1]!.sequence : fromSequence;
      const hasMore = envs.length > batch.length;
      this.write(st, {
        type: "catchup_res",
        envelopes: batch,
        fromSequence,
        toSequence,
        hasMore,
      });
      return;
    }
    if (msg.type === "catchup_res") {
      this.onCatchupRes?.(msg.envelopes);
    }
  }

  /** Broadcast envelope only to authenticated peers. */
  broadcastEnvelope(envelope: NodeEnvelope): void {
    const msg: WireMessage = { type: "envelope", envelope };
    const wire = encodeMsg(msg);
    for (const st of this.states) {
      if (st.socket.destroyed) continue;
      if (this.cfg.requireAuth && !st.authenticated) continue;
      try {
        st.socket.write(wire);
      } catch {
        /* ignore */
      }
    }
  }

  requestCatchUp(fromSequence: number, maxBatch = MAX_CATCHUP_BATCH): void {
    const msg: WireMessage = {
      type: "catchup_req",
      fromSequence,
      maxBatch: clampCatchupBatch(maxBatch),
    };
    const wire = encodeMsg(msg);
    for (const st of this.states) {
      if (st.socket.destroyed) continue;
      if (this.cfg.requireAuth && !st.authenticated) continue;
      try {
        st.socket.write(wire);
      } catch {
        /* ignore */
      }
    }
  }

  authenticatedPeerCount(): number {
    let n = 0;
    for (const st of this.states) {
      if (st.authenticated) n++;
    }
    return n;
  }

  async close(): Promise<void> {
    for (const st of [...this.states]) st.socket.destroy();
    this.states.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        setTimeout(resolve, 200);
      });
    }
    this.server = null;
  }
}

/** Full authenticated lab node. */
export class AuthNetworkNode {
  readonly lab: LabNode;
  readonly transport: AuthNodeTransport;
  readonly isSequencer: boolean;
  authenticatedPeers: string[] = [];

  constructor(opts: {
    lab: LabNode;
    registry: NodeRegistry;
    isSequencer: boolean;
    role: NodeRole;
    listenHost?: string;
  }) {
    this.lab = opts.lab;
    this.isSequencer = opts.isSequencer;
    this.transport = new AuthNodeTransport({
      identity: opts.lab.identity,
      registry: opts.registry,
      networkId: opts.lab.networkId,
      domainId: opts.lab.domainId,
      role: opts.role,
      listenHost: opts.listenHost ?? "127.0.0.1",
      requireAuth: true,
    });
    this.transport.setEnvelopeHandler((env) => {
      this.lab.apply(env);
    });
    this.transport.setCatchupHandlers(
      (from) => this.lab.log.filter((e) => e.sequence > from),
      (envs) => {
        try {
          this.lab.catchUp(envs);
        } catch {
          /* ignore */
        }
      },
    );
    this.transport.setAuthOkHandler((peerId) => {
      if (!this.authenticatedPeers.includes(peerId)) {
        this.authenticatedPeers.push(peerId);
      }
    });
  }

  get port(): number {
    return this.transport.port;
  }

  async start(): Promise<number> {
    return this.transport.listen(0);
  }

  async connectToSequencer(host: string, port: number): Promise<string> {
    return this.transport.connectAndAuth(host, port);
  }

  commitAndBroadcast(input: {
    previousStateRoot: string;
    newStateRoot: string;
    transitionId: string;
    nullifier: string;
    previousNullifierRoot?: string;
    newNullifierRoot?: string;
    proofHex?: string;
    publicInputsHex?: string[];
    vkHex?: string;
    vkId?: string;
    transactionCommitment?: string;
  }): { ok: true; envelope: NodeEnvelope } | { ok: false; error: string } {
    if (!this.isSequencer) return { ok: false, error: "NOT_SEQUENCER" };
    try {
      const env = this.lab.propose(input);
      const r = this.lab.apply(env);
      if (!r.ok) return { ok: false, error: r.error };
      this.transport.broadcastEnvelope(env);
      return { ok: true, envelope: env };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  requestCatchUp(): void {
    this.transport.requestCatchUp(this.lab.sequence);
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
