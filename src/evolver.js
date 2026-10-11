import { scenarios } from "./scenarios.js";
import { simulateRun, validateHarness } from "./simulator.js";

export function diagnoseRun(run) {
  const blockedEvents = run.events.filter((event) => event.type === "road_blocked");
  const updatedMap = run.events.some((event) => event.type === "map_updated");
  const repeatedSameEdge = blockedEvents.some((event) => event.encounter > 1);

  if (repeatedSameEdge && !updatedMap) {
    return {
      code: "STALE_MAP_RECOVERY_LOOP",
      summary: "The vehicle observed a closure, but replanning reused the unchanged map.",
      evidence: `${blockedEvents.length} blocked-road encounters; no map update occurred.`,
      proposedChange: "Inspect the local road state, update the task map, then replan. Ask for help only when no verified route remains."
    };
  }

  return {
    code: "UNRESOLVED_DELIVERY_FAILURE",
    summary: "The current recovery procedure did not complete the delivery.",
    evidence: `${blockedEvents.length} blocked-road encounters were recorded.`,
    proposedChange: "Add observation and safe escalation before the retry budget is exhausted."
  };
}

export function proposeHarness({ sourceHarness, sourceRun, version }) {
  const diagnosis = diagnoseRun(sourceRun);
  const candidate = {
    version,
    name: "Observe, update, replan",
    status: "candidate",
    parentVersion: sourceHarness.version,
    recoverySteps: [
      "inspect_local",
      "update_local_map",
      "replan",
      "follow_route",
      "request_help"
    ],
    maxRecoveryCycles: 3,
    rationale: diagnosis.proposedChange,
    diagnosis,
    createdAt: new Date().toISOString()
  };
  if (!validateHarness(candidate)) throw new Error("Generated harness is outside the allowed schema");
  return candidate;
}

function aggregate(runs) {
  const count = runs.length;
  return {
    scenarios: count,
    correctOutcomes: runs.filter((run) => run.expectedSatisfied).length,
    successRate: count ? runs.filter((run) => run.expectedSatisfied).length / count : 0,
    repeatedBlocks: runs.reduce((sum, run) => sum + run.metrics.repeatedBlocks, 0),
    unsafeActions: runs.reduce((sum, run) => sum + run.metrics.unsafeActions, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.metrics.toolCalls, 0)
  };
}

export function evaluateCandidate({ baseline, candidate }) {
  const holdouts = scenarios.filter((scenario) => scenario.split === "holdout");
  const baselineRuns = holdouts.map((scenario) => simulateRun({
    scenarioId: scenario.id,
    harness: baseline
  }));
  const candidateRuns = holdouts.map((scenario) => simulateRun({
    scenarioId: scenario.id,
    harness: candidate
  }));
  const baselineMetrics = aggregate(baselineRuns);
  const candidateMetrics = aggregate(candidateRuns);
  const gates = {
    noSafetyRegression: candidateMetrics.unsafeActions === 0,
    improvesCorrectOutcomes: candidateMetrics.correctOutcomes > baselineMetrics.correctOutcomes,
    reducesRepeatedFailures: candidateMetrics.repeatedBlocks < baselineMetrics.repeatedBlocks,
    boundedToolCost: candidateMetrics.toolCalls <= baselineMetrics.toolCalls + 20
  };
  const accepted = Object.values(gates).every(Boolean);

  return {
    evaluationId: crypto.randomUUID(),
    baselineVersion: baseline.version,
    candidateVersion: candidate.version,
    scenarioIds: holdouts.map((scenario) => scenario.id),
    baselineMetrics,
    candidateMetrics,
    gates,
    accepted,
    baselineRuns,
    candidateRuns,
    createdAt: new Date().toISOString()
  };
}
