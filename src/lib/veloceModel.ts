// The "veloce" provider (Veloce ADR-020): when the Veloce host starts a Forge round, every model answer comes from the HOST, which
// makes the call with the client's own key, reserves the cost in its budget first and settles it after. Forge holds no key for it.
// Rules: only the configured host address is ever called, with the task's grant as the bearer; the grant lives in memory only (it is
// never logged, stored or put in an error); there is no retry and no fallback to Forge's own providers; a refusal keeps only the
// host's short code. The host accepts text in, text out: no tools, no JSON mode, so the prompt itself asks for JSON.
import { extractJson, type Completer, type Completion } from "./llm";

/** The host's per-call output cap (src/lib/adapterModelCall.ts in the Veloce repo, raised to 8,192 for Forge). */
export const HOST_MAX_OUTPUT_TOKENS = 8192;
/** The providers the host's model.call accepts. */
export const HOST_PROVIDERS = ["openai", "anthropic", "gemini", "groq", "openrouter"] as const;
export type HostProvider = (typeof HOST_PROVIDERS)[number];
export const MAX_REPLY_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 90_000;
export const MAX_GRANT_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const MAX_MODEL_CHARS = 180;
const TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const HOST_CODE = /^[a-z][a-z0-9_]{0,59}$/;
const JSON_RULE = ' Respond with a single JSON object: {"rationale": string, "code": string}.';

/** A short, safe reason. The message is the code itself, so nothing the host or a provider wrote can leak through it. */
export class HostModelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostModelError";
  }
}

/** https only, except plain http to this machine for local runs; never an address with a login in it. */
export function validHostUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > MAX_URL_CHARS) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}
export const isHostProvider = (p: unknown): p is HostProvider => typeof p === "string" && (HOST_PROVIDERS as readonly string[]).includes(p);
export const validModelName = (m: unknown): m is string => typeof m === "string" && m.length >= 1 && m.length <= MAX_MODEL_CHARS;
export const validGrantToken = (t: unknown): t is string => typeof t === "string" && t.length >= 1 && t.length <= MAX_GRANT_CHARS;

export interface HostModelOptions {
  url: string;
  provider: string;
  model: string;
  /** The task's model grant from the host. Kept in this closure only. */
  token: string;
  /** The host's key for the task (the task.run idempotency key); the grant is bound to it. */
  taskKey: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function assertOptions(o: HostModelOptions): number {
  if (!validHostUrl(o.url)) throw new Error("the host model address must be https (or http to this machine) with no login in it");
  if (!isHostProvider(o.provider)) throw new Error(`the host model provider must be one of ${HOST_PROVIDERS.join(", ")}`);
  if (!validModelName(o.model)) throw new Error(`the host model name must be 1 to ${MAX_MODEL_CHARS} characters`);
  if (!validGrantToken(o.token)) throw new Error("a model grant from the host is required");
  if (typeof o.taskKey !== "string" || !TASK_KEY.test(o.taskKey)) throw new Error("the host task key is not valid");
  const maxOut = o.maxOutputTokens ?? HOST_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > HOST_MAX_OUTPUT_TOKENS) throw new Error(`maxOutputTokens must be a whole number from 1 to ${HOST_MAX_OUTPUT_TOKENS}`);
  return maxOut;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The host's short refusal code, or a generic one when the reply is not a short code. */
function refusalCode(text: string | null): string {
  const body = text === null ? undefined : parseJson(text);
  const error = isObject(body) ? body.error : undefined;
  return typeof error === "string" && HOST_CODE.test(error) ? error : "model_host_refused";
}

function proposalOf(output: string): { rationale?: string; code: string } {
  const j = parseJson(extractJson(output));
  if (!isObject(j) || typeof j.code !== "string" || j.code.length === 0) throw new HostModelError("model_reply_unusable");
  return { code: j.code, ...(typeof j.rationale === "string" ? { rationale: j.rationale } : {}) };
}

/** A model call for one host-started round. Settings are checked here, before any call is made. */
export function hostCompleter(o: HostModelOptions): Completer {
  const maxOut = assertOptions(o);
  const doFetch: typeof fetch = (input, init) => (o.fetchImpl ?? globalThis.fetch)(input, init); // looked up per call
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (system, user) => {
    const body = JSON.stringify({
      taskKey: o.taskKey,
      provider: o.provider,
      model: o.model,
      messages: [{ role: "system", content: system + JSON_RULE }, { role: "user", content: user }],
      maxOutputTokens: maxOut,
    });
    let res: Response;
    try {
      // redirect "error": the grant is never carried to an address other than the configured one
      res = await doFetch(o.url, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new HostModelError("model_host_unreachable");
    }
    const text = await res.text().catch(() => null);
    if (!res.ok) throw new HostModelError(refusalCode(text));
    if (text === null || Buffer.byteLength(text) > MAX_REPLY_BYTES) throw new HostModelError("model_host_bad_reply");
    const reply = parseJson(text);
    if (!isObject(reply) || reply.ok !== true || typeof reply.output !== "string") throw new HostModelError("model_host_bad_reply");
    const json = proposalOf(reply.output);
    const usage = isObject(reply.usage) ? reply.usage : {};
    const completion: Completion = {
      text: reply.output,
      tokensIn: count(usage.inputTokens),
      tokensOut: count(usage.outputTokens),
      provider: "veloce",
      model: `${o.provider}:${o.model}`,
    };
    return { completion, json, tried: ["veloce"] };
  };
}
