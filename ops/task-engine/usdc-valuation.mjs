// SPDX-License-Identifier: BUSL-1.1
//
// What one unit of the vault's USDC-family assets (Ethereum USDC, Mezo mUSDC) is worth in MUSD.
//
// Claims on the vault are MUSD. Most of its assets are USDC. Valuing that USDC at 1:1 while MUSD
// trades below par (0.9908-0.9917 on the Tigris pool at every sample since 2026-08-07) books the
// discount as a loss when MUSD is swapped in, and books the premium as a gain only when USDC is
// swapped back — AFTER the leaving holder's MUSD payout was fixed at batch close. The leaver eats
// the entry discount; whoever stays collects the exit premium. With one depositor at ~99% of the
// vault that transfer is ~0.7% of their deposit on a two-week round trip.
//
// The fix is to value USDC at what it converts back into: the pool's time-weighted exit rate
// (mean tick over `twapSecs`, less the pool fee). Every NAV post uses it — deposits mint at the last
// posted NAV and batch close fixes payouts at the round's NAV, so applying it to only one of the two
// would let anyone deposit at one valuation and leave at the other.
//
// Why a TWAP rather than the pinned-block quote: a quote moves with a same-block swap, and the
// direction that pays (drain the pool's MUSD so USDC reads cheap, deposit at the lower NAV) costs
// two swaps. A mean resists that, but only in proportion: a move of m held for d seconds shifts it
// by m·d/twapSecs. So the TWAP is paired with a spot check, and every limit REFUSES the round rather
// than substituting a price: out of band from par, spot disagreeing with the TWAP, or a pool that
// cannot answer for the whole window.
//
// All arithmetic is integer and deterministic: the aggregator and every operator compute this at
// the same pinned Mezo block and must agree to the wei.

const Q192 = 1n << 192n;
const MAX_TICK = 887272n;
const MAX_UINT256 = (1n << 256n) - 1n;
const PAR = 10n ** 12n; // MUSD wei (18dp) per USDC micro-unit (6dp)
const FEE_UNITS = 1_000_000n; // pool fee is in pips

/** Uniswap v3 TickMath.getSqrtRatioAtTick, ported verbatim to BigInt (rounds up, like the original). */
export function getSqrtRatioAtTick(tick) {
  const t = BigInt(tick);
  const absTick = t < 0n ? -t : t;
  if (absTick > MAX_TICK) throw new Error(`tick ${t} out of range`);
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of steps) {
    if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  }
  if (t > 0n) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** OracleLibrary.consult: arithmetic mean tick, rounded toward negative infinity. */
export function meanTick(tickCumulativePast, tickCumulativeNow, secondsAgo) {
  const window = BigInt(secondsAgo);
  if (window <= 0n) throw new Error("TWAP window must be positive");
  const delta = BigInt(tickCumulativeNow) - BigInt(tickCumulativePast);
  let tick = delta / window; // BigInt division truncates toward zero, like Solidity
  if (delta < 0n && delta % window !== 0n) tick -= 1n;
  return tick;
}

/**
 * MUSD wei per USDC micro-unit as a fraction {num, den}, from the pool's time-weighted price at
 * `block`, less the pool fee. Throws — so the price-setting round REFUSES; nothing is clamped and
 * nothing falls back to par — when:
 *  - the pool cannot answer for the whole window (observe reverts OLD: raise its cardinality);
 *  - it is not the MUSD/mUSDC pool;
 *  - the rate is more than `bandBps` from par (a depeg or a moved pool — a person decides);
 *  - the live quote for a `spotProbe` of USDC disagrees with the TWAP by more than
 *    `maxSpotDivergenceBps`. A mean over 30 minutes is not "hold the pool for 30 minutes": a move
 *    of m held for d seconds shifts it by m·d/window. This catches the move while it is held (spot
 *    off) and after it is released (TWAP off), which is what makes the window worth anything.
 */
export async function usdcExitRate({
  reader, leg = "mezo", pool, quoter, musd, musdc, block, twapSecs, bandBps, maxSpotDivergenceBps, spotProbe,
}) {
  const window = BigInt(twapSecs);
  const band = BigInt(bandBps);
  const maxDivergence = BigInt(maxSpotDivergenceBps);
  const probe = BigInt(spotProbe);
  if (window <= 0n) throw new Error("usdc valuation: twapSecs must be positive");
  if (band < 0n || band >= 10_000n) throw new Error("usdc valuation: bandBps out of range");
  if (maxDivergence < 0n || maxDivergence >= 10_000n) throw new Error("usdc valuation: maxSpotDivergenceBps out of range");
  if (probe <= 0n) throw new Error("usdc valuation: spotProbe must be positive");
  const isAddress = (a) => typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a) && !/^0x0+$/i.test(a);
  if (!isAddress(pool)) throw new Error("usdc valuation: swap pool address is required");
  if (!isAddress(quoter)) throw new Error("usdc valuation: swap quoter address is required");
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const [token0, token1] = await Promise.all([
    reader.addressCall(leg, pool, "token0()(address)", [], block),
    reader.addressCall(leg, pool, "token1()(address)", [], block),
  ]);
  const musdcIsToken0 = same(token0, musdc) && same(token1, musd);
  if (!musdcIsToken0 && !(same(token0, musd) && same(token1, musdc))) {
    throw new Error(`usdc valuation: pool ${pool} is ${token0}/${token1}, not MUSD/mUSDC`);
  }
  const [feePips, tickSpacing] = await Promise.all([
    reader.uintCall(leg, pool, "fee()(uint24)", [], block).then(BigInt),
    reader.uintCall(leg, pool, "tickSpacing()(int24)", [], block).then(BigInt),
  ]);
  if (feePips < 0n || feePips >= FEE_UNITS) throw new Error(`usdc valuation: pool fee ${feePips} out of range`);
  if (tickSpacing <= 0n || tickSpacing > 16384n) throw new Error(`usdc valuation: pool tickSpacing ${tickSpacing} out of range`);
  if (typeof reader.tickCumulatives !== "function") throw new Error("usdc valuation: reader cannot read the pool TWAP");
  let cumulatives;
  try {
    cumulatives = await reader.tickCumulatives(leg, pool, window, block);
  } catch (error) {
    throw new Error(`usdc valuation: pool TWAP over ${window}s unreadable at block ${block} `
      + `(raise the pool's observation cardinality if it reverted OLD): ${error.message}`);
  }
  const tick = meanTick(cumulatives[0], cumulatives[1], window);
  const ratioX192 = getSqrtRatioAtTick(tick) ** 2n;
  // price(token1 per token0) = ratioX192 / 2^192, both in raw units.
  let num = musdcIsToken0 ? ratioX192 : Q192;
  let den = musdcIsToken0 ? Q192 : ratioX192;
  num *= FEE_UNITS - feePips;
  den *= FEE_UNITS;
  const rate = { num, den };
  const bps = (a, b) => ((a > b ? a - b : b - a) * 10_000n) / b;
  const parValue = probe * PAR;
  const twapValue = usdcToMusd(probe, 6, rate);
  const fromPar = bps(twapValue, parValue);
  if (fromPar > band) {
    throw new Error(`usdc valuation: pool exit rate is ${fromPar} bps from par, beyond the ${band} bps band; `
      + "refusing to price (a depeg or a moved pool needs a person, not a substituted rate)");
  }
  const spotOut = BigInt(await reader.uintCall(
    leg, quoter, "quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)",
    [musdc, musd, probe, tickSpacing, 0n], block,
  ));
  const spotDivergenceBps = bps(spotOut, twapValue);
  if (spotDivergenceBps > maxDivergence) {
    throw new Error(`usdc valuation: live quote diverges from the ${window}s TWAP by ${spotDivergenceBps} bps `
      + `(limit ${maxDivergence}); refusing to price while the pool is or was recently moved`);
  }
  return { ...rate, meanTick: tick, feePips, tickSpacing, twapSecs: window, fromParBps: fromPar, spotDivergenceBps, musdcIsToken0 };
}

/** The one way the aggregator and every seat turn the git-tracked policy and their OWN Mezo leg
 * config into valuation inputs, so the two sides cannot build different ones. */
export function valuationFromPolicy(mezoLeg, policy) {
  return {
    pool: mezoLeg.swapPool,
    quoter: mezoLeg.swapQuoter,
    twapSecs: policy.usdcExitTwapSecs,
    bandBps: policy.usdcExitBandBps,
    maxSpotDivergenceBps: policy.usdcSpotDivergenceBps,
    spotProbe: policy.usdcSpotProbe,
    maxLiquidationImpactBps: policy.usdcMaxLiquidationImpactBps,
  };
}

/**
 * The least MUSD `amount` mUSDC may convert into: `capBps` under its value at `rate`. Exact — rounded
 * UP from one integer product, never from basis points already rounded down — so "not below the
 * floor" means what it says.
 */
export function twapFloorOut(amount, rate, capBps) {
  const cap = BigInt(capBps);
  if (cap < 0n || cap >= 10_000n) throw new Error("usdc valuation: cap out of range");
  const n = BigInt(amount) * BigInt(rate.num) * (10_000n - cap), d = BigInt(rate.den) * 10_000n;
  return (n + d - 1n) / d;
}

/**
 * The rate NAV marks USDC at: what the WHOLE position converts into now (`quotedOut` for `amount`,
 * the executable quote at the pinned block), never above its value at the TWAP `rate`. Nothing
 * raises it: a floor under the quote would be a promised sale price, not a liquidation value, and a
 * batch fixed at it can be owed more than exists (Codex, 2026-09-30: 2,918.90 MUSD short with only
 * our own swaps and elapsed time). When the quote is more than `maxImpactBps` under the TWAP the
 * pool cannot absorb the position, and this THROWS: the close waits for liquidity and a person, it
 * is not priced. Returned as a fraction so each asset rounds down on its own and the parts never
 * sum past the whole.
 */
export function usdcMarkRate({ rate, amount, quotedOut, maxImpactBps }) {
  const total = BigInt(amount);
  const floor = twapFloorOut(total, rate, maxImpactBps);
  if (total === 0n) return { num: BigInt(rate.num), den: BigInt(rate.den) };
  const twapValue = usdcToMusd(total, 6, rate);
  const out = BigInt(quotedOut);
  if (out < floor) {
    throw new Error(`usdc valuation: the pool cannot absorb the vault's ${total} USDC units within ${maxImpactBps} bps `
      + `of its TWAP (quote ${out}, floor ${floor}); holding the price until there is liquidity for it`);
  }
  return { num: out > twapValue ? twapValue : out, den: total };
}

/**
 * How far below the TWAP value a conversion of `amount` USDC would actually land right now: the
 * size-dependent impact the TWAP (a price, not a depth) does not see. Its quote for the whole
 * position sets NAV's mark (usdcMarkRate).
 */
export async function usdcExitImpact({ reader, leg = "mezo", quoter, musd, musdc, block, tickSpacing, amount, rate }) {
  if (amount <= 0n) return { amount, quotedOut: 0n, twapValue: 0n, impactBps: 0n };
  const quotedOut = BigInt(await reader.uintCall(
    leg, quoter, "quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)",
    [musdc, musd, amount, tickSpacing, 0n], block,
  ));
  return { amount, quotedOut, twapValue: usdcToMusd(amount, 6, rate), impactBps: exitImpactBps(amount, quotedOut, rate) };
}

/** Basis points by which `quotedOut` MUSD falls short of `amount` USDC valued at `rate`; 0 when it does not. */
export function exitImpactBps(amount, quotedOut, rate) {
  const twapValue = usdcToMusd(amount, 6, rate);
  const out = BigInt(quotedOut);
  return twapValue > out ? ((twapValue - out) * 10_000n) / twapValue : 0n;
}

/**
 * The swap-back cap: the largest part of `available` mUSDC whose executable quote lands within
 * `maxImpactBps` of `rate`, the TWAP exit rate NAV valued it at. The pool is flat up to its MUSD
 * inventory and falls off a cliff past it; selling into the cliff hands the loss to every holder who
 * stays. The rest waits on the executor until the pool can take it.
 *
 * Anchored to the TWAP, not to the spot the previous swap left behind: this pool does not revert, so
 * a spot-relative cap would walk the whole cliff one tick at a time. The TWAP follows a move only
 * over its window, and while spot is more than the NAV divergence limit away the rate refuses and
 * nothing is swapped at all. Bisects on `quote(amount)`, which must be depth-aware; impact grows
 * with size in a single pool, which is what makes bisection valid.
 */
export function capSwapBack({ available, maxImpactBps, rate, quote, steps = 16 }) {
  const cap = BigInt(maxImpactBps);
  if (cap < 0n || cap >= 10_000n) throw new Error("capSwapBack: maxImpactBps out of range");
  const fits = (amount) => BigInt(quote(amount)) >= twapFloorOut(amount, rate, cap);
  if (available <= 0n || fits(available)) return available;
  let lo = 0n, hi = available;
  for (let i = 0; i < steps && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * The return quote to size a venue unwind with: the executable quote, or the cap's floor under the
 * TWAP when the quote is worse. Every swap-back's signed min-out is at or above that floor, so sizing
 * at a cliff quote would value mUSDC already waiting on Mezo at a price it can never be sold at, and
 * keep unwinding the venue for a gap that is not there.
 */
export function cappedReturnQuote({ quotedOut, probe, rate, maxImpactBps }) {
  const floor = twapFloorOut(probe, rate, maxImpactBps);
  return BigInt(quotedOut) > floor ? BigInt(quotedOut) : floor;
}

/** Value a USDC-family amount (6dp) in MUSD wei at `rate`, rounding down. */
export function usdcToMusd(amount, decimals, rate, label = "asset") {
  if (Number(decimals) !== 6) throw new Error(`${label}: USDC-family asset must have 6 decimals, got ${decimals}`);
  const a = BigInt(amount);
  if (a < 0n) throw new Error(`${label}: negative amount`);
  return (a * BigInt(rate.num)) / BigInt(rate.den);
}
