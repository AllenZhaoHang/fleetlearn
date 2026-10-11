// The closed loop, shared by the web server and the CLI:
// run vehicles -> record traces and road events in Atlas -> propose -> evaluate -> activate.
import { materializeScenario } from "./scenarios.js";
import { simulateRun } from "./simulator.js";
import { evaluateCandidate, proposeHarness, proposeShortcut } from "./evolver.js";
import { modelProposer } from "./model-proposer.js";

export async function runLive(store, scenarioId, harnessVersion) {
  const harness = harnessVersion ? await store.getHarness(harnessVersion) : await store.getActiveHarness();
  if (!harness) throw Object.assign(new Error("Harness not found"), { status: 404 });
  const scenario = materializeScenario(scenarioId);
  const reported = await store.listRoadEvents(scenario.id);
  const fleetMemory = [...new Set([...(scenario.priorReports ?? []), ...reported.map((item) => item.edge)])];
  const previous = (await store.listRuns(200)).filter((run) => run.scenarioId === scenario.id).length;
  const run = simulateRun({ scenario, harness, fleetMemory, vehicle: previous + 1 });
  await store.saveRun(run);
  await store.saveRoadEvents(scenario.id, run.reportedEvents, run);
  return run;
}

export async function nextVersion(store) {
  const harnesses = await store.listHarnesses();
  return Math.max(...harnesses.map((item) => item.version), 0) + 1;
}

export async function evolveOnce(store, { sourceRunId, searchOnly = false } = {}) {
  const sourceRun = sourceRunId ? await store.getRun(sourceRunId) : null;
  if (sourceRunId && !sourceRun) throw Object.assign(new Error("Source run not found"), { status: 404 });
  const sourceHarness = sourceRun ? await store.getHarness(sourceRun.harnessVersion) : await store.getActiveHarness();
  const candidate = await proposeHarness({
    sourceHarness,
    sourceRun,
    version: await nextVersion(store),
    modelProposer: searchOnly ? null : modelProposer(),
    rejected: await store.listRejected()
  });
  await store.saveHarness(candidate);
  return candidate;
}

// Stores a cost-cutting shortcut as a candidate, so the demo can show the fixed gate refusing it.
export async function shortcutOnce(store, { sourceRunId } = {}) {
  const sourceRun = sourceRunId ? await store.getRun(sourceRunId) : null;
  const candidate = proposeShortcut({
    sourceHarness: await store.getActiveHarness(),
    sourceRun,
    version: await nextVersion(store),
    rejected: await store.listRejected()
  });
  await store.saveHarness(candidate);
  return candidate;
}

export async function evaluateAndRecord(store, candidateVersion) {
  const candidate = await store.getHarness(candidateVersion);
  if (!candidate) throw Object.assign(new Error("Candidate harness not found"), { status: 404 });
  const baseline = await store.getHarness(candidate.parentVersion);
  if (!baseline) throw Object.assign(new Error("Parent harness not found"), { status: 404 });
  const evaluation = evaluateCandidate({ baseline, candidate });
  await store.saveEvaluation(evaluation);
  if (!evaluation.accepted) await store.setHarnessStatus(candidate.version, "rejected");
  return evaluation;
}

// Keeps evolving until the development set has nothing left to teach or a candidate fails the gate.
export async function autoEvolve(store, { maxGenerations = 8, searchOnly = false, onStep = () => {} } = {}) {
  const steps = [];
  for (let generation = 0; generation < maxGenerations; generation += 1) {
    let candidate;
    try {
      candidate = await evolveOnce(store, { searchOnly });
    } catch (error) {
      steps.push({ stopped: error.message });
      break;
    }
    const evaluation = await evaluateAndRecord(store, candidate.version);
    if (evaluation.accepted) await store.activateHarness(candidate.version);
    const step = { candidate, evaluation };
    steps.push(step);
    onStep(step);
    if (!evaluation.accepted) break;
  }
  return steps;
}
