// Demo cost model (NOT real pricing). Money is held in integer micro-dollars (1e-6 USD).
// Veloce invariant: unknown usage is never priced as zero; callers must check usage.unknown first.
export const RATES = {
  inMicrosPerToken: 0.3, // ~$0.30 per 1M input tokens
  outMicrosPerToken: 2.5, // ~$2.50 per 1M output tokens
  execMicrosPerMs: 0.1, // ~$0.10 per 1000 sandbox seconds
  feeMicros: 20_000, // flat $0.02 per round
};
export const ROUND_CAP_MICROS = 250_000; // reserved before any sandbox exists: $0.25
export const TOPUP_CENTS = 500; // $5.00 test-mode top-up

/** `modelsPaidByHost`: a round started by the Veloce host (ADR-020) has its model calls reserved and settled in the HOST's
 *  ledger, so Forge charges only the sandbox time and the fee; pricing the tokens here as well would charge them twice. */
export function priceMicros(u: { tokensIn: number; tokensOut: number; execMs: number }, opts: { modelsPaidByHost?: boolean } = {}): number {
  const tokens = opts.modelsPaidByHost ? 0 : u.tokensIn * RATES.inMicrosPerToken + u.tokensOut * RATES.outMicrosPerToken;
  return Math.ceil(tokens + u.execMs * RATES.execMicrosPerMs + RATES.feeMicros);
}

export const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(3)}`;
