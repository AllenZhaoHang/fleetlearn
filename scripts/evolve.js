// Headless evolution loop: `npm run evolve` (add `-- --reset` to start from v1).
import "dotenv/config";
import { FleetStore } from "../src/store.js";
import { autoEvolve } from "../src/fleet.js";
import { configuredModel } from "../src/model-proposer.js";

const store = new FleetStore({ uri: process.env.MONGODB_URI, databaseName: process.env.MONGODB_DB ?? "fleetlearn" });
const mode = await store.init();
if (process.argv.includes("--reset")) await store.resetDemo();
const searchOnly = process.argv.includes("--search-only");
console.log(`storage: ${mode}   proposer: ${searchOnly || !configuredModel() ? "local search only" : `${configuredModel()} + local search`}\n`);

const pct = (m) => `${m.correctOutcomes}/${m.scenarios}`;
await autoEvolve(store, {
  searchOnly,
  onStep: ({ candidate: c, evaluation: e }) => {
    const b = e.baselineMetrics;
    const a = e.candidateMetrics;
    console.log(`v${c.parentVersion} → v${c.version}  ${e.accepted ? "ACTIVATED" : "rejected "}  [${c.proposer}]  ${c.name}`);
    console.log(`   diagnosis : ${c.diagnosis.code} — ${c.diagnosis.evidence}`);
    console.log(`   holdout   : correct ${pct(b)} → ${pct(a)}   blocked roads ${b.blockedEncounters} → ${a.blockedEncounters}   tool calls ${b.toolCalls} → ${a.toolCalls}`);
    const rules = (c.rules ?? []).map((r) => `if ${r.when} → ${r.then}`).join("; ");
    console.log(`   procedure : [${c.preflight.join(", ")}] ${c.recoverySteps.join(" → ")}  (×${c.maxRecoveryCycles})${rules ? `  rules: ${rules}` : ""}  radius ${c.context?.perceptionRadius ?? 0}`);
    console.log(`   searched  : ${c.candidatesConsidered} candidates${c.searchDepth === 2 ? " (widened to 2-edit combinations)" : ""}\n`);
  }
});

const lineage = await store.listHarnesses();
console.log("lineage:", lineage.map((h) => `v${h.version}:${h.status}`).join("  "));
await store.close();
