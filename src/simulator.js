import { edgeKey, materializeScenario } from "./scenarios.js";

export const baselineHarness = {
  version: 1,
  name: "Static-map recovery",
  status: "active",
  parentVersion: null,
  recoverySteps: ["replan", "follow_route"],
  maxRecoveryCycles: 3,
  rationale: "Replan on the original map, then retry the route.",
  createdAt: new Date().toISOString()
};

const allowedSteps = new Set([
  "inspect_local",
  "update_local_map",
  "replan",
  "follow_route",
  "request_help"
]);

export function validateHarness(harness) {
  if (!harness || !Array.isArray(harness.recoverySteps)) return false;
  if (harness.recoverySteps.length < 2 || harness.recoverySteps.length > 7) return false;
  if (!harness.recoverySteps.every((step) => allowedSteps.has(step))) return false;
  return Number.isInteger(harness.maxRecoveryCycles)
    && harness.maxRecoveryCycles >= 1
    && harness.maxRecoveryCycles <= 5;
}

function shortestPath(scenario, knownBlocked, from, goal) {
  const distance = new Map([[from, 0]]);
  const previous = new Map();
  const remaining = new Set(Object.keys(scenario.nodes));

  while (remaining.size) {
    let current = null;
    let best = Infinity;
    for (const node of remaining) {
      const value = distance.get(node) ?? Infinity;
      if (value < best) {
        best = value;
        current = node;
      }
    }
    if (current === null || best === Infinity) break;
    remaining.delete(current);
    if (current === goal) break;

    for (const [a, b, weight] of scenario.edges) {
      if (knownBlocked.has(edgeKey(a, b))) continue;
      const neighbor = a === current ? b : b === current ? a : null;
      if (!neighbor || !remaining.has(neighbor)) continue;
      const candidate = best + weight;
      if (candidate < (distance.get(neighbor) ?? Infinity)) {
        distance.set(neighbor, candidate);
        previous.set(neighbor, current);
      }
    }
  }

  if (!distance.has(goal)) return null;
  const path = [];
  let cursor = goal;
  while (cursor) {
    path.unshift(cursor);
    if (cursor === from) break;
    cursor = previous.get(cursor);
  }
  return path[0] === from ? path : null;
}

export function simulateRun({ scenarioId, harness, runId = crypto.randomUUID() }) {
  if (!validateHarness(harness)) throw new Error("Harness failed schema validation");
  const scenario = materializeScenario(scenarioId);
  const worldBlocked = new Set(scenario.blockedEdges.map(([a, b]) => edgeKey(a, b)));
  const knownBlocked = new Set();
  const events = [];
  const encountered = new Map();
  let current = scenario.start;
  let route = shortestPath(scenario, knownBlocked, current, scenario.goal);
  let observedBlock = null;
  let delivered = false;
  let requestedHelp = false;
  let unsafeActions = 0;

  const record = (type, detail = {}) => {
    events.push({ index: events.length, type, current, ...detail });
  };

  record("run_started", { route, harnessVersion: harness.version });

  const followRoute = () => {
    if (!route) {
      record("route_unavailable");
      return "unavailable";
    }
    for (let index = 1; index < route.length; index += 1) {
      const next = route[index];
      const key = edgeKey(current, next);
      record("edge_attempted", { from: current, to: next, edge: key });
      if (worldBlocked.has(key)) {
        observedBlock = key;
        encountered.set(key, (encountered.get(key) ?? 0) + 1);
        record("road_blocked", {
          from: current,
          to: next,
          edge: key,
          encounter: encountered.get(key)
        });
        return "blocked";
      }
      current = next;
      record("vehicle_moved", { to: current });
      if (current === scenario.goal) {
        delivered = true;
        record("delivery_completed");
        return "delivered";
      }
    }
    return delivered ? "delivered" : "stopped";
  };

  let outcome = followRoute();
  let cycles = 0;
  while (!delivered && !requestedHelp && cycles < harness.maxRecoveryCycles) {
    cycles += 1;
    record("recovery_cycle_started", { cycle: cycles });

    for (const step of harness.recoverySteps) {
      record("tool_called", { tool: step, cycle: cycles });
      if (step === "inspect_local") {
        record("local_observation", { observedBlock });
      } else if (step === "update_local_map") {
        if (observedBlock) {
          knownBlocked.add(observedBlock);
          record("map_updated", { blockedEdge: observedBlock });
        } else {
          record("map_update_skipped", { reason: "No locally observed blockage" });
        }
      } else if (step === "replan") {
        route = shortestPath(scenario, knownBlocked, current, scenario.goal);
        record("route_planned", { route, knownBlocked: [...knownBlocked] });
      } else if (step === "follow_route") {
        outcome = followRoute();
        if (outcome === "delivered") break;
      } else if (step === "request_help" && !route) {
        requestedHelp = true;
        record("assistance_requested", {
          reason: "No verified route remains",
          knownBlocked: [...knownBlocked]
        });
        break;
      }
    }
  }

  if (!delivered && !requestedHelp) {
    record("run_stopped", { reason: "Recovery budget exhausted" });
  }

  const repeatedBlocks = [...encountered.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  const expectedSatisfied = scenario.expected === "deliver" ? delivered : requestedHelp;
  const status = delivered ? "delivered" : requestedHelp ? "help_requested" : "failed";

  return {
    runId,
    scenarioId,
    scenarioName: scenario.name,
    scenario,
    harnessVersion: harness.version,
    harnessName: harness.name,
    status,
    expectedSatisfied,
    events,
    metrics: {
      delivered,
      requestedHelp,
      repeatedBlocks,
      unsafeActions,
      toolCalls: events.filter((event) => event.type === "tool_called").length,
      movementSteps: events.filter((event) => event.type === "vehicle_moved").length,
      totalEvents: events.length
    },
    createdAt: new Date().toISOString()
  };
}
