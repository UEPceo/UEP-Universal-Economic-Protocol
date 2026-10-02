import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
} from "./node-identity.ts";
import {
  createHello,
  createAuth,
  HandshakeResponder,
  verifyAuthOk,
  authOkBody,
} from "./node-handshake.ts";
import { signBytes } from "./node-identity.ts";

describe("UEP-33.3 mutual handshake", () => {
  function setup() {
    const seq = createNodeIdentity("seq");
    const rep = createNodeIdentity("replica-1");
    const reg = new NodeRegistry();
    reg.register(
      registryFromIdentity(seq, {
        networkId: "local",
        domainId: 1,
        role: "sequencer",
      }),
    );
    reg.register(
      registryFromIdentity(rep, {
        networkId: "local",
        domainId: 1,
        role: "replica",
      }),
    );
    return { seq, rep, reg };
  }

  it("HELLO → CHALLENGE → AUTH → signed AUTH_OK verified", () => {
    const { seq, rep, reg } = setup();
    const hs = new HandshakeResponder(reg, "local", 1, seq, "sequencer");
    const hello = createHello(rep, {
      networkId: "local",
      domainId: 1,
      role: "replica",
      sequence: 0,
      stateRoot: "GENESIS",
    });
    const ch = hs.onHello(hello);
    assert.equal(ch.type, "challenge");
    if (ch.type !== "challenge") return;
    const auth = createAuth(rep, ch.nonce);
    const ok = hs.onAuth(auth);
    assert.equal(ok.type, "auth_ok");
    if (ok.type !== "auth_ok") return;
    assert.ok(ok.signature);
    assert.equal(ok.nonce, ch.nonce);
    const v = verifyAuthOk(reg, ok, ch.nonce, "local", 1);
    assert.equal(v.ok, true);
  });

  it("forged AUTH_OK without responder signature is rejected", () => {
    const { seq, rep, reg } = setup();
    const hs = new HandshakeResponder(reg, "local", 1, seq, "sequencer");
    const hello = createHello(rep, {
      networkId: "local",
      domainId: 1,
      role: "replica",
      sequence: 0,
      stateRoot: "GENESIS",
    });
    const ch = hs.onHello(hello);
    assert.equal(ch.type, "challenge");
    if (ch.type !== "challenge") return;
    const auth = createAuth(rep, ch.nonce);
    const ok = hs.onAuth(auth);
    assert.equal(ok.type, "auth_ok");
    if (ok.type !== "auth_ok") return;
    const forged = { ...ok, signature: "00".repeat(64) };
    const v = verifyAuthOk(reg, forged, ch.nonce, "local", 1);
    assert.equal(v.ok, false);
  });

  it("second HELLO on same connection does not overwrite challenge", () => {
    const { seq, rep, reg } = setup();
    const other = createNodeIdentity("replica-2");
    reg.register(
      registryFromIdentity(other, {
        networkId: "local",
        domainId: 1,
        role: "replica",
      }),
    );
    const hs = new HandshakeResponder(reg, "local", 1, seq, "sequencer");
    const ch = hs.onHello(
      createHello(rep, {
        networkId: "local",
        domainId: 1,
        role: "replica",
        sequence: 0,
        stateRoot: "GENESIS",
      }),
    );
    assert.equal(ch.type, "challenge");
    const r2 = hs.onHello(
      createHello(other, {
        networkId: "local",
        domainId: 1,
        role: "replica",
        sequence: 0,
        stateRoot: "GENESIS",
      }),
    );
    assert.equal(r2.type, "auth_reject");
    if (r2.type === "auth_reject") {
      assert.match(r2.reason, /CHALLENGE_ALREADY_PENDING/);
    }
  });

  it("rejects HELLO role mismatch vs registry", () => {
    const { seq, rep, reg } = setup();
    const hs = new HandshakeResponder(reg, "local", 1, seq, "sequencer");
    const r = hs.onHello(
      createHello(rep, {
        networkId: "local",
        domainId: 1,
        role: "sequencer",
        sequence: 0,
        stateRoot: "GENESIS",
      }),
    );
    assert.equal(r.type, "auth_reject");
  });

  it("rejects replica→replica", () => {
    const { rep, reg } = setup();
    const other = createNodeIdentity("other-rep");
    reg.register(
      registryFromIdentity(other, {
        networkId: "local",
        domainId: 1,
        role: "replica",
      }),
    );
    const hs = new HandshakeResponder(reg, "local", 1, rep, "replica");
    const r = hs.onHello(
      createHello(other, {
        networkId: "local",
        domainId: 1,
        role: "replica",
        sequence: 0,
        stateRoot: "GENESIS",
      }),
    );
    assert.equal(r.type, "auth_reject");
  });

  it("rejects unknown / revoked / wrong network", () => {
    const { seq, reg } = setup();
    const stranger = createNodeIdentity("stranger");
    const hs = new HandshakeResponder(reg, "local", 1, seq, "sequencer");
    assert.equal(
      hs.onHello(
        createHello(stranger, {
          networkId: "local",
          domainId: 1,
          role: "replica",
          sequence: 0,
          stateRoot: "G",
        }),
      ).type,
      "auth_reject",
    );
  });
});
