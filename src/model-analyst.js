export async function enrichDiagnosis({ run, diagnosis }) {
  const { MODEL_API_URL, MODEL_API_KEY, MODEL_NAME } = process.env;
  if (!MODEL_API_URL || !MODEL_API_KEY || !MODEL_NAME) {
    return { diagnosis, analyst: "bounded-local-critic" };
  }

  const trace = run.events.map((event) => ({
    type: event.type,
    tool: event.tool,
    edge: event.edge,
    encounter: event.encounter,
    reason: event.reason
  }));
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MODEL_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a fleet-harness critic. Explain the smallest evidence-backed recovery-policy change. Never weaken collision rules, the tool budget, or the evaluator. Return JSON with summary, evidence, and proposedChange."
        },
        {
          role: "user",
          content: JSON.stringify({ currentDiagnosis: diagnosis, trace })
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`Model critic returned HTTP ${response.status}`);
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content;
  const parsed = JSON.parse(text);
  return {
    diagnosis: {
      ...diagnosis,
      summary: String(parsed.summary ?? diagnosis.summary),
      evidence: String(parsed.evidence ?? diagnosis.evidence),
      proposedChange: String(parsed.proposedChange ?? diagnosis.proposedChange)
    },
    analyst: MODEL_NAME
  };
}
