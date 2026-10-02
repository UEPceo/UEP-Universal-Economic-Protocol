import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNodeIdentity,
  LabNode,
  signEnvelope,
  NODE_PROTOCOL_VERSION,
} from "./node-protocol.ts";
import { VerifyingKeyRegistry } from "./verifying-key-registry.ts";

describe("UEP-32.5b pinned vk_id", () => {
  it("rejects unknown vkId", () => {
    const id = createNodeIdentity("seq");
    const reg = new VerifyingKeyRegistry();
    reg.pin({
      networkId: "local",
      vkId: "UEP-D4-VK-001",
      vkHex: "aa".repeat(32),
    });
    const node = new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId, {
      requireZkVerify: true,
      vkRegistry: reg,
    });
    const env = signEnvelope(id, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "ROOT_B",
      transitionId: "t1",
      nullifier: "n1",
      proofHex: "dead",
      publicInputsHex: Array(13).fill("00".repeat(32)), // 12 economic publics + domain_id
      vkId: "EVIL-VK",
      vkHex: "bb".repeat(32),
      ts: 1,
    });
    assert.equal(node.apply(env).error, "VK_ID_NOT_PINNED");
  });

  it("rejects vkHex that does not match pin", () => {
    const id = createNodeIdentity("seq");
    const reg = new VerifyingKeyRegistry();
    reg.pin({
      networkId: "local",
      vkId: "UEP-D4-VK-001",
      vkHex: "aa".repeat(32),
    });
    const node = new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId, {
      requireZkVerify: true,
      vkRegistry: reg,
    });
    const env = signEnvelope(id, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "ROOT_B",
      transitionId: "t1",
      nullifier: "n1",
      proofHex: "dead",
      publicInputsHex: Array(13).fill("00".repeat(32)), // 12 economic publics + domain_id
      vkId: "UEP-D4-VK-001",
      vkHex: "cc".repeat(32), // mismatch
      ts: 1,
    });
    assert.equal(node.apply(env).error, "VK_HEX_PIN_MISMATCH");
  });

  it("requires vkId when registry is configured", () => {
    const id = createNodeIdentity("seq");
    const reg = new VerifyingKeyRegistry();
    reg.pin({
      networkId: "local",
      vkId: "UEP-D4-VK-001",
      vkHex: "aa".repeat(32),
    });
    const node = new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId, {
      requireZkVerify: true,
      vkRegistry: reg,
    });
    const env = signEnvelope(id, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "ROOT_B",
      transitionId: "t1",
      nullifier: "n1",
      proofHex: "dead",
      publicInputsHex: Array(13).fill("00".repeat(32)), // 12 economic publics + domain_id
      vkHex: "aa".repeat(32),
      // no vkId
      ts: 1,
    });
    assert.equal(node.apply(env).error, "VK_ID_REQUIRED");
  });
});
