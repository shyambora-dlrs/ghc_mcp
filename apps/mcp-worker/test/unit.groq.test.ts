import { describe, expect, it } from "vitest";
import { LlmError, createGroundedCompletion, type GroqConfig } from "../src/services/groq.service";

const cfg: GroqConfig = { apiKey: "gsk_secret_key_value", baseUrl: "https://api.groq.com/openai/v1/", model: "some-model", enabled: true, timeoutMs: 200, maxCompletionTokens: 100, temperature: 0.2, maxInputChars: 1000 };
const input = { systemPrompt: "sys", userPrompt: "usr" };
const ok = (text = "hello") => new Response(JSON.stringify({ model: "some-model", choices: [{ message: { content: text } }] }), { status: 200 });
const noSleep = { sleep: async () => undefined };

async function kind(p: Promise<unknown>): Promise<string> {
  try { await p; return "none"; } catch (e) { return e instanceof LlmError ? e.kind : `other:${String(e)}`; }
}

describe("createGroundedCompletion", () => {
  it("is disabled / unconfigured without touching the network", async () => {
    let called = 0;
    const f = (async () => { called++; return ok(); }) as typeof fetch;
    expect(await kind(createGroundedCompletion({ ...cfg, enabled: false }, input, { fetch: f }))).toBe("disabled");
    expect(await kind(createGroundedCompletion({ ...cfg, apiKey: "" }, input, { fetch: f }))).toBe("not_configured");
    expect(await kind(createGroundedCompletion({ ...cfg, model: "" }, input, { fetch: f }))).toBe("not_configured");
    expect(called).toBe(0);
  });
  it("sends a well-formed server-side request and returns the text", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }; return ok("summary"); }) as unknown as typeof fetch;
    const out = await createGroundedCompletion(cfg, input, { fetch: f, ...noSleep });
    expect(out).toEqual({ text: "summary", model: "some-model" });
    expect(seen!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seen!.headers.Authorization).toBe("Bearer gsk_secret_key_value");
    expect(seen!.body).toMatchObject({ model: "some-model", temperature: 0.2, max_tokens: 100 });
  });
  it("does not retry invalid credentials or invalid models", async () => {
    for (const [status, expected] of [[401, "auth"], [403, "auth"], [404, "invalid_model"]] as const) {
      let calls = 0;
      const f = (async () => { calls++; return new Response("x", { status }); }) as typeof fetch;
      expect(await kind(createGroundedCompletion(cfg, input, { fetch: f, ...noSleep }))).toBe(expected);
      expect(calls).toBe(1);
    }
    const f = (async () => new Response('{"error":{"message":"The model `x` does not exist"}}', { status: 400 })) as typeof fetch;
    expect(await kind(createGroundedCompletion(cfg, input, { fetch: f, ...noSleep }))).toBe("invalid_model");
  });
  it("retries rate limits and server errors, then succeeds", async () => {
    let calls = 0;
    const f = (async () => (++calls === 1 ? new Response("slow down", { status: 429 }) : calls === 2 ? new Response("oops", { status: 503 }) : ok("finally"))) as typeof fetch;
    expect((await createGroundedCompletion(cfg, input, { fetch: f, ...noSleep })).text).toBe("finally");
    expect(calls).toBe(3);
  });
  it("gives up after bounded attempts with a classified error", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("limit", { status: 429 }); }) as typeof fetch;
    expect(await kind(createGroundedCompletion(cfg, input, { fetch: f, ...noSleep }))).toBe("rate_limit");
    expect(calls).toBe(3);
  });
  it("times out", async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    expect(await kind(createGroundedCompletion({ ...cfg, timeoutMs: 20 }, input, { fetch: f, ...noSleep }))).toBe("timeout");
  });
  it("rejects malformed provider responses and oversized input", async () => {
    expect(await kind(createGroundedCompletion(cfg, input, { fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch, ...noSleep }))).toBe("bad_response");
    expect(await kind(createGroundedCompletion(cfg, input, { fetch: (async () => ok("  ")) as typeof fetch, ...noSleep }))).toBe("bad_response");
    expect(await kind(createGroundedCompletion(cfg, { systemPrompt: "s", userPrompt: "x".repeat(6000) }, { fetch: (async () => ok()) as typeof fetch }))).toBe("input_too_large");
  });
  it("never leaks the key or upstream body in errors", async () => {
    const f = (async () => new Response("secret upstream body gsk_secret_key_value", { status: 500 })) as typeof fetch;
    try { await createGroundedCompletion(cfg, input, { fetch: f, ...noSleep }); } catch (e) { expect(String((e as Error).message)).not.toMatch(/gsk_|upstream body/); }
  });
});
