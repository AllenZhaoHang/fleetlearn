const state = {
  overview: null,
  scenarioId: "construction-main",
  run: null,
  candidate: null,
  evaluation: null,
  busy: false
};

const elements = Object.fromEntries([
  "storage-pill", "harness-pill", "scenario-select", "scenario-title", "road-map",
  "map-caption", "run-button", "evolve-button", "evaluate-button", "activate-button",
  "harness-name", "policy-state", "procedure-list", "trace-log", "trace-count",
  "learning-title", "diagnosis-copy", "before-policy", "after-policy", "success-metric",
  "success-detail", "repeat-metric", "repeat-detail", "safety-metric", "safety-detail",
  "gate-result", "toast"
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
  toast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

function activeHarness() {
  return state.overview?.activeHarness;
}

function scenario() {
  return state.overview.scenarios.find((item) => item.id === state.scenarioId);
}

function edgeKey(a, b) {
  return [a, b].sort().join("::");
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function renderMap(runScenario = null) {
  const data = runScenario ?? state.run?.scenario;
  if (!data?.nodes || !data?.edges) return;
  const svg = elements["road-map"];
  svg.replaceChildren();
  const blocked = new Set(data.blockedEdges.map(([a, b]) => edgeKey(a, b)));

  for (const [a, b] of data.edges) {
    const from = data.nodes[a];
    const to = data.nodes[b];
    const key = edgeKey(a, b);
    const road = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `road${blocked.has(key) ? " blocked" : ""}`, "data-edge": key });
    const center = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `road-center${blocked.has(key) ? " blocked" : ""}`, "data-edge-center": key });
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

  for (const [id, node] of Object.entries(data.nodes)) {
    const dot = svgElement("circle", { cx: node.x, cy: node.y, r: node.kind ? 12 : 7, class: node.kind ? "node-dot endpoint" : "node-dot" });
    const label = svgElement("text", { x: node.x, y: node.y + (node.kind ? 31 : 25), class: node.kind ? "endpoint-label" : "node-label" });
    label.textContent = node.label;
    svg.append(dot, label);
  }

  const start = data.nodes[data.start];
  const vehicle = svgElement("g", { id: "vehicle", class: "vehicle", transform: `translate(${start.x} ${start.y})` });
  vehicle.append(
    svgElement("rect", { x: -15, y: -11, width: 30, height: 22, rx: 8, class: "vehicle-body" }),
    svgElement("circle", { cx: 7, cy: 0, r: 3, class: "vehicle-light" })
  );
  svg.append(vehicle);
}

function renderProcedure(harness = activeHarness()) {
  if (!harness) return;
  elements["harness-name"].textContent = harness.name;
  elements["harness-pill"].textContent = `Harness v${harness.version}`;
  elements["policy-state"].textContent = harness.status === "active" ? "Active" : "Candidate";
  elements["procedure-list"].replaceChildren(...harness.recoverySteps.map((step) => {
    const item = document.createElement("li");
    item.className = "procedure-item";
    item.dataset.step = step;
    item.textContent = step;
    return item;
  }));
  renderPolicy(elements["before-policy"], activeHarness()?.recoverySteps ?? [], []);
}

function renderPolicy(container, steps, addedSteps) {
  container.classList.remove("muted");
  container.replaceChildren(...steps.map((step, index) => {
    const line = document.createElement("span");
    line.textContent = `${index + 1}. ${step}`;
    if (addedSteps.includes(step)) line.classList.add("added");
    return line;
  }));
}

function setButtons() {
  const locked = state.busy;
  elements["run-button"].disabled = locked;
  elements["evolve-button"].disabled = locked || state.run?.status !== "failed";
  elements["evaluate-button"].disabled = locked || !state.candidate;
  elements["activate-button"].disabled = locked || !state.evaluation?.accepted || state.candidate?.status === "active";
}

function setBusy(value) {
  state.busy = value;
  setButtons();
}

function traceMessage(event) {
  const messages = {
    run_started: `Planned route: ${(event.route ?? []).join(" → ") || "none"}`,
    edge_attempted: `Approaching ${event.from} → ${event.to}`,
    vehicle_moved: `Vehicle reached ${event.to}`,
    road_blocked: `Road ${event.edge.replace("::", "–")} is blocked (encounter ${event.encounter})`,
    recovery_cycle_started: `Recovery cycle ${event.cycle} started`,
    tool_called: `Called ${event.tool}`,
    local_observation: event.observedBlock ? `Observed closure ${event.observedBlock.replace("::", "–")}` : "No nearby closure observed",
    map_updated: `Task map now excludes ${event.blockedEdge.replace("::", "–")}`,
    route_planned: event.route ? `New route: ${event.route.join(" → ")}` : "No verified route remains",
    delivery_completed: "Meal delivered to the resident",
    assistance_requested: "Requested help with a compact evidence packet",
    run_stopped: "Stopped safely: recovery budget exhausted"
  };
  return messages[event.type] ?? event.type.replaceAll("_", " ");
}

function traceClass(event) {
  if (["road_blocked", "run_stopped"].includes(event.type)) return "bad";
  if (["delivery_completed", "map_updated", "assistance_requested"].includes(event.type)) return "good";
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
    document.querySelector(`[data-edge-center="${event.blockedEdge}"]`)?.classList.add("known");
    elements["map-caption"].textContent = "Local evidence has been promoted into the task map.";
  }
  if (event.type === "tool_called") {
    document.querySelectorAll(".procedure-item").forEach((item) => item.classList.toggle("active", item.dataset.step === event.tool));
  }
  if (event.type === "delivery_completed") elements["map-caption"].textContent = "Delivery completed with the verified route.";
  if (event.type === "assistance_requested") elements["map-caption"].textContent = "No verified route exists. The vehicle stops and requests help.";
  await wait(event.type === "vehicle_moved" ? 420 : 230);
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
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ scenarioId: state.scenarioId })
    });
    state.run = run;
    renderMap(run.scenario);
    renderProcedure(activeHarness());
    for (const event of run.events) await animateEvent(event, run.scenario);
    document.querySelectorAll(".procedure-item").forEach((item) => item.classList.remove("active"));
    if (run.status === "failed") toast("Failure captured. The trace can now teach the harness.");
    else if (run.status === "delivered") toast("Delivery completed.");
    else toast("Vehicle stopped safely and requested assistance.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function evolveHarness() {
  setBusy(true);
  try {
    state.candidate = await api("/api/evolve", {
      method: "POST",
      body: JSON.stringify({ runId: state.run.runId })
    });
    const diagnosis = state.candidate.diagnosis;
    elements["learning-title"].textContent = diagnosis.code === "STALE_MAP_RECOVERY_LOOP"
      ? "The retry loop used a stale map."
      : "The recovery policy needs a new procedure.";
    elements["diagnosis-copy"].textContent = `${diagnosis.summary} Evidence: ${diagnosis.evidence}`;
    const added = state.candidate.recoverySteps.filter((step) => !activeHarness().recoverySteps.includes(step));
    renderPolicy(elements["after-policy"], state.candidate.recoverySteps, added);
    renderProcedure(state.candidate);
    elements["policy-state"].textContent = "Candidate";
    toast(`Candidate harness v${state.candidate.version} generated and stored.`);
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function evaluateHarness() {
  setBusy(true);
  try {
    state.evaluation = await api("/api/evaluations", {
      method: "POST",
      body: JSON.stringify({ candidateVersion: state.candidate.version })
    });
    const { baselineMetrics: before, candidateMetrics: after, accepted } = state.evaluation;
    elements["success-metric"].textContent = `${before.correctOutcomes} → ${after.correctOutcomes}`;
    elements["success-detail"].textContent = `${after.scenarios} unseen road scenarios`;
    elements["repeat-metric"].textContent = `${before.repeatedBlocks} → ${after.repeatedBlocks}`;
    elements["repeat-detail"].textContent = after.repeatedBlocks === 0 ? "Retry loops eliminated" : "Further reduction required";
    elements["safety-metric"].textContent = `${after.unsafeActions}`;
    elements["safety-detail"].textContent = "Fixed collision guard retained";
    elements["gate-result"].className = `gate-result ${accepted ? "pass" : "fail"}`;
    elements["gate-result"].innerHTML = accepted
      ? '<span class="gate-icon">✓</span><div><strong>All gates passed</strong><small>Candidate is eligible for fleet activation.</small></div>'
      : '<span class="gate-icon">×</span><div><strong>Candidate rejected</strong><small>The active harness remains unchanged.</small></div>';
    toast(accepted ? "Candidate passed every fixed evaluation gate." : "Candidate was rejected by the evaluator.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function activateHarness() {
  setBusy(true);
  try {
    const activated = await api(`/api/harnesses/${state.candidate.version}/activate`, { method: "POST", body: "{}" });
    state.candidate = activated;
    state.overview = await api("/api/overview");
    renderProcedure(state.overview.activeHarness);
    elements["policy-state"].textContent = "Active";
    state.scenarioId = "delivery-truck";
    elements["scenario-select"].value = state.scenarioId;
    elements["scenario-title"].textContent = scenario().name;
    renderMapForSelection();
    toast("Harness activated fleet-wide. A transfer scenario is ready.");
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
  api(`/api/scenarios/${selected.id}`)
    .then((preview) => renderMap(preview))
    .catch((error) => toast(error.message));
  elements["map-caption"].textContent = selected.description;
}

async function init() {
  try {
    state.overview = await api("/api/overview");
    const pill = elements["storage-pill"];
    pill.className = `status-pill ${state.overview.storageMode}`;
    pill.innerHTML = state.overview.storageMode === "atlas"
      ? "<i></i> Atlas connected"
      : "<i></i> Memory demo mode";
    elements["scenario-select"].replaceChildren(...state.overview.scenarios.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      return option;
    }));
    renderProcedure(activeHarness());
    elements["before-policy"].classList.remove("muted");

    const preview = await api(`/api/scenarios/${state.scenarioId}`);
    renderMap(preview);
    elements["trace-log"].innerHTML = '<div class="empty-trace">Run a delivery to generate evidence.</div>';
    elements["trace-count"].textContent = "0 events";
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
  elements["scenario-title"].textContent = scenario().name;
  renderMapForSelection();
  elements["trace-log"].innerHTML = '<div class="empty-trace">Run a delivery to generate evidence.</div>';
  elements["trace-count"].textContent = "0 events";
  setButtons();
});
elements["run-button"].addEventListener("click", runMission);
elements["evolve-button"].addEventListener("click", evolveHarness);
elements["evaluate-button"].addEventListener("click", evaluateHarness);
elements["activate-button"].addEventListener("click", activateHarness);

init();
