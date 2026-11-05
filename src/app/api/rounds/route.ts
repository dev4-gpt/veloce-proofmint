import { randomUUID } from "node:crypto";
import { FAMILIES, type Family } from "@/lib/bench/cases";
import { ROUND_CAP_MICROS } from "@/lib/cost";
import { ensureSchema, tryStartRound } from "@/lib/db";
import { stripeApi } from "@/lib/cardHold";
import { cardPayer, walletPayer } from "@/lib/payer";
import type { RoundEvent } from "@/lib/round";
import { executeRound } from "@/lib/roundJob";
import { requireRole } from "@/lib/auth";

export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as { family?: Family; cheat?: boolean; simulateMissingUsage?: boolean; payWith?: "wallet" | "card_hold" };
  const family = body.family;
  if (!family || !FAMILIES[family]) return Response.json({ error: "family must be dates, money or durations" }, { status: 400 });

  await ensureSchema();
  const roundId = "r-" + randomUUID().slice(0, 8);
  if (!(await tryStartRound(roundId, family, auth.identity.id))) {
    return Response.json({ error: "another round is running (free plan allows one sandbox at a time)" }, { status: 409 });
  }
  // Who pays: the credit wallet (default) or a Stripe test-mode card hold (hold, run, capture the actual cost, free the rest).
  const payer = body.payWith === "card_hold" ? cardPayer(roundId, ROUND_CAP_MICROS, () => stripeApi()) : walletPayer(roundId, ROUND_CAP_MICROS);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: RoundEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        // The whole paid round (authorise, run, settle, store, seal) lives in roundJob.ts, shared with the Veloce h1 surface.
        await executeRound({
          roundId, family, startedBy: auth.identity.id, payer, send,
          cheat: Boolean(body.cheat),
          simulateMissingUsage: body.simulateMissingUsage === true, // operator-only demo flag: the route above already requires the passcode
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
