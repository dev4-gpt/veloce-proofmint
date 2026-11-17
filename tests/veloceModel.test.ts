// Run: npx tsx --test tests/veloceModel.test.ts
// The "veloce" provider (Veloce ADR-020): a Forge round started by the Veloce host asks the HOST for every model answer, with the
// host's grant, and never falls back to Forge's own free-tier keys. Every network call here is a stub; no real key or prompt is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_MAX_OUTPUT_TOKENS, HostModelError, hostCompleter } from "../src/lib/veloceModel";

const URL_ = "https://host.example.test/api/adapter-host/model-call";
const OK_BODY = { ok: true, output: '{"rationale":"made up","code":"def normalize(raw):\\n    return raw\\n"}', usage: { inputTokens: 120, outputTokens: 40 }, costMicros: 9, call: 1 };

type Call = { url: string; init: RequestInit };
function stub(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const make = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  hostCompleter({ url: URL_, provider: "groq", model: "openai/gpt-oss-120b", token: "grant-token-made-up", taskKey: "host-task-0001", fetchImpl, ...extra });

test("sends exactly the host's request shape, only to the configured address, with the grant as the bearer", async () => {
  const s = stub(() => json(200, OK_BODY));
  const out = await make(s.fetchImpl)("SYSTEM TEXT", "USER TEXT");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, URL_);
  assert.equal(s.calls[0].init.method, "POST");
  assert.equal(s.calls[0].init.redirect, "error"); // a redirect would carry the grant somewhere else
  assert.ok(s.calls[0].init.signal); // every call has a time limit
  const headers = new Headers(s.calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer grant-token-made-up");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(s.calls[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), ["maxOutputTokens", "messages", "model", "provider", "taskKey"]);
  assert.equal(body.taskKey, "host-task-0001");
  assert.equal(body.provider, "groq");
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.maxOutputTokens, HOST_MAX_OUTPUT_TOKENS);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.ok(body.messages[0].content.startsWith("SYSTEM TEXT"));
  assert.match(body.messages[0].content, /single JSON object/);
  assert.deepEqual(body.messages[1], { role: "user", content: "USER TEXT" });
  assert.equal(out.json.code, "def normalize(raw):\n    return raw\n");
  assert.equal(out.json.rationale, "made up");
  assert.equal(out.completion.tokensIn, 120);
  assert.equal(out.completion.tokensOut, 40);
  assert.equal(out.completion.provider, "veloce");
  assert.equal(out.completion.model, "groq:openai/gpt-oss-120b");
  assert.deepEqual(out.tried, ["veloce"]);
});

test("the output cap is the host's 8,192 and a larger request is refused when the completer is made", () => {
  assert.equal(HOST_MAX_OUTPUT_TOKENS, 8192);
  const s = stub(() => json(200, OK_BODY));
  assert.throws(() => make(s.fetchImpl, { maxOutputTokens: 8193 }), /maxOutputTokens/);
  assert.throws(() => make(s.fetchImpl, { maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => make(s.fetchImpl, { maxOutputTokens: 1.5 }), /maxOutputTokens/);
  assert.doesNotThrow(() => make(s.fetchImpl, { maxOutputTokens: 256 }));
});

test("bad settings are refused before any call: address, provider, model, grant, task key", () => {
  const s = stub(() => json(200, OK_BODY));
  for (const extra of [
    { url: "http://host.example.test/x" }, // plain http only for this machine
    { url: "https://user:pw@host.example.test/x" },
    { url: "not a url" },
    { provider: "xai" },
    { provider: "veloce" },
    { model: "" },
    { model: "m".repeat(181) },
    { token: "" },
    { taskKey: "" },
    { taskKey: "has/slash" },
    { taskKey: "k".repeat(121) },
  ]) {
    assert.throws(() => make(s.fetchImpl, extra), Error, JSON.stringify(extra));
  }
  assert.doesNotThrow(() => make(s.fetchImpl, { url: "http://localhost:3000/api/adapter-host/model-call" }));
  assert.doesNotThrow(() => make(s.fetchImpl, { url: "http://127.0.0.1:3000/api/adapter-host/model-call" }));
  assert.equal(s.calls.length, 0);
});

test("an unreachable host fails with model_host_unreachable, once, with no retry and no fallback", async () => {
  const s = stub(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(make(s.fetchImpl)("s", "u"), (e: unknown) => e instanceof HostModelError && e.code === "model_host_unreachable");
  assert.equal(s.calls.length, 1);
  const t = stub(() => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  await assert.rejects(make(t.fetchImpl)("s", "u"), (e: unknown) => e instanceof HostModelError && e.code === "model_host_unreachable");
});

test("a host refusal keeps only the host's short code, never other text", async () => {
  for (const [status, error, code] of [
    [429, "budget_exceeded", "budget_exceeded"],
    [403, "call_limit", "call_limit"],
    [401, "bad_credential", "bad_credential"],
    [502, "provider_timeout", "provider_timeout"],
    [400, "Some <b>long</b> text from somewhere", "model_host_refused"],
    [500, 42, "model_host_refused"],
  ] as const) {
    const s = stub(() => json(status, { ok: false, error }));
    await assert.rejects(make(s.fetchImpl)("s", "u"), (e: unknown) => {
      assert.ok(e instanceof HostModelError);
      assert.equal(e.code, code);
      assert.ok(!e.message.includes("<b>"));
      return true;
    });
  }
  const s = stub(() => new Response("not json", { status: 503 }));
  await assert.rejects(make(s.fetchImpl)("s", "u"), (e: unknown) => e instanceof HostModelError && e.code === "model_host_refused");
});

test("a reply the round cannot use is refused: wrong shape, too large, unparseable or without code", async () => {
  const cases: [Response, string][] = [
    [json(200, { ok: true }), "model_host_bad_reply"],
    [json(200, { ok: false, output: "x" }), "model_host_bad_reply"],
    [json(200, { ...OK_BODY, output: 5 }), "model_host_bad_reply"],
    [new Response("x".repeat(300 * 1024), { status: 200 }), "model_host_bad_reply"],
    [new Response("not json", { status: 200 }), "model_host_bad_reply"],
    [json(200, { ...OK_BODY, output: JSON.stringify({ rationale: "r", code: "x".repeat(300 * 1024) }) }), "model_host_bad_reply"], // valid but too large
    [json(200, { ...OK_BODY, output: "plain words, not JSON" }), "model_reply_unusable"],
    [json(200, { ...OK_BODY, output: '{"rationale":"no code here"}' }), "model_reply_unusable"],
    [json(200, { ...OK_BODY, output: '{"rationale":"empty","code":""}' }), "model_reply_unusable"],
    [json(200, { ...OK_BODY, output: '["code"]' }), "model_reply_unusable"],
  ];
  for (const [res, code] of cases) {
    const s = stub(() => res);
    await assert.rejects(make(s.fetchImpl)("s", "u"), (e: unknown) => e instanceof HostModelError && e.code === code, code);
  }
});

test("a fenced JSON reply is accepted, and missing usage stays unknown (null), never zero", async () => {
  const s = stub(() => json(200, { ...OK_BODY, output: '```json\n{"rationale":"r","code":"x = 1"}\n```', usage: null }));
  const out = await make(s.fetchImpl)("s", "u");
  assert.equal(out.json.code, "x = 1");
  assert.equal(out.completion.tokensIn, null);
  assert.equal(out.completion.tokensOut, null);
  const t = stub(() => json(200, { ...OK_BODY, usage: { inputTokens: "1", outputTokens: 2 } }));
  const o2 = await make(t.fetchImpl)("s", "u");
  assert.equal(o2.completion.tokensIn, null);
  assert.equal(o2.completion.tokensOut, 2);
  const n = stub(() => json(200, { ...OK_BODY, usage: { inputTokens: -1, outputTokens: 1.5 } }));
  const o3 = await make(n.fetchImpl)("s", "u");
  assert.equal(o3.completion.tokensIn, null);
  assert.equal(o3.completion.tokensOut, null);
});

test("the round's proposer uses the model call it is given, and reports its usage and model", async () => {
  const { propose, SYSTEM } = await import("../src/lib/gemini");
  const { FAMILIES } = await import("../src/lib/bench/cases");
  const s = stub(() => json(200, OK_BODY));
  const out = await propose({ spec: FAMILIES.dates, currentCode: "def normalize(raw):\n    return raw\n", failures: [], complete: make(s.fetchImpl) });
  assert.equal(s.calls.length, 1);
  assert.ok(JSON.parse(String(s.calls[0].init.body)).messages[0].content.startsWith(SYSTEM));
  assert.equal(out.code, "def normalize(raw):\n    return raw\n");
  assert.equal(out.tokensIn, 120);
  assert.equal(out.tokensOut, 40);
  assert.equal(out.model, "veloce:groq:openai/gpt-oss-120b");
});

test("the grant never appears in an error message", async () => {
  const s = stub(() => json(401, { ok: false, error: "bad_credential" }));
  await assert.rejects(make(s.fetchImpl)("s", "u"), (e: unknown) => !String((e as Error).message).includes("grant-token-made-up"));
});
