import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { developmentSet, families, holdoutSet, materializeScenario, scenarios } from "./src/scenarios.js";
import { guardrails, toolCatalog } from "./src/simulator.js";
import { gatePolicy } from "./src/evolver.js";
import { configuredModel } from "./src/model-proposer.js";
import { autoEvolve, evaluateAndRecord, evolveOnce, runLive } from "./src/fleet.js";
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
  const [activeHarness, harnesses, runs, evaluations, roadEvents] = await Promise.all([
    store.getActiveHarness(),
    store.listHarnesses(),
    store.listRuns(),
    store.listEvaluations(),
    store.listRoadEvents()
  ]);
  response.json({
    storageMode,
    atlasRequiredForSubmission: true,
    model: configuredModel(),
    scenarios,
    families,
    toolCatalog,
    guardrails,
    gatePolicy,
    developmentScenarios: developmentSet.length,
    holdoutScenarios: holdoutSet.length,
    activeHarness,
    harnesses,
    runs,
    evaluations,
    roadEvents
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
  const run = await runLive(store, request.body.scenarioId ?? "construction-main", request.body.harnessVersion);
  response.status(201).json(run);
}));

app.post("/api/evolve", asyncRoute(async (request, response) => {
  const candidate = await evolveOnce(store, { sourceRunId: request.body.runId });
  response.status(201).json(candidate);
}));

app.post("/api/evaluations", asyncRoute(async (request, response) => {
  response.status(201).json(await evaluateAndRecord(store, request.body.candidateVersion));
}));

app.post("/api/harnesses/:version/activate", asyncRoute(async (request, response) => {
  const version = Number(request.params.version);
  const evaluations = await store.listEvaluations(50);
  const approval = evaluations.find(
    (evaluation) => evaluation.candidateVersion === version && evaluation.accepted
  );
  if (!approval) {
    return response.status(409).json({ error: "Candidate must pass the fixed evaluation gates first" });
  }
  response.json(await store.activateHarness(version));
}));

app.post("/api/auto-evolve", asyncRoute(async (request, response) => {
  const steps = await autoEvolve(store, { maxGenerations: Math.min(Number(request.body.maxGenerations ?? 6), 10) });
  response.json({
    steps: steps.map((step) => step.stopped ? step : {
      version: step.candidate.version,
      name: step.candidate.name,
      proposer: step.candidate.proposer,
      issue: step.candidate.diagnosis.code,
      accepted: step.evaluation.accepted,
      before: step.evaluation.baselineMetrics,
      after: step.evaluation.candidateMetrics
    }),
    activeHarness: await store.getActiveHarness()
  });
}));

app.post("/api/reset", asyncRoute(async (_request, response) => {
  await store.resetDemo();
  response.json({ ok: true });
}));

app.get("/health", (_request, response) => {
  response.json({ ok: true, storageMode });
});

app.use((error, _request, response, _next) => {
  const status = error.status ?? (/No (failure patterns|candidate improved)/.test(error.message) ? 409 : 500);
  if (status === 500) console.error(error);
  response.status(status).json({ error: error.message || "Unexpected server error" });
});

const server = app.listen(port, () => {
  console.log(`FleetLearn running at http://localhost:${port} (${storageMode} storage, model: ${configuredModel() ?? "none - local search only"})`);
});

const shutdown = async () => {
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
