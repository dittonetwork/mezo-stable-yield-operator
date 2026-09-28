// SPDX-License-Identifier: BUSL-1.1
/**
 * Min-out derivation for swap-bearing tasks.
 *
 * The trap this module exists to close: `TigrisCLSwapAdapter.quote()` returns the pool's
 * `slot0` spot MID price. It says so, and that is a legitimate interface contract — the
 * adapter's own doc directs callers to "re-quote off-chain and enforce min-out on-chain".
 * But every caller then built the floor as `quote() x (1 - slippageBps)`, which silently
 * assumes the spot mid is achievable. It is not: execution pays the pool fee AND price
 * impact on top. With a 40-50 bps tolerance and a 5 bps fee, that left ~35-45 bps to absorb
 * an impact nobody measured.
 *
 * This was invisible on matsnet because that pool is a mock whose quote is exact by
 * construction, so the floor was always satisfiable.
 *
 * MEASURED on Mezo mainnet 2026-08-07, which corrects an earlier claim in this header that the
 * first real placement would revert MinOutNotMet: at our clip sizes it does not. The live ts=10
 * pool is deep enough that a 2,000 MUSD swap costs 5.0 bps all-in and a 10,000 one costs 5.1 —
 * the fee tier and almost nothing else. The danger is not at 2,000; it is that the SAME quote
 * shape lies catastrophically at size once the pool is drained (see DEFAULT_TICK_SPACING's
 * note for why that is bounded elsewhere, not guarded here), and that the floor was quietly
 * spending 5 of its 50 bps on a fee it never named.
 *
 * A spot mid is therefore NOT a safe basis for a min-out. A depth-aware quote (QuoterV2,
 * which simulates the swap across real ticks and returns a fee- and impact-inclusive output)
 * IS. `slippageBps` then means what it should: tolerance for movement between quoting and
 * execution — not a blind allowance for costs we declined to measure.
 */

/** QuoterV2.quoteExactInputSingle is non-view by design (it simulates and reverts); it is
 * called through eth_call, which is exactly what `cast call` does.
 *
 * SLIPSTREAM, NOT UNISWAP V3. Tigris' quoter takes `int24 tickSpacing` where Uniswap takes
 * `uint24 fee`, so the selector differs (0x9e7defe6 vs 0xc6a5026a) and the Uniswap one simply
 * reverts on this contract. Verified live on Mezo mainnet 2026-08-07 against
 * 0x4E56aF2d49D3D8F9a99155b31dd117ccDD545dC7 — see docs/tigris-quoter-and-depth-v1.md. */
export const QUOTER_V2_SIG =
  "quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)";

/** Default tick spacing of the only live MUSD/mUSDC venue (the ts=1 pool exists and is empty). */
export const DEFAULT_TICK_SPACING = 10;

// NO DEPTH-EXHAUSTION LAYER HERE, deliberately (2026-08-07). The quoter does return a partial
// amountOut against the full amountIn once the pool is drained — measured, 1,000,000 MUSD quotes
// 146,747 mUSDC — so an off-chain proportionality check against a small reference clip was added
// and then removed. Two reasons it is not needed:
//
//   * it cannot be reached. `hardCap` is 100_000e18, so total assets, and therefore any
//     placeableSurplus() a placement can draw on, stay below the pool's ~156,594 MUSD cap.
//   * where it could be reached, the chain already refuses: a spot-derived min-out makes an
//     oversized swap revert rather than fill (test/fork/TigrisCLSwapAdapterFork).
//
// So it was a second layer over a bound that already exists, and every such layer is another way
// to wedge a live vault. Security here is the 4-of-5 quorum plus the on-chain min-out, not a
// stack of off-chain refusals. If hardCap is ever raised near pool depth, revisit THIS comment.

export class SpotQuoteRefused extends Error {
  constructor(detail) {
    super(`refusing to derive min-out from a spot mid-price: ${detail}`);
    this.name = "SpotQuoteRefused";
  }
}

/**
 * Turn a quote into a min-out floor.
 *
 * @param {{quotedOut:bigint, slippageBps:number|bigint, depthAware:boolean,
 *          requireDepthAware?:boolean, feeBps?:number|bigint, label?:string}} s
 * @returns {{minOut:bigint, basis:"depth-aware"|"spot-degraded", warning?:string}}
 */
export function resolveMinOut(s) {
  const quoted = BigInt(s.quotedOut);
  if (quoted <= 0n) throw new SpotQuoteRefused(`${s.label ?? "swap"}: quote returned ${quoted}`);
  const slippage = BigInt(s.slippageBps);

  if (s.depthAware) {
    // The quote already carries fee and impact; the haircut covers drift only.
    return { minOut: (quoted * (10_000n - slippage)) / 10_000n, basis: "depth-aware" };
  }

  if (s.requireDepthAware) {
    throw new SpotQuoteRefused(
      `${s.label ?? "swap"}: no quoter configured and requireDepthAwareQuote is set. ` +
        `A slot0 mid omits both the pool fee and price impact, so the floor it produces is ` +
        `not a floor. Configure a QuoterV2 address for this pair.`
    );
  }

  // Degraded path, kept only so a mock-pool test stack keeps working. Subtract the KNOWN fee
  // as well as the drift tolerance; price impact remains unmeasured, hence the warning.
  const fee = BigInt(s.feeBps ?? 0);
  const minOut = (quoted * (10_000n - slippage - fee)) / 10_000n;
  return {
    minOut,
    basis: "spot-degraded",
    warning:
      `${s.label ?? "swap"}: min-out derived from a spot mid; price impact is NOT covered. ` +
      `Safe only against a pool whose quote is exact (mocks) or at sizes with negligible impact.`,
  };
}

/**
 * Depth-aware quote via QuoterV2. Returns null when no quoter is configured, so callers can
 * apply their own policy rather than getting a silent spot fallback here.
 *
 * @param {{cast:Function, quoter?:string, tokenIn:string, tokenOut:string, amountIn:bigint,
 *          tickSpacing?:number|bigint, label?:string}} s
 *          `cast` matches the aggregator's helper: (…args) => string
 */
export function depthAwareQuote(s) {
  if (!s.quoter) return null;
  const ts = s.tickSpacing ?? DEFAULT_TICK_SPACING;
  const raw = s.cast("call", s.quoter, QUOTER_V2_SIG, `(${s.tokenIn},${s.tokenOut},${s.amountIn},${ts},0)`);
  const out = BigInt(String(raw).trim().split(/\s+/)[0]);
  if (out <= 0n) throw new SpotQuoteRefused(`quoter returned ${out} for ${s.amountIn}`);
  return out;
}

/**
 * Both halves of a round trip, quoted through the venue itself: `amountIn` of tokenIn out to
 * tokenOut, then that exact output back again. Deliberately sequential rather than two independent
 * quotes at a notional size — the return leg has to be quoted for the amount the FORWARD leg
 * actually produces, or the pair does not describe one round trip.
 *
 * `forwardOut` skips re-quoting a forward leg the caller already has, which matters for more than
 * the saved RPC call: the round trip must be measured against the very quote the min-out floor was
 * derived from, not a second read of a pool that may have moved in between.
 *
 * `quote` may be sync or async, and may return null for "no quoter here" — which is refused rather
 * than degraded, same as resolveMinOut's requireDepthAware branch and for the same reason.
 *
 * @param {{quote:(tokenIn:string, tokenOut:string, amountIn:bigint)=>bigint|null|Promise<bigint|null>,
 *          tokenIn:string, tokenOut:string, amountIn:bigint, forwardOut?:bigint|null,
 *          label?:string}} s
 * @returns {Promise<{out:bigint, back:bigint}>}
 */
export async function roundTripQuote(s) {
  const label = s.label ?? "round trip";
  const leg = async (tokenIn, tokenOut, amountIn, which) => {
    const q = await s.quote(tokenIn, tokenOut, amountIn);
    if (q === null || q === undefined || BigInt(q) <= 0n) {
      throw new SpotQuoteRefused(`${label}: ${which} leg has no depth-aware quote (${q})`);
    }
    return BigInt(q);
  };
  const out = s.forwardOut !== undefined && s.forwardOut !== null && BigInt(s.forwardOut) > 0n
    ? BigInt(s.forwardOut)
    : await leg(s.tokenIn, s.tokenOut, s.amountIn, "forward");
  const back = await leg(s.tokenOut, s.tokenIn, out, "return");
  return { out, back };
}

/**
 * What a round trip costs, in bps of the amount sent out. Negative means the pool would pay to do
 * it, which is not an error — it is a one-sided pool, and it passes.
 *
 * This is a DIFFERENT question from the min-out floor. The floor asks whether one swap is priced
 * honestly against the pool as it stands right now; this asks whether the pool's standing spread
 * makes crossing it at all a losing move. On the live ts=10 venue the two are far apart: impact at
 * our clip sizes is under a basis point, while the standing spread costs ~12 bps for the pair
 * (~0.9911 out, ~1.0078 back, measured 2026-08-07). A tighter min-out cannot reduce that, and clip
 * size cannot either — only declining to place can.
 *
 * @param {{amountIn:bigint, amountBack:bigint, maxLossBps:bigint|number}} s
 * @returns {{ok:boolean, lossBps:bigint, reason?:string}}
 */
export function evaluateRoundTrip(s) {
  if (s.amountIn <= 0n) throw new SpotQuoteRefused(`round trip: amountIn is ${s.amountIn}`);
  const loss = s.amountIn - s.amountBack; // negative when the pool would pay to do it
  const max = BigInt(s.maxLossBps);
  // Cross-multiplied, so the comparison is EXACT. Dividing first and comparing the quotient let a
  // fractional overshoot through: bigint division truncates toward zero, so a real 50.99 bps loss
  // computed as `50` and passed a 50 bps limit — the check silently carried an extra ~1 bp of
  // tolerance, worst exactly where it matters, at the boundary it exists to defend. `lossBps` below is
  // REPORTING ONLY and still truncates; nothing decides on it.
  if (loss * 10_000n > s.amountIn * max) {
    const lossBps = (loss * 10_000n) / s.amountIn;
    return {
      ok: false, lossBps,
      // Name the exact figure as well as the rounded one, or a refusal at 50.99 reads as "50 exceeds
      // 50" and looks like an off-by-one in the check rather than a pool that is genuinely too dear.
      reason: `round-trip loss ${lossBps}bps (exactly ${loss}/${s.amountIn}) exceeds ${max}bps`,
    };
  }
  return { ok: true, lossBps: (loss * 10_000n) / s.amountIn };
}

/**
 * Convenience: quote depth-aware when possible, else fall back under policy.
 *
 * @param {{cast:Function, quoter?:string, spotQuote:()=>bigint, tokenIn:string,
 *          tokenOut:string, amountIn:bigint, tickSpacing?:number|bigint,
 *          slippageBps:number|bigint, requireDepthAware?:boolean, feeBps?:number|bigint,
 *          label?:string}} s
 */
export function quoteAndFloor(s) {
  let quotedOut = null;
  let depthAware = false;
  if (s.quoter) {
    quotedOut = depthAwareQuote({
      cast: s.cast, quoter: s.quoter, tokenIn: s.tokenIn, tokenOut: s.tokenOut,
      amountIn: s.amountIn, tickSpacing: s.tickSpacing, label: s.label,
    });
    depthAware = quotedOut !== null;
  }
  if (quotedOut === null) quotedOut = BigInt(s.spotQuote());
  const r = resolveMinOut({
    quotedOut, slippageBps: s.slippageBps, depthAware,
    requireDepthAware: s.requireDepthAware, feeBps: s.feeBps, label: s.label,
  });
  return { ...r, quotedOut };
}
