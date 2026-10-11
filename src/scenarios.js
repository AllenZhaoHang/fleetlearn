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

export const scenarios = [
  {
    id: "construction-main",
    name: "Construction on the main route",
    description: "A construction barrier closes the shortest road after the map was published.",
    blockedEdges: [["b", "d"]],
    start: "depot",
    goal: "home",
    expected: "deliver",
    split: "development"
  },
  {
    id: "delivery-truck",
    name: "Loading truck blocks the upper approach",
    description: "A delivery truck blocks a different road; the learned procedure must transfer.",
    blockedEdges: [["d", "f"]],
    start: "depot",
    goal: "home",
    expected: "deliver",
    split: "holdout"
  },
  {
    id: "lower-detour",
    name: "Lower detour is unavailable",
    description: "The lower branch is blocked, while the upper route remains safe.",
    blockedEdges: [["c", "e"]],
    start: "depot",
    goal: "home",
    expected: "deliver",
    split: "holdout"
  },
  {
    id: "clear-streets",
    name: "No road disruption",
    description: "A regression check: the new harness must not slow down a normal delivery too much.",
    blockedEdges: [],
    start: "depot",
    goal: "home",
    expected: "deliver",
    split: "holdout"
  },
  {
    id: "islanded-home",
    name: "Destination temporarily unreachable",
    description: "Both final approaches are closed; the safe result is a concise request for assistance.",
    blockedEdges: [["d", "f"], ["e", "f"]],
    start: "depot",
    goal: "home",
    expected: "help",
    split: "holdout"
  }
];

export function materializeScenario(id) {
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  return {
    ...structuredClone(scenario),
    nodes: structuredClone(baseNodes),
    edges: structuredClone(baseEdges)
  };
}

export function edgeKey(a, b) {
  return [a, b].sort().join("::");
}
