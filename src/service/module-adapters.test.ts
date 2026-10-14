import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CategoryRelayAdapter, PolicyOracleAdapter } from "./module-adapters.ts";

test("relay and oracle routes use the category and oracle modules", async () => {
  const relay = new CategoryRelayAdapter(() => 3);
  const pushed = await relay.push("e1", "chunk");
  assert.equal(pushed.module, "category/relay");
  const oracle = new PolicyOracleAdapter(() => 3);
  oracle.set("EUR", "1000000");
  const quote = await oracle.quote("EUR");
  assert.equal(quote.settles, false);
  assert.equal(quote.confidence, "POLICY");
  const node = fs.readFileSync(new URL("../node/assemble.ts", import.meta.url), "utf8");
  assert.equal(node.includes("SmtEconomicState"), false);
});
