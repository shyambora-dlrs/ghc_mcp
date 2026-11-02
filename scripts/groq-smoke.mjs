#!/usr/bin/env node
// Opt-in smoke test for the Groq configuration. Requires real credentials; NOT run in CI or by `npm test`.
//   GROQ_API_KEY=... GROQ_MODEL=... node scripts/groq-smoke.mjs
// 1) lists the models your key can use, 2) checks GROQ_MODEL is among them, 3) sends one tiny completion.
// The key is only sent to GROQ_BASE_URL and is never printed.
const base = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const key = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL;
if (!key) { console.error("Set GROQ_API_KEY (e.g. in your shell; do not commit it)."); process.exit(2); }

const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const ml = await fetch(`${base}/models`, { headers });
if (!ml.ok) { console.error(`GET /models failed: HTTP ${ml.status} (${ml.status === 401 ? "invalid API key" : "see Groq console"})`); process.exit(1); }
const ids = (await ml.json()).data.map((m) => m.id).sort();
console.log(`Models available to this key (${ids.length}):\n  ${ids.join("\n  ")}`);
if (!model) { console.error("\nSet GROQ_MODEL to one of the ids above, then re-run."); process.exit(2); }
if (!ids.includes(model)) { console.error(`\nGROQ_MODEL=${model} is NOT available to this key. Pick one from the list.`); process.exit(1); }

const r = await fetch(`${base}/chat/completions`, {
  method: "POST", headers,
  body: JSON.stringify({ model, temperature: 0, max_tokens: 40, messages: [
    { role: "system", content: "Reply with exactly: OK" }, { role: "user", content: "ping" }] }),
});
if (!r.ok) { console.error(`chat/completions failed: HTTP ${r.status}`); process.exit(1); }
const out = await r.json();
console.log(`\nSmoke test passed with model ${out.model ?? model}: ${JSON.stringify(out.choices?.[0]?.message?.content)}`);
console.log("Record this model id in docs/groq-configuration.md and set it as the GROQ_MODEL Worker variable.");
