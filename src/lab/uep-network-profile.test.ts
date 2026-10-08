import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activateProfile, assertSameNetwork, LAB_PROFILE } from "./uep-network-profile.ts";

describe("UEP-NET-001", () => {
  it("lab profile activates and a testnet without ceremony does not", () => {
    assert.equal(activateProfile(LAB_PROFILE).ok, true);
    assert.equal(LAB_PROFILE.networkId, "uep-lab-1");
    assert.equal(LAB_PROFILE.domainId, "lab-earth-0");
    assert.equal(LAB_PROFILE.ceremony, false);
    const blocked = activateProfile({ ...LAB_PROFILE, kind: "TESTNET", testnetAllowed: true } as unknown as Parameters<typeof activateProfile>[0]);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "TESTNET_BLOCKED_NO_CEREMONY");
    assert.equal(assertSameNetwork(LAB_PROFILE, "uep-lab-1", "lab-earth-0").ok, true);
    assert.equal(assertSameNetwork(LAB_PROFILE, "uep-other", "lab-earth-0").ok, false);
    assert.equal(assertSameNetwork(LAB_PROFILE, "uep-lab-1", "other-domain").ok, false);
  });
});
