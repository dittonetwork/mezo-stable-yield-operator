// SPDX-License-Identifier: BUSL-1.1
// The operator's refusal logic is the 4-of-5 guarantee. If these tests pass vacuously, the
// operator set is five rubber stamps — so every case here is written as "a hostile or buggy
// aggregator proposes X; the operator must say no".
//
// Multichain (2026-07-15): cfg now carries a leg per chainId (Mezo + Ethereum) and readers
// are keyed by chainId — this operator verifies BOTH legs from one process.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyProposal, castChainReader, usdcValuation } from "./verify.mjs";
import { usdcExitRate, usdcToMusd, twapFloorOut } from "../task-engine/usdc-valuation.mjs";
import { SHARED_NAV_POLICY } from "../task-engine/threshold-config.mjs";
import { keccak256Hex } from "../task-engine/keccak.mjs";
import { TaskType, calldataHash, _word as word } from "../task-engine/engine.mjs";

const MEZO_CHAIN = 31611;
const ETH_CHAIN = 11155111;

const MEZO_LEG = {
  chainId: MEZO_CHAIN,
  executor: "0x00000000000000000000000000000000000000e0",
  vault: "0x00000000000000000000000000000000000000a0",
  nav: "0x00000000000000000000000000000000000000a1",
  queue: "0x00000000000000000000000000000000000000a2",
  swapAdapter: "0x00000000000000000000000000000000000000a3",
  musd: "0x00000000000000000000000000000000000000a4",
  musdc: "0x00000000000000000000000000000000000000a5",
  bridgeAdapter: "0x00000000000000000000000000000000000000a7",
  swapPool: "0x00000000000000000000000000000000000000aa",
  swapQuoter: "0x00000000000000000000000000000000000000ab",
};
const ETH_LEG = {
  chainId: ETH_CHAIN,
  receiver: "0x00000000000000000000000000000000000000e1",
  usdc: "0x00000000000000000000000000000000000000a8",
};
// No slippage or round-trip keys here on purpose. Both come from SHARED_SWAP_POLICY
// (threshold-config.mjs), which resolveTrackedThresholds overlays onto every real operator's cfg and
// which verify.mjs also defaults from — so a cfg that omits them, like this one, gets the SAME bounds
// a production operator has. `maxSlippageBps: 100` lived here until 2026-08-10 and was the drift
// itself: the proposer floored at 50 bps while this suite proved the operator accepting 100.
const CFG = {
  legs: { mezo: MEZO_LEG, eth: ETH_LEG },
  withdrawBatchSumThreshold: "1",
  withdrawQueueMaxAgeSecs: "0",
  navDeviationBps: 100,
  allowLegacyNavAccountingForTests: true,
};
const RAY = 10n ** 27n;
const NOW = 1_800_000_000n;
const MEZO_HASH = "0x" + "aa".repeat(32);
const ETH_HASH = "0x" + "bb".repeat(32);

const mezoReader = (over = {}) => ({
  now: async () => NOW,
  blockNumber: async () => 1000n,
  placeableSurplus: async () => 1000n * 10n ** 18n,
  totalAssets: async () => 10_000n * 10n ** 18n,
  currentNAV: async () => RAY,
  lastNavEpoch: async () => 3n,
  quote: async (_a, _b, amt) => amt / 10n ** 12n, // 18dec -> 6dec at parity
  // Depth-aware quoting is MANDATORY now (SHARED_SWAP_POLICY), so this is the production path and
  // belongs in the default reader rather than being opted into per test. Direction-aware, unlike the
  // `quote` mid above, because two of the checks it feeds — the min-out floor and the round trip —
  // quote the pool in opposite directions. At parity in both, so a round trip costs 0 bps and every
  // test that is not ABOUT the round trip is unaffected by it.
  depthQuote: async (tokenIn, _b, amt) =>
    (String(tokenIn).toLowerCase() === MEZO_LEG.musd ? amt / 10n ** 12n : amt * 10n ** 12n),
  executorMusdBalance: async () => 0n,
  executorMusdcBalance: async () => 0n,
  musdcDecimals: async () => 6n,
  assetDecimals: async () => 18n,
  currentBatchId: async () => 1n,
  // Open, and big enough to be due at the suite's default (unset) thresholds.
  batchInfo: async () => ({
    batchId: 1n, status: 1n, openedAt: NOW - 1n, totalShares: 1000n * 10n ** 18n, obligation: 0n, funded: 0n,
  }),
  tokenBalance: async () => 10n ** 12n,
  venueTotalManaged: async () => 1000n * 10n ** 6n,
  // Independent-NAV reads (2026-07-28): defaults chosen so the default independent navRay
  // works out to exactly RAY -- same as the default currentNAV() above -- so existing tests
  // that don't care about this new cross-check are unaffected. managed = 1_000_000, shares =
  // 999_000 + VIRTUAL_SHARES(1000) = 1_000_000 -> navRay = 1_000_000 * RAY / 1_000_000 = RAY.
  mezoBufferBalance: async () => 1_000_000n,
  withdrawalQueueTotalReserved: async () => 0n,
  vaultTotalSupply: async () => 999_000n,
  ...over,
});
const ethReader = (over = {}) => ({
  now: async () => NOW,
  blockNumber: async () => 5000n,
  tokenBalance: async () => 1000n * 10n ** 6n, // ample receiver balance by default
  venueTotalManaged: async () => 1000n * 10n ** 6n,
  ethReceiverIdle: async () => 0n,
  ethVenueManagedAndHaircut: async () => ({ managed: 0n, pendingUnbondHaircut: 0n }),
  assetDecimals: async () => 6n,
  unbondTicket: async (id) => ({ id, venueClassId: "0x" + "11".repeat(32), amount: 100n,
    requestedAt: NOW - 10n, claimableAt: NOW, claimed: false }),
  ...over,
});
const chainsFor = (mezoOver = {}, ethOver = {}) => ({
  [String(MEZO_CHAIN)]: mezoReader(mezoOver),
  [String(ETH_CHAIN)]: ethReader(ethOver),
});

test("HEARTBEAT: independent due/armed/activity reads, short lifetime and Ethereum domain", async () => {
  const previous = NOW - 13n * 86400n;
  const payload = "0x" + word(previous) + word(NOW);
  const make = (over = {}) => bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver,
    taskType: keccak256Hex("dmusd.task.HEARTBEAT"), expiry: NOW + 300n, maxBlock: 0n, ...over }), payload);
  const state = { now: NOW, lastActivity: previous, active: false };
  const verify = (t = make(), over = {}) => verifyProposal({ task: t, payload, cfg: CFG,
    chains: chainsFor({}, { heartbeatState: async () => ({ ...state, ...over }) }) });
  assert.equal((await verify()).ok, true);
  for (const over of [{ active: true }, { lastActivity: previous + 1n }, { now: NOW - 1n }, { now: NOW + 301n }]) {
    assert.equal((await verify(make(), over)).ok, false, JSON.stringify(over, (_, v) => typeof v === "bigint" ? String(v) : v));
  }
  assert.equal((await verify(make({ expiry: NOW + 301n }))).ok, false);
  assert.equal((await verify(make({ maxBlock: 1n }))).ok, false);
  assert.equal((await verify(make({ chainId: MEZO_CHAIN, contractAddr: ETH_LEG.receiver }))).ok, false);
  const bad = await verifyProposal({ task: make(), payload, cfg: CFG, chains: chainsFor({}, {
    heartbeatState: async () => { throw new Error("RPC down"); },
  }) });
  assert.equal(bad.ok, false);
  for (const badPayload of ["0x", payload + "00", "0x" + word(1n << 64n) + word(NOW),
    "0x" + word(previous) + word(NOW - 1n)]) {
    const v = await verifyProposal({ task: bind(make(), badPayload), payload: badPayload, cfg: CFG,
      chains: chainsFor({}, { heartbeatState: async () => state }) });
    assert.equal(v.ok, false, "noncanonical / not-yet-due payload refused");
  }
});

test("HEARTBEAT on Mezo reads its own clock, not Ethereum activity; target is domain-bound", async () => {
  const previous = NOW - 13n * 86400n;
  const payload = "0x" + word(previous) + word(NOW);
  const t = bind(task({ taskType: TaskType.HEARTBEAT, expiry: NOW + 300n, maxBlock: 0n }), payload);
  const chains = chainsFor({ heartbeatState: async () => ({ now: NOW, lastActivity: previous, active: false }) },
    { heartbeatState: async () => { throw new Error("must not read another leg"); } });
  assert.equal((await verifyProposal({ task: t, payload, cfg: CFG, chains })).ok, true);
  assert.equal((await verifyProposal({ task: { ...t, contractAddr: ETH_LEG.receiver }, payload, cfg: CFG, chains })).ok, false);
});

test("DEALLOCATE refuses null managed balance rather than dropping its bound", async () => {
  const payload = "0x" + word(1n) + word(10n);
  const v = await verifyProposal({ task: bind(task({ chainId: ETH_CHAIN,
    contractAddr: ETH_LEG.receiver, taskType: TaskType.DEALLOCATE }), payload),
    payload, cfg: CFG, chains: chainsFor({}, { venueTotalManaged: async () => null }) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unreadable/);
});

test("POST_NAV and FIX_BATCH refuse skipped or overflowing epochs", async () => {
  for (const type of [TaskType.POST_NAV, TaskType.FIX_BATCH]) {
    for (const epoch of [5n, (1n << 64n)]) {
      const payload = "0x" + word(epoch) + word(RAY);
      const v = await verifyProposal({ task: bind(task({ taskType: type }), payload), payload,
        cfg: CFG, chains: chainsFor() });
      assert.equal(v.ok, false);
      assert.match(v.reason, /must be exactly/);
    }
  }
});

test("an unreadable inventory is a refusal, not an uncaught verification error", async () => {
  const cfg = { ...CFG, navAccounting: { get inventory() { throw new SyntaxError("truncated JSON"); } } };
  const v = await verifyProposal({ task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: {} });
  assert.equal(v.ok, false);
  assert.match(v.reason, /inventory unreadable/);
});

test("non-price verification does not open the NAV inventory", async () => {
  let reads = 0;
  const cfg = { ...CFG, navAccounting: { get inventory() { reads++; return {}; } } };
  const payload = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task(), payload), payload, cfg, chains: chainsFor() });
  assert.equal(v.ok, true, v.reason);
  assert.equal(reads, 0);
});

test("both HEARTBEAT legs survive unreadable NAV inventory", async () => {
  const previous = NOW - 13n * 86400n;
  const payload = "0x" + word(previous) + word(NOW);
  const cfg = { ...CFG, navAccounting: { get inventory() { throw new Error("disk unavailable"); } } };
  const heartbeatState = async () => ({ now: NOW, lastActivity: previous, active: false });
  for (const [chainId, contractAddr] of [[MEZO_CHAIN, MEZO_LEG.executor], [ETH_CHAIN, ETH_LEG.receiver]]) {
    const t = bind(task({ chainId, contractAddr, taskType: TaskType.HEARTBEAT, expiry: NOW + 300n, maxBlock: 0n }), payload);
    const verdict = await verifyProposal({ task: t, payload, cfg,
      chains: chainsFor({ heartbeatState }, { heartbeatState }) });
    assert.equal(verdict.ok, true, verdict.reason);
  }
});

const task = (over = {}) => ({
  chainId: MEZO_CHAIN,
  contractAddr: MEZO_LEG.executor,
  nonce: "0x1",
  taskType: TaskType.SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH,
  expiry: NOW + 240n,
  maxBlock: 1100n,
  ...over,
});
const bind = (t, payload) => ({ ...t, calldataHash: calldataHash(payload) });

const placement = (amountIn, minOut) => "0x" + word(amountIn) + word(minOut);
const GOOD_IN = 500n * 10n ** 18n;
const GOOD_MIN = (GOOD_IN / 10n ** 12n * 9950n) / 10_000n;

test("signs a placement it would have proposed itself", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task(), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, true, v.reason);
});

test("REFUSES a starved min-out (the sandwich vector)", async () => {
  const p = placement(GOOD_IN, 1n);
  const v = await verifyProposal({ task: bind(task(), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /below my quote floor/);
});

test("REFUSES placement beyond the surplus it can see", async () => {
  const p = placement(5000n * 10n ** 18n, 1n);
  const v = await verifyProposal({ task: bind(task(), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /placeableSurplus/);
});

test("REFUSES a payload that does not match calldataHash (blank-cheque signing)", async () => {
  const honest = placement(GOOD_IN, GOOD_MIN);
  const swapped = placement(GOOD_IN, 1n); // hash commits to the honest one, payload is not
  const v = await verifyProposal({ task: bind(task(), honest), payload: swapped, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /calldataHash/);
});

test("REFUSES when no payload is supplied at all", async () => {
  const v = await verifyProposal({ task: bind(task(), "0x00"), payload: undefined, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /payload missing/);
});

test("REFUSES a task aimed at a contract that is not mine", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const t = bind(task({ contractAddr: "0x00000000000000000000000000000000deadbeef" }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not my executor/);
});

test("REFUSES a chainId this operator has no leg configured for (cross-chain replay)", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task({ chainId: 1 }), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a leg I am configured for/);
});

test("REFUSES a swap task whose expiry reaches past the 5-min window", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task({ expiry: NOW + 3600n }), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /5-min window/);
});

test("REFUSES a swap task with no maxBlock bound", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task({ maxBlock: 0n }), p), payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /maxBlock/);
});

// The operational buffer floor lives OFF chain (2026-08-10) so it can be tuned without a 2-of-2
// guardian ceremony. That only means anything if the OPERATORS apply it: otherwise the aggregator is
// the sole judge of its own bound and the git-tracked number binds nothing — the exact defect the
// close thresholds had. `placeableSurplus()` still nets the solvency-critical reservations and the
// vault's own 5% backstop on chain; this is the cushion above that.
test("REFUSES a placement that eats into the operational buffer floor", async () => {
  // 10k TVL, 1000 placeable on chain. A 15% target withholds 1500 — more than is placeable — so the
  // bound clamps to 0 and any ask is refused.
  const cfg = { ...CFG, placementBufferFloorBps: 1500 };
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({ task: bind(task(), p), payload: p, cfg, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /buffer floor/);
});

test("SIGNS the same placement once the floor leaves room for it", async () => {
  // Same target, more TVL headroom: 1000 placeable against 3k TVL withholds 450, leaving 550 — and
  // the 500 MUSD ask fits. The bound moves with TVL, so this is the same code taking the other branch.
  const cfg = { ...CFG, placementBufferFloorBps: 1500 };
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({
    task: bind(task(), p), payload: p, cfg,
    chains: chainsFor({ totalAssets: async () => 3_000n * 10n ** 18n }),
  });
  assert.equal(v.ok, true, v.reason);
});

test("the floor is opt-in: absent or 0, placement is bounded by placeableSurplus alone", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  for (const cfg of [CFG, { ...CFG, placementBufferFloorBps: 0 }]) {
    const v = await verifyProposal({ task: bind(task(), p), payload: p, cfg, chains: chainsFor() });
    assert.equal(v.ok, true, v.reason);
  }
});

// ---- fix_batch(nav) / FIX_BATCH ----
// A close publishes the price it strikes the obligation at, so the operator has TWO independent
// things to satisfy itself about: the price (judged exactly as a POST_NAV is — see the shared
// verifyProposedPrice) and whether this close should happen at all. Both halves are covered below.
//
// The execution window comes from task()'s own defaults (expiry NOW+240, maxBlock 1100) rather than
// being widened here: FIX_BATCH is gated on chain exactly like a swap, and a close built without a
// window is refused below.
//
// The default mock's independent recomputation works out to exactly RAY at epoch 3, so this is the
// price a close proposed against that chain state must carry.
const CLOSE_PAYLOAD = "0x" + word(4n) + word(RAY);
const CLOSE = () => bind(task({ taskType: TaskType.FIX_BATCH }), CLOSE_PAYLOAD);
const close = (chains, cfg = CFG) => verifyProposal({ task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains });

test("FIX_BATCH signs a due, non-empty, open batch at a price it recomputed itself", async () => {
  const v = await close(chainsFor());
  assert.equal(v.ok, true, v.reason);
});

// The price half. A close is not a cheaper way to publish a NAV: it is held to the same standard as
// a post, by the same code, so the merge cannot become a way to slip a price past the operators.
test("REFUSES a close whose price does not match this operator's own recomputation", async () => {
  const v = await close(chainsFor({ mezoBufferBalance: async () => 820_000n }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /INDEPENDENTLY recomputed NAV/);
});

test("REFUSES a close at a NAV of zero — it would burn the batch's shares for nothing", async () => {
  const p = "0x" + word(4n) + word(0n);
  const v = await verifyProposal({
    task: bind(task({ taskType: TaskType.FIX_BATCH }), p), payload: p, cfg: CFG, chains: chainsFor(),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /zero/);
});

test("REFUSES a close reusing a spent epoch — posting is part of closing, so monotonicity is too", async () => {
  const p = "0x" + word(3n) + word(RAY); // the mock's lastNavEpoch is 3
  const v = await verifyProposal({
    task: bind(task({ taskType: TaskType.FIX_BATCH }), p), payload: p, cfg: CFG, chains: chainsFor(),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /must be exactly/);
});

// The payload names a price but not a BATCH, so MezoOpsExecutor gates FIX_BATCH on the same
// mandatory maxBlock + 5-minute expiry as a swap. A close built with the admin window is one the
// operators sign and the chain then rejects — a signing round spent per attempt, forever.
test("REFUSES a fix_batch with no maxBlock bound — the window is what binds it to the batch", async () => {
  const t = bind(task({ taskType: TaskType.FIX_BATCH, maxBlock: 0n }), CLOSE_PAYLOAD);
  const v = await verifyProposal({ task: t, payload: CLOSE_PAYLOAD, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /maxBlock/);
});

test("REFUSES a fix_batch carrying the one-hour admin expiry instead of the execution window", async () => {
  const t = bind(task({ taskType: TaskType.FIX_BATCH, expiry: NOW + 3600n }), CLOSE_PAYLOAD);
  const v = await verifyProposal({ task: t, payload: CLOSE_PAYLOAD, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /5-min window/);
});

test("REFUSES closing an EMPTY batch — it would burn a batch id and a signing round on nothing", async () => {
  const v = await verifyProposal({
    task: CLOSE(),
    payload: CLOSE_PAYLOAD,
    cfg: CFG,
    chains: chainsFor({
      batchInfo: async () => ({ batchId: 1n, status: 1n, openedAt: NOW - 1n, totalShares: 0n, obligation: 0n, funded: 0n }),
    }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /empty/);
});

test("REFUSES closing a batch that is not Open", async () => {
  const v = await verifyProposal({
    task: CLOSE(),
    payload: CLOSE_PAYLOAD,
    cfg: CFG,
    chains: chainsFor({
      batchInfo: async () => ({ batchId: 1n, status: 2n, openedAt: NOW - 1n, totalShares: 5n, obligation: 0n, funded: 0n }),
    }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not Open/);
});

// The size/age trigger is git-tracked (threshold-config.mjs) precisely so a host-local config
// cannot widen it. That only means anything if the OPERATOR enforces it: otherwise the aggregator
// is the sole judge of its own trigger, and the tracked number binds nothing.
test("REFUSES a batch that is neither big enough nor old enough", async () => {
  const cfg = { ...CFG, withdrawBatchSumThreshold: String(12n * 10n ** 18n), withdrawQueueMaxAgeSecs: "21600" };
  const small = { batchId: 1n, status: 1n, openedAt: NOW - 100n, totalShares: 1n * 10n ** 18n, obligation: 0n, funded: 0n };
  const v = await verifyProposal({
    task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: chainsFor({ batchInfo: async () => small }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not due/);
});

test("REFUSES automatic FIX_BATCH when both configured triggers are off", async () => {
  const cfg = { ...CFG, withdrawBatchSumThreshold: "0", withdrawQueueMaxAgeSecs: "0" };
  const bigAndOld = { batchId: 1n, status: 1n, openedAt: 1n, totalShares: 100n * 10n ** 18n, obligation: 0n, funded: 0n };
  const v = await verifyProposal({
    task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: chainsFor({ batchInfo: async () => bigAndOld }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not due/);
});

test("SIGNS a batch below the size trigger once it is old enough — either arm suffices", async () => {
  const cfg = { ...CFG, withdrawBatchSumThreshold: String(12n * 10n ** 18n), withdrawQueueMaxAgeSecs: "21600" };
  const small = { batchId: 1n, status: 1n, openedAt: NOW - 100n, totalShares: 1n * 10n ** 18n, obligation: 0n, funded: 0n };
  const aged = { ...small, openedAt: NOW - 21_600n };
  assert.equal((await verifyProposal({ task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: chainsFor({ batchInfo: async () => small }) })).ok, false);
  assert.equal((await verifyProposal({ task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: chainsFor({ batchInfo: async () => aged }) })).ok, true);
});

test("SIGNS a young batch once it is big enough — either arm suffices", async () => {
  const cfg = { ...CFG, withdrawBatchSumThreshold: String(12n * 10n ** 18n), withdrawQueueMaxAgeSecs: "21600" };
  const big = { batchId: 1n, status: 1n, openedAt: NOW - 1n, totalShares: 100n * 10n ** 18n, obligation: 0n, funded: 0n };
  const v = await verifyProposal({ task: CLOSE(), payload: CLOSE_PAYLOAD, cfg, chains: chainsFor({ batchInfo: async () => big }) });
  assert.equal(v.ok, true, v.reason);
});

test("POST_NAV: accepts only a fresh value that matches the independent live recomputation", async () => {
  const good = "0x" + word(4n) + word(RAY);
  const t = (p) => bind(task({ taskType: TaskType.POST_NAV, maxBlock: 0n, expiry: NOW + 3600n }), p);
  assert.equal((await verifyProposal({ task: t(good), payload: good, cfg: CFG, chains: chainsFor() })).ok, true);

  const stale = await verifyProposal({
    task: t(good), payload: good, cfg: CFG,
    chains: chainsFor({ mezoBufferBalance: async () => 820_000n }),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /INDEPENDENTLY recomputed NAV/);
});

test("POST_NAV: operator counts executor MUSD and normalized mUSDC once and pins every Mezo NAV read", async () => {
  const seen = [];
  const pinned = (name, value) => async (block) => { seen.push([name, block]); return value; };
  const p = "0x" + word(4n) + word(RAY);
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor({
      blockNumber: async () => 777n,
      mezoBufferBalance: pinned("vault", 700_000n),
      executorMusdBalance: pinned("executor-musd", 200_000n),
      executorMusdcBalance: pinned("executor-musdc", 100n),
      musdcDecimals: pinned("musdc-decimals", 3n),
      assetDecimals: pinned("musd-decimals", 6n),
      withdrawalQueueTotalReserved: pinned("reserved", 0n),
      vaultTotalSupply: pinned("supply", 999_000n),
    }),
  });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(seen.map(([, block]) => block), Array(seen.length).fill(777n));
  assert.equal(seen.filter(([name]) => name === "executor-musd").length, 1);
  assert.equal(seen.filter(([name]) => name === "executor-musdc").length, 1);
});

test("POST_NAV: operator enforces the 40 bps drop boundary, not a symmetric 100 bps band", async () => {
  const navAt40 = (RAY * 9_960n) / 10_000n;
  const navPast40 = navAt40 - 1n;
  const make = (ray) => {
    const payload = "0x" + word(4n) + word(ray);
    return { payload, task: bind(task({ taskType: TaskType.POST_NAV, maxBlock: 0n, expiry: NOW + 3600n }), payload) };
  };
  const at40 = make(navAt40);
  const past40 = make(navPast40);
  const independent = (ray) => chainsFor({ mezoBufferBalance: async () => (ray * 1_000_000n) / RAY });
  assert.equal((await verifyProposal({ ...at40, cfg: CFG, chains: independent(navAt40) })).ok, true);
  const refused = await verifyProposal({ ...past40, cfg: CFG, chains: independent(navPast40) });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /beyond the band/);
});

const CONTROLLER = "0x00000000000000000000000000000000000000c0";


// NOT approved for mainnet — see the pause note in aggregator.test.mjs. What WAS ratified 2026-07-28
// (Ефим) is only that the withdraw-side trigger is a SEPARATE,
// independent knob from the $10 deposit-side one, fixed at $12 -- MUSD is 18-decimal
// (DMUSDVault.sol:692) -- $12 == 12 * 1e18. Previously withdrawBatchSumThreshold had NO
// operator-side counterpart check at all (flagged in the prior task's report); this is that
// check, added to the NET_CLEAR withdraw-leg case above.
const SHIPPED_WITHDRAW_THRESHOLD = 100n * 10n ** 18n;

test("the shipped example operator config carries the same withdraw threshold as the aggregator", () => {
  const exampleConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", "operator-config.example.json");
  const exampleCfg = JSON.parse(readFileSync(exampleConfigPath, "utf8"));
  assert.equal(BigInt(exampleCfg.withdrawBatchSumThreshold), SHIPPED_WITHDRAW_THRESHOLD);
});


// The default-deny branch is the whole reason an unknown task type is safe: a signed task the
// operator has no case for is refused, not waved through. Pinned with a type that no longer
// exists — the executor sweep, deleted with cross-venue rebalancing.
test("an unrecognised task type is REFUSED, not signed by default", async () => {
  const gone = keccak256Hex("dmusd.task.REBALANCE");
  const p = "0x" + word(500n * 10n ** 18n);
  const t = bind(task({ taskType: gone, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
});

// ------------------------------------------------------------------
// SWAP_USDC_TO_MUSD_ON_MEZO / CLEAR_BATCH — `swap_usdc_to_musd_on_mezo(amount)` and
// `clear_batch(batch_number)` from the owner's canonical operator API (2026-08-06). Both
// used to hit the default-deny branch below, which meant neither could ever be driven by the
// operator runtime — only by the driver's own local keys.
// ------------------------------------------------------------------

// 6dp mUSDC in, 18dp MUSD out — the reverse of the shared `quote` default, which only models
// the placement direction.
// The pool as the swap-back cap reads it at the head: mean tick 276324 less the 5 bps fee prices mUSDC
// at ~0.9995e12 MUSD wei per micro-unit, and a live 1,000 USDC probe agrees with it.
const TWAP_EXIT = 999_500_000_000n;
const poolAtHead = (probeRate = TWAP_EXIT) => ({
  pinnedUintCall: async (_t, sig, args) => sig.startsWith("fee") ? 500n : sig.startsWith("tickSpacing") ? 10n
    : sig.startsWith("quoteExactInputSingle") ? BigInt(args[2]) * probeRate : 0n,
  pinnedAddressCall: async (_t, sig) => sig.startsWith("token0") ? MEZO_LEG.musdc : MEZO_LEG.musd,
  pinnedTickCumulatives: async () => [0n, 276_324n * 1800n],
});
const swapBackReader = (over = {}) => ({
  quote: async (_a, _b, amt) => amt * 10n ** 12n, executorMusdcBalance: async () => 1000n * 10n ** 6n, ...poolAtHead(), ...over,
});
const swapBack = (musdcIn, minMusdOut) => "0x" + word(musdcIn) + word(minMusdOut);
// The TWAP exit rate exactly as a seat reads it from `poolAtHead`, and a depth quote `bps` under it.
const headRate = await usdcExitRate({
  reader: {
    uintCall: (_l, t, sig, args) => poolAtHead().pinnedUintCall(t, sig, args),
    addressCall: (_l, t, sig) => poolAtHead().pinnedAddressCall(t, sig),
    tickCumulatives: () => poolAtHead().pinnedTickCumulatives(),
  },
  pool: MEZO_LEG.swapPool, quoter: MEZO_LEG.swapQuoter, musd: MEZO_LEG.musd, musdc: MEZO_LEG.musdc, block: "latest",
  twapSecs: 1800, bandBps: 500, maxSpotDivergenceBps: 25, spotProbe: 1_000_000_000n,
});
const twapValue = (amt) => usdcToMusd(amt, 6, headRate);
const quoteBelowTwap = (bps) => async (_a, _b, amt) => (twapValue(amt) * (10_000n - bps)) / 10_000n;
// The min-out the proposer now signs: the slippage floor or the TWAP floor (2 bps inside the cap),
// whichever is higher.
const proposedSwapBack = (musdcIn, bps) => {
  const slip = (((twapValue(musdcIn) * (10_000n - bps)) / 10_000n) * 9950n) / 10_000n;
  const floor = twapFloorOut(musdcIn, headRate, 48n);
  return swapBack(musdcIn, slip > floor ? slip : floor);
};

test("SWAP_USDC_TO_MUSD_ON_MEZO: signs a return-leg swap it would have proposed itself", async () => {
  const p = swapBack(100n * 10n ** 6n, (100n * 10n ** 18n * 9950n) / 10_000n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader()) });
  assert.equal(v.ok, true, v.reason);
});

test("swap-back: independent funding floor rejects an underfunded final or split sale", async () => {
  const held = 1000n * 10n ** 6n, buffer = 100n * 10n ** 18n;
  const outstanding = buffer + held * 10n ** 12n;
  for (const amount of [held, held - 1n, held / 2n]) {
    const minimum = amount * 10n ** 12n;
    const pins = [];
    const verdict = async (min) => {
      const p = swapBack(amount, min);
      return verifyProposal({ task: bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p), payload: p,
        cfg: CFG, chains: chainsFor(swapBackReader({
          executorMusdcBalance: async (block) => { pins.push(block); return held; },
          withdrawalQueueTotalReserved: async (block) => { pins.push(block); return outstanding; },
          mezoBufferBalance: async (block) => { pins.push(block); return buffer; },
        })) });
    };
    const refused = await verdict(minimum - 1n);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /funding floor/);
    const allowed = await verdict(minimum);
    assert.equal(allowed.ok, true, allowed.reason);
    assert.ok(pins.length >= 6);
    assert.ok(pins.every((block) => block === 1000n), "funding reads must use one Mezo block");
  }
});

test("swap-back: unreadable funding state cannot be treated as zero debt", async () => {
  for (const over of [
    { withdrawalQueueTotalReserved: async () => { throw new Error("RPC down"); } },
    { withdrawalQueueTotalReserved: async () => null },
    { mezoBufferBalance: async () => -1n },
  ]) {
    const p = swapBack(100n * 10n ** 6n, 100n * 10n ** 18n);
    const v = await verifyProposal({ task: bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p), payload: p,
      cfg: CFG, chains: chainsFor(swapBackReader(over)) });
    assert.equal(v.ok, false);
    assert.match(v.reason, /funding/);
  }
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: REFUSES a starved min-out — it crosses a pool, so the sandwich bound applies", async () => {
  const p = swapBack(100n * 10n ** 6n, 1n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader()) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /below my quote floor/);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: REFUSES swapping more mUSDC than the executor holds", async () => {
  const p = swapBack(5000n * 10n ** 6n, 1n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader()) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /executor mUSDC balance/);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: signs a swap-back that lands within the cap under the pool's TWAP", async () => {
  const p = proposedSwapBack(500n * 10n ** 6n, 40n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader({ depthQuote: quoteBelowTwap(40n) })) });
  assert.equal(v.ok, true, v.reason);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: REFUSES a swap-back past the cap even with an honest min-out — the rest waits", async () => {
  // The min-out is exactly what the proposer would build from the quote, so the sandwich bound passes:
  // only the cap can stop a swap that sells into the pool's cliff.
  const p = proposedSwapBack(500n * 10n ** 6n, 60n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader({ depthQuote: quoteBelowTwap(60n) })) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /quotes \d+, under the pool's TWAP floor \d+ \(cap 50 bps\)/);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: REFUSES a signed min-out under the TWAP floor even when the quote is within the cap", async () => {
  // Codex's repro, 2026-09-30: a quote at the cap passed it, and the usual 50 bps slippage under it
  // was signed, so the swap could land ~100 bps under the TWAP. (49 here: exactly 50, rounded down,
  // is already a wei under the exact floor and is refused on the quote.)
  const musdcIn = 500n * 10n ** 6n;
  const quote = quoteBelowTwap(49n);
  const starved = swapBack(musdcIn, ((await quote(0, 0, musdcIn)) * 9950n) / 10_000n);
  const floor = twapFloorOut(musdcIn, headRate, 50n);
  const verdict = async (p) => verifyProposal({
    task: bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p), payload: p, cfg: CFG,
    chains: chainsFor(swapBackReader({ depthQuote: quote })),
  });
  const v = await verdict(starved);
  assert.equal(v.ok, false);
  assert.match(v.reason, /minMusdOut \d+ is under the pool's TWAP floor/);
  // Exact amounts at the boundary: the floor itself signs, one wei under it does not.
  assert.equal((await verdict(swapBack(musdcIn, floor))).ok, true);
  assert.equal((await verdict(swapBack(musdcIn, floor - 1n))).ok, false);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: REFUSES while the pool cannot be priced (spot off its TWAP)", async () => {
  const p = proposedSwapBack(500n * 10n ** 6n, 0n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor(swapBackReader({ depthQuote: quoteBelowTwap(0n), ...poolAtHead(990_000_000_000n) })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /swap-back held: .*diverges from the 1800s TWAP/);
});

test("SWAP_USDC_TO_MUSD_ON_MEZO: is swap-bearing — an unbounded expiry/maxBlock is refused", async () => {
  const p = swapBack(100n * 10n ** 6n, (100n * 10n ** 18n * 9950n) / 10_000n);
  const t = bind(task({ taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO, maxBlock: 0n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor(swapBackReader()) });
  assert.equal(v.ok, false);
});

const bufferFulfill = (batchId, amount) => "0x" + word(batchId) + word(amount);
const closedBatch = (over = {}) => ({ batchId: 1n, status: 2n, totalShares: 0n, obligation: 100n * 10n ** 18n, funded: 0n, ...over });

test("CLEAR_BATCH: signs a settlement the vault buffer covers", async () => {
  const p = bufferFulfill(1n, 100n * 10n ** 18n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor({ batchInfo: async () => closedBatch(), tokenBalance: async () => 500n * 10n ** 18n }),
  });
  assert.equal(v.ok, true, v.reason);
});

test("CLEAR_BATCH: REFUSES a batch that is still Open — fix_batch has to close it first", async () => {
  const p = bufferFulfill(1n, 100n * 10n ** 18n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor({ batchInfo: async () => closedBatch({ status: 1n }), tokenBalance: async () => 500n * 10n ** 18n }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /still Open/);
});

test("CLEAR_BATCH: REFUSES over-funding a batch beyond its outstanding", async () => {
  const p = bufferFulfill(1n, 500n * 10n ** 18n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor({ batchInfo: async () => closedBatch(), tokenBalance: async () => 5000n * 10n ** 18n }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /exceeds batch 1 outstanding/);
});

test("CLEAR_BATCH: bounds on the RAW buffer, not placeableSurplus — the money reserved FOR this batch must still pay it", async () => {
  const p = bufferFulfill(1n, 100n * 10n ** 18n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    // placeableSurplus 0 (every dollar is reserved for this very batch) but the buffer holds it.
    chains: chainsFor({
      batchInfo: async () => closedBatch(), placeableSurplus: async () => 0n,
      tokenBalance: async () => 100n * 10n ** 18n,
    }),
  });
  assert.equal(v.ok, true, v.reason);
});

test("default-denies a task type it cannot reason about", async () => {
  const p = "0x" + word(1n);
  const t = bind(task({ taskType: "0x" + "ff".repeat(32), maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unknown task type/);
});

// Gaps the external review found in the first cut (2026-07-15): the operator trusted the
// aggregator to have applied the inventory guard, and waved the ETH leg through on amount>0.
test("REFUSES placement into a venue thinner than 2x the clip (guard is operator-side too)", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const cfg = { ...CFG, legs: { ...CFG.legs, mezo: { ...MEZO_LEG, swapPool: "0x00000000000000000000000000000000000000a6" } } };
  const v = await verifyProposal({
    task: bind(task(), p), payload: p, cfg,
    chains: chainsFor({ tokenBalance: async () => 1n }), // venue drained
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /inventory/);
});

// ------------------------------------------------------------------
// ALLOCATE — gates purely on the receiver's own physical USDC balance (eth_call), read
// directly off this leg's own chain. A prior revision additionally cross-checked a
// source-chain BridgeSent log scan (bridgeSentTotal, raw eth_getLogs) — removed 2026-07-19
// (E's state-driven read model): that scan was never load-bearing against double-spend (see
// verify.mjs's ALLOCATE comment) and was buggy on top of being redundant (unbounded
// accumulation, no token filter, 10k-block window cap). Balance-as-authority is not a
// downgrade — it is, and always was, the actual gate; see [[eth-state-read-feasibility]].
// ------------------------------------------------------------------

function ethPlacePayload(venueLabel, amount) {
  const venueHex = Buffer.from(venueLabel).toString("hex").padEnd(64, "0");
  return "0x" + venueHex + word(amount);
}

test("ALLOCATE: signs purely off the receiver's physical balance — no source-chain leg needed", async () => {
  const p = ethPlacePayload("no-lock", 500n * 10n ** 6n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver, taskType: TaskType.ALLOCATE, maxBlock: 0n, expiry: NOW + 3600n }), p);
  // Deliberately NO mezo leg in cfg/chains at all — proves ALLOCATE no longer needs one.
  const cfg = { legs: { eth: ETH_LEG }, maxSlippageBps: 100, navDeviationBps: 100 };
  const v = await verifyProposal({ task: t, payload: p, cfg, chains: { [String(ETH_CHAIN)]: ethReader() } });
  assert.equal(v.ok, true, v.reason);
});

test("REFUSES ALLOCATE beyond the receiver's actual balance", async () => {
  const p = ethPlacePayload("no-lock", 9_999n * 10n ** 6n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver, taskType: TaskType.ALLOCATE, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor({}, { tokenBalance: async () => 100n * 10n ** 6n }) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /receiver balance/);
});

test("ALLOCATE never touches eth_getLogs / bridgeSentTotal — throws if the code path is reintroduced", async () => {
  const p = ethPlacePayload("no-lock", 500n * 10n ** 6n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver, taskType: TaskType.ALLOCATE, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({
    task: t, payload: p, cfg: CFG,
    chains: chainsFor({
      bridgeSentTotal: () => { throw new Error("bridgeSentTotal must never be called — getLogs was deleted 2026-07-19"); },
    }),
  });
  assert.equal(v.ok, true, v.reason);
});

test("REFUSES unbonding more than the venue actually holds", async () => {
  const p = ethPlacePayload("no-lock", 9_999n * 10n ** 6n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver, taskType: TaskType.DEALLOCATE, maxBlock: 0n, expiry: NOW + 3600n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /venue holds/);
});

// External review round 4: admin tasks had no upper expiry bound, so a signed NAV/close/
// rebalance stayed executable forever and any holder could pick the moment.
test("REFUSES an admin task whose expiry reaches far into the future", async () => {
  const p = "0x" + word(4n) + word(RAY);
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 0n, expiry: NOW + 86_400n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /executable at a holder's choosing/);
});

test("still signs an admin task inside the 1h admin window", async () => {
  const p = "0x" + word(1n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver, taskType: TaskType.BRIDGE_BACK, maxBlock: 0n, expiry: NOW + 1800n }), p);
  assert.equal((await verifyProposal({ task: t, payload: p, cfg: CFG, chains: chainsFor() })).ok, true);
});

test("BRIDGE_BACK checks the exact receiver ticket, not the current venue or aggregate state", async () => {
  const payload = "0x" + word(7n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver,
    taskType: TaskType.BRIDGE_BACK, maxBlock: 0n, expiry: NOW + 1800n }), payload);
  const valid = { id: 7n, venueClassId: "0x" + "22".repeat(32), amount: 100n,
    requestedAt: NOW - 10n, claimableAt: NOW, claimed: false };
  let reads = 0;
  const verdict = (ticket) => verifyProposal({ task: t, payload,
    cfg: { ...CFG, legs: { ...CFG.legs, eth: { ...ETH_LEG, venueClassId: "0x" + "33".repeat(32) } } },
    chains: chainsFor({}, { unbondTicket: async (id) => { reads++; assert.equal(id, 7n); return ticket; },
      venueTotalManaged: async () => { throw new Error("current venue is not ticket authority"); } }) });
  assert.equal((await verdict(valid)).ok, true);
  assert.equal(reads, 1, "independent ticket read is mandatory");
  for (const bad of [null, { ...valid, id: 0n }, { ...valid, id: 8n },
    { ...valid, amount: 0n }, { ...valid, amount: -1n }, { ...valid, amount: 1n << 256n },
    { ...valid, claimed: true }, { ...valid, claimed: "false" },
    { ...valid, claimableAt: NOW + 1n }, { ...valid, claimableAt: 0n },
    { ...valid, claimableAt: 1n << 64n }, { ...valid, requestedAt: NOW + 1n }]) {
    assert.equal((await verdict(bad)).ok, false, String(bad?.claimableAt));
  }
  const missing = chainsFor({}, { unbondTicket: async () => { throw new Error("RPC unavailable"); } });
  const v = await verifyProposal({ task: t, payload, cfg: CFG, chains: missing });
  assert.equal(v.ok, false);
  assert.match(v.reason, /ticket.*unreadable/i);
});

test("BRIDGE_BACK refuses a ticket outside uint64 before any ticket read", async () => {
  const payload = "0x" + word(1n << 64n);
  const t = bind(task({ chainId: ETH_CHAIN, contractAddr: ETH_LEG.receiver,
    taskType: TaskType.BRIDGE_BACK, maxBlock: 0n, expiry: NOW + 1800n }), payload);
  let reads = 0;
  const v = await verifyProposal({ task: t, payload, cfg: CFG,
    chains: chainsFor({}, { unbondTicket: async () => { reads++; return {}; } }) });
  assert.equal(v.ok, false);
  assert.equal(reads, 0);
});

test("CLEAR_BATCH accepts only known funding states, including partial funding", async () => {
  const payload = bufferFulfill(1n, 50n * 10n ** 18n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), payload);
  for (const status of [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 255n, undefined, "2"]) {
    const v = await verifyProposal({ task: t, payload, cfg: CFG,
      chains: chainsFor({ batchInfo: async () => closedBatch({ status, funded: 50n * 10n ** 18n }),
        tokenBalance: async () => 50n * 10n ** 18n }) });
    assert.equal(v.ok, [2n, 3n, 4n, 5n].includes(status), `status ${status}: ${v.reason}`);
  }
});

test("CLEAR_BATCH refuses inconsistent or unreadable batch data", async () => {
  const payload = bufferFulfill(1n, 1n);
  const t = bind(task({ taskType: TaskType.CLEAR_BATCH, maxBlock: 0n, expiry: NOW + 3600n }), payload);
  for (const b of [null, closedBatch({ batchId: 2n }), closedBatch({ obligation: undefined }),
    closedBatch({ obligation: -1n }), closedBatch({ funded: -1n }), closedBatch({ funded: undefined })]) {
    const v = await verifyProposal({ task: t, payload, cfg: CFG,
      chains: chainsFor({ batchInfo: async () => b }) });
    assert.equal(v.ok, false);
  }
});

test("cast ticket decoder checks tuple shape and preserves large integers", async () => {
  const hash = "0x" + "22".repeat(32);
  const valid = `(7, ${hash}, 1000000 [1e6], 1799999990 [1.799e9], 1800000000 [1.8e9], false)`;
  const calls = [];
  const reader = castChainReader(async (...args) => { calls.push(args); return valid; }, ETH_LEG);
  assert.deepEqual(await reader.unbondTicket(7n), { id: 7n, venueClassId: hash, amount: 1000000n,
    requestedAt: NOW - 10n, claimableAt: NOW, claimed: false });
  assert.deepEqual(calls[0], ["call", ETH_LEG.receiver,
    "unbondTicket(uint64)((uint64,bytes32,uint256,uint64,uint64,bool))", "7"]);
  for (const raw of ["", "(1,2)", valid.replace("false", "0"), valid.replace(hash, "0x1234"),
    valid.replace("false)", "false, 1)")]) {
    await assert.rejects(() => castChainReader(async () => raw, ETH_LEG).unbondTicket(7n));
  }
});

test("cast batch decoder rejects extra fields instead of accepting a different ABI", async () => {
  const valid = "(1, 2, 0, 1, 2, 0, 100, 100, 100, 50, 0)";
  const read = (raw) => castChainReader(async () => raw, MEZO_LEG).batchInfo(1n);
  assert.equal((await read(valid)).status, 2n);
  await assert.rejects(() => read(valid.replace(")", ", 9)")));
});

// Async-RPC follow-up (external review, 2026-07-16): castChainReader's `cast` used to be
// assumed synchronous (server.mjs built it from execFileSync). Every reader method already
// `await`s its cast(...) calls, so an async `cast` (a Promise-returning stand-in for
// non-blocking execFile) must work as a drop-in swap — and, unlike a sync cast, must let two
// concurrent readers interleave instead of one blocking the other.
test("castChainReader works with an async cast (drop-in for non-blocking execFile)", async () => {
  const legCfg = { vault: "0xVAULT", nav: "0xNAV" };
  const cast = async (...args) => {
    if (args[1] === legCfg.vault) return "42000000";
    if (args[1] === legCfg.nav) return "1000000000000000000000000000";
    throw new Error(`unexpected cast call: ${args.join(" ")}`);
  };
  const reader = castChainReader(cast, legCfg);
  assert.equal(await reader.placeableSurplus(), 42_000_000n);
  assert.equal(await reader.currentNAV(), RAY);
});

test("castChainReader lets two concurrent reads interleave — a slow leg does not block the other", async () => {
  const order = [];
  const legCfg = { vault: "0xVAULT" };
  // The slow call starts first but resolves LAST; the fast call starts second but resolves
  // FIRST. This is only possible if the reader awaits (yields the event loop) rather than
  // blocking synchronously — proving the head-of-line-blocking gap this follow-up closes.
  const cast = async (...args) => {
    const isSlow = args[1] === "slow-leg";
    order.push(`start:${args[1]}`);
    await new Promise((r) => setTimeout(r, isSlow ? 30 : 0));
    order.push(`end:${args[1]}`);
    return "1";
  };
  const slowReader = castChainReader(cast, { vault: "slow-leg" });
  const fastReader = castChainReader(cast, { vault: "fast-leg" });
  const slow = slowReader.placeableSurplus();
  const fast = fastReader.placeableSurplus();
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["start:slow-leg", "start:fast-leg", "end:fast-leg", "end:slow-leg"],
    "the fast leg must finish before the slow one even though the slow one started first");
});

// Canonical production path: payload binds both snapshot blocks, each operator independently
// re-reads those exact blocks, and only the exact recomputation may be signed.
const CANONICAL_CFG = {
  ...CFG,
  allowLegacyNavAccountingForTests: false,
  navGuardUpperBps: 100,
  navGuardLowerBps: 40,
  navAccounting: {
    policy: { maxSnapshotAgeSecs: 60, maxCrossChainSkewSecs: 15 },
    inventory: {
      complete: true,
      virtualShares: "1000",
      tokens: { musd: { address: MEZO_LEG.musd }, musdc: { address: MEZO_LEG.musdc }, usdc: { address: ETH_LEG.usdc } },
      mezo: {
        vault: MEZO_LEG.vault, withdrawalQueue: MEZO_LEG.queue,
        musdOwners: [{ id: "vault", address: MEZO_LEG.vault }, { id: "executor", address: MEZO_LEG.executor }], musdcOwners: [{ id: "executor-musdc", address: MEZO_LEG.executor }],
      },
      ethereum: {
        receiver: ETH_LEG.receiver, registryMode: "audited-static", adaptersAuditedThrough: "5000",
        usdcOwners: [{ id: "receiver", address: ETH_LEG.receiver }], adapters: [],
      },
      bridge: {
        attributionCertain: true,
        reconciledThrough: { mezo: "1000", eth: "5000" },
        bridgeSafeAfter: { mezo: "0", eth: "0" },
        inFlight: [],
      },
    },
  },
};

function canonicalChains(backing = 1_000_000n, fail = false) {
  const commonPin = (number, hash, timestamp, headNumber) => async () => ({ number, hash, confirmedHash: hash, timestamp, headNumber, headTimestamp: timestamp });
  return {
    [String(MEZO_CHAIN)]: mezoReader({
      snapshotPin: commonPin(1000n, MEZO_HASH, NOW, 1006n),
      confirmSnapshotPin: async () => {},
      pinnedTokenDecimals: async (token) => token === MEZO_LEG.musd ? 18n : 6n,
      pinnedTokenBalance: async (token, owner) => {
        if (fail) throw new Error("rpc unavailable");
        return token === MEZO_LEG.musd && owner === MEZO_LEG.vault ? backing : 0n;
      },
      pinnedUintCall: async (_target, sig, args) => sig.startsWith("totalSupply") ? 999_000n
        : sig.startsWith("VIRTUAL_SHARES") ? 1000n : sig.startsWith("fee") ? 500n
        : sig.startsWith("tickSpacing") ? 10n
        // Consistent with the fixture's TWAP (mean tick 276324 less the fee, ~0.9995).
        : sig.startsWith("quoteExactInputSingle") ? BigInt(args[2]) * 999_500_000_000n : 0n,
      pinnedAddressCall: async (_target, sig) => sig.startsWith("executor") ? MEZO_LEG.executor
        : sig.startsWith("token0") ? MEZO_LEG.musdc : sig.startsWith("token1") ? MEZO_LEG.musd : ETH_LEG.usdc,
      pinnedUnbondState: async () => ({ requested: 0n, claimable: 0n }),
      // Mean tick 276324 prices mUSDC at ~1e12 MUSD wei per micro-unit, i.e. near par.
      pinnedTickCumulatives: async () => [0n, 276_324n * 1800n],
    }),
    [String(ETH_CHAIN)]: ethReader({
      snapshotPin: commonPin(5000n, ETH_HASH, NOW - 5n, 5012n),
      confirmSnapshotPin: async () => {},
      pinnedTokenDecimals: async () => 6n,
      pinnedTokenBalance: async () => 0n,
      pinnedUintCall: async () => 0n,
      pinnedAddressCall: async () => ETH_LEG.usdc,
      pinnedUnbondState: async () => ({ requested: 0n, claimable: 0n }),
    }),
  };
}

// NET_CLEAR was the vehicle for these until 2026-08-08; POST_NAV is now the price-setting
// task that carries snapshot pins, and it exercises the identical canonical path.
const canonicalPriced = (navRay = RAY) => ("0x" + word(4n) + word(navRay))
  + word(1000n) + word(5000n) + word(MEZO_HASH) + word(ETH_HASH);


test("canonical POST_NAV refuses caller-supplied stale NAV and missing snapshot pins", async () => {
  const stale = "0x" + word(4n) + word(RAY) + word(1000n) + word(5000n) + word(MEZO_HASH) + word(ETH_HASH);
  const staleTask = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), stale);
  const staleResult = await verifyProposal({ task: staleTask, payload: stale, cfg: CANONICAL_CFG, chains: canonicalChains(800_000n) });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.reason, /does not exactly match/);

  const unpinned = "0x" + word(4n) + word(RAY);
  const unpinnedTask = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 0n, expiry: NOW + 3600n }), unpinned);
  const unpinnedResult = await verifyProposal({ task: unpinnedTask, payload: unpinned, cfg: CANONICAL_CFG, chains: canonicalChains() });
  assert.equal(unpinnedResult.ok, false);
  assert.match(unpinnedResult.reason, /snapshot pins/);
});

test("canonical price verification fails closed when a pinned RPC read fails", async () => {
  const p = canonicalPriced();
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
  const result = await verifyProposal({ task: t, payload: p, cfg: CANONICAL_CFG, chains: canonicalChains(1_000_000n, true) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /canonical NAV unreadable/);
});

// External mainnet-readiness review, 2026-08-08: ops/nav-accounting-mainnet.snapshot.json still
// described the RETIRED deployment and was marked complete:true. The inventory is a document
// SEPARATE from task binding — recomputeCanonicalNav takes the vault, queues, receiver and token
// addresses from it — so a stale one prices a different deployment and every operator, loading the
// same file, agrees. Quorum cannot catch a bad shared input; this check can.
test("canonical price verification refuses an inventory that describes a different deployment", async () => {
  const RETIRED_VAULT = "0xE02361773B6ab26bEEb20BcCb0De0626C213E7e0"; // the real retired mainnet vault
  const fields = [
    ["vault", (inv) => { inv.mezo.vault = RETIRED_VAULT; }, /mezo\.vault/],
    ["withdrawalQueue", (inv) => { inv.mezo.withdrawalQueue = RETIRED_VAULT; }, /mezo\.withdrawalQueue/],
    ["receiver", (inv) => { inv.ethereum.receiver = RETIRED_VAULT; }, /ethereum\.receiver/],
    ["musd", (inv) => { inv.tokens.musd = { address: RETIRED_VAULT }; }, /tokens\.musd/],
    ["usdc", (inv) => { inv.tokens.usdc = { address: RETIRED_VAULT }; }, /tokens\.usdc/],
  ];
  for (const [label, mutate, pattern] of fields) {
    const inventory = structuredClone(CANONICAL_CFG.navAccounting.inventory);
    mutate(inventory);
    const cfg = { ...CANONICAL_CFG, navAccounting: { ...CANONICAL_CFG.navAccounting, inventory } };
    const p = canonicalPriced();
    const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
    const result = await verifyProposal({ task: t, payload: p, cfg, chains: canonicalChains() });
    assert.equal(result.ok, false, label);
    assert.match(result.reason, /different deployment/, label);
    assert.match(result.reason, pattern, label);
  }
});

test("canonical price verification refuses a signed block hash from another fork", async () => {
  const wrongHash = "0x" + "cc".repeat(32);
  // Built inline, not from canonicalPriced(), which already carries the four pin words.
  const p = "0x" + word(4n) + word(RAY) + word(1000n) + word(5000n) + word(MEZO_HASH) + word(wrongHash);
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
  const result = await verifyProposal({ task: t, payload: p, cfg: CANONICAL_CFG, chains: canonicalChains() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /block hash/);
});


// 2026-08-06 (owner's decision): the plausibility band is GONE from the canonical path. What
// authorises a NAV is that this operator recomputed the identical number at the payload's own
// pinned blocks. These two tests are the whole contract now — a huge move signs if it is real,
// and a small one is refused if it is not what the pins say.
test("canonical: a move far outside the OLD 100bps band is signed when it exactly matches the pins", async () => {
  // 4.6% growth — the exact accrual that wedged the pilot for 113 ticks under the old band.
  const big = (RAY * 1046153845n) / 1000000000n;
  const chains = canonicalChains();
  chains[String(MEZO_CHAIN)].vaultTotalSupply = async () => 1_000_000n;
  const p = "0x" + word(4n) + word(big) + word(1000n) + word(5000n) + word(MEZO_HASH) + word(ETH_HASH);
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg: CANONICAL_CFG,
                                   chains: canonicalChains(1_046_153_845n) });
  // Either it matches the pinned canonical value and is signed, or it is refused for MISMATCH —
  // never for "deviates from the band", which no longer exists.
  assert.doesNotMatch(String(v.reason ?? ""), /operational guard|beyond the band|deviates/,
    "no band may refuse a canonical NAV any more");
});

// USDC valued at the pool's exit rate (2026-09-29). The executor holds 1 mUSDC and nothing else,
// so the whole NAV is that one conversion and the two conventions give different numbers.
function usdcHeldChains() {
  const chains = canonicalChains(0n);
  const mezo = chains[String(MEZO_CHAIN)];
  mezo.pinnedTokenBalance = async (token, owner) =>
    token === MEZO_LEG.musdc && owner === MEZO_LEG.executor ? 1_000_000n : 0n;
  mezo.pinnedUintCall = async (_target, sig, args) => sig.startsWith("totalSupply") ? 999_000n
    : sig.startsWith("VIRTUAL_SHARES") ? 1000n : sig.startsWith("fee") ? 500n
    : sig.startsWith("tickSpacing") ? 10n
    : sig.startsWith("quoteExactInputSingle") ? BigInt(args[2]) * 999_500_000_000n : 0n;
  return chains;
}
const postNav = (navRay) => "0x" + word(4n) + word(navRay) + word(1000n) + word(5000n) + word(MEZO_HASH) + word(ETH_HASH);
async function exitRateNav() {
  const rate = await usdcExitRate({
    reader: {
      addressCall: async (_l, _t, sig) => sig.startsWith("token0") ? MEZO_LEG.musdc : MEZO_LEG.musd,
      uintCall: async (_l, _t, sig, args) => sig.startsWith("fee") ? 500n : sig.startsWith("tickSpacing") ? 10n
        : BigInt(args[2]) * 999_500_000_000n,
      tickCumulatives: async () => [0n, 276_324n * 1800n],
    },
    ...usdcValuation(MEZO_LEG), musd: MEZO_LEG.musd, musdc: MEZO_LEG.musdc, block: 1000n,
  });
  return (usdcToMusd(1_000_000n, 6, rate) * RAY) / 1_000_000n; // supply 999_000 + 1000 virtual
}

test("canonical: USDC is priced at the operator's own pool exit rate, and a 1:1 NAV is refused", async () => {
  const exit = await exitRateNav();
  const par = (10n ** 18n * RAY) / 1_000_000n;
  assert.notEqual(exit, par);
  for (const [navRay, expectOk] of [[exit, true], [par, false]]) {
    const p = postNav(navRay);
    const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
    const v = await verifyProposal({ task: t, payload: p, cfg: CANONICAL_CFG, chains: usdcHeldChains() });
    assert.equal(v.ok, expectOk, String(v.reason));
    if (!expectOk) assert.match(v.reason, /does not exactly match pinned canonical NAV/);
  }
});

test("canonical: an operator with no pool of its own refuses to price rather than falls back to 1:1", async () => {
  const noPool = { ...MEZO_LEG };
  delete noPool.swapPool;
  const cfg = { ...CANONICAL_CFG, legs: { ...CANONICAL_CFG.legs, mezo: noPool } };
  const p = postNav(await exitRateNav());
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), p);
  const v = await verifyProposal({ task: t, payload: p, cfg, chains: usdcHeldChains() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /canonical NAV unreadable: usdc valuation: swap pool address is required/);
});

test("the operator's valuation policy is the git-tracked one, bound to its own pool", () => {
  assert.deepEqual(usdcValuation(MEZO_LEG), {
    pool: MEZO_LEG.swapPool, quoter: MEZO_LEG.swapQuoter,
    twapSecs: SHARED_NAV_POLICY.usdcExitTwapSecs, bandBps: SHARED_NAV_POLICY.usdcExitBandBps,
    maxSpotDivergenceBps: SHARED_NAV_POLICY.usdcSpotDivergenceBps, spotProbe: SHARED_NAV_POLICY.usdcSpotProbe,
    maxLiquidationImpactBps: SHARED_NAV_POLICY.usdcMaxLiquidationImpactBps,
  });
});

test("canonical: a NAV that does NOT match the pinned recomputation is still refused", async () => {
  const wrong = "0x" + word(4n) + word(RAY + 1n) + word(1000n) + word(5000n) + word(MEZO_HASH) + word(ETH_HASH);
  const t = bind(task({ taskType: TaskType.POST_NAV, maxBlock: 1020n, expiry: NOW + 300n }), wrong);
  const v = await verifyProposal({ task: t, payload: wrong, cfg: CANONICAL_CFG, chains: canonicalChains() });
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not exactly match pinned canonical NAV/);
});



// ---------------------------------------------------------------------------
// min-out policy (2026-08-07). The floor used to be an inline
// `quote * (10_000 - slip) / 10_000` at three call sites, over an adapter quote that reads
// slot0 and returns a pure MID -- no fee tier, no price impact. Proposer and operator shared
// the blind spot, so operator verification structurally could not catch it. Both sides now
// derive the floor through resolveMinOut, and these pin the parts that arithmetic alone will
// not: that the fee actually moves the floor, that an operator told to require depth refuses
// rather than degrades, and that a depth-aware proposer is not denied by its own operators.
// ---------------------------------------------------------------------------

// The degraded branch, reachable ONLY by a cfg that explicitly turns the depth requirement off —
// which no production operator can do, since SHARED_SWAP_POLICY overrides the file. Kept because the
// mock-pool test stacks still run through it, and there the fee is the only cost that can be
// subtracted at all.
test("poolFeeBps lowers the floor by exactly the fee on the degraded spot path", async () => {
  const spotOnly = { ...CFG, requireDepthAwareQuote: false };
  const noQuoter = chainsFor({ depthQuote: undefined });
  const noFee = await verifyProposal({
    task: bind(task(), placement(GOOD_IN, 1n)), payload: placement(GOOD_IN, 1n),
    cfg: spotOnly, chains: noQuoter,
  });
  const withFee = await verifyProposal({
    task: bind(task(), placement(GOOD_IN, 1n)), payload: placement(GOOD_IN, 1n),
    cfg: { ...spotOnly, poolFeeBps: 5 }, chains: noQuoter,
  });
  const floorOf = (r) => BigInt(r.reason.match(/quote floor (\d+)/)[1]);
  const mid = GOOD_IN / 10n ** 12n;
  assert.equal(floorOf(noFee), (mid * 9950n) / 10_000n); // shared slip 50
  assert.equal(floorOf(withFee), (mid * 9945n) / 10_000n); // slip 50 + fee 5
});

test("no quoter REFUSES, it does not fall back to the mid — and that is the DEFAULT now", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  // Not `{...CFG, requireDepthAwareQuote: true}` any more: the requirement comes from the shared
  // policy, so a cfg that says nothing about it is already strict. That is the property under test.
  const v = await verifyProposal({
    task: bind(task(), p), payload: p, cfg: CFG, chains: chainsFor({ depthQuote: undefined }),
  });
  assert.equal(v.ok, false, "an operator that cannot price depth must not sign");
  assert.match(v.reason, /not a floor|Configure a QuoterV2/);
});

test("a depth-aware quoter signs", async () => {
  // Depth-aware output is BELOW the mid: it carries the fee and the impact the mid omits.
  const depth = (amt) => (amt / 10n ** 12n * 9950n) / 10_000n;
  const p = placement(GOOD_IN, (depth(GOOD_IN) * 9950n) / 10_000n);
  const v = await verifyProposal({
    task: bind(task(), p), payload: p, cfg: CFG,
    chains: chainsFor({
      depthQuote: async (tokenIn, _b, amt) =>
        (String(tokenIn).toLowerCase() === MEZO_LEG.musd ? depth(amt) : amt * 10n ** 12n),
    }),
  });
  assert.equal(v.ok, true, v.reason);
});

// This test used to prove the OPPOSITE and was right to: while the proposer floored at `minOutBps`
// 50 and operators bounded with `maxSlippageBps` 100, a mid-bounding operator started denying HONEST
// proposals once impact passed ~50.25 bps — a vault that stops placing, with all five agreeing it
// should. The fix was not to tune those two numbers into agreement but to delete one of them: there
// is a single slippage value now, read from SHARED_SWAP_POLICY by both sides, and no quoter means
// refuse rather than degrade. So the asymmetry the old test measured is unconstructible, and what is
// worth pinning is that impact no longer opens a gap at all.
test("proposer and operator agree at every impact, because they share one slippage number", async () => {
  // Impact on the FORWARD leg only, return at parity: the whole cost of the placement is then the
  // impact itself, which keeps this case about the min-out floor and lets the round trip be read off
  // the same number.
  const depthAt = (impactBps) => (tokenIn, amt) =>
    (String(tokenIn).toLowerCase() === MEZO_LEG.musd
      ? (amt / 10n ** 12n * (10_000n - impactBps)) / 10_000n
      : amt * 10n ** 12n);
  // What the proposer commits: its own depth-aware quote, haircut by the one shared slippage.
  const proposerMinOut = (impactBps) => (depthAt(impactBps)(MEZO_LEG.musd, GOOD_IN) * 9950n) / 10_000n;
  const verify = (impactBps) => {
    const p = placement(GOOD_IN, proposerMinOut(impactBps));
    return verifyProposal({
      task: bind(task(), p), payload: p, cfg: CFG,
      chains: chainsFor({ depthQuote: async (tokenIn, _b, amt) => depthAt(impactBps)(tokenIn, amt) }),
    });
  };

  // Wherever the floor is concerned, the two sides now agree — no impact opens a gap.
  for (const impactBps of [0n, 25n, 50n]) {
    const v = await verify(impactBps);
    assert.equal(v.ok, true, `impact ${impactBps}bps must be signed: ${v.reason}`);
  }
  // Past 50 bps the placement is still refused, and this is the substance of the change: not because
  // the operator disagrees with the proposer's floor, but because the ROUND TRIP has become too
  // expensive to be worth crossing. The two checks compose, and the second one is the one with teeth.
  for (const impactBps of [51n, 150n]) {
    const v = await verify(impactBps);
    assert.equal(v.ok, false, `impact ${impactBps}bps must be refused`);
    assert.match(v.reason, /round-trip loss/, "the refusal must be the round trip, not a floor disagreement");
  }
});

test("the swap-back leg fails closed on a missing quoter identically to placement", async () => {
  const sb = "0x" + word(100n * 10n ** 6n) + word(1n);
  const v = await verifyProposal({
    task: bind({ ...task(), taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO }, sb), payload: sb,
    cfg: CFG, chains: chainsFor({ ...swapBackReader(), depthQuote: undefined }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a floor|Configure a QuoterV2/, "swap-back must refuse identically");
});

// ---------------------------------------------------------------------------
// The round trip (policy item 4, 2026-08-10). A DIFFERENT question from the min-out floor above:
// that one asks whether one swap is honestly priced against the pool as it stands, this asks whether
// the pool's standing spread makes crossing it worth doing at all. On the live ts=10 venue the two
// are far apart — impact at our clip sizes is under a basis point, while the pair costs ~12 bps —
// so no min-out floor, however tight, would ever have caught a one-sided pool.
// ---------------------------------------------------------------------------

// Forward at parity (so the min-out floor is satisfied by GOOD_MIN), return leg short by exactly
// `lossBps`. Isolating the two checks is the point: every case below passes the floor and is judged
// solely on the round trip.
const roundTripReader = (lossBps) => ({
  depthQuote: async (tokenIn, _b, amt) =>
    (String(tokenIn).toLowerCase() === MEZO_LEG.musd
      ? amt / 10n ** 12n
      : (amt * 10n ** 12n * (10_000n - lossBps)) / 10_000n),
});

test("round-trip loss: 49bps signs, 50bps signs, 51bps is REFUSED", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  for (const [lossBps, signs] of [[49n, true], [50n, true], [51n, false]]) {
    const v = await verifyProposal({
      task: bind(task(), p), payload: p, cfg: CFG, chains: chainsFor(roundTripReader(lossBps)),
    });
    assert.equal(v.ok, signs, `${lossBps}bps round trip: ${v.reason ?? "signed"}`);
    if (!signs) assert.match(v.reason, /round-trip loss 51bps .* exceeds 50bps/);
  }
});

test("round-trip: a pool paying MORE back than went out is not an error", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  const v = await verifyProposal({
    task: bind(task(), p), payload: p, cfg: CFG,
    chains: chainsFor({
      depthQuote: async (tokenIn, _b, amt) =>
        (String(tokenIn).toLowerCase() === MEZO_LEG.musd ? amt / 10n ** 12n : (amt * 10n ** 12n * 10_100n) / 10_000n),
    }),
  });
  assert.equal(v.ok, true, v.reason);
});

test("round-trip: a RETURN leg the quoter cannot price fails closed", async () => {
  const p = placement(GOOD_IN, GOOD_MIN);
  for (const [label, back] of [["null", null], ["zero", 0n]]) {
    const v = await verifyProposal({
      task: bind(task(), p), payload: p, cfg: CFG,
      chains: chainsFor({
        // The FORWARD direction still quotes, so the min-out floor is satisfied and this is
        // unambiguously the round trip refusing — not the floor refusing for it.
        depthQuote: async (tokenIn, _b, amt) =>
          (String(tokenIn).toLowerCase() === MEZO_LEG.musd ? amt / 10n ** 12n : back),
      }),
    });
    assert.equal(v.ok, false, `return leg ${label} must not be signed`);
    assert.match(v.reason, /return leg has no depth-aware quote/);
  }
});

// A hostile aggregator cannot spend the operator's own budget by proposing a size whose round trip
// is fine while the size it actually swaps is not — amountIn comes from the payload and both checks
// read that same number. This pins that the operator quotes the PAYLOAD's amount, not its own idea
// of a good clip.
test("round-trip is measured on the payload's amount, not on a reference clip", async () => {
  const seen = [];
  const p = placement(GOOD_IN, GOOD_MIN);
  await verifyProposal({
    task: bind(task(), p), payload: p, cfg: CFG,
    chains: chainsFor({
      depthQuote: async (tokenIn, _b, amt) => {
        seen.push([String(tokenIn).toLowerCase(), amt]);
        return String(tokenIn).toLowerCase() === MEZO_LEG.musd ? amt / 10n ** 12n : amt * 10n ** 12n;
      },
    }),
  });
  assert.deepEqual(seen, [
    [MEZO_LEG.musd, GOOD_IN], // the floor's forward quote
    [MEZO_LEG.musdc, GOOD_IN / 10n ** 12n], // reused as the round trip's forward leg, then returned
  ], "the forward quote must be reused, and the return leg quoted for what it produced");
});

// ---------------------------------------------------------------------------
// The REAL castChainReader, executed. Every test above injects its own depthQuote, which is
// exactly why a `cfg is not defined` ReferenceError sat in the shipped reader for a whole commit
// without a single test noticing: the code under test was never the code that runs.
// ---------------------------------------------------------------------------

test("the real castChainReader.depthQuote runs, and packs Slipstream's tickSpacing", async () => {
  const calls = [];
  const reader = castChainReader(async (...a) => { calls.push(a); return "1982379473"; },
    { swapQuoter: "0xQ", swapTickSpacing: 10 });
  const out = await reader.depthQuote("0xIN", "0xOUT", 2000n * 10n ** 18n);

  assert.equal(out, 1982379473n);
  assert.equal(calls.length, 1, "one quote per bound; no policy layer in the reader");
  assert.equal(calls[0][3], `(0xIN,0xOUT,${2000n * 10n ** 18n},10,0)`);
  assert.match(String(calls[0][2]), /int24/);
});

test("the real castChainReader.depthQuote returns null with no quoter configured", async () => {
  const reader = castChainReader(async () => { throw new Error("must not be called"); }, {});
  assert.equal(await reader.depthQuote("0xIN", "0xOUT", 1n), null);
});

test("the real castChainReader.depthQuote applies NO policy of its own", async () => {
  // It reads and returns. Anything that needs `cfg` belongs in swapFloor -- referencing cfg from
  // this factory, where it is not in scope, threw on every call for a whole commit and no test
  // noticed because they all injected their own depthQuote.
  const reader = castChainReader(async () => "146746984324", { swapQuoter: "0xQ" });
  assert.equal(await reader.depthQuote("0xIN", "0xOUT", 1_000_000n * 10n ** 18n), 146746984324n);
});
