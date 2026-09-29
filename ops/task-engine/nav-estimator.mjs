// SPDX-License-Identifier: BUSL-1.1
// v3 independent NAV recomputation + off-chain guard band (Ефим 2026-07-28).
//
// Replaces the P1 bug documented in docs/audit/KNOWN-ISSUES.md: NET_CLEAR used to re-post
// NAVConsumer.currentNAV() read fresh in the same tick — a diff==0 self-comparison that
// trivially satisfies any on-chain band and never moves the vault's share price. This module
// is the pure-math half of the fix (no I/O — mirrors apy-estimator.mjs's split between pure
// projection and live readers); ops/aggregator/aggregator.mjs's computeClearingNavRay does
// the actual on-chain reads and calls computeNavRay below.
//
// Two independent guards now exist, deliberately at different widths (Ефим: "широкий guard
// на чейне... в JS уже более гибкий guard 100/40 bps"):
//   - on-chain (NAVConsumer.sol): wide, static, guardian-settable circuit breaker (default
//     1000/1000bps) — last-resort catch-all against a gross error/compromise.
//   - HERE (off-chain, this module): the real day-to-day operational band (default
//     100/40bps), applied BEFORE a NAV is ever proposed on-chain. checkNavWithinGuard uses
//     the exact same cross-multiplication as NAVConsumer.postNAV's require, so the two never
//     disagree at a boundary — this is a strictly TIGHTER pre-filter, not a different rule.

import { usdcToMusd } from "./usdc-valuation.mjs";

export const DEFAULT_GUARD_UPPER_BPS = 100n;
export const DEFAULT_GUARD_LOWER_BPS = 40n;
export const ACCOUNTING_DECIMALS = 18;
export const RAY = 10n ** 27n;

export function integerValue(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(?:-?[0-9]+|0x[0-9a-f]+)$/i.test(value)) return BigInt(value);
  throw new Error(`${label}: unreadable or ambiguous integer`);
}

/** Normalize an integer token amount to the canonical 18-decimal MUSD accounting unit. */
export function normalizeTo18(amount, decimals, label = "asset") {
  const value = integerValue(amount, `${label} amount`);
  const d = Number(integerValue(decimals, `${label} decimals`));
  if (!Number.isInteger(d) || d < 0 || d > ACCOUNTING_DECIMALS) {
    throw new Error(`${label}: unsupported or ambiguous decimals ${decimals}`);
  }
  if (value < 0n) throw new Error(`${label}: negative amount`);
  return value * 10n ** BigInt(ACCOUNTING_DECIMALS - d);
}

/**
 * Canonical ownership model. Readers on both sides independently build this snapshot from
 * pinned chain state; this function is the sole production arithmetic specification.
 * Every physical unit appears in one `assets` location and every external claim appears in
 * one `liabilities` location. Unknown inventory or bridge attribution is a hard refusal.
 *
 * @param {{inventoryComplete:boolean, bridgeAttributionCertain:boolean,
 *   assets:Array<{id:string,amount:bigint|string|number,decimals:number,haircutBps?:bigint|string|number}>,
 *   liabilities:Array<{id:string,amount:bigint|string|number,decimals:number}>,
 *   totalSupply:bigint|string|number,virtualShares?:bigint|string|number,ray?:bigint}} snapshot
 */
export function computeOwnershipNav(snapshot) {
  if (!snapshot?.inventoryComplete) throw new Error("NAV inventory is not authoritative and complete");
  if (!snapshot.bridgeAttributionCertain) throw new Error("bridge in-flight attribution is uncertain");
  if (!Array.isArray(snapshot.assets) || !Array.isArray(snapshot.liabilities)) {
    throw new Error("NAV snapshot assets/liabilities are required");
  }

  const seen = new Set();
  const sum = (entries, liability) => entries.reduce((total, entry) => {
    if (!entry?.id || seen.has(entry.id)) throw new Error(`duplicate or missing NAV location id: ${entry?.id ?? ""}`);
    seen.add(entry.id);
    if (liability && entry.usdc) throw new Error(`${entry.id}: liabilities are MUSD`);
    // USDC-family assets are worth what they convert back into MUSD (usdc-valuation.mjs) when the
    // snapshot carries that rate; without one they stay at 1:1, the pre-2026-09-29 convention.
    const normalized = entry.usdc && snapshot.usdcRate
      ? usdcToMusd(entry.amount, entry.decimals, snapshot.usdcRate, entry.id)
      : normalizeTo18(entry.amount, entry.decimals, entry.id);
    if (liability && entry.haircutBps !== undefined) throw new Error(`${entry.id}: liability cannot carry a haircut`);
    const haircutBps = BigInt(entry.haircutBps ?? 0);
    if (haircutBps < 0n || haircutBps > 10_000n) throw new Error(`${entry.id}: invalid haircutBps`);
    return total + (normalized * (10_000n - haircutBps)) / 10_000n;
  }, 0n);

  const grossAssets = sum(snapshot.assets, false);
  const liabilities = sum(snapshot.liabilities, true);
  const netAssets = grossAssets > liabilities ? grossAssets - liabilities : 0n;
  const shares = BigInt(snapshot.totalSupply) + BigInt(snapshot.virtualShares ?? 1_000n);
  if (shares <= 0n) throw new Error("computeOwnershipNav: zero shares");
  const ray = BigInt(snapshot.ray ?? RAY);
  return { grossAssets, liabilities, netAssets, navRay: (netAssets * ray) / shares };
}

/** Normalize an asset amount before combining balances from different chains/tokens. */
export function scaleAssetAmount(amount, fromDecimals, toDecimals) {
  const from = BigInt(fromDecimals);
  const to = BigInt(toDecimals);
  if (from < 0n || to < 0n || from > 77n || to > 77n) throw new Error("scaleAssetAmount: invalid decimals");
  if (from === to) return amount;
  if (from < to) return amount * 10n ** (to - from);
  const divisor = 10n ** (from - to);
  if (amount % divisor !== 0n) throw new Error("scaleAssetAmount: precision loss");
  return amount / divisor;
}

/**
 * Independent NAV formula from real on-chain state, NOT a read-your-own-write of
 * NAVConsumer.currentNAV(). Assets under management minus liabilities not yet reflected in
 * totalSupply, divided by outstanding+virtual shares (mirrors DMUSDVault's own
 * totalSupply()+VIRTUAL_SHARES share-math, just solved for price instead of assets):
 *
 *   managed      = mezoBufferBalance + mezoExecutorBalance + mezoExecutorMusdcBalance
 *                + ethVenueManaged + ethPendingUnbondHaircut
 *                + ethReceiverIdle
 *   liabilities  = withdrawReserved (WithdrawalQueue.totalReserved(): cash earmarked for a
 *                  closed-unfunded withdrawal batch -> belongs to EXITING holders, whose shares
 *                  are already burned, so it is no longer backing the outstanding supply)
 *   navRay       = (managed - liabilities) * ray / (totalSupply + virtualShares)
 *
 * There is no entry-side liability term, and that is a property of the design rather than an
 * omission: entry mints in the same transaction as the transfer, so a depositor's MUSD and the
 * shares it backs enter `managed` and `totalSupply` together and the ratio never moves. (An
 * entry queue WOULD need one — cash landing in the buffer before its shares exist reads as pure
 * yield for existing holders — which is one reason there isn't one.)
 *
 * ethReceiverIdle is USDC sitting on BridgeReceiver between arriving from the bridge and being
 * placed into a venue via ALLOCATE (or between being claimed and actually leaving) -- real
 * managed value that would otherwise be invisible here, understating NAV during that transport
 * window. It defaults to 0n when omitted, so a caller with no idle receiver balance is not
 * required to say so.
 *
 * Scope note (honest, not audit-grade): assumes USDC/MUSD 1:1 parity across the bridge (the
 * same assumption dustEpsilon/minOutBps already make throughout this codebase), and does not
 * discount in-flight BRIDGE TRANSFERS themselves (the amount currently mid-transit, neither
 * sitting on the receiver nor yet reflected in the Mezo buffer) beyond the caller-supplied
 * ethPendingUnbondHaircut -- that gap is a documented, accepted limitation, not fixed here.
 * It is a real independent read, not a claim of cent-perfect precision.
 *
 * @param {{mezoBufferBalance:bigint, mezoExecutorBalance?:bigint,
 *          mezoExecutorMusdcBalance?:bigint,
 *          ethVenueManaged:bigint, ethPendingUnbondHaircut:bigint,
 *          ethReceiverIdle?:bigint, withdrawReserved:bigint, totalSupply:bigint,
 *          virtualShares:bigint, ray:bigint}} inputs
 * @returns {bigint} navRay
 */
export function computeNavRay(inputs) {
  const managed =
    inputs.mezoBufferBalance + (inputs.mezoExecutorBalance ?? 0n)
    + (inputs.mezoExecutorMusdcBalance ?? 0n)
    + inputs.ethVenueManaged + inputs.ethPendingUnbondHaircut + (inputs.ethReceiverIdle ?? 0n);
  const liabilities = inputs.withdrawReserved;
  const netAssets = managed > liabilities ? managed - liabilities : 0n;
  const shares = inputs.totalSupply + inputs.virtualShares;
  if (shares === 0n) throw new Error("computeNavRay: zero shares (virtualShares misconfigured?)");
  return (netAssets * inputs.ray) / shares;
}

/**
 * Off-chain guard band hook. Currently returns static config values (100/40bps default) —
 * the `marketCondition` parameter exists so a FUTURE dynamic model (vol-scaled, TVL-scaled,
 * venue-count-scaled, whatever) can compute upper/lowerBps from live conditions without
 * every caller changing; today it is unused and the function is a pure passthrough over
 * config, same "explicit input, no invented defaults buried deep" shape as evaluateApyGate.
 *
 * @param {{upperBps?: bigint|number|string, lowerBps?: bigint|number|string,
 *          marketCondition?: object}} input
 * @returns {{upperBps:bigint, lowerBps:bigint}}
 */
export function navGuardBand({ upperBps, lowerBps } = {}) {
  return {
    upperBps: upperBps === undefined || upperBps === null ? DEFAULT_GUARD_UPPER_BPS : BigInt(upperBps),
    lowerBps: lowerBps === undefined || lowerBps === null ? DEFAULT_GUARD_LOWER_BPS : BigInt(lowerBps),
  };
}

/**
 * Pure guard check applied BEFORE a candidate NAV is ever proposed on-chain. Same
 * cross-multiplication as NAVConsumer.postNAV's require (growth*10000 > prev*bps) so the
 * off-chain guard's boundary exactly matches the on-chain one it is meant to sit inside of.
 *
 * @param {{candidateNavRay:bigint, prevNavRay:bigint, upperBps:bigint, lowerBps:bigint}} input
 * @returns {{ok:boolean, reason?:string, side:"growth"|"drop", deltaAssets:bigint}}
 */
export function checkNavWithinGuard({ candidateNavRay, prevNavRay, upperBps, lowerBps }) {
  if (prevNavRay === 0n) return { ok: false, reason: "prevNavRay is zero", side: "growth", deltaAssets: 0n };
  if (candidateNavRay >= prevNavRay) {
    const growth = candidateNavRay - prevNavRay;
    const exceeds = growth * 10_000n > prevNavRay * upperBps;
    return {
      ok: !exceeds,
      reason: exceeds ? `growth exceeds off-chain guard upperBps=${upperBps}` : undefined,
      side: "growth",
      deltaAssets: growth,
    };
  }
  const drop = prevNavRay - candidateNavRay;
  const exceeds = drop * 10_000n > prevNavRay * lowerBps;
  return {
    ok: !exceeds,
    reason: exceeds ? `drop exceeds off-chain guard lowerBps=${lowerBps}` : undefined,
    side: "drop",
    deltaAssets: drop,
  };
}
