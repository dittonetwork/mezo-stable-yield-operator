// SPDX-License-Identifier: BUSL-1.1
// Every threshold that decides whether a task is SIGNABLE must live in git, so that changing one
// takes a commit rather than a hand-edit on a host. On the real droplet AGG_CONFIG and
// OPERATOR_CONFIG point at /etc/ditto/*.json, generated outside git by
// ops/testnet/setup-runtime-host.sh and never derived from this repo's example files — so without
// this indirection, bumping a threshold would never leave a trace in history. Both aggregator.mjs
// and operator/server.mjs call this against their OWN *-config.example.json at a path that is
// never env-overridable (always relative to the calling script, i.e. this checkout, kept current
// by `git pull` alongside the code), then overlay the result onto their locally resolved cfg.
// Every other key — rpcUrl, addresses, secret refs, pollSecs — still comes from the host config.
//
// DELETED 2026-08-10, by that rule: navGuardUpperBps / navGuardLowerBps. The canonical exact-match
// verification (verify.mjs verifyCanonicalPrice) replaced the plausibility band on 2026-08-06, so the
// band only ever fired on the legacy test path — a dead entry here reads as a live safety property in
// review, which is exactly what the rule forbids. Also gone: minPlacementClip, whose job the shared
// economic minimum now does in one place instead of two.
//
// The rule for what belongs here: a knob the OPERATORS enforce. Aggregator-only cadence does not
// (see navPostIntervalSecs below), and a knob nothing reads must be deleted rather than tracked —
// a dead entry here reads as a live safety property in review.

// Swap policy the proposer and every operator must hold IDENTICALLY. A constant, not a key in
// either example.json, because two files are two places to edit and what they produce when they
// disagree is silent: the operator denies an honest proposal, or co-signs a slack one, and either
// way nothing says which side is wrong.
//
// It was already wrong. The proposer floored min-out at `minOutBps` 50 while every operator bounded
// with `maxSlippageBps` 100, so a quorum would have co-signed a min-out twice as slack as the one
// the proposer builds — the sandwich margin the operator check exists to close, left open by two
// keys that were never the same knob. `maxSlippageBps` is deleted; this is the only slippage number
// in the system now.
export const SHARED_SWAP_POLICY = {
  // minOut = 99.5% of the depth-aware quote. The quote already carries the pool's fee tier and the
  // trade's price impact, so this covers drift between quoting and execution and nothing else.
  minOutBps: 50,
  // Refuse a placement whose whole MUSD -> mUSDC -> MUSD round trip costs more than this. Measured
  // against the live ts=10 venue through its own quoter, 2026-08-10: 10 bps at 2k / 10k / 25k / 50k
  // and 11 bps at 75k — flat in size, because the cost is the pool's standing spread (~0.9911 out,
  // ~1.0078 back) rather than impact. So this is ~5x headroom in normal conditions and binds only
  // once the pool has gone one-sided. Capital then stays idle, which is the intended answer: a
  // per-dollar spread is not something a smaller clip or a tighter min-out can reduce.
  maxRoundTripLossBps: 50,
  // No spot mids, anywhere, ever. `TigrisCLSwapAdapter.quote()` reads slot0 and returns a MID that
  // omits both the fee and the impact, so the floor derived from it is not a floor. With no quoter
  // reachable, both sides refuse to sign rather than quietly bound with a number that cannot bound.
  requireDepthAwareQuote: true,
};

// The economic minimum for a Mezo -> Ethereum deployment, in MUSD wei. ONE value, enforced by the
// proposer and by every operator, for the same reason the swap policy is one value: two copies drift.
//
// OWNER DECISION 2026-09-24: 500 MUSD, replacing the 100 MUSD commissioning threshold.
// This applies to the actual placement clip AFTER withdrawal reservations and the 15% buffer
// floor, accumulated across depositors. It is not a minimum deposit and does not gate withdrawals
// or ALLOCATE of USDC already delivered to Ethereum. Below it, MUSD stays idle on Mezo.
// At near-parity exchange rates a 3 USDC outbound bridge fee is about 0.6% of a 500 MUSD
// placement, before swaps, gas or return costs. This is an owner-selected cost/waiting trade-off,
// not a guaranteed break-even or APY. Both proposer and all seats must deploy the same source.
export const SHARED_PLACEMENT_POLICY = {
  minEconomicPlacementMusd: 500n * 10n ** 18n,
};

export function resolveTrackedThresholds(readFileSyncFn, trackedConfigPath) {
  const tracked = JSON.parse(readFileSyncFn(trackedConfigPath, "utf8"));
  for (const key of ["withdrawBatchSumThreshold", "withdrawQueueMaxAgeSecs", "poolFeeBps", "placementBufferFloorBps"]) {
    const value = tracked?.[key];
    if (!((typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === "string" && /^[0-9]+$/.test(value)))) {
      throw new Error(`tracked safety setting ${key} must be an unsigned integer`);
    }
    if (BigInt(value) >= 1n << 256n || (key.endsWith("Bps") && BigInt(value) > 10_000n)) {
      throw new Error(`tracked safety setting ${key} is out of range`);
    }
  }
  return {
    withdrawBatchSumThreshold: tracked.withdrawBatchSumThreshold,
    // The withdrawal queue's age escape: a CLOSE trigger the operators enforce, so a host-local
    // config must not be able to widen it behind a commit's back. (navPostIntervalSecs is
    // deliberately NOT here — it is aggregator cadence only, nothing operator-side checks it.)
    withdrawQueueMaxAgeSecs: tracked.withdrawQueueMaxAgeSecs,
    // The pool's fee tier (Tigris CL MUSD/mUSDC mainnet = 5). Only `resolveMinOut`'s degraded
    // branch reads it, and SHARED_SWAP_POLICY closes that branch off in production — kept tracked
    // so the mock-pool test stacks that do reach it stay fee-aware, not as a live bound.
    poolFeeBps: tracked.poolFeeBps,
    // The operational buffer floor, moved off chain 2026-08-10 so tuning it takes a commit instead
    // of a 2-of-2 guardian ceremony plus a 24 h timelock. It decides whether a PLACEMENT is
    // signable, so it belongs here by the rule above: a host-local config that quietly set it to 0
    // would let placement drain the cushion to the on-chain backstop without leaving a trace.
    placementBufferFloorBps: tracked.placementBufferFloorBps,
    // Last, so it wins over anything either example.json says about these. They are the same values on
    // both sides by construction rather than by two files agreeing.
    ...SHARED_SWAP_POLICY,
    ...SHARED_PLACEMENT_POLICY,
  };
}
