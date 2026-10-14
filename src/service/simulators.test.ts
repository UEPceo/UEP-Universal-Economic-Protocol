import test from "node:test";
import assert from "node:assert/strict";
import { adversaryScenario, machineDropScenario, providerScenario } from "./simulators.ts";

test("seeded scenarios conserve value and capacity and repeat", () => {
  const a = providerScenario(7, 4);
  const b = providerScenario(7, 4);
  assert.deepEqual(a, b);
  assert.equal(a.settled, 4);
  assert.equal(a.valueConserved, true);
  assert.equal(a.capacityConserved, true);
  const adv = adversaryScenario(7);
  assert.equal(adv.settled, 0);
  assert.equal(adv.valueConserved, true);
  const machine = machineDropScenario(7);
  assert.equal(machine.settled, 1);
  assert.equal(machine.valueConserved, true);
  assert.equal(machine.capacityConserved, true);
});
