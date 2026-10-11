import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCandidate, evaluateOn, proposeHarness, proposeShortcut } from "../src/evolver.js";
import { baselineHarness, runScenario, simulateRun } from "../src/simulator.js";
import { developmentSet, holdoutSet, materializeScenario } from "../src/scenarios.js";

test("baseline repeats a blocked road because the task map stays stale", () => {
  const run = simulateRun({ scenarioId: "construction-main", harness: baselineHarness });
  assert.equal(run.status, "failed");
  assert.equal(run.metrics.repeatedBlocks, 3);
  assert.equal(run.events.some((event) => event.type === "map_updated"), false);
});

test("generated holdout cities are frozen, distinct from development, and solvable", () => {
  assert.equal(holdoutSet.length, 36);
  assert.ok(Object.isFrozen(holdoutSet[0].blockedEdges));
  const devIds = new Set(developmentSet.map((s) => s.id));
  assert.ok(holdoutSet.every((s) => !devIds.has(s.id)));
  assert.deepEqual(materializeScenario(holdoutSet[3].id).blockedEdges, holdoutSet[3].blockedEdges);
});

test("the proposer is not hard-coded: it derives v2 from the failure and scores it on development data", async () => {
  const failedRun = simulateRun({ scenarioId: "construction-main", harness: baselineHarness });
  const candidate = await proposeHarness({ sourceHarness: baselineHarness, sourceRun: failedRun, version: 2 });
  assert.equal(candidate.diagnosis.code, "STALE_MAP_RECOVERY_LOOP");
  assert.ok(candidate.recoverySteps.includes("update_local_map"));
  assert.ok(candidate.candidatesConsidered > 10);
  assert.ok(candidate.devMetrics.candidate.correctOutcomes > candidate.devMetrics.parent.correctOutcomes);
  const improved = simulateRun({ scenarioId: "construction-main", harness: candidate });
  assert.equal(improved.status, "delivered");
});

test("a model suggestion that scores best on development wins over local search", async () => {
  const fakeModel = async () => ({
    model: "fake-model",
    candidates: [
      { preflight: [], recoverySteps: ["update_local_map", "replan", "follow_route", "request_help"], maxRecoveryCycles: 3, rationale: "update the map and escalate" },
      { preflight: [], recoverySteps: ["bogus_tool"], maxRecoveryCycles: 3, rationale: "invalid, must be dropped" }
    ]
  });
  const candidate = await proposeHarness({ sourceHarness: baselineHarness, version: 2, modelProposer: fakeModel });
  assert.equal(candidate.proposer, "fake-model");
  assert.equal(candidate.rationale, "update the map and escalate");
  assert.equal(candidate.modelCandidates.length, 1);
});

test("a regressing candidate is rejected by the fixed holdout gate", () => {
  const good = { ...baselineHarness, version: 2, recoverySteps: ["update_local_map", "replan", "follow_route", "request_help"] };
  const worse = { ...baselineHarness, version: 3, recoverySteps: ["update_local_map", "replan", "follow_route"] };
  const evaluation = evaluateCandidate({ baseline: good, candidate: worse });
  assert.equal(evaluation.accepted, false);
  assert.equal(evaluation.gates.noFamilyRegression, false);
});

test("convoy: the second vehicle avoids the closure only if the first one reported it", () => {
  const scenario = developmentSet.find((s) => s.family === "convoy");
  const silent = { ...baselineHarness, preflight: ["query_fleet_memory"], recoverySteps: ["update_local_map", "replan", "follow_route"] };
  const sharing = { ...silent, recoverySteps: ["report_road_event", ...silent.recoverySteps] };
  const [, secondSilent] = runScenario(scenario, silent);
  const [, secondSharing] = runScenario(scenario, sharing);
  assert.ok(secondSilent.metrics.blockedEncounters > 0);
  assert.equal(secondSharing.metrics.blockedEncounters, 0);
});

test("four generations of local search reach every holdout family", async () => {
  let harness = baselineHarness;
  for (let version = 2; version <= 5; version += 1) {
    const candidate = await proposeHarness({ sourceHarness: harness, version });
    const evaluation = evaluateCandidate({ baseline: harness, candidate });
    assert.equal(evaluation.accepted, true, `v${version} should pass the gate`);
    harness = candidate;
  }
  const final = evaluateOn(harness, holdoutSet).metrics;
  assert.equal(final.correctOutcomes, holdoutSet.length);
  assert.equal(final.unsafeActions, 0);
});

test("giving up early does not count as fewer blocked roads", () => {
  const giveUp = { ...baselineHarness, version: 2, recoverySteps: ["follow_route"] };
  const evaluation = evaluateCandidate({ baseline: baselineHarness, candidate: { ...giveUp, recoverySteps: ["replan"] } });
  assert.equal(evaluation.gates.measurableImprovement, false);
  assert.equal(evaluation.accepted, false);
});

test("a cost-cutting shortcut that only checks the last run is rejected by the holdout gate", async () => {
  let harness = baselineHarness;
  for (let version = 2; version <= 3; version += 1) harness = await proposeHarness({ sourceHarness: harness, version });
  const run = simulateRun({ scenarioId: "construction-main", harness });
  const shortcut = proposeShortcut({ sourceHarness: harness, sourceRun: run, version: 4 });
  assert.equal(simulateRun({ scenarioId: "construction-main", harness: shortcut }).status, "delivered");
  const evaluation = evaluateCandidate({ baseline: harness, candidate: shortcut });
  assert.equal(evaluation.accepted, false);
  assert.ok(evaluation.familyDiff.unreachable.correctAfter < evaluation.familyDiff.unreachable.correctBefore);
});
