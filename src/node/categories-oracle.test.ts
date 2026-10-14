import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { signAction } from "../marketplace/identity.ts";
import { assembleNode } from "./assemble.ts";

test("the node instantiates category modules and an admin can feed the oracle", async () => {
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const node = assembleNode({ custody, feeAccount, adminId: "admin-1" });
  assert.equal(typeof node.categories.swap.open, "function");
  assert.equal(typeof node.categories.relay.open, "function");
  assert.equal(typeof node.categories.dispute.open, "function");
  assert.equal(typeof node.categories.drip.claim, "function");
  const started = await node.listen(0);
  try {
    const auth = signAction({ marketplaceId: node.marketplace.marketplaceId, action: "oracle-feed", actorId: "admin-1", target: "EUR", details: { value: "1000000" } }, node.admin.privateKey);
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/oracle/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-uep-actor-id": auth.actorId, "x-uep-signature": auth.signature },
      body: JSON.stringify({ feed: "EUR", value: "1000000" }),
    });
    assert.equal(response.status, 201);
    const quote = await fetch(`http://127.0.0.1:${started.port}/v1/oracle/quotes/EUR`);
    const body = await quote.json() as { data?: { value?: string; settles?: boolean } };
    assert.equal(body.data?.value, "1000000");
    assert.equal(body.data?.settles, false);
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
