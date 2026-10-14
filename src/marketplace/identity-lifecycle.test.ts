import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { act, createTestAuthority, enrollIdentity, publishAs } from "./testkit.ts";

test("a suspended or revoked identity cannot sign a new action", () => {
  const admin = createTestAuthority("admin-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  enrollIdentity(m, "provider-1");
  m.setIdentityStatus("provider-1", "suspended", act(m, "admin-1", "identity-status", "provider-1", { status: "suspended" }, admin));
  assert.throws(() => publishAs(m, { providerId: "provider-1", title: "t", description: "d", category: "API", asset: "EUR", unitPrice: 20n, capacity: 2n }), /IDENTITY_NOT_ACTIVE/);
  m.setIdentityStatus("provider-1", "revoked", act(m, "admin-1", "identity-status", "provider-1", { status: "revoked" }, admin));
  assert.throws(() => publishAs(m, { providerId: "provider-1", title: "t", description: "d", category: "API", asset: "EUR", unitPrice: 20n, capacity: 2n }), /IDENTITY_NOT_ACTIVE/);
  assert.equal(m.registeredIdentity("provider-1").kind, "human");
});
