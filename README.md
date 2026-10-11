# FleetLearn

**Roads change. The fleet learns.**

FleetLearn is a self-improving harness for delivery robots, built at the Harness Engineering & Model Wrangling #SFTechWeek Hackathon (Oct 11, 2026). Problem statement: **Recursive Harnessing**.

A robot that hits a road closure it has never seen leaves a trace. FleetLearn diagnoses that trace, proposes a new harness, scores the candidates on development cities, and promotes a winner only if it passes fixed gates on **42 cities it has never seen**. Once activated, every robot in the fleet loads the new harness from MongoDB Atlas. A robot also writes the closures it sees to fleet memory in Atlas, so the next robot plans around them before it leaves.

## What evolves, and what doesn't

| Evolves (the harness) | Fixed in code (can't be evolved) |
|---|---|
| **Tool access and order.** Which of the 7 tools run in each recovery cycle, and in what order | Collision rule: a robot can never enter a blocked road |
| **Preflight.** E.g. read fleet memory before departure | What each tool does, and the rule conditions and actions available |
| **Conditional rules.** E.g. `if temporary_obstacle → wait_and_retry`, `if repeated_block → request_help` | Tool-call budget per run (24) |
| **Context policy.** Perception radius: how much of the surroundings an inspection reveals (0–2 hops, each hop costs a tool call) | Holdout scenarios (deep-frozen) and the promotion gates |
| Recovery cycles (1–5) | |

## The loop

```
robot run ──► trace + road events ──► diagnose ──► propose candidates ──► score on 14 dev cities
   ▲              (Atlas: runs,           (8 failure     (LLM + local search over      │
   │               road_events)            patterns)      tools, rules, context)       ▼
   └──── activate fleet-wide ◄── pass all gates on 42 holdout cities ◄── best candidate
              (Atlas: harness_versions)        (Atlas: evaluations)
```

- **Diagnosis** turns traces into named patterns: `STALE_MAP_RECOVERY_LOOP`, `NO_SAFE_ESCALATION`, `TEMPORARY_OBSTACLE_MISHANDLED`, `CLOSURES_FOUND_ONE_AT_A_TIME`, `KNOWN_CLOSURE_REDISCOVERED`, `FLEET_KNOWLEDGE_NOT_SHARED`, `RECOVERY_BUDGET_EXHAUSTED`, `TOOL_BUDGET_EXCEEDED`.
- **Proposal.**
  - An LLM reads the patterns and a compact trace, and proposes complete harnesses. It can be Claude, or any OpenAI-compatible model; we demo with `openai/gpt-oss-120b` on Groq.
  - Local search tries every single edit. When no single edit helps, it widens to 2-edit combinations.
  - Every candidate, whoever proposed it, is schema-validated and scored on the development set. Rejected versions are never proposed again.
- **Gates (holdout, fixed).** No unsafe actions. No disruption type gets worse. A measurable improvement: more correct outcomes, or the same outcomes with fewer blocked-road encounters *on successful deliveries*. Tool cost stays bounded.
- **The gate is tested adversarially.** *Try a cheaper shortcut* proposes what a naive self-improver would: the cheapest edit that still handles the last run. The gate rejects it and names the disruption type that regressed. For example, removing `request_help` drops "unreachable" from 6/6 to 0/6. Building this probe caught a real reward hack in our first gate: a harness that gave up early hit fewer barriers and looked "better". Blocked roads now only count on deliveries that succeeded.

## Results on 42 unseen cities

**Local search only** (`npm run evolve -- --reset --search-only`, deterministic):

| Version | Change the harness made to itself | Triggering pattern | Correct | Blocked roads |
|---|---|---|---|---|
| v1 | `replan → follow_route` | — | 6 / 42 | 168 |
| v2 | add `update_local_map` | STALE_MAP_RECOVERY_LOOP | 30 / 42 | 52 |
| v3 | add `request_help` | NO_SAFE_ESCALATION | 36 / 42 | 52 |
| v4 | `query_fleet_memory` before departure | KNOWN_CLOSURE_REDISCOVERED | 36 / 42 | 46 |
| v5 | add `report_road_event` | FLEET_KNOWLEDGE_NOT_SHARED | 36 / 42 | 40 |
| v6 | add `inspect_local` + rule `if temporary_obstacle → wait_and_retry` (*2-edit search, 1,564 candidates*) | TEMPORARY_OBSTACLE_MISHANDLED | 42 / 42 | 40 |
| v7 | perception radius 0 → 2 | CLOSURES_FOUND_ONE_AT_A_TIME | 42 / 42 | 34 |

**LLM + local search** (`npm run evolve -- --reset`): the model read the v1 failure traces and proposed one complete harness. It covered inspection, map updates, fleet memory, both rules, and radius 2. The harness went **6 → 42 / 42 in a single generation**, verified by the same frozen gate.

## MongoDB Atlas is the memory, not a log

| Collection | Role in the running system |
|---|---|
| `harness_versions` | Every robot run loads the active harness from here. It holds the full lineage: parent, diagnosis, proposer, and status (active, retired, rejected). |
| `runs` | Full traces. These are the evidence the diagnosis reads. |
| `road_events` | Fleet memory. Closures reported by one robot are read by the next robot before it departs. |
| `evaluations` | Holdout results, per-family diffs, and gate decisions. Activation is refused without a passing evaluation. |

## Run it

```bash
npm install
cp .env.example .env      # MONGODB_URI (hackathon Atlas Sandbox) + optional model settings
npm start                 # http://localhost:3000
npm test                  # 13 tests
npm run evolve -- --reset # headless evolution loop with printed lineage (add --search-only to skip the model)
```

Without `MONGODB_URI` the app runs in memory mode, which is fine for development. Submission requires Atlas. Without a model key, the proposer uses local search only.

## 3-minute demo script

1. **Reset to v1** → choose *Delivery truck unloading at the door* → **Run active harness**. The robot treats the truck as a closure, has no detour, and gives up. The failure is written to Atlas.
2. **Generate improvement**. The LLM reads the trace and proposes a complete harness. Show the diagnosis, the before/after procedure, and the model's rationale.
3. **Evaluate candidate**. Usually 6 → 42 of 42 unseen cities, all gates pass. **Activate fleet-wide** and run again: the robot inspects, the rule fires, it waits, the truck moves, delivered. LLM output varies: if the gate shows fewer than 42/42, press **Run evolution loop** to finish the remaining families before re-running.
4. **Try a cheaper shortcut** → **Evaluate candidate**. The fixed gate rejects it and names what would have regressed.
5. Tick **Search only** → **Reset** → **Run evolution loop**. Without the model, local search needs 6 generations, and widens to 2-edit combinations to find the conditional rule. Scroll to the lineage.
6. *Construction on the main route*: run twice. Robot 1 hits the closure once and reports it. Robot 2 loads it from Atlas and delivers on the first try.

## Built during the hackathon

All code in this repository was written on Oct 11, 2026 during the event. Third-party pieces: Express, the MongoDB Node driver, dotenv, and the Anthropic SDK. LLM inference during the demo comes from Groq's OpenAI-compatible API.

Team: Hang Zhao (solo).
