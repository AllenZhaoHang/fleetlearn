// Road worlds. Hand-made demo scenarios share one map; development and holdout
// scenarios are generated from seeds so the evaluator tests transfer to unseen layouts.

const baseNodes = {
  depot: { x: 78, y: 300, label: "Community Kitchen", kind: "depot" },
  a: { x: 185, y: 300, label: "A" },
  b: { x: 300, y: 205, label: "B" },
  c: { x: 300, y: 395, label: "C" },
  d: { x: 445, y: 205, label: "D" },
  e: { x: 445, y: 395, label: "E" },
  f: { x: 585, y: 300, label: "F" },
  home: { x: 710, y: 300, label: "Resident Home", kind: "home" }
};

const baseEdges = [
  ["depot", "a", 1],
  ["a", "b", 1],
  ["a", "c", 1.15],
  ["b", "d", 1],
  ["c", "e", 1],
  ["b", "c", 1.3],
  ["d", "e", 1.3],
  ["d", "f", 1],
  ["e", "f", 1.05],
  ["f", "home", 1]
];

// Scenario families. Each one needs a different capability from the harness.
export const families = {
  clear: "No road disruption (regression check)",
  closure: "One unknown closure on the planned route",
  double_closure: "A second closure appears on the detour",
  unreachable: "Every approach to the destination is closed",
  reported: "Another vehicle already reported the closure",
  convoy: "Two vehicles in sequence; the second can learn from the first",
  temporary: "A delivery truck is unloading on the only approach; it will move"
};

export function edgeKey(a, b) {
  return [a, b].sort().join("::");
}

const demoScenarios = [
  {
    id: "construction-main",
    name: "Construction on the main route",
    description: "A construction barrier closes the shortest road after the map was published.",
    family: "closure",
    blockedEdges: [["b", "d"]],
    expected: "deliver"
  },
  {
    id: "second-closure",
    name: "The detour is closed too",
    description: "After the first closure, the replanned route hits a second barrier.",
    family: "double_closure",
    blockedEdges: [["b", "d"], ["e", "f"]],
    expected: "deliver"
  },
  {
    id: "islanded-home",
    name: "Destination temporarily unreachable",
    description: "Both final approaches are closed; the safe result is a concise request for assistance.",
    family: "unreachable",
    blockedEdges: [["d", "f"], ["e", "f"]],
    expected: "help"
  },
  {
    id: "delivery-truck",
    name: "Loading truck blocks the upper approach",
    description: "A delivery truck blocks a different road; the learned procedure must transfer.",
    family: "closure",
    blockedEdges: [["d", "f"]],
    expected: "deliver"
  },
  {
    id: "truck-at-door",
    name: "Delivery truck unloading at the door",
    description: "A truck blocks the only street into the resident's home. It is temporary: waiting works, rerouting can't.",
    family: "temporary",
    blockedEdges: [["f", "home"]],
    temporaryEdges: ["f::home"],
    expected: "deliver"
  },
  {
    id: "clear-streets",
    name: "No road disruption",
    description: "A regression check: the new harness must not slow down a normal delivery.",
    family: "clear",
    blockedEdges: [],
    expected: "deliver"
  }
].map((s) => ({ temporaryEdges: [], ...s, split: "demo", start: "depot", goal: "home", priorReports: [], vehicles: 1 }));

// ---------- procedural maps ----------

function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function shortestPath(nodes, edges, blocked, from, goal) {
  const distance = new Map([[from, 0]]);
  const previous = new Map();
  const remaining = new Set(Object.keys(nodes));
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
    if (current === null) break;
    remaining.delete(current);
    if (current === goal) break;
    for (const [a, b, weight] of edges) {
      if (blocked.has(edgeKey(a, b))) continue;
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
  const path = [goal];
  while (path[0] !== from) path.unshift(previous.get(path[0]));
  return path;
}

function pathEdges(path) {
  return path.slice(1).map((node, i) => [path[i], node]);
}

function generateMap(random) {
  const cols = 5;
  const rows = 4;
  const nodes = {};
  const id = (c, r) => `n${c}${r}`;
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      nodes[id(c, r)] = {
        x: Math.round(150 + c * 125 + (random() - 0.5) * 50),
        y: Math.round(95 + r * 115 + (random() - 0.5) * 45),
        label: `${String.fromCharCode(65 + c)}${r + 1}`
      };
    }
  }
  const startRow = Math.floor(random() * rows);
  const goalRow = Math.floor(random() * rows);
  nodes.depot = { x: 45, y: nodes[id(0, startRow)].y, label: "Kitchen", kind: "depot" };
  nodes.home = { x: 745, y: nodes[id(cols - 1, goalRow)].y, label: "Home", kind: "home" };

  const dist = (a, b) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) / 100;
  const edges = [["depot", id(0, startRow)], [id(cols - 1, goalRow), "home"]];
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      // Keep every horizontal street; drop some vertical ones so layouts differ.
      if (c + 1 < cols) edges.push([id(c, r), id(c + 1, r)]);
      if (r + 1 < rows && random() > 0.3) edges.push([id(c, r), id(c, r + 1)]);
    }
  }
  return { nodes, edges: edges.map(([a, b]) => [a, b, Number(dist(a, b).toFixed(2))]) };
}

// Blocks edges so the scenario requires its family's capability; returns null if the layout can't support it.
function buildFamily(family, nodes, edges, random) {
  const blocked = new Set();
  const plan = () => shortestPath(nodes, edges, blocked, "depot", "home");
  const blockOnPlan = () => {
    const path = plan();
    if (!path) return null;
    // Never block the first or last connector, so a detour can exist.
    const inner = pathEdges(path).slice(1, -1);
    if (!inner.length) return null;
    const edge = inner[Math.floor(random() * inner.length)];
    blocked.add(edgeKey(...edge));
    return edge;
  };

  const out = { blockedEdges: [], temporaryEdges: [], priorReports: [], vehicles: 1, expected: "deliver" };
  if (family === "clear") return out;
  if (family === "temporary") {
    // A truck on the final connector: there is no detour, only waiting.
    const [a, b] = edges.find(([x, y]) => x === "home" || y === "home");
    out.blockedEdges = [[a, b]];
    out.temporaryEdges = [edgeKey(a, b)];
    return out;
  }
  if (family === "unreachable") {
    // Close every street into the last intersection before the destination.
    const hubEdge = edges.find(([a, b]) => a === "home" || b === "home");
    const hub = hubEdge[0] === "home" ? hubEdge[1] : hubEdge[0];
    out.blockedEdges = edges
      .filter(([a, b]) => (a === hub || b === hub) && a !== "home" && b !== "home")
      .map(([a, b]) => [a, b]);
    out.expected = "help";
    return out;
  }
  const first = blockOnPlan();
  if (!first) return null;
  out.blockedEdges.push(first);
  if (family === "double_closure") {
    const second = blockOnPlan();
    if (!second) return null;
    out.blockedEdges.push(second);
  }
  if (!plan()) return null;
  if (family === "reported") out.priorReports = [edgeKey(...first)];
  if (family === "convoy") out.vehicles = 2;
  return out;
}

export function generateScenario(family, seed, split) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const random = rng(seed * 7919 + attempt * 104729 + family.length);
    const { nodes, edges } = generateMap(random);
    const built = buildFamily(family, nodes, edges, random);
    if (!built) continue;
    return {
      id: `${split}-${family}-${seed}`,
      name: `${families[family]} (city #${seed})`,
      description: families[family],
      family,
      split,
      start: "depot",
      goal: "home",
      nodes,
      edges,
      ...built
    };
  }
  throw new Error(`Could not generate ${family} scenario for seed ${seed}`);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const familyNames = Object.keys(families);

// Development set: what the optimizer may look at. Holdout: only the fixed evaluator sees it.
export const developmentSet = deepFreeze(
  familyNames.flatMap((family) => [1, 2].map((seed) => generateScenario(family, seed, "development")))
);
export const holdoutSet = deepFreeze(
  familyNames.flatMap((family) => [101, 102, 103, 104, 105, 106].map((seed) => generateScenario(family, seed, "holdout")))
);

// Live catalogue shown in the UI: hand-made demos plus a few generated cities.
export const scenarios = [
  ...demoScenarios,
  ...["closure", "reported", "convoy"].map((family) => {
    const { nodes, edges, ...meta } = generateScenario(family, 7, "demo");
    return meta;
  })
];

export function materializeScenario(id) {
  const demo = demoScenarios.find((item) => item.id === id);
  if (demo) return { ...structuredClone(demo), nodes: structuredClone(baseNodes), edges: structuredClone(baseEdges) };
  const match = /^(demo|development|holdout)-([a-z_]+)-(\d+)$/.exec(id);
  if (!match) throw new Error(`Unknown scenario: ${id}`);
  return generateScenario(match[2], Number(match[3]), match[1]);
}
