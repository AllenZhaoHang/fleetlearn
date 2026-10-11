# FleetLearn

**Roads change. The fleet learns.**

FleetLearn is a self-improving harness for delivery robots, built at the Harness Engineering & Model Wrangling #SFTechWeek Hackathon (Oct 11, 2026). Problem statement: **Recursive Harnessing**.

A robot that hits a road closure it has never seen leaves a trace. FleetLearn diagnoses that trace, proposes a new recovery procedure, scores the candidates on development cities, and promotes a winner only if it passes fixed gates on **36 cities it has never seen**. Once activated, every robot in the fleet loads the new harness from MongoDB Atlas. A robot also writes the closures it sees to fleet memory in Atlas, so the next robot plans around them before it leaves.

## What evolves, and what doesn't

| Evolves (the harness) | Fixed in code (can't be evolved) |
|---|---|
| Preflight tools: e.g. read fleet memory before departure | Collision rule: a robot can never enter a blocked road |
| Recovery procedure: which tools run, and in what order | The tool set and what each tool does |
| Number of recovery cycles (1–5) | Tool-call budget per run (24) |
| | Holdout scenarios (deep-frozen) and the promotion gates |

Tools the harness can compose: `query_fleet_memory`, `inspect_local`, `update_local_map`, `report_road_event`, `replan`, `follow_route`, `request_help`.

## The loop

```
robot run ──► trace + road events ──► diagnose ──► propose candidates ──► score on 12 dev cities
   ▲              (Atlas: runs,            (6 failure      (Claude + local search     │
   │               road_events)             patterns)       over the tool surface)    ▼
   └──── activate fleet-wide ◄── pass all gates on 36 holdout cities ◄── best candidate
              (Atlas: harness_versions)        (Atlas: evaluations)
```

- **Diagnosis** turns traces into named patterns: `STALE_MAP_RECOVERY_LOOP`, `NO_SAFE_ESCALATION`, `RECOVERY_BUDGET_EXHAUSTED`, `TOOL_BUDGET_EXCEEDED`, `KNOWN_CLOSURE_REDISCOVERED`, `FLEET_KNOWLEDGE_NOT_SHARED`.
- **Proposal.** If a model is configured, Claude reads the patterns and the trace and suggests candidates. Local search also tries every single edit of the current harness. Every candidate, whoever proposed it, is schema-validated and scored on the development set. Versions that were rejected before are never proposed again.
- **Gates (holdout, fixed).** No unsafe actions. No disruption type gets worse. A measurable improvement (more correct outcomes, or fewer blocked-road encounters). Tool cost stays bounded.

## Result (deterministic, reproducible with `npm run evolve -- --reset`)

| Version | Change the harness made to itself | Triggering pattern | Holdout correct | Blocked-road encounters |
|---|---|---|---|---|
| v1 | `replan → follow_route` | — | 6 / 36 | 144 |
| v2 | add `update_local_map` | STALE_MAP_RECOVERY_LOOP | 30 / 36 | 46 |
| v3 | add `request_help` | NO_SAFE_ESCALATION | 36 / 36 | 46 |
| v4 | `query_fleet_memory` before departure | KNOWN_CLOSURE_REDISCOVERED | 36 / 36 | 40 |
| v5 | add `report_road_event` | FLEET_KNOWLEDGE_NOT_SHARED | 36 / 36 | 34 |

## MongoDB Atlas is the memory, not a log

| Collection | Role in the running system |
|---|---|
| `harness_versions` | Every robot run loads the active harness from here. It holds the full lineage: parent, diagnosis, proposer, and status (active, retired, rejected). |
| `runs` | Full traces. These are the evidence the diagnosis reads. |
| `road_events` | Fleet memory. Closures reported by one robot are read by the next robot before it departs. |
| `evaluations` | Holdout results and gate decisions. Activation is refused without a passing evaluation. |

## Run it

```bash
npm install
cp .env.example .env      # set MONGODB_URI to the hackathon Atlas Sandbox cluster
npm start                 # http://localhost:3000
npm test                  # 9 tests
npm run evolve -- --reset # headless evolution loop with printed lineage
```

Without `MONGODB_URI` the app runs in memory mode, which is fine for development. Submission requires Atlas. Without `ANTHROPIC_API_KEY` the proposer uses local search only.

## 3-minute demo script

1. **Reset to v1** → **Run active harness** on *Construction on the main route*. The robot hits B–D four times and stops. The failure is written to Atlas.
2. **Generate improvement**. Show the diagnosis, how many candidates were scored, and the before/after procedure.
3. **Evaluate candidate**. 6 → 30 of 36 unseen cities. All gates pass. **Activate fleet-wide**.
4. **Run evolution loop**. The harness rewrites itself up to v5. Scroll to the lineage: each version shows why it exists.
5. Run the mission twice. Robot 1 hits the closure once and reports it. Robot 2 loads it from Atlas and delivers on the first try.
6. Switch to a generated city to show that the procedure transfers.

## Built during the hackathon

All code in this repository was written on Oct 11, 2026 during the event. Third-party pieces: Express, the MongoDB Node driver, dotenv, and the Anthropic SDK.

Team: _add names and roles here_.
