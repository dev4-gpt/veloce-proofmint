// Run: npx tsx --test tests/h1.test.ts
// Forge's Veloce h1 surface (Veloce ADR-005, ADR-012, ADR-020) against the REAL SQL in an in-process Postgres (PGlite).
// Host tokens are minted here the way the Veloce host mints them (Ed25519 over the base64url claims); keys are generated per run.
// The round itself is a stand-in: no sandbox, no model and no real data.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, ensureSchema, sql, tryStartRound } from "../src/lib/db";
import { h1Config, H1_ADAPTER_ID, FORGE_TASK, MANIFEST, type H1Config } from "../src/lib/h1/manifest";
import { verifyHostToken } from "../src/lib/h1/token";
import { handleH1, type RoundRunner } from "../src/lib/h1/tasks";
import { executeRound, type RoundJobInput } from "../src/lib/roundJob";
import { priceMicros } from "../src/lib/cost";
import type { Payer } from "../src/lib/payer";
import type { RoundResult } from "../src/lib/round";

let pg: PGlite;
const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
  return (await pg.query(text, values as unknown[])).rows as unknown[];
};
before(async () => {
  pg = new PGlite();
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  __setSqlForTests(tag);
  await ensureSchema();
});

const host = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const TENANT = "tenant-a";
const MODEL_URL = "https://host.example.test/api/adapter-host/model-call";
const NOW = 1_800_000_000;
const PEM = host.publicKey.export({ type: "spki", format: "pem" }).toString();
const config = (): H1Config => ({ tenantSlug: TENANT, publicKeys: [host.publicKey], modelUrl: MODEL_URL, provider: "groq", model: "openai/gpt-oss-120b" });

function mint(scope: unknown, over: Record<string, unknown> = {}, key: KeyObject = host.privateKey): string {
  const claims = { v: "h1", iss: "veloce-host", tenant: TENANT, aud: H1_ADAPTER_ID, scope, jti: randomUUID(), iat: NOW, exp: NOW + 60, ...over };
  const part = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${part}.${sign(null, Buffer.from(part), key).toString("base64url")}`;
}

interface Harness {
  scheduled: (() => Promise<void>)[];
  runs: Parameters<RoundRunner>[0][];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tests read many fields of the parsed JSON reply
  call(op: string, opts?: { method?: string; token?: string | null; body?: unknown; raw?: string; query?: string }): Promise<{ status: number; body: any }>;
  drain(): Promise<void>;
}
function harness(run?: RoundRunner): Harness {
  const scheduled: (() => Promise<void>)[] = [];
  const runs: Parameters<RoundRunner>[0][] = [];
  const runner: RoundRunner = async (job) => {
    runs.push(job);
    return run ? run(job) : { status: "proposed", toolId: "t-dates-" + job.roundId, candidateSha: "a".repeat(64), code: "def normalize(raw):\n    return raw\n", costMicros: 20_010, visible: { candidate: 12, total: 12 }, heldout: { candidate: 10, total: 10 } };
  };
  const deps = { config: config(), schedule: (fn: () => Promise<void>) => void scheduled.push(fn), run: runner, nowSeconds: () => NOW + 1 };
  return {
    scheduled,
    runs,
    async call(op, opts = {}) {
      const method = opts.method ?? (op === "task.run" || op === "task.cancel" ? "POST" : "GET");
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = opts.token === undefined ? mint([op]) : opts.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      const req = new Request(`https://forge.example.test/h1/${op}${opts.query ?? ""}`, { method, headers, body: method === "GET" ? undefined : body });
      const res = await handleH1(req, op, deps);
      return { status: res.status, body: await res.json() };
    },
    async drain() {
      while (scheduled.length) await scheduled.shift()!();
    },
  };
}

const runBody = (over: Record<string, unknown> = {}) => ({
  tenantSlug: TENANT, adapterId: H1_ADAPTER_ID, task: FORGE_TASK, idempotencyKey: "host-task-0001", budgetMaxMicros: 500_000,
  input: { family: "dates" }, modelGrant: { token: "grant-token-made-up", url: MODEL_URL }, ...over,
});
const count = async (table: "h1_tasks" | "rounds" | "h1_used_tokens", where = "true") =>
  ((await pg.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0] as { n: number }).n;

// ---------------- settings ----------------

test("the surface is off unless FORGE_H1_ENABLED is exactly true, and bad settings are refused, not guessed", () => {
  const good = { FORGE_H1_ENABLED: "true", VELOCE_TENANT_SLUG: TENANT, VELOCE_HOST_PUBLIC_KEYS: JSON.stringify([PEM]), VELOCE_HOST_MODEL_URL: MODEL_URL, VELOCE_HOST_MODEL_PROVIDER: "groq", VELOCE_HOST_MODEL: "openai/gpt-oss-120b" };
  const ok = h1Config(good as unknown as NodeJS.ProcessEnv);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.tenantSlug, TENANT);
    assert.equal(ok.config.publicKeys.length, 1);
    assert.equal(ok.config.modelUrl, MODEL_URL);
    assert.equal(ok.config.provider, "groq");
    assert.equal(ok.config.model, "openai/gpt-oss-120b");
  }
  for (const flag of [undefined, "", "1", "TRUE", "yes"]) assert.deepEqual(h1Config({ ...good, FORGE_H1_ENABLED: flag } as unknown as NodeJS.ProcessEnv), { ok: false, reason: "off" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const bad of [
    { VELOCE_TENANT_SLUG: "" }, { VELOCE_TENANT_SLUG: "1bad" }, { VELOCE_TENANT_SLUG: "Tenant" }, { VELOCE_TENANT_SLUG: undefined },
    { VELOCE_HOST_PUBLIC_KEYS: "" }, { VELOCE_HOST_PUBLIC_KEYS: "not json" }, { VELOCE_HOST_PUBLIC_KEYS: "[]" }, { VELOCE_HOST_PUBLIC_KEYS: JSON.stringify([PEM, PEM, PEM, PEM]) },
    { VELOCE_HOST_PUBLIC_KEYS: JSON.stringify(["garbage"]) }, { VELOCE_HOST_PUBLIC_KEYS: JSON.stringify([rsa]) }, { VELOCE_HOST_PUBLIC_KEYS: JSON.stringify([5]) }, { VELOCE_HOST_PUBLIC_KEYS: JSON.stringify(PEM) },
    { VELOCE_HOST_MODEL_URL: "" }, { VELOCE_HOST_MODEL_URL: "http://host.example.test/x" }, { VELOCE_HOST_MODEL_URL: "https://u:p@host.example.test/x" },
    { VELOCE_HOST_MODEL_PROVIDER: "xai" }, { VELOCE_HOST_MODEL_PROVIDER: "" }, { VELOCE_HOST_MODEL: "" }, { VELOCE_HOST_MODEL: "m".repeat(181) },
  ]) {
    assert.deepEqual(h1Config({ ...good, ...bad } as unknown as NodeJS.ProcessEnv), { ok: false, reason: "misconfigured" }, JSON.stringify(bad));
  }
  assert.equal(h1Config({ ...good, VELOCE_HOST_PUBLIC_KEYS: JSON.stringify([PEM, PEM, PEM]) } as unknown as NodeJS.ProcessEnv).ok, true);
  assert.equal(h1Config({ ...good, VELOCE_HOST_MODEL_URL: "http://localhost:3000/api/adapter-host/model-call" } as unknown as NodeJS.ProcessEnv).ok, true);
});

test("the manifest follows the host's h1 rules: draft only, no deletion receipts, the task operations together", () => {
  assert.equal(MANIFEST.contractVersion, "h1");
  assert.equal(MANIFEST.adapterId, "veloce-proofmint");
  assert.equal(MANIFEST.displayName, "Veloce ProofMint");
  assert.match(MANIFEST.adapterId, /^[a-z][a-z0-9-]{2,40}$/);
  for (const op of ["manifest", "health", "task.run", "task.get", "task.cancel", "task.result", "events"]) assert.ok(MANIFEST.operations.includes(op), op);
  assert.ok(!MANIFEST.operations.includes("memory.tombstone"));
  assert.ok(!MANIFEST.operations.includes("memory.propose"));
  assert.equal(new Set(MANIFEST.operations).size, MANIFEST.operations.length);
  assert.equal(MANIFEST.deletionGuarantee, "none");
  assert.equal(MANIFEST.sideEffectCeiling, "draft");
  assert.deepEqual(MANIFEST.tasks, [{ name: "forge.round", sideEffect: "draft" }]);
  assert.match(FORGE_TASK, /^[a-z][a-z0-9._-]{1,63}$/);
});

// ---------------- host tokens ----------------

test("a host token is accepted only with every claim right; each wrong claim is refused the same way", () => {
  const check = (token: unknown, op = "task.get", now = NOW + 1) => verifyHostToken({ token, publicKeys: [host.publicKey], tenant: TENANT, adapterId: H1_ADAPTER_ID, operation: op, now });
  assert.ok(check(mint(["task.get"])));
  assert.ok(check(mint(["task.run", "task.get"])));
  const bad: [unknown, string?, number?][] = [
    [mint(["task.get"], {}, other.privateKey)],
    [mint(["task.get"], { v: "h2" })],
    [mint(["task.get"], { v: "mg1" })],
    [mint(["task.get"], { iss: "someone" })],
    [mint(["task.get"], { tenant: "tenant-b" })],
    [mint(["task.get"], { aud: "creator-os" })],
    [mint(["task.run"])],
    [mint("task.get")],
    [mint({ 0: "task.get", length: 1 })],
    [mint([1])],
    [mint(["task.get", 1])],
    [mint(["task.get"], { iat: NOW + 20, exp: NOW + 10 })], // expires before it was issued, though still in the future
    [mint(["task.get"], { jti: "not-a-uuid" })],
    [mint(["task.get"], { jti: 5 })],
    [mint(["task.get"], { iat: NOW, exp: NOW + 301 })],
    [mint(["task.get"], { iat: NOW, exp: NOW })],
    [mint(["task.get"], { iat: NOW + 40, exp: NOW + 100 })],
    [mint(["task.get"], { iat: NOW + 0.5 })],
    [mint(["task.get"], { iat: "x" })],
    [mint(["task.get"]), "task.get", NOW + 61],
    [mint(["task.get"]), "task.get", NOW + 60],
    [undefined], [""], ["a.b.c"], ["only-one-part"], [5], ["x".repeat(5000)],
    // a changed signature byte (the first signature character; the last one only carries padding bits)
    [(() => { const [p, s] = mint(["task.get"]).split("."); return `${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`; })()],
    // a changed claims part under the original signature
    [(() => { const [, s] = mint(["task.get"]).split("."); return `${Buffer.from(JSON.stringify({ v: "h1" })).toString("base64url")}.${s}`; })()],
    [Buffer.from("[1,2]").toString("base64url") + "." + sign(null, Buffer.from(Buffer.from("[1,2]").toString("base64url")), host.privateKey).toString("base64url")],
  ];
  for (const [token, op, now] of bad) assert.equal(check(token, op, now), null, String(token).slice(0, 60));
  // a little clock skew is allowed
  assert.ok(check(mint(["task.get"], { iat: NOW + 25, exp: NOW + 80 })));
  // a rotated key is accepted when listed
  assert.ok(verifyHostToken({ token: mint(["task.get"], {}, other.privateKey), publicKeys: [host.publicKey, other.publicKey], tenant: TENANT, adapterId: H1_ADAPTER_ID, operation: "task.get", now: NOW + 1 }));
  assert.throws(() => verifyHostToken({ token: mint(["task.get"]), publicKeys: [], tenant: TENANT, adapterId: H1_ADAPTER_ID, operation: "task.get", now: NOW }));
});

test("every route needs a host token; a missing, wrong or replayed token gets one answer", async () => {
  const h = harness();
  const unauthorized = { status: 401, body: { ok: false, error: "unauthorized" } };
  assert.deepEqual(await h.call("health", { token: null }), unauthorized);
  assert.deepEqual(await h.call("health", { token: mint(["manifest"]) }), unauthorized);
  assert.deepEqual(await h.call("manifest", { token: mint(["manifest"], {}, other.privateKey) }), unauthorized);
  const once = mint(["health"]);
  assert.deepEqual(await h.call("health", { token: once }), { status: 200, body: { ok: true } });
  assert.deepEqual(await h.call("health", { token: once }), unauthorized);
  const m = await h.call("manifest");
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, JSON.parse(JSON.stringify(MANIFEST)));
  // used token ids are kept until they expire
  const rows = (await sql()`select jti, exp from h1_used_tokens`) as { exp: string | number }[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => Number(r.exp) === NOW + 60));
  // and forgotten once expired
  await sql()`update h1_used_tokens set exp = ${NOW - 10}`;
  assert.equal((await h.call("health")).status, 200);
  assert.equal(await count("h1_used_tokens"), 1);
});

test("unknown operations and wrong methods are 404 before any token is looked at", async () => {
  const h = harness();
  assert.equal((await h.call("memory.tombstone", { method: "POST", body: {} })).status, 404);
  assert.equal((await h.call("approve", { method: "POST", body: {} })).status, 404);
  assert.equal((await h.call("toString", { method: "GET" })).status, 404);
  assert.equal((await h.call("task.run", { method: "GET" })).status, 404);
  assert.equal((await h.call("task.get", { method: "POST", body: {} })).status, 404);
  assert.equal(await count("h1_used_tokens"), 0);
});

// ---------------- task.run ----------------

test("task.run starts one round in the background with the host's grant, and keeps the grant out of the database", async () => {
  const realFetch = globalThis.fetch;
  const h = harness();
  const r = await h.call("task.run", { body: runBody() });
  assert.equal(r.status, 202);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.state, "running");
  assert.match(r.body.taskId, /^ft-[0-9a-f]{24}$/);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.runs.length, 0); // nothing ran before the reply
  assert.equal(await count("rounds", "status = 'running'"), 1); // the single round slot is claimed at once
  const dump = JSON.stringify(await sql()`select * from h1_tasks`) + JSON.stringify(await sql()`select * from rounds`) + JSON.stringify(await sql()`select * from h1_events`);
  assert.ok(!dump.includes("grant-token-made-up"));
  const seen: { url: string; auth: string | null }[] = [];
  const seenBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    seenBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, output: '{"rationale":"r","code":"x = 1"}', usage: { inputTokens: 1, outputTokens: 1 }, costMicros: 1, call: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await h.drain();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].family, "dates");
    assert.match(h.runs[0].roundId, /^r-[0-9a-f]{8}$/);
    const answer = await h.runs[0].complete("s", "u");
    assert.equal(answer.json.code, "x = 1");
    assert.deepEqual(seen, [{ url: MODEL_URL, auth: "Bearer grant-token-made-up" }]);
    assert.equal(seenBodies[0].taskKey, "host-task-0001"); // the host's own key, which its grant is bound to
    assert.equal(seenBodies[0].provider, "groq");
    assert.equal(seenBodies[0].model, "openai/gpt-oss-120b");
  } finally {
    globalThis.fetch = realFetch;
  }
  const afterRun = JSON.stringify(await sql()`select * from h1_tasks`) + JSON.stringify(await sql()`select * from h1_events`) + JSON.stringify(await sql()`select * from rounds`);
  assert.ok(!afterRun.includes("grant-token-made-up"));
});

test("task.run refuses anything but the exact request, and never starts a round for it", async () => {
  const h = harness();
  const cases: [unknown, number, string][] = [
    [{ ...runBody(), requester: "someone" }, 400, "invalid_input"],
    [{ ...runBody(), approver: "someone" }, 400, "invalid_input"],
    [runBody({ tenantSlug: "tenant-b" }), 403, "forbidden"],
    [runBody({ adapterId: "creator-os" }), 403, "forbidden"],
    [runBody({ task: "content.draft" }), 400, "unknown_task"],
    [runBody({ idempotencyKey: "short" }), 400, "invalid_input"],
    [runBody({ idempotencyKey: "has/slash/in-it" }), 400, "invalid_input"],
    [runBody({ idempotencyKey: "k".repeat(121) }), 400, "invalid_input"],
    [runBody({ idempotencyKey: 12345678 }), 400, "invalid_input"],
    [runBody({ budgetMaxMicros: 0 }), 400, "invalid_input"],
    [runBody({ budgetMaxMicros: 1.5 }), 400, "invalid_input"],
    [runBody({ budgetMaxMicros: "5" }), 400, "invalid_input"],
    [runBody({ input: { family: "nope" } }), 400, "invalid_input"],
    [runBody({ input: { family: "dates", cheat: true } }), 400, "invalid_input"],
    [runBody({ input: "dates" }), 400, "invalid_input"],
    [runBody({ input: { family: "toString" } }), 400, "invalid_input"],
    [runBody({ modelGrant: undefined }), 400, "model_grant_required"],
    [runBody({ modelGrant: { token: "grant-token-made-up", url: "https://elsewhere.example.test/model-call" } }), 400, "invalid_input"],
    [runBody({ modelGrant: { token: "grant-token-made-up", url: MODEL_URL, extra: 1 } }), 400, "invalid_input"],
    [runBody({ modelGrant: { token: "", url: MODEL_URL } }), 400, "invalid_input"],
    [runBody({ modelGrant: { token: "t".repeat(4097), url: MODEL_URL } }), 400, "invalid_input"],
    [runBody({ modelGrant: { token: 5, url: MODEL_URL } }), 400, "invalid_input"],
    [runBody({ modelGrant: "grant" }), 400, "invalid_input"],
    [[], 400, "invalid_input"],
    [null, 400, "invalid_input"],
  ];
  for (const [body, status, error] of cases) {
    const r = await h.call("task.run", { body });
    assert.deepEqual(r, { status, body: { ok: false, error } }, JSON.stringify(body));
  }
  assert.deepEqual(await h.call("task.run", { raw: "{not json" }), { status: 400, body: { ok: false, error: "invalid_input" } });
  assert.deepEqual(await h.call("task.run", { raw: JSON.stringify({ ...runBody(), pad: "x".repeat(70 * 1024) }) }), { status: 413, body: { ok: false, error: "too_large" } });
  assert.equal(h.scheduled.length, 0);
  assert.equal(await count("h1_tasks"), 0);
  assert.equal(await count("rounds"), 0);
});

test("the same key and request replays the task; the same key with another request is a conflict", async () => {
  const h = harness();
  const first = await h.call("task.run", { body: runBody() });
  const again = await h.call("task.run", { body: runBody() });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, taskId: first.body.taskId, state: "running", replay: true });
  // the grant may be re-sent with a retry; it is not part of what the task is
  assert.equal((await h.call("task.run", { body: runBody({ modelGrant: { token: "another-made-up-grant", url: MODEL_URL } }) })).status, 200);
  assert.deepEqual(await h.call("task.run", { body: runBody({ input: { family: "money" } }) }), { status: 409, body: { ok: false, error: "idempotency_conflict" } });
  assert.deepEqual(await h.call("task.run", { body: runBody({ budgetMaxMicros: 400_000 }) }), { status: 409, body: { ok: false, error: "idempotency_conflict" } });
  assert.equal(h.scheduled.length, 1);
  await h.drain();
  const done = await h.call("task.run", { body: runBody() });
  assert.deepEqual(done.body, { ok: true, taskId: first.body.taskId, state: "succeeded", replay: true });
});

test("while another round runs, task.run answers busy and records nothing, so the same key can be sent again later", async () => {
  assert.equal(await tryStartRound("r-page0001", "money", "someone"), true);
  const h = harness();
  assert.deepEqual(await h.call("task.run", { body: runBody() }), { status: 503, body: { ok: false, error: "busy" } });
  assert.equal(await count("h1_tasks"), 0);
  await sql()`update rounds set status = 'proposed' where id = 'r-page0001'`;
  assert.equal((await h.call("task.run", { body: runBody() })).status, 202);
});

// ---------------- task.get, task.result, events ----------------

test("a finished round becomes a succeeded task with a result and exactly one final event", async () => {
  const h = harness();
  const { body } = await h.call("task.run", { body: runBody() });
  const id = body.taskId as string;
  const running = await h.call("task.get", { query: `?id=${id}` });
  assert.equal(running.status, 200);
  assert.equal(running.body.state, "running");
  assert.deepEqual(await h.call("task.result", { query: `?id=${id}` }), { status: 409, body: { ok: false, error: "not_ready" } });
  await h.drain();
  const done = await h.call("task.get", { query: `?id=${id}` });
  assert.equal(done.body.state, "succeeded");
  assert.equal(done.body.taskId, id);
  assert.equal(done.body.task, FORGE_TASK);
  assert.equal(done.body.family, "dates");
  const result = await h.call("task.result", { query: `?id=${id}` });
  assert.equal(result.status, 200);
  assert.equal(result.body.verdict, "proposed");
  assert.equal(result.body.needsApproval, true);
  assert.equal(result.body.code, "def normalize(raw):\n    return raw\n");
  assert.equal(result.body.candidateSha, "a".repeat(64));
  assert.equal(result.body.costMicros, 20_010);
  const page = await h.call("events");
  assert.equal(page.status, 200);
  assert.equal(page.body.events.length, 1);
  const e = page.body.events[0];
  assert.equal(e.kind, "task.state");
  assert.equal(e.taskId, id);
  assert.equal(e.data.state, "succeeded");
  assert.ok(!("spentMicros" in e.data)); // the host's ledger holds the model cost; Forge does not report it
  assert.match(e.id, /^[0-9a-f]{32}$/);
  assert.equal(typeof e.seq, "number");
  assert.equal(page.body.next, e.seq);
  assert.equal(page.body.hasMore, false);
  const none = await h.call("events", { query: `?after=${page.body.next}` });
  assert.deepEqual(none.body, { ok: true, events: [], next: page.body.next, hasMore: false });
});

test("a round that ends without a verdict, or throws, is a failed task with a short code and frees the round slot", async () => {
  for (const [run, error] of [
    [async () => ({ status: "blocked_unsettled", toolId: null, candidateSha: null, code: null, costMicros: null, visible: null, heldout: null }), "blocked_unsettled"],
    [async () => ({ status: "refused", toolId: null, candidateSha: null, code: null, costMicros: null, visible: null, heldout: null }), "refused"],
    [async () => ({ status: "error", toolId: null, candidateSha: null, code: null, costMicros: null, visible: null, heldout: null }), "round_error"],
    [async () => { throw new Error("secret detail that must not leak"); }, "round_error"],
  ] as [RoundRunner, string][]) {
    await pg.exec("drop schema public cascade; create schema public;");
    __setSqlForTests(tag);
    await ensureSchema();
    const h = harness(run);
    const { body } = await h.call("task.run", { body: runBody() });
    await h.drain();
    const got = await h.call("task.get", { query: `?id=${body.taskId}` });
    assert.equal(got.body.state, "failed");
    assert.equal(got.body.error, error);
    assert.ok(!JSON.stringify(got.body).includes("secret detail"));
    const page = await h.call("events");
    assert.equal(page.body.events.length, 1);
    assert.equal(page.body.events[0].data.state, "failed");
    assert.deepEqual(await h.call("task.result", { query: `?id=${body.taskId}` }), { status: 409, body: { ok: false, error: "not_ready" } });
    assert.equal(await count("rounds", "status = 'running'"), 0);
  }
});

test("a task still running after the function limit reads as failed (timed_out), once", async () => {
  const h = harness();
  const { body } = await h.call("task.run", { body: runBody() });
  await sql()`update h1_tasks set created_at = now() - interval '331 seconds'`;
  const got = await h.call("task.get", { query: `?id=${body.taskId}` });
  assert.equal(got.body.state, "failed");
  assert.equal(got.body.error, "timed_out");
  await h.call("task.get", { query: `?id=${body.taskId}` });
  assert.equal((await h.call("events")).body.events.length, 1);
  // a round finishing after that cannot overwrite the recorded failure
  await h.drain();
  assert.equal((await h.call("task.get", { query: `?id=${body.taskId}` })).body.state, "failed");
  assert.equal((await h.call("events")).body.events.length, 1);
});

test("a task 329 seconds old is still running, and the events feed also notices timed-out tasks", async () => {
  const h = harness();
  const { body } = await h.call("task.run", { body: runBody() });
  await sql()`update h1_tasks set created_at = now() - interval '329 seconds'`;
  assert.equal((await h.call("task.get", { query: `?id=${body.taskId}` })).body.state, "running");
  await sql()`update h1_tasks set created_at = now() - interval '400 seconds'`;
  const page = await h.call("events");
  assert.equal(page.body.events.length, 1);
  assert.equal(page.body.events[0].data.state, "failed");
});

test("task.get, task.result and task.cancel check their input and hide unknown tasks", async () => {
  const h = harness();
  const { body } = await h.call("task.run", { body: runBody() });
  for (const op of ["task.get", "task.result"]) {
    assert.deepEqual(await h.call(op, { query: "?id=ft-000000000000000000000000" }), { status: 404, body: { ok: false, error: "not_found" } });
    assert.deepEqual(await h.call(op, { query: "" }), { status: 404, body: { ok: false, error: "not_found" } });
    assert.deepEqual(await h.call(op, { query: `?id=${body.taskId}&id=${body.taskId}` }), { status: 400, body: { ok: false, error: "invalid_input" } });
    assert.deepEqual(await h.call(op, { query: `?id=${body.taskId}&x=1` }), { status: 400, body: { ok: false, error: "invalid_input" } });
  }
  // a running round cannot be stopped part way; the answer says so
  assert.deepEqual(await h.call("task.cancel", { body: { id: body.taskId } }), { status: 200, body: { ok: true, taskId: body.taskId, cancelled: false } });
  assert.deepEqual(await h.call("task.cancel", { body: { id: "ft-000000000000000000000000" } }), { status: 404, body: { ok: false, error: "not_found" } });
  assert.deepEqual(await h.call("task.cancel", { body: { id: body.taskId, extra: 1 } }), { status: 400, body: { ok: false, error: "invalid_input" } });
  assert.deepEqual(await h.call("task.cancel", { body: { id: 5 } }), { status: 400, body: { ok: false, error: "invalid_input" } });
  assert.deepEqual(await h.call("task.cancel", { raw: "nope" }), { status: 400, body: { ok: false, error: "invalid_input" } });
});

test("the events feed checks after and limit, pages in order, and says when more is waiting", async () => {
  const h = harness();
  for (const q of ["?after=-1", "?after=x", "?limit=0", "?limit=101", "?after=1&after=2", "?other=1", "?limit=1.5", "?after=1000000000"]) {
    assert.deepEqual(await h.call("events", { query: q }), { status: 400, body: { ok: false, error: "invalid_input" } }, q);
  }
  for (const key of ["host-task-0001", "host-task-0002", "host-task-0003"]) {
    await h.call("task.run", { body: runBody({ idempotencyKey: key }) });
    await h.drain();
  }
  const first = await h.call("events", { query: "?limit=2" });
  assert.equal(first.body.events.length, 2);
  assert.equal(first.body.hasMore, true);
  assert.ok(first.body.events[0].seq < first.body.events[1].seq);
  assert.equal(first.body.next, first.body.events[1].seq);
  const rest = await h.call("events", { query: `?after=${first.body.next}&limit=2` });
  assert.equal(rest.body.events.length, 1);
  assert.equal(rest.body.hasMore, false);
  assert.equal(rest.body.next, rest.body.events[0].seq);
  assert.equal((await h.call("events", { query: "?limit=100" })).body.events.length, 3);
  const exact = await h.call("events", { query: "?limit=3" });
  assert.equal(exact.body.events.length, 3);
  assert.equal(exact.body.hasMore, false); // exactly a full page, nothing more waiting
});

test("a rejected round is a finished task that needs no approval", async () => {
  const h = harness(async () => ({ status: "rejected", toolId: "t-dates-x", candidateSha: "d".repeat(64), code: "y = 2", costMicros: 20_000, visible: null, heldout: null }));
  const { body } = await h.call("task.run", { body: runBody() });
  await h.drain();
  const result = await h.call("task.result", { query: `?id=${body.taskId}` });
  assert.equal(result.body.verdict, "rejected");
  assert.equal(result.body.needsApproval, false);
});

test("a host-started round is paid from Forge's wallet for sandbox time and the fee only", async () => {
  const { runHostRound } = await import("../src/lib/roundJob");
  const { credit, getWallet } = await import("../src/lib/db");
  await credit("test-topup-1", 1_000_000, "made-up credits");
  await tryStartRound("r-host0001", "dates", "veloce-host");
  const complete = async () => { throw new Error("not called by the stand-in"); };
  const seen: unknown[] = [];
  const out = await runHostRound({
    roundId: "r-host0001", family: "dates", complete,
    runRoundImpl: async (opts) => { seen.push(opts.complete); opts.emit?.({ type: "sandbox_created", id: "sb" }); return fakeResult(); },
  });
  const sandboxOnly = priceMicros({ tokensIn: 0, tokensOut: 0, execMs: 100 });
  assert.equal(out.status, "proposed");
  assert.equal(out.costMicros, sandboxOnly);
  assert.deepEqual(seen, [complete]);
  assert.equal((await getWallet()).balance, 1_000_000 - sandboxOnly);
  const report = (await sql()`select body_json from report_chain order by seq desc limit 1`) as { body_json: string }[];
  assert.equal(JSON.parse(report[0].body_json).startedBy, "veloce-host");
});

// ---------------- the round flow shared by the page and h1 ----------------

const fakeResult = (over: Partial<RoundResult> = {}): RoundResult => ({
  verdict: "proposed", family: "dates", candidate: { code: "x = 1", sha: "b".repeat(64), rationale: "r" },
  visible: { current: 10, candidate: 12, total: 12 }, heldout: { current: 8, candidate: 10, total: 10 }, gate: { passed: true, reasons: [] } as never,
  heldoutSha: "c".repeat(64), heldoutPass: Array(10).fill(true), currentHeldoutPass: Array(10).fill(false), currentVisibleCount: 10,
  usage: { tokensIn: 1000, tokensOut: 1000, execMs: 100, unknown: false }, attempts: 1, ...over,
});
function fakePayer(authorizeOk = true) {
  const log: unknown[][] = [];
  const payer: Payer = {
    mode: "wallet",
    async authorize() {
      log.push(["authorize"]);
      return authorizeOk ? { ok: true, capMicros: 250_000, event: { type: "reserved" } } : { ok: false, reason: "insufficient_funds", detail: "no credits" };
    },
    async settle(actual, billable) {
      log.push(["settle", actual, billable]);
      return actual === null ? { kind: "blocked", reason: "unknown" } : { kind: "settled", costMicros: actual, releasedMicros: 250_000 - actual };
    },
    async releaseUnused() { log.push(["release"]); },
    async block(note) { log.push(["block", note]); },
    async info() { return { mode: "wallet", paymentIntent: null, holdState: null, capturedCents: null }; },
  };
  return { payer, log };
}
async function job(over: Partial<RoundJobInput>, result: () => Promise<RoundResult>) {
  await pg.exec("delete from rounds");
  await tryStartRound("r-job00001", "dates", "veloce-host");
  const events: { type: string }[] = [];
  const seenOpts: unknown[] = [];
  const outcome = await executeRound({
    roundId: "r-job00001", family: "dates", startedBy: "veloce-host", payer: fakePayer().payer, send: (e) => void events.push(e),
    runRoundImpl: async (opts) => { seenOpts.push(opts); opts.emit?.({ type: "sandbox_created", id: "sb-made-up" }); return result(); },
    ...over,
  });
  return { outcome, events, seenOpts };
}

test("when the host pays for models, the round is charged sandbox time and the fee only", async () => {
  const p = fakePayer();
  const complete = async () => { throw new Error("not called by the stand-in"); };
  const { outcome, seenOpts } = await job({ payer: p.payer, modelsPaidByHost: true, complete }, async () => fakeResult());
  const sandboxOnly = priceMicros({ tokensIn: 0, tokensOut: 0, execMs: 100 });
  assert.deepEqual(p.log.find((l) => l[0] === "settle"), ["settle", sandboxOnly, true]);
  assert.equal(priceMicros({ tokensIn: 1000, tokensOut: 1000, execMs: 100 }, { modelsPaidByHost: true }), sandboxOnly);
  assert.ok(priceMicros({ tokensIn: 1000, tokensOut: 1000, execMs: 100 }) > sandboxOnly);
  assert.equal(outcome.status, "proposed");
  assert.equal(outcome.costMicros, sandboxOnly);
  assert.equal(outcome.code, "x = 1");
  assert.equal(outcome.candidateSha, (await import("../src/lib/bench/cases")).sha256("x = 1"));
  assert.equal((seenOpts[0] as { complete?: unknown }).complete, complete);
  const tool = (await sql()`select status from tools where round_id = 'r-job00001'`) as { status: string }[];
  assert.deepEqual(tool.map((t) => t.status), ["proposed"]);
  assert.equal(((await sql()`select status from rounds where id = 'r-job00001'`) as { status: string }[])[0].status, "proposed");
  // when the host pays, missing model usage does not block the round, but missing sandbox time still does
  const q = fakePayer();
  await pg.exec("delete from tools where round_id = 'r-job00001'");
  await job({ payer: q.payer, modelsPaidByHost: true }, async () => fakeResult({ usage: { tokensIn: null, tokensOut: null, execMs: 100, unknown: true } }));
  assert.deepEqual(q.log.find((l) => l[0] === "settle"), ["settle", sandboxOnly, true]);
  const r = fakePayer();
  await pg.exec("delete from tools where round_id = 'r-job00001'");
  const blocked = await job({ payer: r.payer, modelsPaidByHost: true }, async () => fakeResult({ usage: { tokensIn: 5, tokensOut: 5, execMs: null, unknown: true } }));
  assert.deepEqual(r.log.find((l) => l[0] === "settle"), ["settle", null, true]);
  assert.equal(blocked.outcome.status, "blocked_unsettled");
});

test("the page's own rounds are still charged for their model tokens, and unknown usage still blocks them", async () => {
  const p = fakePayer();
  await job({ payer: p.payer }, async () => fakeResult());
  assert.deepEqual(p.log.find((l) => l[0] === "settle"), ["settle", priceMicros({ tokensIn: 1000, tokensOut: 1000, execMs: 100 }), true]);
  const q = fakePayer();
  await pg.exec("delete from tools where round_id = 'r-job00001'");
  await job({ payer: q.payer }, async () => fakeResult({ usage: { tokensIn: null, tokensOut: null, execMs: 100, unknown: true } }));
  assert.deepEqual(q.log.find((l) => l[0] === "settle"), ["settle", null, true]);
  const s = fakePayer();
  await pg.exec("delete from tools where round_id = 'r-job00001'");
  await job({ payer: s.payer, simulateMissingUsage: true }, async () => fakeResult());
  assert.deepEqual(s.log.find((l) => l[0] === "settle"), ["settle", null, true]);
});

test("a refused payment runs nothing; a failure before the sandbox releases the hold; after it, the hold is kept", async () => {
  const refused = fakePayer(false);
  let ran = false;
  await tryStartRound("r-job00002", "dates", "x");
  const out = await executeRound({ roundId: "r-job00002", family: "dates", startedBy: "x", payer: refused.payer, send: () => {}, runRoundImpl: async () => { ran = true; return fakeResult(); } });
  assert.equal(ran, false);
  assert.equal(out.status, "refused");
  assert.equal(((await sql()`select status from rounds where id = 'r-job00002'`) as { status: string }[])[0].status, "refused");

  const early = fakePayer();
  await tryStartRound("r-job00003", "dates", "x");
  const e1 = await executeRound({ roundId: "r-job00003", family: "dates", startedBy: "x", payer: early.payer, send: () => {}, runRoundImpl: async () => { throw new Error("before any sandbox"); } });
  assert.equal(e1.status, "error");
  assert.ok(early.log.some((l) => l[0] === "release"));
  assert.ok(!early.log.some((l) => l[0] === "block"));

  const late = fakePayer();
  await tryStartRound("r-job00004", "dates", "x");
  const e2 = await executeRound({
    roundId: "r-job00004", family: "dates", startedBy: "x", payer: late.payer, send: () => {},
    runRoundImpl: async (opts) => { opts.emit?.({ type: "sandbox_created", id: "sb" }); throw new Error("after the sandbox"); },
  });
  assert.equal(e2.status, "error");
  assert.ok(late.log.some((l) => l[0] === "block"));
  assert.ok(!late.log.some((l) => l[0] === "release"));
  assert.equal(await count("rounds", "status = 'running'"), 0);
});
