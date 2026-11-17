// One paid improvement round, end to end: authorise the payer, run the round, settle, store the proposal and seal the report.
// Shared by the page's round route (streamed to the browser) and the Veloce h1 surface (run in the background for the host).
// The money rules are the Veloce ones and do not change with the caller:
//   I1 authorise and reserve BEFORE any sandbox exists; I2 unknown usage is never priced as zero; I3 a failed settlement is a
//   blocked round, never a success; a round that failed before any sandbox ran releases everything (usage is known to be zero).
// When the Veloce host started the round (`modelsPaidByHost`), its model calls were reserved and settled in the HOST's ledger
// (ADR-020), so Forge charges only sandbox time and the fee, and only a missing sandbox-time figure makes the cost unknown.
import { FAMILIES, type Family, PARTNER, sha256 } from "./bench/cases";
import { appendReport } from "./chainStore";
import { summariseEvents, type RoundBody } from "./evidence";
import { saveRoundEvents, type TimedEvent } from "./replay";
import { priceMicros, ROUND_CAP_MICROS } from "./cost";
import { finishRoundRow, getActive, getHeldoutSet, insertTool, nextVersion, setActiveHeldout } from "./db";
import type { Completer } from "./llm";
import { capturePolicy, isBillable, walletPayer, type Payer } from "./payer";
import { RoundCancelled, runRound, type RoundEvent, type RoundUsage } from "./round";

export interface RoundJobInput {
  roundId: string;
  family: Family;
  startedBy: string;
  payer: Payer;
  send: (e: RoundEvent) => void;
  cheat?: boolean; // demo only (page): a scripted candidate that memorises the answers and must be rejected by the gate
  simulateMissingUsage?: boolean; // demo only (page): proves that unknown usage is never settled as zero
  complete?: Completer; // who answers the proposer; default Forge's own providers
  modelsPaidByHost?: boolean;
  stop?: () => Promise<boolean>; // the host asked for a cancel; read at the round's checkpoints
  runRoundImpl?: typeof runRound; // tests only
}

export interface RoundOutcome {
  /** proposed | rejected | blocked_unsettled | refused | error */
  status: string;
  toolId: string | null;
  candidateSha: string | null;
  code: string | null;
  costMicros: number | null;
  visible: unknown;
  heldout: unknown;
}

// Demo-only candidate that memorises the visible/field answers. It must be rejected by the held-out gate.
function cheatCode(family: Family): string {
  const table = Object.fromEntries([...FAMILIES[family].visible, ...FAMILIES[family].field].map((c) => [c.input, c.expected]));
  return `TABLE = ${JSON.stringify(table)}\n\ndef normalize(raw):\n    if raw in TABLE:\n        return TABLE[raw]\n    raise ValueError("unknown input")\n`;
}

/** What the round cost Forge, or null when that is not known (and so must not be settled). */
export function roundCost(usage: RoundUsage, opts: { modelsPaidByHost?: boolean; simulateMissingUsage?: boolean }): number | null {
  if (opts.simulateMissingUsage === true) return null;
  if (opts.modelsPaidByHost) return usage.execMs === null ? null : priceMicros({ tokensIn: 0, tokensOut: 0, execMs: usage.execMs }, { modelsPaidByHost: true });
  if (usage.unknown || usage.tokensIn === null || usage.tokensOut === null || usage.execMs === null) return null;
  return priceMicros({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, execMs: usage.execMs });
}

const none = (status: string, costMicros: number | null = null): RoundOutcome => ({ status, toolId: null, candidateSha: null, code: null, costMicros, visible: null, heldout: null });

export async function executeRound(input: RoundJobInput): Promise<RoundOutcome> {
  const { roundId, family, payer } = input;
  const run = input.runRoundImpl ?? runRound;
  const events: Record<string, unknown>[] = [];
  const timed: TimedEvent[] = []; // the same stream with timestamps, stored for replay
  const t0 = Date.now();
  let sandboxStarted = false;
  const send = (e: RoundEvent) => {
    events.push(e as Record<string, unknown>);
    timed.push({ t: Date.now() - t0, e: e as Record<string, unknown> });
    if (e.type === "sandbox_created") sandboxStarted = true;
    input.send(e);
  };
  let reserved = false;
  let settledOrBlocked = false;
  let settlement: RoundBody["settlement"] = "blocked_unsettled";
  let costMicros: number | null = null;
  let recorded = false;
  // Append the tamper-evident report. A failure to record is surfaced to the caller but never changes money or the verdict.
  const record = async (extra: Partial<RoundBody> & Pick<RoundBody, "status">) => {
    if (recorded) return;
    recorded = true;
    try {
      // Store the stream first so its digest can be sealed into the chain entry. If storing fails the round is still
      // reported (eventsSha null) and the caller is told that replay will not be available.
      const snapshot = timed.slice(0, timed.length);
      let eventsSha: string | null = null;
      try {
        eventsSha = await saveRoundEvents(roundId, family, extra.status, snapshot);
      } catch (err) {
        send({ type: "report_error", message: "events not stored, so this round cannot be replayed: " + (err instanceof Error ? err.message : String(err)) });
      }
      const facts = summariseEvents(events);
      const payment = await payer.info().catch(() => undefined);
      const held = await getHeldoutSet(family).catch(() => null);
      const body: RoundBody = {
        kind: "round", roundId, family, pillar: FAMILIES[family].pillar, startedBy: input.startedBy,
        toolId: null, candidate: null, visible: null, heldout: null, heldoutCommitment: held?.sha ?? null, cross: null, gate: null,
        egressBlocked: facts.egressBlocked, astOk: facts.astOk, sandboxId: facts.sandboxId,
        usage: { tokensIn: null, tokensOut: null, execMs: null }, costMicros: null, settlement, eventsSha, payment, at: new Date().toISOString(), ...extra,
      };
      const entry = await appendReport(body);
      send({ type: "report_sealed", seq: entry.seq, hash: entry.hash, signed: Boolean(entry.sig) });
    } catch (err) {
      send({ type: "report_error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  try {
    // I1: authorise and reserve BEFORE any sandbox exists.
    const authz = await payer.authorize();
    if (!authz.ok) {
      await finishRoundRow(roundId, "refused", {}); // free the single running slot
      send({ type: "refused", reason: authz.reason, detail: authz.reason === "insufficient_funds" ? authz.detail : `${authz.detail}. No sandbox was created.` });
      return none("refused");
    }
    reserved = true;
    send(authz.event as RoundEvent);
    const active = await getActive(family);
    const partnerFamily = PARTNER[family];
    const partner = partnerFamily ? { family: partnerFamily, code: (await getActive(partnerFamily)).code } : undefined;

    const result = await run({
      family,
      currentCode: active.code,
      currentHeldoutPass: active.heldout_pass ?? undefined,
      partner,
      scripted: input.cheat ? { code: cheatCode(family), rationale: "SCRIPTED DEMO: memorises the visible answers" } : undefined,
      maxAttempts: input.cheat ? 1 : 2,
      complete: input.complete,
      emit: send,
      shouldStop: input.stop,
    });

    // Remember the current tool's held-out standing the first time we measure it.
    if (!active.heldout_pass) await setActiveHeldout(active.id, result.currentHeldoutPass, result.currentVisibleCount);

    let status: string = result.verdict;
    let toolStatus: "proposed" | "rejected" | "blocked" = result.verdict === "proposed" ? "proposed" : "rejected";

    // I2/I3: unknown usage is never priced as zero, and a failed settlement can never become success.
    const actual = roundCost(result.usage, input);
    const settled = await payer.settle(actual, isBillable(capturePolicy(), result.verdict));
    settledOrBlocked = true;
    if (settled.kind === "blocked") {
      status = "blocked_unsettled";
      toolStatus = "blocked";
      send({ type: "blocked_unsettled", reason: settled.reason });
    } else {
      settlement = "settled";
      costMicros = settled.costMicros;
      send({ type: "settled", actualMicros: settled.costMicros, releasedMicros: settled.releasedMicros, mode: payer.mode, waived: settled.waived === true });
    }

    const toolId = result.candidate ? "t-" + family + "-" + roundId : null;
    const candidateSha = result.candidate ? sha256(result.candidate.code) : null;
    if (result.candidate && toolId && candidateSha) {
      await insertTool({
        id: toolId, family, version: await nextVersion(family), code: result.candidate.code, sha: candidateSha,
        status: toolStatus, visible_count: result.visible.candidate, heldout_count: result.heldout.candidate,
        heldout_pass: result.heldoutPass ?? null, heldout_sha: result.heldoutSha, round_id: roundId, rationale: result.candidate.rationale, gate: result.gate ?? null,
      });
      send({ type: "result", status, toolId, sha: candidateSha, visible: result.visible, heldout: result.heldout, gate: result.gate, needsApproval: toolStatus === "proposed" });
    }
    await record({
      status, toolId,
      candidate: result.candidate && candidateSha ? { sha: candidateSha, code: result.candidate.code } : null,
      visible: result.visible, heldout: result.heldout, cross: result.cross ?? null, gate: result.gate ?? null,
      usage: { tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut, execMs: result.usage.execMs }, costMicros,
    });
    await finishRoundRow(roundId, status, result.usage);
    return { status, toolId, candidateSha, code: result.candidate?.code ?? null, costMicros, visible: result.visible, heldout: result.heldout };
  } catch (e) {
    if (e instanceof RoundCancelled && reserved && !settledOrBlocked) {
      // The host asked the round to stop at a checkpoint. Settle at what was used, never as zero when that is unknown (I2),
      // and keep a failed settlement a blocked round (I3). Nothing was stored as a tool: a cancelled round proposes nothing.
      let status = "cancelled";
      if (!sandboxStarted) {
        await payer.releaseUnused().catch(() => {}); // nothing ran: usage is known to be zero
        settlement = "released";
        costMicros = 0;
        send({ type: "released", reason: "round cancelled before any sandbox ran; nothing was used" });
      } else {
        const actual = roundCost(e.usage, input);
        const settled = actual === null ? null : await payer.settle(actual, true).catch(() => null);
        if (settled && settled.kind === "settled") {
          settlement = "settled";
          costMicros = settled.costMicros;
          send({ type: "settled", actualMicros: settled.costMicros, releasedMicros: settled.releasedMicros, mode: payer.mode, waived: settled.waived === true });
        } else {
          await payer.block("round cancelled; usage unknown or settlement failed").catch(() => {});
          status = "blocked_unsettled";
          send({ type: "blocked_unsettled", reason: "round cancelled; usage unknown or settlement failed; reservation stays held" });
        }
      }
      settledOrBlocked = true;
      send({ type: "cancelled", usage: { tokensIn: e.usage.tokensIn, tokensOut: e.usage.tokensOut, execMs: e.usage.execMs } });
      await record({ status, costMicros, usage: { tokensIn: e.usage.tokensIn, tokensOut: e.usage.tokensOut, execMs: e.usage.execMs } });
      await finishRoundRow(roundId, status, e.usage);
      return none(status, costMicros);
    }
    const message = e instanceof Error ? e.message : String(e);
    // A failed round must never look free: keep the hold and say why in the ledger.
    if (reserved && !settledOrBlocked) {
      if (!sandboxStarted) {
        // Failed before any sandbox or model call: usage is KNOWN to be zero (not unknown), so release the whole hold.
        await payer.releaseUnused().catch(() => {});
        settlement = "released";
        costMicros = 0;
        send({ type: "released", reason: "round failed before any sandbox ran; nothing was used" });
      } else {
        await payer.block(`round failed: ${message.slice(0, 120)}`).catch(() => {});
      }
    }
    send({ type: "error", message });
    if (reserved) await record({ status: "error", costMicros });
    await finishRoundRow(roundId, "error", {}).catch(() => {});
    return none("error", costMicros);
  }
}

/** A round the Veloce host started (h1 `proofmint.round`): paid from Forge's wallet for sandbox time and the fee only. */
export async function runHostRound(job: { roundId: string; family: Family; complete: Completer; stop?: () => Promise<boolean>; runRoundImpl?: typeof runRound }): Promise<RoundOutcome> {
  return executeRound({
    roundId: job.roundId, family: job.family, startedBy: "veloce-host", payer: walletPayer(job.roundId, ROUND_CAP_MICROS),
    send: () => {}, complete: job.complete, modelsPaidByHost: true, stop: job.stop, runRoundImpl: job.runRoundImpl,
  });
}
