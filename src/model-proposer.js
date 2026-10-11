// Optional model-driven proposer. The model reads the failure patterns and a compact trace,
// and suggests candidate harnesses. Its suggestions are only suggestions: each one is
// schema-validated and scored by the deterministic simulator like any other candidate.
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM = `You improve the recovery harness of autonomous delivery vehicles.
A harness is: preflight (tools run before the first route is planned), recoverySteps (tools run in order each recovery cycle after the vehicle is blocked), maxRecoveryCycles, rules (conditional "when X then Y" checked after every recovery tool call; firing ends the cycle), and context.perceptionRadius (how many hops inspect_local scans; each hop costs one tool call).
You may only compose the listed tools, rule conditions, rule actions, and context options. You cannot change the simulator, the safety rules, the tool budget, or the evaluation scenarios.
Candidates are scored on unseen cities by: correct outcomes first, then fewer blocked roads on successful deliveries, then fewer tool calls.
Propose 3 distinct candidates:
1. one harness that fixes every listed failure pattern at once,
2. the smallest change that fixes the most frequent pattern,
3. an alternative design for the hardest pattern.
Every failure pattern comes with evidence; read it carefully (for example, an obstacle may be temporary rather than a closure).`;

function candidateSchema(toolCatalog, ruleCatalog, contextOptions) {
  return {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            preflight: { type: "array", items: { type: "string", enum: ["query_fleet_memory"] } },
            recoverySteps: { type: "array", items: { type: "string", enum: Object.keys(toolCatalog) } },
            maxRecoveryCycles: { type: "integer" },
            rules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  when: { type: "string", enum: Object.keys(ruleCatalog.conditions) },
                  then: { type: "string", enum: Object.keys(ruleCatalog.actions) }
                },
                required: ["when", "then"],
                additionalProperties: false
              }
            },
            perceptionRadius: { type: "integer", enum: contextOptions.perceptionRadius },
            rationale: { type: "string" }
          },
          required: ["preflight", "recoverySteps", "maxRecoveryCycles", "rules", "perceptionRadius", "rationale"],
          additionalProperties: false
        }
      }
    },
    required: ["candidates"],
    additionalProperties: false
  };
}

function prompt({ harness, issues, sourceRun, toolCatalog, ruleCatalog, contextOptions, guardrails, rejected }) {
  const trace = sourceRun?.events
    .filter((event) => ["tool_called", "road_blocked", "route_planned", "map_updated", "local_observation", "rule_fired", "run_stopped", "assistance_requested"].includes(event.type))
    .slice(0, 40)
    .map((event) => [event.type, event.tool ?? event.edge ?? event.kind ?? event.when ?? (event.route ? event.route.join(">") : event.reason ?? "")].join(" "));
  return JSON.stringify({
    currentHarness: { preflight: harness.preflight, recoverySteps: harness.recoverySteps, maxRecoveryCycles: harness.maxRecoveryCycles, rules: harness.rules, perceptionRadius: harness.context.perceptionRadius },
    tools: toolCatalog,
    ruleConditions: ruleCatalog.conditions,
    ruleActions: ruleCatalog.actions,
    perceptionRadiusOptions: contextOptions.perceptionRadius,
    fixedGuardrails: guardrails,
    failurePatterns: issues.map(({ code, summary, evidence, count }) => ({ code, summary, evidence, count })),
    sourceTrace: trace,
    previouslyRejected: rejected.slice(-5).map((h) => ({ preflight: h.preflight, recoverySteps: h.recoverySteps, maxRecoveryCycles: h.maxRecoveryCycles, rules: h.rules ?? [], perceptionRadius: h.context?.perceptionRadius ?? 0 }))
  }, null, 1);
}

async function proposeWithClaude(input) {
  const client = new Anthropic({ timeout: 90_000, maxRetries: 1 });
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt(input) }],
    output_config: { effort: "low", format: { type: "json_schema", schema: candidateSchema(input.toolCatalog, input.ruleCatalog, input.contextOptions) } }
  });
  if (response.stop_reason === "refusal") throw new Error("Model declined the request");
  const text = response.content.find((block) => block.type === "text")?.text;
  return { model, candidates: JSON.parse(text).candidates.map(toShape) };
}

async function proposeWithOpenAICompatible(input) {
  const { MODEL_API_URL, MODEL_API_KEY, MODEL_NAME } = process.env;
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MODEL_API_KEY}` },
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SYSTEM}\nReturn JSON: {"candidates":[{"preflight":[],"recoverySteps":[],"maxRecoveryCycles":3,"rules":[{"when":"","then":""}],"perceptionRadius":0,"rationale":""}]}` },
        { role: "user", content: prompt(input) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model returned HTTP ${response.status}`);
  const payload = await response.json();
  const candidates = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}").candidates ?? [];
  return { model: MODEL_NAME, candidates: candidates.map(toShape) };
}

// Model output uses a flat perceptionRadius; the harness keeps it under context.
function toShape({ perceptionRadius, rules, ...rest }) {
  return { ...rest, rules: Array.isArray(rules) ? rules : [], context: { perceptionRadius: Number.isInteger(perceptionRadius) ? perceptionRadius : 0 } };
}

export function configuredModel() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  if (process.env.MODEL_API_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME) return process.env.MODEL_NAME;
  return null;
}

// Returns a proposer function, or null when no model is configured (local search still runs).
export function modelProposer() {
  if (process.env.ANTHROPIC_API_KEY) return proposeWithClaude;
  if (process.env.MODEL_API_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME) return proposeWithOpenAICompatible;
  return null;
}
