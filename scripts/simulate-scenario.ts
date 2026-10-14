import { adversaryScenario, machineDropScenario, providerScenario } from "../src/service/simulators.ts";
const seed = 7;
const reports = [providerScenario(seed, 4), adversaryScenario(seed), machineDropScenario(seed)];
for (const report of reports) {
  if (!report.valueConserved || !report.capacityConserved) throw new Error(`SCENARIO_NOT_CONSERVED ${report.name}`);
  console.log(`${report.name} settled=${report.settled} rejected=${report.rejected} conserved=true`);
}
console.log("SCENARIO OK");
