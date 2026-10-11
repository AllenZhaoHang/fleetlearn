import { developmentSet, holdoutSet } from "./scenarios.js";
import { guardrails, normalizeHarness, runScenario, toolCatalog, validateHarness } from "./simulator.js";

// ---------- diagnosis: turn traces into named failure patterns ----------

const issueCatalog = {
  STALE_MAP_RECOVERY_LOOP: {
    summary: "The vehicle observed a closure, but replanning reused the unchanged map.",
    hint: "Observed closures must reach the task map before replanning."
  },
  NO_SAFE_ESCALATION: {
    summary: "No route remained, but the vehicle never asked for help.",
    hint: "When planning finds no route, escalate instead of burning the retry budget."
  },
  RECOVERY_BUDGET_EXHAUSTED: {
    summary: "The vehicle ran out of recovery cycles before reaching the destination.",
    hint: "Recovery has to make progress every cycle, or more cycles are needed."
  },
  TOOL_BUDGET_EXCEEDED: {
    summary: "The run hit the fixed tool-call budget.",
    hint: "The procedure is too long for the fixed budget."
  },
  KNOWN_CLOSURE_REDISCOVERED: {
    summary: "The vehicle drove into a closure that fleet memory already contained.",
    hint: "Read fleet memory before planning the first route."
  },
  FLEET_KNOWLEDGE_NOT_SHARED: {
    summary: "A later vehicle hit the same closure as an earlier one, because nothing was reported.",
    hint: "Publish observed closures so later vehicles can avoid them."
  }
};

export function diagnoseRun(run, previousRunsInScenario = []) {
  const has = (type) => run.events.some((event) => event.type === type);
  const issues = [];
  const add = (code, evidence) => issues.push({ code, ...issueCatalog[code], evidence, scenarioId: run.scenarioId, vehicle: run.vehicle });

  if (run.metrics.repeatedBlocks > 0 && !has("map_updated")) {
    add("STALE_MAP_RECOVERY_LOOP", `${run.metrics.blockedEncounters} blocked-road encounters on ${run.metrics.blockedEncounters - run.metrics.repeatedBlocks} distinct roads; no map update.`);
  }
  if (run.scenario.expected === "help" && !run.metrics.requestedHelp) {
    const noRoute = run.events.some((event) => event.type === "route_planned" && !event.route);
    add("NO_SAFE_ESCALATION", noRoute ? "Planner returned no route, yet no assistance was requested." : "Destination was unreachable; the vehicle kept retrying.");
  }
  if (run.metrics.budgetExceeded) add("TOOL_BUDGET_EXCEEDED", `Stopped at ${guardrails.maxToolCallsPerRun} tool calls.`);
  else if (run.status === "failed" && has("map_updated") && run.scenario.expected === "deliver") {
    add("RECOVERY_BUDGET_EXHAUSTED", `Delivery failed after ${run.events.filter((e) => e.type === "recovery_cycle_started").length} recovery cycles.`);
  }
  if (run.metrics.knownClosuresRediscovered > 0) {
    add("KNOWN_CLOSURE_REDISCOVERED", `${run.metrics.knownClosuresRediscovered} closure(s) were already in fleet memory.`);
  }
  const earlier = previousRunsInScenario.flatMap((prior) => prior.events.filter((e) => e.type === "road_blocked").map((e) => e.edge));
  const repeatedAcrossFleet = run.events.filter((e) => e.type === "road_blocked" && earlier.includes(e.edge));
  if (repeatedAcrossFleet.length && previousRunsInScenario.every((prior) => !prior.reportedEvents.length)) {
    add("FLEET_KNOWLEDGE_NOT_SHARED", `Vehicle ${run.vehicle} hit ${repeatedAcrossFleet[0].edge.replace("::", "–")}, which vehicle ${run.vehicle - 1} had already seen.`);
  }
  return issues;
}

function summarizeIssues(issues) {
  const byCode = new Map();
  for (const issue of issues) {
    const entry = byCode.get(issue.code) ?? { ...issue, count: 0, scenarios: new Set() };
    entry.count += 1;
    entry.scenarios.add(issue.scenarioId);
    byCode.set(issue.code, entry);
  }
  return [...byCode.values()]
    .map(({ scenarios, scenarioId, vehicle, ...rest }) => ({ ...rest, scenarios: scenarios.size }))
    .sort((a, b) => b.count - a.count);
}

// ---------- scoring ----------

export function evaluateOn(harness, scenarioSet) {
  const results = scenarioSet.map((scenario) => {
    const runs = runScenario(scenario, harness);
    const issues = runs.flatMap((run, i) => diagnoseRun(run, runs.slice(0, i)));
    return { scenario, runs, issues, correct: runs.every((run) => run.expectedSatisfied) };
  });
  const runs = results.flatMap((result) => result.runs);
  const sum = (key) => runs.reduce((total, run) => total + Number(run.metrics[key]), 0);
  const byFamily = {};
  for (const result of results) {
    const family = (byFamily[result.scenario.family] ??= { scenarios: 0, correct: 0 });
    family.scenarios += 1;
    family.correct += result.correct ? 1 : 0;
  }
  const metrics = {
    scenarios: results.length,
    correctOutcomes: results.filter((result) => result.correct).length,
    successRate: results.length ? results.filter((result) => result.correct).length / results.length : 0,
    blockedEncounters: sum("blockedEncounters"),
    repeatedBlocks: sum("repeatedBlocks"),
    unsafeActions: sum("unsafeActions"),
    toolCalls: sum("toolCalls"),
    distance: Number(sum("distance").toFixed(2)),
    byFamily
  };
  return { metrics, results, issues: summarizeIssues(results.flatMap((result) => result.issues)) };
}

// Lexicographic: correct outcomes, then fewer blocked-road encounters, then fewer tool calls.
export function compareMetrics(a, b) {
  if (a.correctOutcomes !== b.correctOutcomes) return a.correctOutcomes - b.correctOutcomes;
  if (a.blockedEncounters !== b.blockedEncounters) return b.blockedEncounters - a.blockedEncounters;
  return b.toolCalls - a.toolCalls;
}

// ---------- proposal: model suggestions + local search over the tool surface ----------

const signature = (h) => JSON.stringify([h.preflight, h.recoverySteps, h.maxRecoveryCycles]);

function neighbors(parent) {
  const h = normalizeHarness(parent);
  const out = [];
  const push = (preflight, recoverySteps, maxRecoveryCycles) => out.push({ preflight, recoverySteps, maxRecoveryCycles });
  const steps = h.recoverySteps;
  for (const tool of Object.keys(toolCatalog)) {
    for (let i = 0; i <= steps.length; i += 1) push(h.preflight, [...steps.slice(0, i), tool, ...steps.slice(i)], h.maxRecoveryCycles);
  }
  steps.forEach((_, i) => push(h.preflight, steps.filter((__, j) => j !== i), h.maxRecoveryCycles));
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const swapped = [...steps];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    push(h.preflight, swapped, h.maxRecoveryCycles);
  }
  push(h.preflight, steps, h.maxRecoveryCycles + 1);
  push(h.preflight, steps, h.maxRecoveryCycles - 1);
  push(h.preflight.includes("query_fleet_memory") ? [] : ["query_fleet_memory"], steps, h.maxRecoveryCycles);
  return out;
}

export function describeChange(parent, child) {
  const p = normalizeHarness(parent);
  const changes = [];
  const added = child.recoverySteps.filter((step) => !p.recoverySteps.includes(step));
  const removed = p.recoverySteps.filter((step) => !child.recoverySteps.includes(step));
  if (added.length) changes.push(`add ${added.join(", ")}`);
  if (removed.length) changes.push(`remove ${removed.join(", ")}`);
  if (!added.length && !removed.length && signature({ ...p, maxRecoveryCycles: 0 }) !== signature({ ...child, maxRecoveryCycles: 0 })) {
    if (JSON.stringify(p.recoverySteps) !== JSON.stringify(child.recoverySteps)) changes.push("reorder recovery steps");
  }
  if (child.preflight.length > p.preflight.length) changes.push("query fleet memory before departure");
  if (child.preflight.length < p.preflight.length) changes.push("stop reading fleet memory before departure");
  if (child.maxRecoveryCycles !== p.maxRecoveryCycles) changes.push(`recovery cycles ${p.maxRecoveryCycles} → ${child.maxRecoveryCycles}`);
  return changes;
}

const humanName = (changes) => {
  const text = changes.join("; ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "No change";
};

// Proposes the next harness. Every candidate (from the model or from search) is scored on the
// development set only; the best one that beats the parent becomes the stored candidate.
export async function proposeHarness({ sourceHarness, sourceRun, version, modelProposer, rejected = [] }) {
  const parent = normalizeHarness(sourceHarness);
  const parentEval = evaluateOn(parent, developmentSet);
  const sourceIssues = sourceRun ? diagnoseRun(sourceRun) : [];
  const issues = summarizeIssues([...sourceIssues, ...parentEval.results.flatMap((r) => r.issues)]);
  if (!issues.length) throw new Error("No failure patterns left on the development set; nothing to learn from.");

  const rejectedSigs = new Set(rejected.map((h) => signature(normalizeHarness(h))));
  const pool = [];
  const seen = new Set([signature(parent), ...rejectedSigs]);
  const consider = (shape, proposer, rationale) => {
    const candidate = { ...shape, preflight: shape.preflight ?? [] };
    if (!validateHarness(candidate) || seen.has(signature(candidate))) return;
    seen.add(signature(candidate));
    pool.push({ candidate, proposer, rationale, dev: evaluateOn(candidate, developmentSet).metrics });
  };

  let modelInfo = null;
  if (modelProposer) {
    try {
      modelInfo = await modelProposer({ harness: parent, issues, sourceRun, toolCatalog, guardrails, rejected });
      for (const item of modelInfo?.candidates ?? []) consider(item, modelInfo.model, item.rationale);
    } catch (error) {
      modelInfo = { error: error.message };
    }
  }
  for (const shape of neighbors(parent)) consider(shape, "local-search", null);

  const improving = pool.filter((entry) => compareMetrics(entry.dev, parentEval.metrics) > 0);
  if (!improving.length) throw new Error("No candidate improved on the development set.");
  improving.sort((a, b) => compareMetrics(b.dev, a.dev)
    || (a.proposer === "local-search") - (b.proposer === "local-search")
    || a.candidate.recoverySteps.length - b.candidate.recoverySteps.length);
  const best = improving[0];

  const changes = describeChange(parent, best.candidate);
  const primary = issues[0];
  return {
    version,
    name: humanName(changes),
    status: "candidate",
    parentVersion: parent.version,
    preflight: best.candidate.preflight,
    recoverySteps: best.candidate.recoverySteps,
    maxRecoveryCycles: best.candidate.maxRecoveryCycles,
    changes,
    rationale: best.rationale ?? `${primary.hint} Change: ${changes.join("; ")}.`,
    diagnosis: { code: primary.code, summary: primary.summary, evidence: primary.evidence, proposedChange: changes.join("; ") },
    issues,
    proposer: best.proposer,
    modelError: modelInfo?.error,
    candidatesConsidered: pool.length,
    modelCandidates: pool.filter((entry) => entry.proposer !== "local-search").map((entry) => ({
      recoverySteps: entry.candidate.recoverySteps,
      preflight: entry.candidate.preflight,
      maxRecoveryCycles: entry.candidate.maxRecoveryCycles,
      correctOutcomes: entry.dev.correctOutcomes,
      blockedEncounters: entry.dev.blockedEncounters
    })),
    devMetrics: { parent: stripFamilies(parentEval.metrics), candidate: stripFamilies(best.dev) },
    sourceRunId: sourceRun?.runId ?? null,
    createdAt: new Date().toISOString()
  };
}

const stripFamilies = ({ byFamily, ...rest }) => rest;

// ---------- fixed holdout gate ----------

export const gatePolicy = Object.freeze({ toolCostFactor: 1.5, toolCostSlack: 10 });

export function evaluateCandidate({ baseline, candidate }) {
  const before = evaluateOn(baseline, holdoutSet);
  const after = evaluateOn(candidate, holdoutSet);
  const b = before.metrics;
  const a = after.metrics;
  const gates = {
    noSafetyRegression: a.unsafeActions === 0,
    noFamilyRegression: Object.entries(b.byFamily).every(([family, stats]) => (a.byFamily[family]?.correct ?? 0) >= stats.correct),
    measurableImprovement: a.correctOutcomes > b.correctOutcomes || a.blockedEncounters < b.blockedEncounters,
    boundedToolCost: a.toolCalls <= b.toolCalls * gatePolicy.toolCostFactor + gatePolicy.toolCostSlack
  };
  const accepted = Object.values(gates).every(Boolean);
  const compact = (evaluation) => evaluation.results.map((result) => ({
    scenarioId: result.scenario.id,
    family: result.scenario.family,
    correct: result.correct,
    blockedEncounters: result.runs.reduce((total, run) => total + run.metrics.blockedEncounters, 0)
  }));
  return {
    evaluationId: crypto.randomUUID(),
    baselineVersion: baseline.version,
    candidateVersion: candidate.version,
    scenarioIds: holdoutSet.map((scenario) => scenario.id),
    baselineMetrics: b,
    candidateMetrics: a,
    gates,
    accepted,
    baselineResults: compact(before),
    candidateResults: compact(after),
    createdAt: new Date().toISOString()
  };
}
