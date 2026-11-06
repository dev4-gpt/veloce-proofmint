// Forge's Veloce h1 surface (Veloce ADR-005, ADR-020): manifest, health, task.run, task.get, task.result, task.cancel, events.
// Every operation needs a single-use host token; every refusal is a short code. The host starts a `proofmint.round` task with a model
// grant; the round then runs after the reply (Vercel `after()`), and every model answer comes from the host with that grant
// (veloceModel.ts). The grant stays in memory: it is never written to the database. A round still running after the function
// limit is recorded as failed (`timed_out`), so the host's feed always ends with a final state.
import { createHash, randomUUID } from "node:crypto";
import { FAMILIES, type Family } from "../bench/cases";
import { ROUND_CAP_MICROS } from "../cost";
import { ensureSchema, sql, tryStartRound } from "../db";
import type { Completer } from "../llm";
import type { RoundOutcome } from "../roundJob";
import { hostCompleter, validGrantToken } from "../veloceModel";
import { FORGE_TASK, MANIFEST, type H1Config } from "./manifest";
import { consumeJti, verifyHostToken } from "./token";

export const MAX_BODY_BYTES = 64 * 1024;
/** The function limit is 300 s; a task still running a little after that can no longer finish. */
export const STALE_SECONDS = 330;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;
const MAX_CURSOR = 999_999_999;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const TASK_ID = /^ft-[0-9a-f]{24}$/;
const RUN_FIELDS = ["tenantSlug", "adapterId", "task", "idempotencyKey", "budgetMaxMicros", "input", "modelGrant"] as const;
const FAILED_CODES = new Set(["blocked_unsettled", "refused"]);
const SUCCEEDED = new Set(["proposed", "rejected"]);
const STARTED_BY = "veloce-host";

export type RoundRunner = (job: { roundId: string; family: Family; complete: Completer }) => Promise<RoundOutcome>;
export interface H1Deps {
  config: H1Config;
  /** Runs work after the reply has been sent (Vercel/Next `after`). */
  schedule: (fn: () => Promise<void>) => void;
  run: RoundRunner;
  nowSeconds?: () => number;
}

type Op = "manifest" | "health" | "task.run" | "task.get" | "task.result" | "task.cancel" | "events";
const ROUTES: Record<string, Op> = {
  "GET manifest": "manifest",
  "GET health": "health",
  "GET events": "events",
  "POST task.run": "task.run",
  "GET task.get": "task.get",
  "GET task.result": "task.result",
  "POST task.cancel": "task.cancel",
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: Json, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const send = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const fail = (status: number, error: string) => send(status, { ok: false, error });

interface TaskRow {
  task_id: string;
  idem_key: string;
  request_sha: string;
  family: string;
  round_id: string;
  state: string;
  result_json: string | null;
  error: string | null;
  created_at: unknown;
  finished_at: unknown;
  spent_micros: unknown;
}

/** What a finished round charged the wallet, for the host to settle the budget it set aside. Nothing charged on a refused
 *  payment; a cost that is unknown (held, blocked, lost or timed out) is reported as the full cap, never as zero. */
function spentOf(outcome: RoundOutcome | null): number {
  if (outcome?.status === "refused") return 0;
  return outcome?.costMicros ?? ROUND_CAP_MICROS;
}

function view(row: TaskRow) {
  return {
    taskId: row.task_id,
    task: FORGE_TASK,
    state: row.state,
    family: row.family,
    createdAt: iso(row.created_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.spent_micros === null || row.spent_micros === undefined ? {} : { spentMicros: Number(row.spent_micros) }),
  };
}

async function appendFinal(row: TaskRow): Promise<void> {
  const id = sha(`${row.task_id}|task.state|final`).slice(0, 32);
  await sql()`insert into h1_events(id, kind, task_id, data_json) values (${id}, 'task.state', ${row.task_id}, ${JSON.stringify(view(row))}) on conflict (id) do nothing`;
}

/** Tasks past the function limit become failed (timed_out), once, each with its final event. */
async function sweepStale(): Promise<void> {
  const rows = (await sql()`update h1_tasks set state = 'failed', error = 'timed_out', spent_micros = ${ROUND_CAP_MICROS}, finished_at = now() where state = 'running' and created_at < now() - (${STALE_SECONDS}::int * interval '1 second') returning *`) as TaskRow[];
  for (const row of rows) await appendFinal(row);
}

async function getTask(taskId: string): Promise<TaskRow | null> {
  const rows = (await sql()`select * from h1_tasks where task_id = ${taskId}`) as TaskRow[];
  return rows[0] ?? null;
}

/** Compare-and-set from running: a task already recorded as failed (timed out) is never overwritten. */
async function finishTask(taskId: string, state: "succeeded" | "failed", result: Json | null, error: string | null, spent: number): Promise<void> {
  const rows = (await sql()`update h1_tasks set state = ${state}, result_json = ${result ? JSON.stringify(result) : null}, error = ${error}, spent_micros = ${spent}, finished_at = now() where task_id = ${taskId} and state = 'running' returning *`) as TaskRow[];
  if (rows[0]) await appendFinal(rows[0]);
}

async function runTask(taskId: string, roundId: string, family: Family, complete: Completer, run: RoundRunner): Promise<void> {
  let outcome: RoundOutcome | null = null;
  try {
    outcome = await run({ roundId, family, complete });
  } catch {
    outcome = null; // the cause is not recorded: it may hold text from a provider
  }
  // The round normally frees the single round slot itself; make sure it is free whatever happened.
  await sql()`update rounds set status = ${outcome?.status ?? "error"} where id = ${roundId} and status = 'running'`;
  if (outcome && SUCCEEDED.has(outcome.status)) {
    const result = {
      verdict: outcome.status, needsApproval: outcome.status === "proposed", toolId: outcome.toolId, candidateSha: outcome.candidateSha,
      code: outcome.code, costMicros: outcome.costMicros, visible: outcome.visible, heldout: outcome.heldout,
    };
    return finishTask(taskId, "succeeded", result, null, spentOf(outcome));
  }
  const error = outcome && FAILED_CODES.has(outcome.status) ? outcome.status : "round_error";
  return finishTask(taskId, "failed", null, error, spentOf(outcome));
}

async function readJson(req: Request): Promise<{ tooLarge: true } | { json: unknown }> {
  const text = await req.text().catch(() => null);
  if (text === null) return { json: undefined };
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { tooLarge: true };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { json: undefined };
  }
}

/** undefined = no grant sent; null = a grant that is not exactly { token, url }. */
function grantOf(value: unknown): { token: string; url: string } | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !onlyKeys(value, ["token", "url"])) return null;
  const { token, url } = value;
  if (!validGrantToken(token) || typeof url !== "string") return null;
  return { token, url };
}

async function taskRun(body: unknown, deps: H1Deps): Promise<Response> {
  if (!isObject(body) || !onlyKeys(body, RUN_FIELDS)) return fail(400, "invalid_input"); // also refuses any requester or approver field
  if (body.tenantSlug !== deps.config.tenantSlug || body.adapterId !== MANIFEST.adapterId) return fail(403, "forbidden");
  if (body.task !== FORGE_TASK) return fail(400, "unknown_task");
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) return fail(400, "invalid_input");
  const micros = body.budgetMaxMicros;
  if (typeof micros !== "number" || !Number.isSafeInteger(micros) || micros < 1) return fail(400, "invalid_input");
  if (micros < ROUND_CAP_MICROS) return fail(400, "budget_too_low"); // the host set aside less than one round can cost
  const input = body.input;
  if (!isObject(input) || !onlyKeys(input, ["family"]) || typeof input.family !== "string" || !Object.hasOwn(FAMILIES, input.family)) return fail(400, "invalid_input");
  const family = input.family as Family;
  const grant = grantOf(body.modelGrant);
  if (grant === undefined) return fail(400, "model_grant_required");
  // the grant must name the host address configured here; the address in a request is never called
  if (grant === null || grant.url !== deps.config.modelUrl) return fail(400, "invalid_input");

  // What the task is (the grant is not part of it: a retry may carry a fresh one).
  const requestSha = sha(JSON.stringify({ task: FORGE_TASK, family, budgetMaxMicros: micros }));
  const taskId = "ft-" + sha(key).slice(0, 24);
  await sweepStale();
  const existing = await getTask(taskId);
  if (existing) {
    if (existing.request_sha !== requestSha) return fail(409, "idempotency_conflict");
    return send(200, { ok: true, taskId, state: existing.state, replay: true });
  }
  const roundId = "r-" + randomUUID().slice(0, 8);
  if (!(await tryStartRound(roundId, family, STARTED_BY))) return fail(503, "busy"); // nothing recorded: the same key is safe to send again
  const inserted = await sql()`insert into h1_tasks(task_id, idem_key, request_sha, family, round_id, state) values (${taskId}, ${key}, ${requestSha}, ${family}, ${roundId}, 'running') on conflict do nothing returning task_id`;
  if (inserted.length !== 1) {
    await sql()`update rounds set status = 'abandoned' where id = ${roundId} and status = 'running'`; // a concurrent start won
    return fail(409, "idempotency_conflict");
  }
  const complete = hostCompleter({ url: deps.config.modelUrl, provider: deps.config.provider, model: deps.config.model, token: grant.token, taskKey: key });
  deps.schedule(() => runTask(taskId, roundId, family, complete, deps.run));
  return send(202, { ok: true, taskId, state: "running" });
}

/** The one task id in the query, or a refusal. Only `id` is accepted. */
async function taskFromQuery(url: URL): Promise<TaskRow | Response> {
  for (const k of url.searchParams.keys()) if (k !== "id") return fail(400, "invalid_input");
  const ids = url.searchParams.getAll("id");
  if (ids.length > 1) return fail(400, "invalid_input");
  const id = ids[0] ?? "";
  if (!TASK_ID.test(id)) return fail(404, "not_found");
  await sweepStale();
  return (await getTask(id)) ?? fail(404, "not_found");
}

async function taskGet(url: URL): Promise<Response> {
  const row = await taskFromQuery(url);
  return row instanceof Response ? row : send(200, { ok: true, ...view(row) });
}

async function taskResult(url: URL): Promise<Response> {
  const row = await taskFromQuery(url);
  if (row instanceof Response) return row;
  if (row.state !== "succeeded" || !row.result_json) return fail(409, "not_ready");
  return send(200, { ok: true, taskId: row.task_id, ...(JSON.parse(row.result_json) as Json) });
}

/** A round cannot be stopped part way (the sandbox and the money are already committed), so a cancel is answered, never applied. */
async function taskCancel(body: unknown): Promise<Response> {
  if (!isObject(body) || !onlyKeys(body, ["id"]) || typeof body.id !== "string") return fail(400, "invalid_input");
  if (!TASK_ID.test(body.id) || !(await getTask(body.id))) return fail(404, "not_found");
  return send(200, { ok: true, taskId: body.id, cancelled: false });
}

/** A whole number inside [min, max], or null. Nothing is clamped silently. */
function whole(all: string[], fallback: number, min: number, max: number): number | null {
  if (all.length === 0) return fallback;
  if (all.length > 1 || !/^\d{1,10}$/.test(all[0])) return null;
  const n = Number(all[0]);
  return n < min || n > max ? null : n;
}

async function eventsGet(url: URL): Promise<Response> {
  for (const k of url.searchParams.keys()) if (k !== "after" && k !== "limit") return fail(400, "invalid_input");
  const after = whole(url.searchParams.getAll("after"), 0, 0, MAX_CURSOR);
  const limit = whole(url.searchParams.getAll("limit"), DEFAULT_PAGE, 1, MAX_PAGE);
  if (after === null || limit === null) return fail(400, "invalid_input");
  await sweepStale();
  const rows = (await sql()`select seq, id, kind, task_id, data_json, at from h1_events where seq > ${after} order by seq limit ${limit + 1}`) as { seq: unknown; id: string; kind: string; task_id: string; data_json: string; at: unknown }[];
  const page = rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), id: r.id, at: iso(r.at), kind: r.kind, taskId: r.task_id, data: JSON.parse(r.data_json) as Json }));
  return send(200, { ok: true, events: page, next: page.length ? page[page.length - 1].seq : after, hasMore: rows.length > limit });
}

async function dispatch(op: Op, req: Request): Promise<Response | { body: unknown; op: "task.run" | "task.cancel" }> {
  if (op === "manifest") return send(200, MANIFEST);
  if (op === "health") return send(200, { ok: true });
  const url = new URL(req.url);
  if (op === "task.get") return taskGet(url);
  if (op === "task.result") return taskResult(url);
  if (op === "events") return eventsGet(url);
  const parsed = await readJson(req);
  if ("tooLarge" in parsed) return fail(413, "too_large");
  if (parsed.json === undefined) return fail(400, "invalid_input");
  return { body: parsed.json, op };
}

export async function handleH1(req: Request, op: string, deps: H1Deps): Promise<Response> {
  try {
    const route = `${req.method} ${op}`;
    if (!Object.hasOwn(ROUTES, route)) return fail(404, "not_found");
    const operation = ROUTES[route];
    await ensureSchema();
    const header = req.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const claims = verifyHostToken({ token, publicKeys: deps.config.publicKeys, tenant: deps.config.tenantSlug, adapterId: MANIFEST.adapterId, operation, now });
    if (!claims || !(await consumeJti(claims, now))) return fail(401, "unauthorized"); // one answer for every reason
    const out = await dispatch(operation, req);
    if (out instanceof Response) return out;
    return out.op === "task.run" ? await taskRun(out.body, deps) : await taskCancel(out.body);
  } catch {
    return fail(500, "internal_error"); // the cause is not echoed
  }
}
