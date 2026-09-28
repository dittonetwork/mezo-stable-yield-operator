// SPDX-License-Identifier: BUSL-1.1
// Deterministic task-proposal engine (operator-layer spec v1 §04/§05; plan v4 §04).
//
// Every operator runs this byte-identical against the SAME pinned on-chain state and
// independently derives the SAME canonical Task — no proposer role, no leader election.
// The engine has NO private/local/clock/random inputs: given identical state in, identical
// Task out. It reproduces the on-chain TaskLib.encode / Task hash exactly (verified against
// the Solidity fixture), so operators sign precisely what the executor will verify.

import { keccak256, keccak256Hex } from "./keccak.mjs";
import { resolveMinOut } from "./swap-quote.mjs";

export const MEZO_CHAIN_ID = 31612;

// How many blocks a canonical price task stays executable for, measured from its snapshot pin.
// This is the BLOCK half of the execution window; the expiry beside it is the TIMESTAMP half,
// and the two only agree on a chain whose blocks track wall-clock. The old default of 20 was a
// round could be unexecutable before its operators had finished signing — observed 2026-08-06,
// where the same round was minted, signed and retired three times over. Callers that know their
// chain should still set maxBlockAhead explicitly; this is the floor for those that do not.
export const DEFAULT_MAX_BLOCK_AHEAD = 600n;

// Task type tags — keccak256 of the same strings as TaskTypes.sol.
export const TaskType = {
  SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH: keccak256Hex("dmusd.task.SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH"),
  FIX_BATCH: keccak256Hex("dmusd.task.FIX_BATCH"),
  POST_NAV: keccak256Hex("dmusd.task.POST_NAV"),
  ALLOCATE: keccak256Hex("dmusd.task.ALLOCATE"),
  DEALLOCATE: keccak256Hex("dmusd.task.DEALLOCATE"),
  BRIDGE_BACK: keccak256Hex("dmusd.task.BRIDGE_BACK"),
  HEARTBEAT: keccak256Hex("dmusd.task.HEARTBEAT"),
  // Fund a CLOSED batch straight from the Mezo buffer: no swap, no bridge. This is `clear_batch`
  // in the canonical operation set.
  CLEAR_BATCH: keccak256Hex("dmusd.task.CLEAR_BATCH"),
  // `swap_usdc_to_musd_on_mezo(amount)` — the return
  // leg's swap on its own, landing MUSD in the vault buffer instead of in a batch.
  SWAP_USDC_TO_MUSD_ON_MEZO: keccak256Hex("dmusd.task.SWAP_USDC_TO_MUSD_ON_MEZO"),
};

// ---- canonical ABI encoding (matches abi.encode of the 7 static Task words) ----

export function uint256(value, label = "uint256") {
  if (!(typeof value === "bigint"
      || (typeof value === "number" && Number.isSafeInteger(value))
      || (typeof value === "string" && /^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)))) {
    throw new Error(`${label}: expected an exact unsigned integer`);
  }
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error(`${label}: outside uint256`);
  return n;
}

function word(v) {
  return uint256(v).toString(16).padStart(64, "0");
}

export const HEARTBEAT_INTERVAL = 13n * 86400n;
export const HEARTBEAT_TTL = 300n;

export function heartbeatFields(payload) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(payload)) throw new Error("heartbeat requires two ABI words");
  const previousActivity = BigInt("0x" + payload.slice(2, 66));
  const issuedAt = BigInt("0x" + payload.slice(66));
  if (previousActivity >= 1n << 64n || issuedAt >= 1n << 64n) throw new Error("heartbeat timestamps must fit uint64");
  return { previousActivity, issuedAt };
}

/** A quiet leg needs no capital movement just to prove quorum liveness. */
export function proposeHeartbeat({ now, lastActivity, active }) {
  now = uint256(now); lastActivity = uint256(lastActivity);
  if (now >= 1n << 64n || lastActivity >= 1n << 64n || typeof active !== "boolean") {
    throw new Error("unreadable heartbeat state");
  }
  if (active || now < lastActivity + HEARTBEAT_INTERVAL) return null;
  return { taskType: TaskType.HEARTBEAT, payload: "0x" + word(lastActivity) + word(now) };
}

function fixedHex(value, bytes, label) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${label}: expected ${bytes} bytes of hex`);
  }
  return word(value);
}

/** abi.encode(chainId, contractAddr, nonce, taskType, calldataHash, expiry, maxBlock) */
export function encodeTask(task) {
  return (
    "0x" +
    word(uint256(task.chainId, "chainId")) +
    fixedHex(task.contractAddr, 20, "contractAddr") +
    word(uint256(task.nonce, "nonce")) +
    fixedHex(task.taskType, 32, "taskType") +
    fixedHex(task.calldataHash, 32, "calldataHash") +
    word(uint256(task.expiry, "expiry")) +
    word(uint256(task.maxBlock, "maxBlock"))
  );
}

/** keccak256(encodeTask(task)) — the digest operators sign (before hash-to-curve). */
export function taskHash(task) {
  const bytes = Buffer.from(encodeTask(task).slice(2), "hex");
  return keccak256Hex(new Uint8Array(bytes));
}

/** keccak256(payloadBytes) — the calldataHash field. payload is 0x-hex. */
export function calldataHash(payloadHex) {
  if (typeof payloadHex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payloadHex)) {
    throw new Error("payload missing or malformed");
  }
  const bytes = Buffer.from(payloadHex.replace(/^0x/, ""), "hex");
  return keccak256Hex(new Uint8Array(bytes));
}

// ---- yield/APY placement gate (F5 negative-APY guard) ----
//
// E accepted fixing this at the JS layer (mirrors how navDeviationBps gates POST_NAV — see
// ops/operator/verify.mjs): before this, proposeSwapAndBridgeOut/proposeAllocate triggered purely on
// placeableSurplus()>0 + clip size, with zero yield input (see knowledge memory
// mezo-mainnet-rollout.md). Ported pattern from dittonetwork/delta-neutral-vault:
// YieldSplitLogic.sol's `_validateReturnImprovement` (absolute-floor + relative-improvement
// gate) fed by ReturnEstimator/IIRMEstimator's post-trade APY projection — see
// ops/task-engine/apy-estimator.mjs and knowledge memory mezo-yieldsplit-vault-analysis.md.

// Safe default floor: refuse to place into a venue projected at/below 0% APY. Callers raise
// this via state.minPlacementApyBps; the engine never places below this floor without an
// explicit (and therefore reviewable) override.
export const DEFAULT_MIN_PLACEMENT_APY_BPS = 0n;

/**
 * Pure APY-gate evaluation shared by proposeSwapAndBridgeOut and proposeAllocate: refuse to place
 * into a venue projected at or below the floor. FAIL-SAFE — `projectedApyBps` missing (estimator
 * unavailable, or not wired for this venue) blocks placement exactly like failing the floor, never
 * treated as "assume it's fine".
 *
 * There is deliberately NO relative-improvement leg. One existed, ported from YieldSplitLogic's
 * `_validateReturnImprovement`: place only if the new venue beats the current one by some margin.
 * It answers a question this vault does not ask — capital goes to one venue, and the only reason to
 * move it is to pay a withdrawal, never to chase a better rate. It was also dead in practice, since
 * nothing ever supplied a `currentApyBps` baseline, so it read as a live safety property while
 * binding nothing.
 *
 * @param {{projectedApyBps: bigint|number|null|undefined, minPlacementApyBps?: bigint|number}} s
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function evaluateApyGate(s) {
  const floor =
    s.minPlacementApyBps === undefined || s.minPlacementApyBps === null
      ? DEFAULT_MIN_PLACEMENT_APY_BPS
      : BigInt(s.minPlacementApyBps);
  if (s.projectedApyBps === null || s.projectedApyBps === undefined) {
    return { ok: false, reason: "apy-estimator-unavailable" };
  }
  const projected = BigInt(s.projectedApyBps);
  if (projected < floor) {
    return { ok: false, reason: `projected-apy-below-floor:${projected}<${floor}` };
  }
  return { ok: true };
}

// ---- deterministic proposals from pinned state ----

/**
 * Placement proposal. Derives the placeable clip from pinned on-chain state ONLY:
 * surplus (already netted of reservedForWithdrawals + floor on-chain), the live-quoted
 * flat band ceiling, and the mUSDC-inventory auto-pause guard (§06: pause when inventory
 * < 2x the clip). Also gated by evaluateApyGate — see above; callers should call it
 * themselves too (same convention as the inventory guard) to log the rejection reason.
 * Returns null when nothing should be placed (engine emits no task).
 *
 * @param {{surplus:bigint, bandCeiling:bigint, musdcInventory:bigint, minOutBps:number,
 *          nonce:bigint, executor:string, blockNumber:bigint, blockTimestamp:bigint,
 *          swapExpirySecs:bigint, maxBlockAhead:bigint, projectedApyBps:bigint|number|null|undefined,
 *          minPlacementApyBps?:bigint|number}} s  pinned state (all deterministic)
 */
export function proposeSwapAndBridgeOut(s) {
  let clip = s.surplus < s.bandCeiling ? s.surplus : s.bandCeiling;
  if (clip <= 0n) return null;
  // launch-blocking inventory monitor (§06 v4): pause if inventory < 2x the clip
  if (s.musdcInventory < clip * 2n) return null;
  if (!evaluateApyGate(s).ok) return null;
  // min-out is denominated in the OUTPUT token, so it must come from a quote of the output —
  // never from `clip`, which is the INPUT. MUSD is 18dp and mUSDC is 6dp, so an
  // input-denominated floor is ~1e12x the achievable output and reverts every placement.
  // See swap-quote.mjs for why a spot mid is not an acceptable basis either.
  const { minOut } = resolveMinOut({
    quotedOut: s.quotedOut, slippageBps: s.minOutBps, depthAware: s.quoteIsDepthAware === true,
    requireDepthAware: s.requireDepthAwareQuote, feeBps: s.poolFeeBps, label: "placement",
  });
  const payload = "0x" + word(clip) + word(minOut); // abi.encode(uint256 amountIn, uint256 minOut)
  const task = {
    chainId: MEZO_CHAIN_ID,
    contractAddr: s.executor,
    nonce: s.nonce,
    taskType: TaskType.SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH,
    calldataHash: calldataHash(payload),
    // swap-bearing task: SHORT expiry + max-block bound (executor enforces both)
    expiry: s.blockTimestamp + s.swapExpirySecs,
    maxBlock: s.blockNumber + s.maxBlockAhead,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * NAV post proposal. NAV value is computed off-engine; the engine only packages it deterministically
 * once agreed, with strict monotonic epoch.
 *
 * NOTHING PROPOSES THIS ON A SCHEDULE any more (owner, 2026-08-10: "we don't need to post nav onchain
 * based on any interval. only during fix batch clearing"). The periodic heartbeat and its
 * `shouldPostNav` trigger are deleted, not disabled — a price reaches the chain either as part of a
 * close, or through the deliberate `aggregator.mjs post-nav` one-shot, which is the only caller left
 * and the documented response to the `lastPostedAt()` drift alarm.
 */
export function proposePostNav(s) {
  if (s.navEpoch <= s.lastNavEpoch) return null; // monotonicity mirrors the on-chain guard
  const pins = s.mezoSnapshotBlock && s.ethSnapshotBlock && s.mezoSnapshotHash && s.ethSnapshotHash
    ? word(s.mezoSnapshotBlock) + word(s.ethSnapshotBlock) + word(s.mezoSnapshotHash) + word(s.ethSnapshotHash) : "";
  const canonical = pins.length !== 0;
  const payload = "0x" + word(BigInt(s.navEpoch)) + word(s.navRay) + pins;
  const task = {
    chainId: MEZO_CHAIN_ID,
    contractAddr: s.executor,
    nonce: s.nonce,
    taskType: TaskType.POST_NAV,
    calldataHash: calldataHash(payload),
    expiry: s.blockTimestamp + (canonical && s.adminExpirySecs > 300n ? 300n : s.adminExpirySecs),
    maxBlock: canonical ? s.mezoSnapshotBlock + BigInt(s.maxBlockAhead ?? DEFAULT_MAX_BLOCK_AHEAD) : 0n,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * Ethereum-leg placement proposal. Unlike proposeSwapAndBridgeOut (Mezo), this task's chainId is
 * the ETH LEG's, not MEZO_CHAIN_ID — a multichain operator/aggregator must build it against
 * the receiver's own chain, never its own. Nothing about WHEN this runs changes what it means —
 * no quote to rot, no price to pin, no open batch to strike — so it carries the admin expiry and
 * no block bound. POST_NAV and FIX_BATCH are the opposite case and are gated on chain like a swap
 * (MezoOpsExecutor's execution-window branch); do not group this with them.
 * The amount this proposes must be backed by a real arrival: callers
 * derive it from the source-chain BridgeSent proof event, never from a bucket/notifier.
 *
 * Also gated by evaluateApyGate (F5 negative-APY guard, see above) — callers should call it
 * themselves too (same convention as the inventory guard in proposeSwapAndBridgeOut) to log the
 * rejection reason.
 *
 * @param {{ethChainId:bigint, receiver:string, venueClassId:string, amount:bigint,
 *          nonce:bigint, ethBlockTimestamp:bigint, adminExpirySecs:bigint,
 *          projectedApyBps:bigint|number|null|undefined, minPlacementApyBps?:bigint|number,
 *          }} s
 */
export function proposeAllocate(s) {
  if (s.amount <= 0n) return null;
  if (!evaluateApyGate(s).ok) return null;
  const payload = "0x" + word(s.venueClassId) + word(s.amount);
  const task = {
    chainId: s.ethChainId,
    contractAddr: s.receiver,
    nonce: s.nonce,
    taskType: TaskType.ALLOCATE,
    calldataHash: calldataHash(payload),
    expiry: s.ethBlockTimestamp + s.adminExpirySecs,
    maxBlock: 0n,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * De-allocation trigger (owner, 2026-08-06): the piece that lets automation PAY for a
 * withdrawal, not just commit to one. A closed batch's obligation is only settleable out of
 * the Mezo buffer, so when the buffer is short the shortfall has to be unwound from the venue
 * — and until now nothing proposed that, so a closed batch on a fully-deployed vault waited
 * for a human.
 *
 * The whole difficulty is NOT double-unwinding. Between requesting an unbond and the MUSD
 * landing in the buffer the money passes through four places, and every one of them is
 * already earmarked for this shortfall:
 *
 *   venue --unbond--> unbond escrow --claim+bridge--> bridge escrow --release--> executor
 *          (pendingUnbond)            (inFlight)                      (mUSDC)
 *
 * Count only the buffer and you re-unwind the same dollars on every tick until the venue is
 * drained. This is the exact shape of the F-3 finding and of the mirror the owner-scenario
 * run hit on 2026-08-03 ("spark 4.8 < required 5.0" with 5.2 already in flight), so
 * `coveredElsewhere` sums all of it and the proposal is for the remainder alone.
 *
 * @param {{outstanding:bigint, buffer:bigint, pendingUnbond:bigint, inFlight:bigint,
 *          executorMusdc:bigint, minClip:bigint}} s
 * @returns {bigint} the amount still to unwind, 0n when nothing is due
 */
export function unbondShortfall(s) {
  if (s.outstanding <= 0n) return 0n;
  const coveredElsewhere = s.buffer + s.pendingUnbond + s.inFlight + s.executorMusdc;
  if (coveredElsewhere >= s.outstanding) return 0n;
  const gap = s.outstanding - coveredElsewhere;
  // A clip floor keeps a rounding-dust gap from minting a signing round of its own.
  return gap < s.minClip ? 0n : gap;
}

/**
 * De-allocation proposal. `amount` is denominated in the VENUE's token (6dp mUSDC), while the
 * obligation that motivates it is 18dp MUSD — the caller scales, because only it knows both
 * decimals. Admin-expiry, no maxBlock: this task crosses no pool, so there is no price for a
 * submitter to pick.
 *
 * @param {{venueClassId:string, amount:bigint, ethChainId:bigint, receiver:string,
 *          nonce:bigint, ethBlockTimestamp:bigint, adminExpirySecs:bigint}} s
 */
export function proposeDeallocate(s) {
  if (s.amount <= 0n) return null;
  const payload = "0x" + word(s.venueClassId) + word(s.amount);
  const task = {
    chainId: s.ethChainId,
    contractAddr: s.receiver,
    nonce: s.nonce,
    taskType: TaskType.DEALLOCATE,
    calldataHash: calldataHash(payload),
    expiry: s.ethBlockTimestamp + s.adminExpirySecs,
    maxBlock: 0n,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * The placement ceiling once the buffer floor is applied.
 *
 * THE FLOOR IS ONLY HERE. There is no on-chain counterpart as of 2026-08-10 — `bufferFloorBps`,
 * its initializer parameter and its dual-org propose/confirm ceremony are deleted from the vault
 * (owner: "no need for guards"). So this function is the entire cushion, and it binds because the
 * aggregator and every operator call it and the bps is git-tracked; nothing on chain will stop a
 * placement that gets past it.
 *
 * What the chain still guarantees, unconditionally, is SOLVENCY: `placeableSurplus()` nets
 * closed-batch obligations and the open batch's shares marked at NAV before this is called, and
 * `_handlePlacement` reverts `ExceedsPlaceableSurplus`. That reservation math is not reproduced
 * here — duplicating on-chain logic in JS is how two sources of truth drift, which this file has
 * already paid for once.
 *
 * The floor's job is redemption LATENCY, not solvency: placing through it loses nobody's money, it
 * means the next withdrawal needs a venue unwind and a bridge round trip instead of settling
 * locally out of the buffer. That is a number to tune against real behaviour, which is why it lives
 * where tuning is a commit rather than a 24 h guardian ceremony.
 *
 * @param {{onchainPlaceable:bigint, totalAssets:bigint, targetFloorBps:bigint}} s
 */
export function placeableAfterBufferFloor(s) {
  if (s.targetFloorBps <= 0n) return s.onchainPlaceable;
  const floor = (s.totalAssets * s.targetFloorBps) / 10_000n;
  return s.onchainPlaceable > floor ? s.onchainPlaceable - floor : 0n;
}

/**
 * The economic-minimum gate on a Mezo -> Ethereum deployment.
 *
 * Deploying is not free and the cost does not scale down: a flat bridge fee plus gas, on top of the
 * pool's round-trip spread. Below the approved size the policy is to leave
 * the MUSD on Mezo and let later deposits accumulate with it — NOT to place it and hope.
 *
 * Applied BEFORE the bridge, deliberately. Once USDC has already crossed, the fee is spent and leaving
 * it idle on the receiver earns nothing, so ALLOCATE has no minimum of its own: arrived capital goes
 * into the venue unless the APY check refuses it.
 *
 * `minEconomicMusd` of 0 disables the gate for callers that explicitly choose it;
 * production resolves the approved nonzero SHARED_PLACEMENT_POLICY on both sides.
 *
 * @param {{deployableSurplus:bigint, minEconomicMusd:bigint}} s
 * @returns {{ok: true} | {ok: false, reason: string, heldMusd: bigint}}
 */
export function evaluateEconomicMinimum(s) {
  const min = BigInt(s.minEconomicMusd ?? 0n);
  if (min <= 0n) return { ok: true };
  if (s.deployableSurplus < min) {
    return {
      ok: false,
      reason: `deployable ${s.deployableSurplus} below the economic minimum ${min}`,
      heldMusd: s.deployableSurplus,
    };
  }
  return { ok: true };
}

/**
 * Withdrawal-batch close trigger: the OPEN batch's notional (shares priced at the live NAV,
 * since shares are not asset-denominated until a close-NAV is fixed) crossing a configurable
 * SUM threshold, never a request count. One large request trips it exactly like many small
 * ones; a lone dust request never does. Pure and deterministic, so every operator agrees on
 * the same moment without coordinating.
 *
 * Owner's automation parameter #4 (2026-08-06), `withdrawal queue max age`: size alone is not
 * a sufficient trigger, because a queue that never reaches the threshold never closes and the
 * people in it wait forever — there is no redemption SLA you can advertise on top of that. So
 * a batch ALSO becomes due once its oldest request has waited `maxAgeSecs`, whatever its size.
 * Both are opt-in (0 = off), and the age escape deliberately requires a NON-EMPTY batch: an
 * empty open batch ages too, and closing it would burn a NAV epoch and a signing round on
 * nothing.
 *
 * @param {{batchNotional:bigint, sumThresholdAssets:bigint, openedAt?:bigint, now?:bigint,
 *          maxAgeSecs?:bigint}} s
 */
export function shouldFixBatch(s) {
  if (s.sumThresholdAssets > 0n && s.batchNotional > 0n && s.batchNotional >= s.sumThresholdAssets) return true;
  const maxAge = s.maxAgeSecs ?? 0n;
  if (maxAge <= 0n) return false;
  if (s.batchNotional <= 0n) return false; // nothing queued — ageing an empty batch is not a trigger
  if (!s.openedAt || !s.now) return false; // no clock to judge by: fail closed, never guess
  return s.now - s.openedAt >= maxAge;
}

/**
 * `fix_batch(nav)`: publish the price and close the open withdrawal batch against it, in one task.
 *
 * The payload is the SAME six words as POST_NAV — (navEpoch, navRay) plus four canonical snapshot
 * pins — so every operator re-derives navRay at exactly those pinned blocks and signs only on an
 * exact match. What it does NOT carry is a batch id: the executor closes whichever batch the queue
 * has open, so the EXECUTION WINDOW is what ties the signed close to the batch the quorum meant.
 * `maxBlock` and a short expiry are mandatory on chain for exactly that reason.
 *
 * These were two rounds until 2026-08-09, and splitting them could not deliver what it promised.
 * The close and the post raced to reach quorum independently, and the close — a handful of reads
 * against the post's full canonical recomputation — systematically won, so a batch closed at the
 * previous heartbeat's price while the NAV meant to price it landed afterwards. Atomicity is what
 * makes "a batch closes at a price struck for it" true, and it costs one signing round, not two.
 *
 * @param {{navEpoch:bigint|number, lastNavEpoch:bigint|number, navRay:bigint, executor:string,
 *          nonce:bigint, blockTimestamp:bigint, swapExpirySecs?:bigint, adminExpirySecs:bigint,
 *          maxBlock:bigint, mezoSnapshotBlock:bigint, ethSnapshotBlock:bigint,
 *          mezoSnapshotHash:string, ethSnapshotHash:string}} s
 */
export function proposeFixBatch(s) {
  if (BigInt(s.navEpoch) <= BigInt(s.lastNavEpoch)) return null; // monotonicity mirrors the on-chain guard
  if (!s.navRay || s.navRay <= 0n) return null; // the executor rejects a zero NAV; never propose one
  // No unpinned form. POST_NAV tolerates one for the legacy test path; a close does not, because
  // an unpinned price is one no operator can reproduce and the executor refuses the shape outright.
  if (!s.mezoSnapshotBlock || !s.ethSnapshotBlock || !s.mezoSnapshotHash || !s.ethSnapshotHash) return null;
  const payload = "0x" + word(BigInt(s.navEpoch)) + word(s.navRay)
    + word(s.mezoSnapshotBlock) + word(s.ethSnapshotBlock) + word(s.mezoSnapshotHash) + word(s.ethSnapshotHash);
  // The window is bounded by the SWAP window, not the admin one: this task's meaning depends on
  // when it runs, exactly like a task carrying a quote.
  const window = s.swapExpirySecs ?? (s.adminExpirySecs > 300n ? 300n : s.adminExpirySecs);
  const task = {
    chainId: MEZO_CHAIN_ID,
    contractAddr: s.executor,
    nonce: s.nonce,
    taskType: TaskType.FIX_BATCH,
    calldataHash: calldataHash(payload),
    expiry: s.blockTimestamp + window,
    maxBlock: s.maxBlock,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * An unbond ticket is claimable once the venue adapter's own maturity answer has passed —
 * `claimableAt` is authoritative (BridgeReceiver._claimAndBridge reverts UnbondNotMature on-
 * chain if called early, so this gate is a courtesy against wasted rounds, not the real
 * safety backstop; the contract itself is).
 *
 * @param {{claimableAt:bigint, claimed:boolean, now:bigint}} s
 */
export function shouldClaimUnbondTicket(s) {
  return !s.claimed && s.claimableAt !== 0n && s.claimableAt <= s.now;
}

/**
 * ETH-leg claim-and-bridge proposal — phase 2 of the two-phase unbond (v4 §03). Carries the
 * admin expiry window like ALLOCATE (not swap-bearing: no quote/slippage on this leg).
 *
 * @param {{ticketId:bigint, ethChainId:bigint, receiver:string, nonce:bigint,
 *          ethBlockTimestamp:bigint, adminExpirySecs:bigint}} s
 */
export function proposeBridgeBack(s) {
  if (s.ticketId === 0n) return null;
  const payload = "0x" + word(s.ticketId);
  const task = {
    chainId: s.ethChainId,
    contractAddr: s.receiver,
    nonce: s.nonce,
    taskType: TaskType.BRIDGE_BACK,
    calldataHash: calldataHash(payload),
    expiry: s.ethBlockTimestamp + s.adminExpirySecs,
    maxBlock: 0n,
  };
  return { task, payload, hash: taskHash(task) };
}

/**
 * Return-leg trigger: a batch that is closed but not yet Fulfilled still has an outstanding
 * obligation, and there is executor-held mUSDC that could be swapped toward it. This gates
 * SWAP_USDC_TO_MUSD_ON_MEZO rather than proposing a swap on every tick — bringing money home costs slippage, so
 * it happens against a real obligation, not speculatively.
 *
 * Note what it does NOT decide: which batch the money pays. SWAP_USDC_TO_MUSD_ON_MEZO lands MUSD in the vault
 * buffer and settlement reads only the buffer, so this trigger's batch is the reason to swap,
 * never the destination.
 *
 * @param {{batchStatus:bigint, fulfilledOnce:boolean, obligation:bigint, funded:bigint,
 *          available:bigint}} s
 */
// Types.sol BatchStatus: Closed, Unwinding, InFlight, PartiallyFunded. Unknown future
// states must be reviewed before either proposer or operator treats them as fundable.
export function isFundableBatchStatus(status) {
  return status === 2n || status === 3n || status === 4n || status === 5n;
}

export function shouldSwapBackForFunding(s) {
  if (!isFundableBatchStatus(s.batchStatus)) return false;
  if (s.fulfilledOnce) return false;
  const outstanding = s.obligation > s.funded ? s.obligation - s.funded : 0n;
  return outstanding > 0n && s.available > 0n;
}

/**
 * Standalone return-leg swap (`swap_usdc_to_musd_on_mezo`). Turns executor-held mUSDC into
 * MUSD in the VAULT BUFFER, touching no batch — see MezoOpsExecutor._handleSwapBack for why that
 * separation exists. `minMusdOut` comes from the caller's OWN quote rather than from any target
 * figure, so the operator's independent quote-vs-minOut check has something real to bound.
 *
 * @param {{musdcIn:bigint, quotedOut:bigint, slippageBps:bigint, executor:string,
 *          nonce:bigint, blockTimestamp:bigint, swapExpirySecs:bigint, maxBlock:bigint}} s
 */
export function proposeSwapBack(s) {
  if (s.musdcIn <= 0n) return null;
  if (s.quotedOut <= 0n) return null;
  const { minOut: minMusdOut } = resolveMinOut({
    quotedOut: s.quotedOut, slippageBps: s.slippageBps, depthAware: s.quoteIsDepthAware === true,
    requireDepthAware: s.requireDepthAwareQuote, feeBps: s.poolFeeBps, label: "swap-back",
  });
  if (minMusdOut <= 0n) return null; // the executor rejects an unpriced swap — never propose one
  const payload = "0x" + word(s.musdcIn) + word(minMusdOut);
  const task = {
    chainId: MEZO_CHAIN_ID,
    contractAddr: s.executor,
    nonce: s.nonce,
    taskType: TaskType.SWAP_USDC_TO_MUSD_ON_MEZO,
    calldataHash: calldataHash(payload),
    expiry: s.blockTimestamp + s.swapExpirySecs,
    maxBlock: s.maxBlock,
  };
  return { task, payload, hash: taskHash(task), minMusdOut };
}

/**
 * `clear_batch`: pay a CLOSED batch out of the Mezo buffer. The buffer is the SINGLE funding pool
 * — every route home (a fresh deposit, an unwind swapped back) ends there — so this is the only
 * settlement path, and the order in which money arrives cannot matter.
 *
 * BINARY: this returns the WHOLE outstanding obligation, or 0n. A buffer that covers only part of
 * the batch is not a reason to pay part of it — the executor would revert
 * PartialClearingNotAllowed, and the right move is to unwind more on Ethereum, bring it home, and
 * clear once. Returning a tranche here would spend a signing round to build a task that cannot
 * execute.
 *
 * `minClip` still applies: a rounding-dust obligation is not worth a signing round.
 *
 * @param {{outstanding:bigint, buffer:bigint, minClip:bigint}} s
 * @returns {bigint} the whole outstanding obligation when the buffer covers it, else 0n
 */
export function clearBatchAmount(s) {
  if (s.outstanding <= 0n || s.buffer < s.outstanding) return 0n;
  return s.outstanding < s.minClip ? 0n : s.outstanding;
}

/**
 * Buffer-funding proposal: (batchId, amount), no swap and no bridge, so no min-out and no
 * block bound — there is no price for a submitter to pick.
 *
 * @param {{batchId:bigint, amount:bigint, executor:string, nonce:bigint,
 *          blockTimestamp:bigint, adminExpirySecs:bigint}} s
 */
export function proposeClearBatch(s) {
  if (s.amount <= 0n) return null;
  const payload = "0x" + word(s.batchId) + word(s.amount);
  const task = {
    chainId: MEZO_CHAIN_ID,
    contractAddr: s.executor,
    nonce: s.nonce,
    taskType: TaskType.CLEAR_BATCH,
    calldataHash: calldataHash(payload),
    expiry: s.blockTimestamp + s.adminExpirySecs,
    maxBlock: 0n,
  };
  return { task, payload, hash: taskHash(task) };
}

export { word as _word };
