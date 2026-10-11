// Optional model-driven proposer. The model reads the failure patterns and a compact trace,
// and suggests candidate harnesses. Its suggestions are only suggestions: each one is
// schema-validated and scored by the deterministic simulator like any other candidate.
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM = `You improve the recovery harness of autonomous delivery vehicles.
A harness is: preflight (tools run before the first route is planned), recoverySteps (tools run in order each recovery cycle after the vehicle is blocked), and maxRecoveryCycles.
You may only compose the listed tools. You cannot change the simulator, the safety rules, the tool budget, or the evaluation scenarios.
Propose 3 distinct candidates that fix the observed failure patterns with the smallest change. Prefer fixing the most frequent pattern first.`;

function candidateSchema(toolCatalog) {
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
            rationale: { type: "string" }
          },
          required: ["preflight", "recoverySteps", "maxRecoveryCycles", "rationale"],
          additionalProperties: false
        }
      }
    },
    required: ["candidates"],
    additionalProperties: false
  };
}

function prompt({ harness, issues, sourceRun, toolCatalog, guardrails, rejected }) {
  const trace = sourceRun?.events
    .filter((event) => ["tool_called", "road_blocked", "route_planned", "map_updated", "run_stopped", "assistance_requested"].includes(event.type))
    .slice(0, 40)
    .map((event) => [event.type, event.tool ?? event.edge ?? (event.route ? event.route.join(">") : event.reason ?? "")].join(" "));
  return JSON.stringify({
    currentHarness: { preflight: harness.preflight, recoverySteps: harness.recoverySteps, maxRecoveryCycles: harness.maxRecoveryCycles },
    tools: toolCatalog,
    fixedGuardrails: guardrails,
    failurePatterns: issues.map(({ code, summary, evidence, count }) => ({ code, summary, evidence, count })),
    sourceTrace: trace,
    previouslyRejected: rejected.slice(-5).map((h) => ({ preflight: h.preflight, recoverySteps: h.recoverySteps, maxRecoveryCycles: h.maxRecoveryCycles }))
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
    output_config: { effort: "low", format: { type: "json_schema", schema: candidateSchema(input.toolCatalog) } }
  });
  if (response.stop_reason === "refusal") throw new Error("Model declined the request");
  const text = response.content.find((block) => block.type === "text")?.text;
  return { model, candidates: JSON.parse(text).candidates };
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
        { role: "system", content: `${SYSTEM}\nReturn JSON: {"candidates":[{"preflight":[],"recoverySteps":[],"maxRecoveryCycles":3,"rationale":""}]}` },
        { role: "user", content: prompt(input) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model returned HTTP ${response.status}`);
  const payload = await response.json();
  return { model: MODEL_NAME, candidates: JSON.parse(payload.choices?.[0]?.message?.content ?? "{}").candidates ?? [] };
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
