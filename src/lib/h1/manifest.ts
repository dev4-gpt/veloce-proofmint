// Veloce ProofMint (this repo, formerly Veloce Forge) as a Veloce adapter (h1 contract, Veloce ADR-005): what it offers and the settings it needs. OFF unless
// FORGE_H1_ENABLED is exactly "true"; any setting that is present but wrong is refused, never guessed.
//
// One task, `forge.round`, draft class: it proposes a better tool version; promotion still needs Forge's own hash-bound human
// approval, so nothing here can publish. Deletion guarantee "none": Forge keeps no host memory and offers no deletion receipts,
// which keeps it out of a client edition until it does (Veloce ADR-014).
import { createPublicKey, type KeyObject } from "node:crypto";
import { isHostProvider, validHostUrl, validModelName, type HostProvider } from "../veloceModel";

export const H1_ADAPTER_ID = "veloce-proofmint";
export const FORGE_TASK = "forge.round";
export const MAX_HOST_KEYS = 3; // current, next and retiring while a key is rotated (Veloce ADR-012)
const TENANT_SLUG = /^[a-z][a-z0-9-]{2,40}$/;

export interface H1Manifest {
  contractVersion: "h1";
  adapterId: string;
  displayName: string;
  adapterVersion: string;
  publisher: string;
  license: string;
  operations: readonly string[];
  tasks: readonly { name: string; sideEffect: "read" | "draft" | "publish" }[];
  sideEffectCeiling: "read" | "draft" | "publish";
  deletionGuarantee: "none" | "host-owned" | "receipt";
}

export const MANIFEST: H1Manifest = Object.freeze({
  contractVersion: "h1",
  adapterId: H1_ADAPTER_ID,
  displayName: "Veloce ProofMint",
  adapterVersion: "0.1.0",
  publisher: "Veloce",
  license: "proprietary",
  operations: Object.freeze(["manifest", "health", "task.run", "task.get", "task.result", "task.cancel", "events"]),
  tasks: Object.freeze([Object.freeze({ name: FORGE_TASK, sideEffect: "draft" as const })]),
  sideEffectCeiling: "draft",
  deletionGuarantee: "none",
});

export interface H1Config {
  tenantSlug: string;
  /** The Veloce host's Ed25519 public keys (1 to 3). */
  publicKeys: KeyObject[];
  /** The host's model.call address; a task's grant must name exactly this. */
  modelUrl: string;
  provider: HostProvider;
  model: string;
}

export type H1ConfigResult = { ok: true; config: H1Config } | { ok: false; reason: "off" | "misconfigured" };

function hostKeys(raw: string | undefined): KeyObject[] | null {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_HOST_KEYS) return null;
  const keys: KeyObject[] = [];
  for (const pem of list) {
    if (typeof pem !== "string") return null;
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") return null;
      keys.push(key);
    } catch {
      return null;
    }
  }
  return keys;
}

/** VELOCE_HOST_PUBLIC_KEYS is a JSON list of PEM strings (one per key). */
export function h1Config(env: NodeJS.ProcessEnv = process.env): H1ConfigResult {
  if (env.FORGE_H1_ENABLED !== "true") return { ok: false, reason: "off" };
  const tenantSlug = env.VELOCE_TENANT_SLUG ?? "";
  const publicKeys = hostKeys(env.VELOCE_HOST_PUBLIC_KEYS);
  const modelUrl = env.VELOCE_HOST_MODEL_URL;
  const provider = env.VELOCE_HOST_MODEL_PROVIDER;
  const model = env.VELOCE_HOST_MODEL;
  if (!TENANT_SLUG.test(tenantSlug) || !publicKeys || !validHostUrl(modelUrl) || !isHostProvider(provider) || !validModelName(model)) {
    return { ok: false, reason: "misconfigured" };
  }
  return { ok: true, config: { tenantSlug, publicKeys, modelUrl, provider, model } };
}
