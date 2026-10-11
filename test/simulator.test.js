import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCandidate, proposeHarness } from "../src/evolver.js";
import { baselineHarness, simulateRun } from "../src/simulator.js";

test("baseline repeats a blocked road because the task map stays stale", () => {
  const run = simulateRun({
    scenarioId: "construction-main",
    harness: baselineHarness,
    runId: "baseline-test"
  });

  assert.equal(run.status, "failed");
  assert.equal(run.metrics.repeatedBlocks, 3);
  assert.equal(run.events.some((event) => event.type === "map_updated"), false);
});

test("evolved harness transfers the observed closure into the planner map", () => {
  const failedRun = simulateRun({
    scenarioId: "construction-main",
    harness: baselineHarness,
    runId: "source-test"
  });
  const candidate = proposeHarness({
    sourceHarness: baselineHarness,
    sourceRun: failedRun,
    version: 2
  });
  const improvedRun = simulateRun({
    scenarioId: "construction-main",
    harness: candidate,
    runId: "candidate-test"
  });

  assert.equal(improvedRun.status, "delivered");
  assert.equal(improvedRun.metrics.repeatedBlocks, 0);
  assert.equal(improvedRun.events.some((event) => event.type === "map_updated"), true);
});

test("candidate must pass unseen delivery, regression, and unreachable scenarios", () => {
  const failedRun = simulateRun({
    scenarioId: "construction-main",
    harness: baselineHarness
  });
  const candidate = proposeHarness({
    sourceHarness: baselineHarness,
    sourceRun: failedRun,
    version: 2
  });
  const evaluation = evaluateCandidate({ baseline: baselineHarness, candidate });

  assert.equal(evaluation.accepted, true);
  assert.equal(evaluation.candidateMetrics.correctOutcomes, 4);
  assert.equal(evaluation.candidateMetrics.repeatedBlocks, 0);
  assert.equal(evaluation.candidateMetrics.unsafeActions, 0);
  assert.equal(evaluation.gates.improvesCorrectOutcomes, true);
});
