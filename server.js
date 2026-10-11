import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { materializeScenario, scenarios } from "./src/scenarios.js";
import { simulateRun } from "./src/simulator.js";
import { diagnoseRun, evaluateCandidate, proposeHarness } from "./src/evolver.js";
import { enrichDiagnosis } from "./src/model-analyst.js";
import { FleetStore } from "./src/store.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const store = new FleetStore({
  uri: process.env.MONGODB_URI,
  databaseName: process.env.MONGODB_DB ?? "fleetlearn"
});
const storageMode = await store.init();

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

const asyncRoute = (handler) => async (request, response, next) => {
  try {
    await handler(request, response);
  } catch (error) {
    next(error);
  }
};

app.get("/api/overview", asyncRoute(async (_request, response) => {
  const [activeHarness, harnesses, runs, evaluations] = await Promise.all([
    store.getActiveHarness(),
    store.listHarnesses(),
    store.listRuns(),
    store.listEvaluations()
  ]);
  response.json({
    storageMode,
    atlasRequiredForSubmission: true,
    modelAnalystConfigured: Boolean(
      process.env.MODEL_API_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME
    ),
    scenarios,
    activeHarness,
    harnesses,
    runs,
    evaluations
  });
}));

app.get("/api/scenarios/:id", (request, response, next) => {
  try {
    response.json(materializeScenario(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs", asyncRoute(async (request, response) => {
  const scenarioId = request.body.scenarioId ?? "construction-main";
  const harness = request.body.harnessVersion
    ? await store.getHarness(request.body.harnessVersion)
    : await store.getActiveHarness();
  if (!harness) return response.status(404).json({ error: "Harness not found" });
  const run = simulateRun({ scenarioId, harness });
  await store.saveRun(run);
  response.status(201).json(run);
}));

app.post("/api/evolve", asyncRoute(async (request, response) => {
  const sourceRun = await store.getRun(request.body.runId);
  if (!sourceRun) return response.status(404).json({ error: "Source run not found" });
  if (sourceRun.status !== "failed") {
    return response.status(409).json({ error: "Only failed runs can trigger harness evolution" });
  }
  const sourceHarness = await store.getHarness(sourceRun.harnessVersion);
  const harnesses = await store.listHarnesses();
  const nextVersion = Math.max(...harnesses.map((item) => item.version), 0) + 1;
  const localDiagnosis = diagnoseRun(sourceRun);
  let enriched;
  try {
    enriched = await enrichDiagnosis({ run: sourceRun, diagnosis: localDiagnosis });
  } catch (error) {
    enriched = {
      diagnosis: localDiagnosis,
      analyst: "bounded-local-critic",
      analystFallbackReason: error.message
    };
  }
  const candidate = proposeHarness({ sourceHarness, sourceRun, version: nextVersion });
  candidate.diagnosis = enriched.diagnosis;
  candidate.rationale = enriched.diagnosis.proposedChange;
  candidate.analyst = enriched.analyst;
  if (enriched.analystFallbackReason) candidate.analystFallbackReason = enriched.analystFallbackReason;
  await store.saveHarness(candidate);
  response.status(201).json(candidate);
}));

app.post("/api/evaluations", asyncRoute(async (request, response) => {
  const candidate = await store.getHarness(request.body.candidateVersion);
  if (!candidate) return response.status(404).json({ error: "Candidate harness not found" });
  const baseline = await store.getHarness(candidate.parentVersion);
  if (!baseline) return response.status(404).json({ error: "Parent harness not found" });
  const evaluation = evaluateCandidate({ baseline, candidate });
  await store.saveEvaluation(evaluation);
  response.status(201).json(evaluation);
}));

app.post("/api/harnesses/:version/activate", asyncRoute(async (request, response) => {
  const version = Number(request.params.version);
  const evaluations = await store.listEvaluations(20);
  const approval = evaluations.find(
    (evaluation) => evaluation.candidateVersion === version && evaluation.accepted
  );
  if (!approval) {
    return response.status(409).json({ error: "Candidate must pass the fixed evaluation gates first" });
  }
  const harness = await store.activateHarness(version);
  response.json(harness);
}));

app.post("/api/reset", asyncRoute(async (_request, response) => {
  await store.resetDemo();
  response.json({ ok: true });
}));

app.get("/health", (_request, response) => {
  response.json({ ok: true, storageMode });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || "Unexpected server error" });
});

const server = app.listen(port, () => {
  console.log(`FleetLearn running at http://localhost:${port} (${storageMode} storage)`);
});

const shutdown = async () => {
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
