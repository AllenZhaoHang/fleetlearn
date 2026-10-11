const state = {
  overview: null,
  scenarioId: "construction-main",
  mapData: null,
  run: null,
  candidate: null,
  evaluation: null,
  busy: false
};

const elements = Object.fromEntries([
  "storage-pill", "memory-pill", "harness-pill", "scenario-select", "scenario-title", "road-map",
  "map-caption", "run-button", "evolve-button", "shortcut-button", "evaluate-button", "activate-button", "auto-button",
  "reset-button", "search-only", "harness-name", "policy-state", "procedure-list", "trace-log", "trace-count",
  "learning-title", "diagnosis-copy", "proposer-copy", "before-policy", "after-policy", "success-metric",
  "success-detail", "repeat-metric", "repeat-detail", "safety-metric", "safety-detail",
  "gate-result", "lineage-list", "holdout-copy", "toast"
].map((id) => [id, document.getElementById(id)]));

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

const activeHarness = () => state.overview?.activeHarness;
const scenario = () => state.overview.scenarios.find((item) => item.id === state.scenarioId);
const edgeKey = (a, b) => [a, b].sort().join("::");
const label = (id) => state.mapData?.nodes?.[id]?.label ?? id;
const edgeLabel = (key) => key.split("::").map(label).join("–");

function svgElement(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function fleetMemoryFor(scenarioId) {
  return (state.overview?.roadEvents ?? []).filter((item) => item.worldId === scenarioId).map((item) => item.edge);
}

function renderMap(data) {
  if (!data?.nodes || !data?.edges) return;
  state.mapData = data;
  const svg = elements["road-map"];
  svg.replaceChildren();
  const blocked = new Set(data.blockedEdges.map(([a, b]) => edgeKey(a, b)));
  const remembered = new Set([...(data.priorReports ?? []), ...fleetMemoryFor(data.id)]);

  for (const [a, b] of data.edges) {
    const from = data.nodes[a];
    const to = data.nodes[b];
    const key = edgeKey(a, b);
    const road = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `road${blocked.has(key) ? " blocked" : ""}`, "data-edge": key });
    const center = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `road-center${blocked.has(key) ? " blocked" : ""}${remembered.has(key) ? " memory" : ""}`, "data-edge-center": key });
    svg.append(road, center);
    if (blocked.has(key)) {
      const x = (from.x + to.x) / 2;
      const y = (from.y + to.y) / 2;
      const barrier = svgElement("g", { class: "barrier", "data-barrier": key, transform: `translate(${x} ${y}) rotate(-18)` });
      barrier.append(
        svgElement("line", { x1: -14, y1: -9, x2: 14, y2: 9 }),
        svgElement("line", { x1: -14, y1: 9, x2: 14, y2: -9 })
      );
      svg.append(barrier);
    }
  }

  for (const node of Object.values(data.nodes)) {
    const dot = svgElement("circle", { cx: node.x, cy: node.y, r: node.kind ? 12 : 7, class: node.kind ? "node-dot endpoint" : "node-dot" });
    const text = svgElement("text", { x: node.x, y: node.y + (node.kind ? 31 : 25), class: node.kind ? "endpoint-label" : "node-label" });
    text.textContent = node.label;
    svg.append(dot, text);
  }

  const start = data.nodes[data.start];
  const vehicle = svgElement("g", { id: "vehicle", class: "vehicle", transform: `translate(${start.x} ${start.y})` });
  vehicle.append(
    svgElement("rect", { x: -15, y: -11, width: 30, height: 22, rx: 8, class: "vehicle-body" }),
    svgElement("circle", { cx: 7, cy: 0, r: 3, class: "vehicle-light" })
  );
  svg.append(vehicle);
}

function procedureLines(harness) {
  return [
    ...(harness.preflight ?? []).map((step) => ({ step, preflight: true })),
    ...harness.recoverySteps.map((step) => ({ step, preflight: false })),
    ...(harness.rules ?? []).map((rule) => ({ step: `if ${rule.when} → ${rule.then}`, rule: true })),
    ...((harness.context?.perceptionRadius ?? 0) > 0 ? [{ step: `perception radius ${harness.context.perceptionRadius}`, context: true }] : [])
  ];
}

function renderProcedure(harness = activeHarness()) {
  if (!harness) return;
  elements["harness-name"].textContent = harness.name;
  elements["harness-pill"].textContent = `Harness v${harness.version}`;
  elements["policy-state"].textContent = harness.status === "active" ? "Active" : "Candidate";
  elements["procedure-list"].replaceChildren(...procedureLines(harness).map(({ step, preflight, rule, context }) => {
    const item = document.createElement("li");
    item.className = `procedure-item${preflight ? " preflight" : ""}${rule ? " rule" : ""}${context ? " context" : ""}`;
    item.dataset.step = rule ? `rule:${step}` : step;
    item.textContent = preflight ? `${step} (before departure)` : step;
    item.title = state.overview?.toolCatalog?.[step] ?? "";
    return item;
  }));
}

function renderPolicy(container, harness, compareTo = null) {
  container.classList.remove("muted");
  const previous = compareTo ? new Set(procedureLines(compareTo).map((line) => `${line.preflight}:${line.step}`)) : null;
  const lines = procedureLines(harness);
  container.replaceChildren(...lines.map((line, index) => {
    const span = document.createElement("span");
    span.textContent = line.preflight ? `pre. ${line.step}` : line.rule || line.context ? `   ${line.step}` : `${index + 1 - (harness.preflight?.length ?? 0)}. ${line.step}`;
    if (line.preflight) span.classList.add("preflight");
    if (previous && !previous.has(`${line.preflight}:${line.step}`)) span.classList.add("added");
    return span;
  }), Object.assign(document.createElement("span"), { textContent: `× up to ${harness.maxRecoveryCycles} cycles` }));
}

function renderLineage() {
  const { harnesses = [], evaluations = [] } = state.overview ?? {};
  const byCandidate = new Map(evaluations.map((evaluation) => [evaluation.candidateVersion, evaluation]));
  elements["lineage-list"].replaceChildren(...[...harnesses].reverse().map((harness) => {
    const item = document.createElement("li");
    item.className = `lineage-item ${harness.status}`;
    const evaluation = byCandidate.get(harness.version);
    const rules = (harness.rules ?? []).map((rule) => `if ${rule.when} → ${rule.then}`).join("; ");
    const radius = harness.context?.perceptionRadius ? ` · radius ${harness.context.perceptionRadius}` : "";
    const steps = `${(harness.preflight ?? []).length ? `[${harness.preflight.join(", ")}] ` : ""}${harness.recoverySteps.join(" → ")}${rules ? ` · ${rules}` : ""}${radius}`;
    const why = harness.diagnosis ? `${harness.diagnosis.code}: ${harness.diagnosis.evidence}` : harness.rationale;
    const result = evaluation
      ? ` Holdout: ${evaluation.baselineMetrics.correctOutcomes} → ${evaluation.candidateMetrics.correctOutcomes}/${evaluation.candidateMetrics.scenarios} correct, blocked roads ${evaluation.baselineMetrics.blockedEncounters} → ${evaluation.candidateMetrics.blockedEncounters}.`
      : "";
    item.innerHTML = `<span class="lineage-version"></span><div class="lineage-body"><strong></strong><small class="why"></small><small><code></code></small></div><span class="lineage-status"></span>`;
    item.querySelector(".lineage-version").textContent = `v${harness.version}`;
    item.querySelector("strong").textContent = harness.name;
    item.querySelector(".why").textContent = `${why}${harness.proposer ? ` · proposed by ${harness.proposer}` : ""}${result}`;
    item.querySelector("code").textContent = steps;
    item.querySelector(".lineage-status").textContent = harness.status;
    return item;
  }));
  const count = state.overview?.roadEvents?.length ?? 0;
  elements["memory-pill"].textContent = `Fleet memory: ${count} closure${count === 1 ? "" : "s"}`;
}

function setButtons() {
  const locked = state.busy;
  elements["run-button"].disabled = locked;
  elements["auto-button"].disabled = locked;
  elements["search-only"].disabled = locked;
  elements["reset-button"].disabled = locked;
  elements["evolve-button"].disabled = locked || !state.run;
  elements["shortcut-button"].disabled = locked || !state.run;
  elements["evaluate-button"].disabled = locked || !state.candidate || state.candidate.status !== "candidate";
  elements["activate-button"].disabled = locked || !state.evaluation?.accepted || state.candidate?.status === "active";
}

function setBusy(value) {
  state.busy = value;
  setButtons();
}

function traceMessage(event) {
  const messages = {
    run_started: () => `Vehicle ${event.vehicle} departs with harness v${event.harnessVersion} (fleet memory: ${event.fleetMemorySize} closures)`,
    edge_attempted: () => `Approaching ${label(event.from)} → ${label(event.to)}`,
    vehicle_moved: () => `Vehicle reached ${label(event.to)}`,
    road_blocked: () => `Road ${edgeLabel(event.edge)} is blocked (encounter ${event.encounter})`,
    recovery_cycle_started: () => `Recovery cycle ${event.cycle} started`,
    tool_called: () => `Called ${event.tool}`,
    fleet_memory_loaded: () => event.edges?.length ? `Fleet memory: avoiding ${event.edges.map(edgeLabel).join(", ")}` : "Fleet memory: no reported closures here",
    local_observation: () => [
      event.observedBlock ? `Inspected ${edgeLabel(event.observedBlock)}: ${event.kind === "temporary" ? "a truck that will move" : "a closure"}` : "Nothing directly ahead",
      event.nearby?.length ? `; also sees ${event.nearby.map(edgeLabel).join(", ")} (radius ${event.radius})` : ""
    ].join(""),
    rule_fired: () => `Rule fired: if ${event.when} → ${event.then}`,
    obstacle_cleared: () => `Waited; ${edgeLabel(event.edge)} is clear again`,
    map_updated: () => `Task map now excludes ${(event.edges ?? [event.blockedEdge]).map(edgeLabel).join(", ")}`,
    map_update_skipped: () => "No observed closure to add to the map",
    road_event_reported: () => `Reported ${edgeLabel(event.edge)} to fleet memory in Atlas`,
    route_planned: () => event.route ? `Route: ${event.route.map(label).join(" → ")}` : "No verified route remains",
    route_unavailable: () => "No route to follow",
    delivery_completed: () => "Meal delivered to the resident",
    assistance_requested: () => "Requested help with a compact evidence packet",
    run_stopped: () => `Stopped safely: ${event.reason?.toLowerCase() ?? "recovery budget exhausted"}`
  };
  return messages[event.type]?.() ?? event.type.replaceAll("_", " ");
}

function traceClass(event) {
  if (["road_blocked", "run_stopped"].includes(event.type)) return "bad";
  if (["delivery_completed", "map_updated", "assistance_requested", "road_event_reported", "fleet_memory_loaded", "rule_fired", "obstacle_cleared"].includes(event.type)) return "good";
  if (event.type === "tool_called") return "tool";
  return "";
}

function appendTrace(event) {
  if (elements["trace-log"].querySelector(".empty-trace")) elements["trace-log"].replaceChildren();
  const entry = document.createElement("div");
  entry.className = `trace-entry ${traceClass(event)}`;
  const text = document.createElement("div");
  text.textContent = traceMessage(event);
  const meta = document.createElement("span");
  meta.textContent = `event ${String(event.index + 1).padStart(2, "0")}`;
  text.append(meta);
  entry.append(text);
  elements["trace-log"].append(entry);
  elements["trace-log"].scrollTop = elements["trace-log"].scrollHeight;
  elements["trace-count"].textContent = `${event.index + 1} events`;
}

async function animateEvent(event, data) {
  appendTrace(event);
  if (event.type === "vehicle_moved") {
    const node = data.nodes[event.to];
    document.getElementById("vehicle")?.setAttribute("transform", `translate(${node.x} ${node.y})`);
  }
  if (event.type === "road_blocked") {
    document.querySelector(`[data-barrier="${event.edge}"]`)?.classList.add("revealed");
    document.getElementById("vehicle")?.classList.add("pulse");
    elements["map-caption"].textContent = "The vehicle sees a closure that the planner map does not know about.";
  }
  if (event.type === "map_updated") {
    (event.edges ?? [event.blockedEdge]).forEach((edge) => document.querySelector(`[data-edge-center="${edge}"]`)?.classList.add("known"));
    elements["map-caption"].textContent = "Local evidence has been promoted into the task map.";
  }
  if (event.type === "fleet_memory_loaded" && event.edges?.length) {
    event.edges.forEach((edge) => document.querySelector(`[data-edge-center="${edge}"]`)?.classList.add("known"));
    elements["map-caption"].textContent = "Closures reported by earlier vehicles were loaded from Atlas before departure.";
  }
  if (event.type === "obstacle_cleared") {
    document.querySelector(`[data-barrier="${event.edge}"]`)?.classList.remove("revealed");
    elements["map-caption"].textContent = "The truck moved on. Waiting beat rerouting.";
  }
  if (event.type === "rule_fired") {
    document.querySelectorAll(".procedure-item").forEach((item) => item.classList.toggle("active", item.dataset.step === `rule:if ${event.when} → ${event.then}`));
  }
  if (event.type === "road_event_reported") elements["map-caption"].textContent = "Closure published to fleet memory. The next vehicle will plan around it.";
  if (event.type === "tool_called") {
    document.querySelectorAll(".procedure-item").forEach((item) => item.classList.toggle("active", item.dataset.step === event.tool));
  }
  if (event.type === "delivery_completed") elements["map-caption"].textContent = "Delivery completed with the verified route.";
  if (event.type === "assistance_requested") elements["map-caption"].textContent = "No verified route exists. The vehicle stops and requests help.";
  await wait(event.type === "vehicle_moved" ? 380 : 170);
}

async function refreshOverview() {
  state.overview = await api("/api/overview");
  renderLineage();
}

async function runMission() {
  setBusy(true);
  state.run = null;
  state.candidate = null;
  state.evaluation = null;
  elements["trace-log"].replaceChildren();
  elements["trace-count"].textContent = "0 events";
  resetEvaluationView();
  try {
    renderProcedure(activeHarness());
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ scenarioId: state.scenarioId }) });
    state.run = run;
    renderMap(run.scenario);
    for (const event of run.events) await animateEvent(event, run.scenario);
    document.querySelectorAll(".procedure-item").forEach((item) => item.classList.remove("active"));
    await refreshOverview();
    if (run.status === "failed") toast("Failure captured in Atlas. The trace can now teach the harness.");
    else if (run.status === "delivered") toast(run.metrics.blockedEncounters ? `Delivered after ${run.metrics.blockedEncounters} blocked road(s).` : "Delivered on the first try.");
    else toast("Vehicle stopped safely and requested assistance.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function evolveHarness(kind = "evolve") {
  setBusy(true);
  try {
    const parent = activeHarness();
    state.evaluation = null;
    resetEvaluationView();
    state.candidate = await api(`/api/${kind}`, { method: "POST", body: JSON.stringify({ runId: state.run.runId, searchOnly: elements["search-only"].checked }) });
    const { diagnosis, devMetrics, proposer, candidatesConsidered, modelError } = state.candidate;
    elements["learning-title"].textContent = diagnosis.summary;
    elements["diagnosis-copy"].textContent = `${diagnosis.code}. Evidence: ${diagnosis.evidence} Proposed change: ${state.candidate.changes.join("; ")}.`;
    elements["proposer-copy"].textContent = kind === "shortcut"
      ? `Proposed by a ${proposer}: ${state.candidate.rationale} Will the fixed gate catch it?`
      : `${candidatesConsidered} candidates scored on ${devMetrics.parent.scenarios} development scenarios${state.candidate.searchDepth === 2 ? " (single edits stopped helping, so search widened to 2-edit combinations)" : ""}; winner from ${proposer}. `
        + `Development: correct ${devMetrics.parent.correctOutcomes} → ${devMetrics.candidate.correctOutcomes}, blocked roads ${devMetrics.parent.blockedEncounters} → ${devMetrics.candidate.blockedEncounters}.`
        + (modelError ? ` (Model unavailable: ${modelError})` : "");
    renderPolicy(elements["before-policy"], parent);
    renderPolicy(elements["after-policy"], state.candidate, parent);
    renderProcedure(state.candidate);
    await refreshOverview();
    toast(`Candidate harness v${state.candidate.version} stored in Atlas.`);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function showEvaluation(evaluation) {
  const { baselineMetrics: before, candidateMetrics: after, accepted } = evaluation;
  elements["success-metric"].textContent = `${before.correctOutcomes} → ${after.correctOutcomes}`;
  elements["success-detail"].textContent = `of ${after.scenarios} unseen generated cities`;
  elements["repeat-metric"].textContent = `${before.blockedEncounters} → ${after.blockedEncounters}`;
  elements["repeat-detail"].textContent = "Across all holdout vehicles";
  elements["safety-metric"].textContent = `${after.unsafeActions}`;
  elements["safety-detail"].textContent = "Fixed collision guard retained";
  const failed = Object.entries(evaluation.gates ?? {}).filter(([, ok]) => !ok).map(([gate]) => gate);
  const worse = Object.entries(evaluation.familyDiff ?? {})
    .filter(([, d]) => d.correctAfter < d.correctBefore || d.blockedAfter > d.blockedBefore)
    .map(([family, d]) => d.correctAfter < d.correctBefore
      ? `${family}: ${d.correctBefore} → ${d.correctAfter} of ${d.scenarios} correct`
      : `${family}: blocked roads ${d.blockedBefore} → ${d.blockedAfter}`);
  elements["gate-result"].className = `gate-result ${accepted ? "pass" : "fail"}`;
  elements["gate-result"].innerHTML = accepted
    ? '<span class="gate-icon">✓</span><div><strong>All gates passed</strong><small>Candidate is eligible for fleet activation.</small></div>'
    : '<span class="gate-icon">×</span><div><strong>Candidate rejected</strong><small class="gate-why"></small></div>';
  if (!accepted) {
    const why = elements["gate-result"].querySelector(".gate-why");
    why.textContent = `Failed: ${failed.join(", ") || "a fixed gate"}. The active harness is unchanged.`;
    for (const line of worse) why.append(Object.assign(document.createElement("span"), { className: "family-diff", textContent: `▼ ${line}` }));
  }
}

async function evaluateHarness() {
  setBusy(true);
  try {
    state.evaluation = await api("/api/evaluations", { method: "POST", body: JSON.stringify({ candidateVersion: state.candidate.version }) });
    if (!state.evaluation.accepted) {
      state.candidate.status = "rejected";
      renderProcedure(activeHarness());
    }
    showEvaluation(state.evaluation);
    await refreshOverview();
    toast(state.evaluation.accepted ? "Candidate passed every fixed evaluation gate." : "Candidate was rejected by the evaluator.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function activateHarness() {
  setBusy(true);
  try {
    state.candidate = await api(`/api/harnesses/${state.candidate.version}/activate`, { method: "POST", body: "{}" });
    await refreshOverview();
    renderProcedure(activeHarness());
    renderPolicy(elements["before-policy"], activeHarness());
    renderMapForSelection();
    toast(`Harness v${state.candidate.version} is now active for every vehicle. Run the mission again.`);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function autoEvolve() {
  setBusy(true);
  try {
    const before = activeHarness()?.version;
    const result = await api("/api/auto-evolve", { method: "POST", body: JSON.stringify({ maxGenerations: 8, searchOnly: elements["search-only"].checked }) });
    await refreshOverview();
    renderProcedure(activeHarness());
    renderPolicy(elements["before-policy"], activeHarness());
    elements["after-policy"].className = "policy-code muted";
    elements["after-policy"].textContent = "Evolution loop finished; see the lineage below";
    const generations = result.steps.filter((step) => !step.stopped);
    if (generations.length) {
      const last = generations.at(-1);
      showEvaluation({ baselineMetrics: generations[0].before, candidateMetrics: last.after, accepted: last.accepted });
    }
    toast(before === result.activeHarness.version
      ? (result.steps[0]?.stopped ?? "No improvement found.")
      : `Evolved v${before} → v${result.activeHarness.version} in ${generations.length} generation(s).`);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function resetDemo() {
  setBusy(true);
  try {
    await api("/api/reset", { method: "POST", body: "{}" });
    state.run = null;
    state.candidate = null;
    state.evaluation = null;
    await refreshOverview();
    renderProcedure(activeHarness());
    renderPolicy(elements["before-policy"], activeHarness());
    renderMapForSelection();
    resetEvaluationView();
    elements["after-policy"].className = "policy-code muted";
    elements["after-policy"].textContent = "Waiting for a failed run";
    elements["proposer-copy"].textContent = "";
    toast("Fleet reset to harness v1. Atlas collections cleared.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function resetEvaluationView() {
  for (const id of ["success-metric", "repeat-metric", "safety-metric"]) elements[id].textContent = "—";
  elements["success-detail"].textContent = "Run an evaluation";
  elements["repeat-detail"].textContent = "Run an evaluation";
  elements["safety-detail"].textContent = "Must remain zero";
  elements["gate-result"].className = "gate-result waiting";
  elements["gate-result"].innerHTML = '<span class="gate-icon">○</span><div><strong>Evaluation pending</strong><small>Candidate has not been tested.</small></div>';
}

function renderMapForSelection() {
  const selected = scenario();
  elements["scenario-title"].textContent = selected.name;
  elements["map-caption"].textContent = selected.description;
  api(`/api/scenarios/${selected.id}`).then(renderMap).catch((error) => toast(error.message));
  elements["trace-log"].innerHTML = '<div class="empty-trace">Run a delivery to generate evidence.</div>';
  elements["trace-count"].textContent = "0 events";
}

async function init() {
  try {
    await refreshOverview();
    const pill = elements["storage-pill"];
    pill.className = `status-pill ${state.overview.storageMode}`;
    pill.innerHTML = state.overview.storageMode === "atlas" ? "<i></i> Atlas connected" : "<i></i> Memory demo mode";
    elements["holdout-copy"].textContent = `New policies face ${state.overview.holdoutScenarios} unseen generated cities across ${Object.keys(state.overview.families).length} disruption types. A candidate activates only when every gate passes.`;
    elements["scenario-select"].replaceChildren(...state.overview.scenarios.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      return option;
    }));
    renderProcedure(activeHarness());
    renderPolicy(elements["before-policy"], activeHarness());
    renderMapForSelection();
    setButtons();
  } catch (error) {
    toast(`Startup failed: ${error.message}`);
    elements["storage-pill"].innerHTML = "<i></i> Connection failed";
  }
}

elements["scenario-select"].addEventListener("change", (event) => {
  state.scenarioId = event.target.value;
  state.run = null;
  state.candidate = null;
  state.evaluation = null;
  renderMapForSelection();
  setButtons();
});
elements["run-button"].addEventListener("click", runMission);
elements["evolve-button"].addEventListener("click", () => evolveHarness("evolve"));
elements["shortcut-button"].addEventListener("click", () => evolveHarness("shortcut"));
elements["evaluate-button"].addEventListener("click", evaluateHarness);
elements["activate-button"].addEventListener("click", activateHarness);
elements["auto-button"].addEventListener("click", autoEvolve);
elements["reset-button"].addEventListener("click", resetDemo);

init();
