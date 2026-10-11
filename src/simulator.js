import { edgeKey, materializeScenario, shortestPath } from "./scenarios.js";

export const baselineHarness = {
  version: 1,
  name: "Static-map recovery",
  status: "active",
  parentVersion: null,
  preflight: [],
  recoverySteps: ["replan", "follow_route"],
  maxRecoveryCycles: 3,
  rationale: "Replan on the original map, then retry the route.",
  createdAt: new Date().toISOString()
};

// The tool surface the harness may compose. The optimizer can reorder, add, or drop
// these, but cannot add new tools or change what they do.
export const toolCatalog = {
  query_fleet_memory: "Load road closures other vehicles reported for this area into the task map.",
  inspect_local: "Look closely at the obstacle (closure or temporary vehicle) and scan nearby roads within the perception radius.",
  update_local_map: "Mark the closure this vehicle just observed as blocked in its task map.",
  report_road_event: "Publish the closure this vehicle observed to fleet memory (MongoDB Atlas) for later vehicles.",
  replan: "Compute a new shortest route from the current position using the task map.",
  follow_route: "Drive the current route until delivery or the next blocked road.",
  request_help: "If no route remains in the task map, stop and request human assistance."
};

const preflightTools = new Set(["query_fleet_memory"]);

// Conditional rules: "when <condition>, do <action> and end this recovery cycle".
// They are checked after every recovery tool call.
export const ruleCatalog = {
  conditions: {
    temporary_obstacle: "inspect_local found that the obstacle is a temporary vehicle, not a closure",
    repeated_block: "the vehicle has hit the same blocked road at least twice"
  },
  actions: {
    wait_and_retry: "wait for the obstacle to clear, then continue the current route",
    request_help: "stop and request human assistance"
  }
};

// Context policy: what the vehicle perceives. A wider radius sees more closures per inspection
// but costs one extra sensor sweep (tool call) per hop.
export const contextOptions = { perceptionRadius: [0, 1, 2] };

// Fixed guardrails. These are not part of the harness and cannot be evolved.
export const guardrails = Object.freeze({
  maxToolCallsPerRun: 24,
  maxRecoveryCycles: 5,
  maxRecoverySteps: 8,
  maxRules: 3
});

export function normalizeHarness(harness) {
  return {
    preflight: [],
    rules: [],
    ...harness,
    context: { perceptionRadius: 0, ...(harness.context ?? {}) }
  };
}

export function validateHarness(input) {
  if (!input || !Array.isArray(input.recoverySteps)) return false;
  const harness = normalizeHarness(input);
  if (!Array.isArray(harness.preflight) || harness.preflight.length > 2) return false;
  if (!harness.preflight.every((step) => preflightTools.has(step))) return false;
  if (harness.recoverySteps.length < 1 || harness.recoverySteps.length > guardrails.maxRecoverySteps) return false;
  if (!harness.recoverySteps.every((step) => step in toolCatalog)) return false;
  if (!Array.isArray(harness.rules) || harness.rules.length > guardrails.maxRules) return false;
  if (!harness.rules.every((rule) => rule?.when in ruleCatalog.conditions && rule?.then in ruleCatalog.actions)) return false;
  if (!contextOptions.perceptionRadius.includes(harness.context.perceptionRadius)) return false;
  return Number.isInteger(harness.maxRecoveryCycles)
    && harness.maxRecoveryCycles >= 1
    && harness.maxRecoveryCycles <= guardrails.maxRecoveryCycles;
}

export function simulateRun({ scenarioId, scenario: given, harness: input, fleetMemory = [], vehicle = 1, runId = crypto.randomUUID() }) {
  if (!validateHarness(input)) throw new Error("Harness failed schema validation");
  const harness = normalizeHarness(input);
  const scenario = given ? structuredClone(given) : materializeScenario(scenarioId);
  const worldBlocked = new Set(scenario.blockedEdges.map(([a, b]) => edgeKey(a, b)));
  const temporary = new Set(scenario.temporaryEdges ?? []);
  const knownBlocked = new Set();
  const events = [];
  const encountered = new Map();
  const reportedEvents = [];
  let current = scenario.start;
  let route = null;
  let observedBlock = null;
  let observedKind = null;
  const observedNearby = new Set();
  let delivered = false;
  let requestedHelp = false;
  let budgetExceeded = false;
  let distance = 0;
  let toolCalls = 0;
  const unsafeActions = 0; // the simulator physically refuses to enter a blocked road

  const record = (type, detail = {}) => {
    events.push({ index: events.length, type, current, ...detail });
  };
  const plan = () => shortestPath(scenario.nodes, scenario.edges, knownBlocked, current, scenario.goal);
  const weightOf = (a, b) => scenario.edges.find(([x, y]) => edgeKey(x, y) === edgeKey(a, b))?.[2] ?? 1;

  const followRoute = () => {
    if (!route) {
      record("route_unavailable");
      return "unavailable";
    }
    const start = route.indexOf(current);
    if (start === -1) {
      record("route_unavailable", { reason: "Route does not start at the vehicle position" });
      return "unavailable";
    }
    for (let index = start + 1; index < route.length; index += 1) {
      const next = route[index];
      const key = edgeKey(current, next);
      record("edge_attempted", { from: current, to: next, edge: key });
      if (worldBlocked.has(key)) {
        observedBlock = key;
        observedKind = null;
        encountered.set(key, (encountered.get(key) ?? 0) + 1);
        record("road_blocked", { from: current, to: next, edge: key, encounter: encountered.get(key) });
        return "blocked";
      }
      distance += weightOf(current, next);
      current = next;
      record("vehicle_moved", { to: current });
      if (current === scenario.goal) {
        delivered = true;
        record("delivery_completed");
        return "delivered";
      }
    }
    return "stopped";
  };

  const callTool = (step, cycle) => {
    toolCalls += 1;
    if (toolCalls > guardrails.maxToolCallsPerRun) {
      budgetExceeded = true;
      return "halt";
    }
    record("tool_called", { tool: step, cycle });
    if (step === "query_fleet_memory") {
      const fresh = fleetMemory.filter((edge) => !knownBlocked.has(edge));
      fresh.forEach((edge) => knownBlocked.add(edge));
      record("fleet_memory_loaded", { edges: fresh, total: fleetMemory.length });
    } else if (step === "inspect_local") {
      const radius = harness.context.perceptionRadius;
      toolCalls += radius; // one sensor sweep per extra hop
      if (observedBlock) observedKind = temporary.has(observedBlock) ? "temporary" : "closure";
      const seen = scanNearby(radius).filter((edge) => !temporary.has(edge) && edge !== observedBlock);
      seen.forEach((edge) => observedNearby.add(edge));
      record("local_observation", { observedBlock, kind: observedKind, nearby: seen, radius });
    } else if (step === "update_local_map") {
      const closures = closuresToShare();
      if (closures.length) {
        closures.forEach((edge) => knownBlocked.add(edge));
        record("map_updated", { blockedEdge: closures[0], edges: closures });
      } else {
        record("map_update_skipped", { reason: "No locally observed blockage" });
      }
    } else if (step === "report_road_event") {
      for (const edge of closuresToShare()) {
        if (reportedEvents.includes(edge)) continue;
        reportedEvents.push(edge);
        record("road_event_reported", { edge });
      }
    } else if (step === "replan") {
      route = plan();
      record("route_planned", { route, knownBlocked: [...knownBlocked] });
    } else if (step === "follow_route") {
      if (followRoute() === "delivered") return "done";
    } else if (step === "request_help" && !route) {
      requestedHelp = true;
      record("assistance_requested", { reason: "No verified route remains", knownBlocked: [...knownBlocked] });
      return "done";
    }
    return "continue";
  };

  // Edges within `radius` hops of the vehicle that are actually blocked.
  function scanNearby(radius) {
    if (radius <= 0) return [];
    const found = new Set();
    let frontier = new Set([current]);
    const visited = new Set([current]);
    for (let hop = 0; hop < radius; hop += 1) {
      const next = new Set();
      for (const [a, b] of scenario.edges) {
        const key = edgeKey(a, b);
        if (!frontier.has(a) && !frontier.has(b)) continue;
        if (worldBlocked.has(key)) found.add(key);
        for (const node of [a, b]) if (!visited.has(node)) { visited.add(node); next.add(node); }
      }
      frontier = next;
    }
    return [...found];
  }

  // Closures the vehicle has evidence for. A known-temporary obstacle is never treated as a closure.
  function closuresToShare() {
    const edges = [...observedNearby];
    if (observedBlock && observedKind !== "temporary" && !edges.includes(observedBlock)) edges.unshift(observedBlock);
    return edges.filter((edge) => worldBlocked.has(edge));
  }

  const ruleConditions = {
    temporary_obstacle: () => observedKind === "temporary" && worldBlocked.has(observedBlock),
    repeated_block: () => [...encountered.values()].some((count) => count >= 2)
  };

  const fireRules = (cycle) => {
    for (const rule of harness.rules) {
      if (!ruleConditions[rule.when]()) continue;
      record("rule_fired", { when: rule.when, then: rule.then, cycle });
      toolCalls += 1;
      if (rule.then === "wait_and_retry") {
        if (temporary.has(observedBlock)) {
          worldBlocked.delete(observedBlock);
          record("obstacle_cleared", { edge: observedBlock });
        }
        return followRoute() === "delivered" ? "done" : "end_cycle";
      }
      if (rule.then === "request_help") {
        requestedHelp = true;
        record("assistance_requested", { reason: `Rule: ${rule.when}`, knownBlocked: [...knownBlocked] });
        return "done";
      }
    }
    return "continue";
  };

  record("run_started", { harnessVersion: harness.version, vehicle, fleetMemorySize: fleetMemory.length });
  for (const step of harness.preflight) callTool(step, 0);
  route = plan();
  record("route_planned", { route, knownBlocked: [...knownBlocked] });
  followRoute();

  let cycles = 0;
  while (!delivered && !requestedHelp && !budgetExceeded && cycles < harness.maxRecoveryCycles) {
    cycles += 1;
    record("recovery_cycle_started", { cycle: cycles });
    for (const step of harness.recoverySteps) {
      let result = callTool(step, cycles);
      if (result === "continue") result = fireRules(cycles);
      if (result !== "continue") break;
    }
  }

  if (budgetExceeded) record("run_stopped", { reason: "Fixed tool-call budget exceeded" });
  else if (!delivered && !requestedHelp) record("run_stopped", { reason: "Recovery budget exhausted" });

  const blockedEncounters = [...encountered.values()].reduce((total, count) => total + count, 0);
  const repeatedBlocks = [...encountered.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const knownInMemory = [...encountered.keys()].filter((edge) => fleetMemory.includes(edge)).length;
  const expectedSatisfied = scenario.expected === "deliver" ? delivered : requestedHelp;
  const status = delivered ? "delivered" : requestedHelp ? "help_requested" : "failed";

  return {
    runId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    family: scenario.family,
    scenario,
    vehicle,
    harnessVersion: harness.version,
    harnessName: harness.name,
    status,
    expectedSatisfied,
    events,
    reportedEvents,
    metrics: {
      delivered,
      requestedHelp,
      blockedEncounters,
      repeatedBlocks,
      knownClosuresRediscovered: knownInMemory,
      unsafeActions,
      budgetExceeded,
      toolCalls: Math.min(toolCalls, guardrails.maxToolCallsPerRun),
      distance: Number(distance.toFixed(2)),
      movementSteps: events.filter((event) => event.type === "vehicle_moved").length,
      totalEvents: events.length
    },
    createdAt: new Date().toISOString()
  };
}

// Runs every vehicle in a scenario. Vehicles share fleet memory in order, so the
// second vehicle in a convoy only benefits if the first one reported what it saw.
export function runScenario(scenario, harness) {
  let memory = [...(scenario.priorReports ?? [])];
  const runs = [];
  for (let vehicle = 1; vehicle <= (scenario.vehicles ?? 1); vehicle += 1) {
    const run = simulateRun({ scenario, harness, fleetMemory: memory, vehicle });
    memory = [...new Set([...memory, ...run.reportedEvents])];
    runs.push(run);
  }
  return runs;
}
