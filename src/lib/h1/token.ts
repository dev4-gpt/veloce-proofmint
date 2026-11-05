// Veloce host tokens (h1, Veloce ADR-012), checked the way the host mints them and the way the content adapter checks them:
// "<base64url claims>.<base64url Ed25519 signature over the first part>". Single use: a token id is recorded in Postgres (not a
// file or memory, because Forge runs as serverless functions) until the token expires, and a second use is refused.
import { verify, type KeyObject } from "node:crypto";
import { sql } from "../db";

export const TOKEN_VERSION = "h1";
export const TOKEN_ISSUER = "veloce-host";
export const MAX_TOKEN_TTL_SECONDS = 300;
export const MAX_CLOCK_SKEW_SECONDS = 30;
export const MAX_VERIFY_KEYS = 3;
const MAX_TOKEN_CHARS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HostClaims {
  v: string;
  iss: string;
  tenant: string;
  aud: string;
  scope: string[];
  jti: string;
  iat: number;
  exp: number;
}

export interface VerifyInput {
  token: unknown;
  publicKeys: readonly KeyObject[];
  tenant: string;
  adapterId: string;
  operation: string;
  /** Seconds since the epoch. */
  now: number;
}

function claimsOf(part: string): Record<string, unknown> | null {
  try {
    const c: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The signature first, then every claim. Returns the claims or null; the reason is deliberately not given. */
export function verifyHostToken(input: VerifyInput): HostClaims | null {
  const { token, publicKeys, tenant, adapterId, operation, now } = input;
  if (publicKeys.length < 1 || publicKeys.length > MAX_VERIFY_KEYS) throw new Error(`verification needs 1 to ${MAX_VERIFY_KEYS} public keys`);
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== 64) return null;
  const signed = Buffer.from(parts[0], "utf8");
  if (!publicKeys.some((key) => verify(null, signed, key, signature))) return null;
  const c = claimsOf(parts[0]);
  if (!c) return null;
  if (c.v !== TOKEN_VERSION || c.iss !== TOKEN_ISSUER || c.tenant !== tenant || c.aud !== adapterId) return null;
  const scope = c.scope;
  if (!Array.isArray(scope) || !scope.every((op) => typeof op === "string") || !scope.includes(operation)) return null;
  const { jti, iat, exp } = c;
  if (typeof jti !== "string" || !UUID.test(jti) || typeof iat !== "number" || typeof exp !== "number") return null;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp <= iat || exp - iat > MAX_TOKEN_TTL_SECONDS || iat > now + MAX_CLOCK_SKEW_SECONDS || exp <= now) return null;
  return { v: TOKEN_VERSION, iss: TOKEN_ISSUER, tenant, aud: adapterId, scope: scope as string[], jti, iat, exp };
}

/** Records the token id; false if it was already used. Expired ids are dropped first (an expired token is refused anyway). */
export async function consumeJti(claims: Pick<HostClaims, "jti" | "exp">, now: number): Promise<boolean> {
  await sql()`delete from h1_used_tokens where exp <= ${now}`;
  const rows = await sql()`insert into h1_used_tokens(jti, exp) values (${claims.jti}, ${claims.exp}) on conflict (jti) do nothing returning jti`;
  return rows.length === 1;
}
