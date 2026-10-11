import { developmentSet, holdoutSet } from "./scenarios.js";
import { contextOptions, guardrails, normalizeHarness, ruleCatalog, runScenario, toolCatalog, validateHarness } from "./simulator.js";

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
  CLOSURES_FOUND_ONE_AT_A_TIME: {
    summary: "The vehicle discovered closures one by one by driving into them.",
    hint: "Perceive more of the surroundings per inspection so nearby closures are known before replanning."
  },
  TEMPORARY_OBSTACLE_MISHANDLED: {
    summary: "A temporary obstacle was treated as a permanent closure.",
    hint: "Inspect obstacles before treating them as closures, and wait when they are temporary."
  },
  FLEET_KNOWLEDGE_NOT_SHARED: {
    summary: "A later vehicle hit the same closure as an earlier one, because nothing was reported.",
    hint: "Publish observed closures so later vehicles can avoid them."
  }
};

export function diagnoseRun(run, previousRunsInScenario = []) {
  const has = (type) => run.events.some((event) => event.type === type);
  const issues = [];
  const road = (key) => key.split("::").map((id) => run.scenario.nodes?.[id]?.label ?? id).join("–");
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
  const distinctBlocks = new Set(run.events.filter((e) => e.type === "road_blocked").map((e) => e.edge));
  if (run.expectedSatisfied && distinctBlocks.size >= 2) {
    add("CLOSURES_FOUND_ONE_AT_A_TIME", `${distinctBlocks.size} different closures were each found by hitting them.`);
  }
  const temporaryHit = run.events.find((e) => e.type === "road_blocked" && (run.scenario.temporaryEdges ?? []).includes(e.edge));
  if (temporaryHit && !run.expectedSatisfied) {
    add("TEMPORARY_OBSTACLE_MISHANDLED", `The obstacle on ${road(temporaryHit.edge)} was a truck that would have moved; the vehicle ${run.metrics.requestedHelp ? "asked for help" : "gave up"} instead of waiting.`);
  }
  if (run.metrics.knownClosuresRediscovered > 0) {
    add("KNOWN_CLOSURE_REDISCOVERED", `${run.metrics.knownClosuresRediscovered} closure(s) were already in fleet memory.`);
  }
  const earlier = previousRunsInScenario.flatMap((prior) => prior.events.filter((e) => e.type === "road_blocked").map((e) => e.edge));
  const repeatedAcrossFleet = run.events.filter((e) => e.type === "road_blocked" && earlier.includes(e.edge));
  if (repeatedAcrossFleet.length && previousRunsInScenario.every((prior) => !prior.reportedEvents.length)) {
    add("FLEET_KNOWLEDGE_NOT_SHARED", `Vehicle ${run.vehicle} hit ${road(repeatedAcrossFleet[0].edge)}, which vehicle ${run.vehicle - 1} had already seen.`);
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
    const blocked = runs.reduce((total, run) => total + run.metrics.blockedEncounters, 0);
    return { scenario, runs, issues, blocked, correct: runs.every((run) => run.expectedSatisfied) };
  });
  const runs = results.flatMap((result) => result.runs);
  const sum = (key) => runs.reduce((total, run) => total + Number(run.metrics[key]), 0);
  const byFamily = {};
  for (const result of results) {
    const family = (byFamily[result.scenario.family] ??= { scenarios: 0, correct: 0, blocked: 0 });
    family.scenarios += 1;
    family.correct += result.correct ? 1 : 0;
    family.blocked += result.blocked;
  }
  const metrics = {
    scenarios: results.length,
    correctOutcomes: results.filter((result) => result.correct).length,
    successRate: results.length ? results.filter((result) => result.correct).length / results.length : 0,
    blockedEncounters: sum("blockedEncounters"),
    // Only count encounters on scenarios that ended correctly, so giving up early can't look like progress.
    blockedOnSuccess: results.filter((result) => result.correct).reduce((total, result) => total + result.blocked, 0),
    repeatedBlocks: sum("repeatedBlocks"),
    unsafeActions: sum("unsafeActions"),
    toolCalls: sum("toolCalls"),
    distance: Number(sum("distance").toFixed(2)),
    byFamily
  };
  return { metrics, results, issues: summarizeIssues(results.flatMap((result) => result.issues)) };
}

// Lexicographic: correct outcomes, then fewer blocked roads on successful deliveries, then fewer tool calls.
export function compareMetrics(a, b) {
  if (a.correctOutcomes !== b.correctOutcomes) return a.correctOutcomes - b.correctOutcomes;
  if (a.blockedOnSuccess !== b.blockedOnSuccess) return b.blockedOnSuccess - a.blockedOnSuccess;
  return b.toolCalls - a.toolCalls;
}

// ---------- proposal: model suggestions + local search over the tool surface ----------

const signature = (input) => {
  const h = normalizeHarness(input);
  return JSON.stringify([h.preflight, h.recoverySteps, h.maxRecoveryCycles, h.rules.map((r) => `${r.when}>${r.then}`), h.context.perceptionRadius]);
};

const shapeOf = (h) => ({
  preflight: h.preflight,
  recoverySteps: h.recoverySteps,
  maxRecoveryCycles: h.maxRecoveryCycles,
  rules: h.rules,
  context: h.context
});

// Every single edit of the harness: tools, order, cycles, preflight, conditional rules, perception radius.
function neighbors(parent) {
  const h = normalizeHarness(parent);
  const base = shapeOf(h);
  const out = [];
  const push = (overrides) => out.push({ ...base, ...overrides });
  const steps = h.recoverySteps;
  for (const tool of Object.keys(toolCatalog)) {
    for (let i = 0; i <= steps.length; i += 1) push({ recoverySteps: [...steps.slice(0, i), tool, ...steps.slice(i)] });
  }
  steps.forEach((_, i) => push({ recoverySteps: steps.filter((__, j) => j !== i) }));
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const swapped = [...steps];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    push({ recoverySteps: swapped });
  }
  push({ maxRecoveryCycles: h.maxRecoveryCycles + 1 });
  push({ maxRecoveryCycles: h.maxRecoveryCycles - 1 });
  push({ preflight: h.preflight.includes("query_fleet_memory") ? [] : ["query_fleet_memory"] });
  for (const when of Object.keys(ruleCatalog.conditions)) {
    for (const then of Object.keys(ruleCatalog.actions)) {
      if (!h.rules.some((r) => r.when === when && r.then === then)) push({ rules: [...h.rules, { when, then }] });
    }
  }
  h.rules.forEach((_, i) => push({ rules: h.rules.filter((__, j) => j !== i) }));
  for (const radius of contextOptions.perceptionRadius) {
    if (Math.abs(radius - h.context.perceptionRadius) === 1) push({ context: { ...h.context, perceptionRadius: radius } });
  }
  return out;
}

const ruleText = (r) => `if ${r.when} → ${r.then}`;

export function describeChange(parent, childInput) {
  const p = normalizeHarness(parent);
  const child = normalizeHarness(childInput);
  const changes = [];
  const added = child.recoverySteps.filter((step) => !p.recoverySteps.includes(step));
  const removed = p.recoverySteps.filter((step) => !child.recoverySteps.includes(step));
  if (added.length) changes.push(`add ${added.join(", ")}`);
  if (removed.length) changes.push(`remove ${removed.join(", ")}`);
  if (!added.length && !removed.length && JSON.stringify(p.recoverySteps) !== JSON.stringify(child.recoverySteps)) changes.push("reorder recovery steps");
  if (child.preflight.length > p.preflight.length) changes.push("query fleet memory before departure");
  if (child.preflight.length < p.preflight.length) changes.push("stop reading fleet memory before departure");
  if (child.maxRecoveryCycles !== p.maxRecoveryCycles) changes.push(`recovery cycles ${p.maxRecoveryCycles} → ${child.maxRecoveryCycles}`);
  const pr = p.rules.map(ruleText);
  const cr = child.rules.map(ruleText);
  cr.filter((r) => !pr.includes(r)).forEach((r) => changes.push(`add rule: ${r}`));
  pr.filter((r) => !cr.includes(r)).forEach((r) => changes.push(`remove rule: ${r}`));
  if (child.context.perceptionRadius !== p.context.perceptionRadius) changes.push(`perception radius ${p.context.perceptionRadius} → ${child.context.perceptionRadius}`);
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
    const candidate = shapeOf(normalizeHarness({ ...shape, preflight: shape.preflight ?? [] }));
    if (!validateHarness(candidate) || seen.has(signature(candidate))) return;
    seen.add(signature(candidate));
    pool.push({ candidate, proposer, rationale, dev: evaluateOn(candidate, developmentSet).metrics });
  };

  let modelInfo = null;
  if (modelProposer) {
    try {
      modelInfo = await modelProposer({ harness: parent, issues, sourceRun, toolCatalog, ruleCatalog, contextOptions, guardrails, rejected });
      for (const item of modelInfo?.candidates ?? []) consider(item, modelInfo.model, item.rationale);
    } catch (error) {
      modelInfo = { error: error.message };
    }
  }
  const singles = neighbors(parent);
  for (const shape of singles) consider(shape, "local-search", null);
  const improves = (entry) => compareMetrics(entry.dev, parentEval.metrics) > 0;

  // When no single edit helps, widen the search to pairs of edits.
  let searchDepth = 1;
  if (!pool.some(improves)) {
    searchDepth = 2;
    for (const first of singles) {
      if (!validateHarness(first)) continue;
      for (const shape of neighbors({ ...first, version: parent.version })) consider(shape, "local-search (2 edits)", null);
    }
  }

  const improving = pool.filter(improves);
  if (!improving.length) throw new Error("No candidate improved on the development set.");
  improving.sort((a, b) => compareMetrics(b.dev, a.dev)
    || a.proposer.startsWith("local-search") - b.proposer.startsWith("local-search")
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
    rules: best.candidate.rules,
    context: best.candidate.context,
    changes,
    rationale: best.rationale ?? `${primary.hint} Change: ${changes.join("; ")}.`,
    diagnosis: { code: primary.code, summary: primary.summary, evidence: primary.evidence, proposedChange: changes.join("; ") },
    issues,
    proposer: best.proposer,
    modelError: modelInfo?.error,
    candidatesConsidered: pool.length,
    searchDepth,
    modelCandidates: pool.filter((entry) => !entry.proposer.startsWith("local-search")).map((entry) => ({
      ...entry.candidate,
      correctOutcomes: entry.dev.correctOutcomes,
      blockedEncounters: entry.dev.blockedEncounters
    })),
    devMetrics: { parent: stripFamilies(parentEval.metrics), candidate: stripFamilies(best.dev) },
    sourceRunId: sourceRun?.runId ?? null,
    createdAt: new Date().toISOString()
  };
}

const stripFamilies = ({ byFamily, ...rest }) => rest;

// Adversarial probe of the gate: the kind of edit a naive self-improver makes when it optimizes
// for cost and only checks the run it just saw. It picks the cheapest single edit that still
// handles that run, and goes to the same fixed holdout gate as any other candidate.
export function proposeShortcut({ sourceHarness, sourceRun, version, rejected = [] }) {
  const parent = normalizeHarness(sourceHarness);
  const parentDev = evaluateOn(parent, developmentSet).metrics;
  const skip = new Set([signature(parent), ...rejected.map((h) => signature(normalizeHarness(h)))]);
  const stillHandlesSource = (candidate) => !sourceRun?.expectedSatisfied || simulateRunLike(sourceRun, candidate).expectedSatisfied;

  const options = neighbors(parent)
    .filter((shape) => validateHarness(shape) && !skip.has(signature(shape)))
    .filter((shape) => sizeOf(shape) < sizeOf(parent)
      || shape.maxRecoveryCycles < parent.maxRecoveryCycles
      || shape.context.perceptionRadius < parent.context.perceptionRadius)
    .filter(stillHandlesSource)
    .map((shape) => ({
      shape,
      sourceCost: sourceRun ? simulateRunLike(sourceRun, shape).metrics.toolCalls : 0,
      size: sizeOf(shape),
      dev: evaluateOn(shape, developmentSet).metrics
    }))
    .sort((a, b) => a.sourceCost - b.sourceCost || a.size - b.size);
  if (!options.length) throw new Error("No cheaper shortcut exists for this harness.");
  const { shape, dev } = options[0];
  const changes = describeChange(parent, shape);
  const saved = Math.max(0, parentDev.toolCalls - dev.toolCalls);
  return {
    version,
    name: `Shortcut: ${changes.join("; ")}`,
    status: "candidate",
    parentVersion: parent.version,
    preflight: shape.preflight,
    recoverySteps: shape.recoverySteps,
    maxRecoveryCycles: shape.maxRecoveryCycles,
    rules: shape.rules,
    context: shape.context,
    changes,
    rationale: `A shorter procedure${sourceRun?.expectedSatisfied ? " that still handles the run you just watched" : ""}. Only that one run was checked; the other disruption types were not.`,
    diagnosis: {
      code: "COST_PRESSURE",
      summary: "A cheaper procedure that looks fine on the last run.",
      evidence: `Removes work the last run did not need (${changes.join("; ")}).`,
      proposedChange: changes.join("; ")
    },
    issues: [],
    proposer: "cost-cutting shortcut (gate probe)",
    candidatesConsidered: options.length,
    modelCandidates: [],
    devMetrics: { parent: stripFamilies(parentDev), candidate: stripFamilies(dev) },
    sourceRunId: sourceRun?.runId ?? null,
    createdAt: new Date().toISOString()
  };
}

const sizeOf = (h) => h.recoverySteps.length + h.preflight.length + h.rules.length;

function simulateRunLike(run, harness) {
  return runScenario({ ...run.scenario, vehicles: 1 }, harness)[0];
}

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
    measurableImprovement: a.correctOutcomes > b.correctOutcomes
      || (a.correctOutcomes === b.correctOutcomes && a.blockedOnSuccess < b.blockedOnSuccess),
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
    familyDiff: Object.fromEntries(Object.entries(b.byFamily).map(([family, stats]) => [family, {
      scenarios: stats.scenarios,
      correctBefore: stats.correct,
      correctAfter: a.byFamily[family]?.correct ?? 0,
      blockedBefore: stats.blocked,
      blockedAfter: a.byFamily[family]?.blocked ?? 0
    }])),
    baselineResults: compact(before),
    candidateResults: compact(after),
    createdAt: new Date().toISOString()
  };
}
