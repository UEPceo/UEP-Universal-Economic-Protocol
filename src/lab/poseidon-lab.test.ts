import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import {
  labProveSpend,
  transitionIdFromPublics,
  LAB_PROFILE,
  LAB_NETWORK_ID,
} from "./poseidon-ledger-lab.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

describe("Poseidon Ledger Lab", () => {
  it("transitionId is stable for same publics", () => {
    const a = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "0a", "0b", "0c"];
    const b = a.map((x) => "0x" + x.padStart(64, "0"));
    const id1 = transitionIdFromPublics(b);
    const id2 = transitionIdFromPublics(b);
    assert.equal(id1, id2);
    const c = [...b];
    c[8] = "0x" + "ff".repeat(32);
    assert.notEqual(transitionIdFromPublics(c), id1);
  });

  it("lab request carries local profile", () => {
    const r = labProveSpend({
      depth: 4,
      senderSecret: Fr.from(11n),
      senderSalt: Fr.from(22n),
      recipientId: Fr.from(33n),
      treasuryId: Fr.from(44n),
      assetId: Fr.from(1n),
      amount: 1000n,
      senderOldBalance: 10_000n,
      noteBlinding: Fr.from(3n),
      recipientBlinding: Fr.from(4n),
      treasuryBlinding: Fr.from(5n),
      extraStateLeaves: [[7, "0x" + "11".repeat(32)]],
    });
    assert.equal((r.request as { network_profile?: string }).network_profile, LAB_PROFILE);
    assert.equal(r.request.amount.toString(), "1000");
    // UEP-29.4: no SKIP — prove path must fail the test if binary missing
    assert.ok(
      findUepZkBinary(),
      "uep-zk binary required (build: scripts/build-uep-zk.sh)",
    );
    assert.equal(r.result.ok, true, r.result.error);
    assert.ok(r.record);
    assert.equal(r.record!.networkId, LAB_NETWORK_ID);
    assert.equal(r.record!.keys, "DEV-TEST-KEYS");
    assert.equal(r.record!.fee, creatorFee(1000n).toString());
  });
});
