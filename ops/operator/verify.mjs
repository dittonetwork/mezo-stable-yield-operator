// SPDX-License-Identifier: BUSL-1.1
// The operator's content check: BOUNDS enforced against this host's own chain reads.
//
// The aggregator is trusted to SEQUENCE rounds, never to dictate their content. Before an
// operator signs, it re-reads the chain itself and refuses anything outside the bounds it
// can justify. Without this the threshold is cryptographically real but semantically empty:
// five rubber stamps, and a compromised aggregator could have `minOut = 1` signed and
// sandwich the swap. (Risk #3 accepts a compromised aggregator only for DUPLICATES.)
//
// Multichain (E, 2026-07-15 — "Полный вперёд"): one operator process now verifies against
// BOTH legs — its own config carries a leg per chainId (Mezo + Ethereum), each with its own
// RPC/cast reader. There is still no trusted notifier anywhere: liquidity is fungible, and
// the receiver's own physical balance (read directly, eth_call) is the ONLY attribution
// mechanism — never the aggregator's word, never a bucket, never a relayer, and (2026-07-19,
// E's state-driven read model) never a source-chain log scan either. See the ALLOCATE case
// below for why balance-as-authority is the right gate, not a downgrade.
//
// WHAT THIS IS NOT — do not overstate it (external review, 2026-07-15; the first two bullets
// were narrowed 2026-08-08 because the canonical-NAV change of 2026-08-06 outgrew them, and a
// stale limitation reads to a reviewer as a live one):
//   - For NON-price-setting tasks it is BOUNDS-CHECKING, not the pinned-state canonical
//     re-derivation the design-of-record specifies: each operator reads `latest` independently,
//     so honest operators can legitimately disagree at a boundary and nothing forces the
//     aggregator's proposal to be reproducible. PRICE_SETTING tasks are the exception — they
//     carry snapshot pins and ARE re-derived byte-identically (next bullet).
//   - Every PRICE_SETTING task must match this operator's OWN recomputation at the payload's
//     pinned blocks EXACTLY (`verifyCanonicalPrice`); there is no band on top, and a config
//     without `navAccounting.inventory` refuses all of them rather than falling back. What is
//     still missing is not a band but agreement on the INPUTS: every operator recomputes from
//     its own copy of the same inventory description, so a wrong shared inventory makes all
//     five agree. Also absent: median+MAD across operators, and any valuation of the MUSD leg
//     independent of the venue.
//   - The min-out floor is quoted from THE SAME POOL the swap will cross. Against a
//     manipulated spot price all five operators consult the manipulated price and all five
//     agree. It stops a starved min-out, not a manipulated venue. A TWAP or an independent
//     reference price is the real defence and does not exist yet.
//   - There is no operator-side guard on the EXECUTOR's own mUSDC inventory (the engine has
//     one; this does not). The swap POOL's inventory is checked, vs 2x the clip.
//   - ALLOCATE / DEALLOCATE are barely constrained beyond a non-zero amount, plus
//     (ALLOCATE only) the receiver-balance check below.
// Tracked in docs/audit/KNOWN-ISSUES.md. Each check below answers only "is this within a
// bound I can justify from my own read?" — anything else is refused (default deny).
import { keccak256Hex } from "../task-engine/keccak.mjs";
import { TaskType, encodeTask, isFundableBatchStatus, heartbeatFields, HEARTBEAT_INTERVAL, HEARTBEAT_TTL } from "../task-engine/engine.mjs";
import { computeNavRay, checkNavWithinGuard, navGuardBand, scaleAssetAmount } from "../task-engine/nav-estimator.mjs";
import { recomputeCanonicalNav } from "../task-engine/nav-snapshot.mjs";
import { rpcChainReader, decodeWords, decodeTickCumulatives } from "../task-engine/rpc-reader.mjs";
import { valuationFromPolicy, usdcExitRate, twapFloorOut } from "../task-engine/usdc-valuation.mjs";
import {
  resolveMinOut, SpotQuoteRefused, QUOTER_V2_SIG, DEFAULT_TICK_SPACING,
  roundTripQuote, evaluateRoundTrip,
} from "../task-engine/swap-quote.mjs";
import { placeableAfterBufferFloor, evaluateEconomicMinimum, swapBackFundingFloor } from "../task-engine/engine.mjs";
import { SHARED_SWAP_POLICY, SHARED_PLACEMENT_POLICY, SHARED_NAV_POLICY } from "../task-engine/threshold-config.mjs";

const ETH_LEG = new Set([TaskType.ALLOCATE, TaskType.DEALLOCATE, TaskType.BRIDGE_BACK]);
const SWAP_BEARING = new Set([TaskType.SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH, TaskType.SWAP_USDC_TO_MUSD_ON_MEZO]);
// The tasks that carry a price, and therefore the ones needing canonical pins and exact-match
// verification against this operator's own recomputation. POST_NAV publishes a price on its own;
// FIX_BATCH publishes one AND strikes the batch's obligation against it in the same transaction,
// which is why a close is verified as rigorously as a post rather than inheriting its result.
const PRICE_SETTING = new Set([TaskType.POST_NAV, TaskType.FIX_BATCH]);
// The types the executor gates on a mandatory `maxBlock` plus the 5-minute expiry ceiling.
// FIX_BATCH is in the set for a reason of its own, not by analogy to a swap: its payload names a
// price but never a BATCH, so the execution window is the ONLY thing tying a signed close to the
// batch the quorum meant to close. Co-signing one without a window means co-signing a close that
// can sit unused and later strike a different batch, and that the chain rejects in any case.
const EXECUTION_WINDOWED = new Set([...SWAP_BEARING, TaskType.FIX_BATCH]);
const SWAP_EXPIRY_WINDOW = 300n; // MezoOpsExecutor.SWAP_EXPIRY_WINDOW = 5 minutes
// Admin (non-swap) tasks have NO on-chain expiry ceiling, so without one here a signed
// NAV/close/rebalance task stays executable indefinitely and any holder picks the moment.
// The chain will not bound it for us; the operators must.
const ADMIN_EXPIRY_MAX_DEFAULT = 3600n;
const RAY = 10n ** 27n;
const VIRTUAL_SHARES = 1_000n;

const deny = (reason) => ({ ok: false, reason });
const ok = () => ({ ok: true });
const isUint = (value, bits) => typeof value === "bigint" && value >= 0n && value < (1n << BigInt(bits));

/** abi-decode a tail of uint256 words (all our payloads are static words). */
function words(payload, n) {
  const hex = payload.replace(/^0x/, "");
  if (hex.length !== n * 64) throw new Error(`payload: want ${n} words, got ${hex.length / 64}`);
  return Array.from({ length: n }, (_, i) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64)));
}

function priceWords(payload, economicWords, canonical) {
  return words(payload, economicWords + (canonical ? 4 : 0));
}

const withinNavGuard = (candidateNavRay, baselineNavRay, cfg) => {
  const { upperBps, lowerBps } = navGuardBand({
    upperBps: cfg.navGuardUpperBps,
    lowerBps: cfg.navGuardLowerBps,
  });
  return checkNavWithinGuard({ candidateNavRay, prevNavRay: baselineNavRay, upperBps, lowerBps }).ok;
};

/** The NAV inventory restates addresses the leg config already binds — make them agree.
 *
 * External mainnet-readiness review, 2026-08-08: `ops/nav-accounting-mainnet.snapshot.json` still
 * described the RETIRED deployment (vault 0xE0236177…) and was marked `complete: true`. Nothing
 * would have caught it. Task binding covers chainId AND the target executor, but the inventory is
 * a separate document: recomputeCanonicalNav reads totalSupply() from `inventory.mezo.vault` and
 * balances from `inventory`'s own owner lists, so a stale inventory prices a DIFFERENT DEPLOYMENT
 * and returns a confident number for it. Every operator loads the same file, so all five agree,
 * the exact-match check passes, and the wrong NAV is signed by a full quorum.
 *
 * That is the one failure consensus structurally cannot catch — the same shape as the absurd-value
 * ceilings. This is the cheap half of the review's §8.2 manifest recommendation: it does not prove
 * the inventory is COMPLETE, but it does prove it describes the deployment this operator was
 * configured for, and it costs nothing at runtime.
 */
function assertInventoryMatchesLegs(inventory, mezoLeg, ethLeg) {
  const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  const bindings = [
    ["mezo.vault", inventory.mezo?.vault, mezoLeg.vault],
    ["mezo.withdrawalQueue", inventory.mezo?.withdrawalQueue, mezoLeg.queue],
    ["tokens.musd", inventory.tokens?.musd?.address, mezoLeg.musd],
    ["tokens.musdc", inventory.tokens?.musdc?.address, mezoLeg.musdc],
    ["ethereum.receiver", inventory.ethereum?.receiver, ethLeg.receiver],
    ["tokens.usdc", inventory.tokens?.usdc?.address, ethLeg.usdc],
  ];
  for (const [field, fromInventory, fromLeg] of bindings) {
    // A leg that does not declare an address cannot contradict the inventory about it.
    if (!fromLeg) continue;
    if (!same(fromInventory, fromLeg)) {
      throw new Error(
        `NAV inventory ${field} is ${fromInventory ?? "missing"}, but this operator's leg config says `
        + `${fromLeg} — the inventory describes a different deployment and would price that one instead`,
      );
    }
  }
}

/** The git-tracked USDC valuation policy, bound to THIS operator's own pool — never the proposer's. */
export const usdcValuation = (mezoLeg) => valuationFromPolicy(mezoLeg, SHARED_NAV_POLICY);

async function computePinnedCanonicalNav(cfg, chains, mezoBlock, ethBlock, mezoHash, ethHash) {
  const mezoEntry = Object.entries(cfg.legs).find(([, l]) => l.vault && l.executor);
  const ethEntry = Object.entries(cfg.legs).find(([, l]) => l.receiver && l.usdc);
  const [mezoName, mezoLeg] = mezoEntry ?? [null, null];
  const [ethName, ethLeg] = ethEntry ?? [null, null];
  if (!mezoLeg || !ethLeg || !cfg.navAccounting?.inventory) throw new Error("canonical NAV configuration is incomplete");
  assertInventoryMatchesLegs(cfg.navAccounting.inventory, mezoLeg, ethLeg);
  // By NAME, not chainId: when both legs sit on one chain the chainId key resolves to a single
  // reader, so the two legs would silently share one set of addresses and the canonical snapshot
  // would price the same leg twice.
  const mezo = chains[mezoName] ?? chains[String(mezoLeg.chainId)];
  const eth = chains[ethName] ?? chains[String(ethLeg.chainId)];
  if (!mezo || !eth) throw new Error("canonical NAV chain reader is missing");
  const [mezoPin, ethPin] = await Promise.all([mezo.snapshotPin(mezoBlock), eth.snapshotPin(ethBlock)]);
  const signedMezoHash = `0x${mezoHash.toString(16).padStart(64, "0")}`;
  const signedEthHash = `0x${ethHash.toString(16).padStart(64, "0")}`;
  if (mezoPin.hash.toLowerCase() !== signedMezoHash || ethPin.hash.toLowerCase() !== signedEthHash) {
    throw new Error("signed snapshot block hash does not match operator RPC");
  }
  const byName = { mezo, eth };
  const pins = { mezo: mezoPin, eth: ethPin };
  // Production JSON-RPC uses EIP-1898, including on fallback providers. A number-only
  // read between two matching hash checks could still have observed a different fork.
  const ref = (leg, block) => byName[leg].pinnedBlockRef?.(pins[leg]) ?? block;
  const reader = {
    tokenDecimals: (leg, token, block) => byName[leg].pinnedTokenDecimals(token, ref(leg, block)),
    tokenBalance: (leg, token, owner, block) => byName[leg].pinnedTokenBalance(token, owner, ref(leg, block)),
    uintCall: (leg, target, sig, args, block) => byName[leg].pinnedUintCall(target, sig, args, ref(leg, block)),
    addressCall: (leg, target, sig, args, block) => byName[leg].pinnedAddressCall(target, sig, args, ref(leg, block)),
    unbondState: (leg, adapter, block) => byName[leg].pinnedUnbondState(adapter, ref(leg, block)),
    tickCumulatives: (leg, pool, secondsAgo, block) => byName[leg].pinnedTickCumulatives(pool, secondsAgo, ref(leg, block)),
    confirmPin: (leg, pin) => byName[leg].confirmSnapshotPin(pin),
  };
  return (await recomputeCanonicalNav({
    reader,
    pins: { mezo: mezoPin, eth: ethPin },
    inventory: cfg.navAccounting.inventory,
    policy: cfg.navAccounting.policy,
    valuation: usdcValuation(mezoLeg),
  })).navRay;
}

async function computeLegacyTestNav(chain, ethChain, ethVenueClassId) {
  const [mezoBlock, ethBlock] = await Promise.all([
    chain.blockNumber(),
    ethChain ? ethChain.blockNumber() : Promise.resolve(null),
  ]);
  const [mezoBufferBalance, mezoExecutorBalance, mezoExecutorMusdc, withdrawReserved, totalSupply] = await Promise.all([
    chain.mezoBufferBalance(mezoBlock),
    chain.executorMusdBalance(mezoBlock),
    chain.executorMusdcBalance(mezoBlock),
    chain.withdrawalQueueTotalReserved(mezoBlock),
    chain.vaultTotalSupply(mezoBlock),
  ]);
  const venue = ethChain && ethVenueClassId
    ? await ethChain.ethVenueManagedAndHaircut(ethVenueClassId, ethBlock)
    : { managed: 0n, pendingUnbondHaircut: 0n };
  const ethReceiverIdle = ethChain ? await ethChain.ethReceiverIdle(ethBlock) : 0n;
  const normalizedMezoExecutorMusdc = mezoExecutorMusdc === 0n
    ? 0n
    : scaleAssetAmount(mezoExecutorMusdc, await chain.musdcDecimals(mezoBlock), await chain.assetDecimals(mezoBlock));
  const hasEthAssets = venue.managed !== 0n || venue.pendingUnbondHaircut !== 0n || ethReceiverIdle !== 0n;
  let normalizeEth = () => 0n;
  if (hasEthAssets) {
    if (!ethChain) throw new Error("independent NAV: Ethereum assets without an Ethereum reader");
    const [ethDecimals, mezoDecimals] = await Promise.all([
      ethChain.assetDecimals(ethBlock), chain.assetDecimals(mezoBlock),
    ]);
    normalizeEth = (amount) => scaleAssetAmount(amount, ethDecimals, mezoDecimals);
  }
  return computeNavRay({
    mezoBufferBalance,
    mezoExecutorBalance,
    mezoExecutorMusdcBalance: normalizedMezoExecutorMusdc,
    ethVenueManaged: normalizeEth(venue.managed),
    ethPendingUnbondHaircut: normalizeEth(venue.pendingUnbondHaircut),
    ethReceiverIdle: normalizeEth(ethReceiverIdle),
    withdrawReserved, totalSupply,
    virtualShares: VIRTUAL_SHARES, ray: RAY,
  });
}

async function navForPayload({ cfg, chains, payloadWords }) {
  if (!cfg.navAccounting?.inventory) throw new Error("canonical NAV accounting is required for every price-setting task");
  const mezoBlock = payloadWords.at(-4);
  const ethBlock = payloadWords.at(-3);
  const mezoHash = payloadWords.at(-2);
  const ethHash = payloadWords.at(-1);
  if (mezoBlock === undefined || ethBlock === undefined || mezoHash === undefined || ethHash === undefined
      || mezoBlock === 0n || ethBlock === 0n || mezoHash === 0n || ethHash === 0n) {
    throw new Error("price-setting payload is missing pinned Mezo/Ethereum blocks");
  }
  return computePinnedCanonicalNav(cfg, chains, mezoBlock, ethBlock, mezoHash, ethHash);
}


async function verifyCanonicalPrice({ cfg, chains, payloadWords, candidate, posted }) {
  let canonical;
  try {
    canonical = await navForPayload({ cfg, chains, payloadWords });
  } catch (error) {
    return deny(`canonical NAV unreadable: ${error.message}`);
  }
  // Exact match against THIS operator's own recomputation at the payload's pinned blocks is the
  // whole verification (owner's decision, 2026-08-06). There is no plausibility band on top any
  // more: a band cannot know more than the canonical computation it is second-guessing, and it
  // deadlocks — the candidate is derived from live state, so a refusal never changes the number
  // and repeats forever. `posted` is deliberately unused now; it is the value a band would have
  // compared against.
  if (candidate !== canonical) return deny(`NAV ${candidate} does not exactly match pinned canonical NAV ${canonical}`);
  return ok();
}

/** Find this operator's own config for the leg a task claims to run on — never the leg the
 * aggregator's word implies. A leg not in cfg.legs means this operator was never told about
 * that chain and must refuse rather than improvise. */
function legEntryFor(cfg, chainId, target) {
  const onChain = Object.entries(cfg.legs).filter(([, leg]) => BigInt(leg.chainId) === BigInt(chainId));
  if (onChain.length <= 1) return onChain[0] ?? [null, null];
  // Two legs on ONE chain — a single-chain rehearsal, where the Mezo and Ethereum sides are both
  // deployed to the same network. chainId alone can no longer say which leg a task belongs to,
  // and picking the first match silently bound every Mezo task to the Ethereum leg's config,
  // whose `vault` is undefined: every operator then refused with an unhelpful leg_unavailable.
  // The task already binds its target contract, so disambiguate on that — strictly more precise
  // than chainId, and a no-op whenever the legs live on different chains, as in production.
  const t = String(target ?? "").toLowerCase();
  return onChain.find(([, leg]) =>
    [leg.executor, leg.receiver].filter(Boolean).some((a) => String(a).toLowerCase() === t))
    ?? [null, null];
}

/**
 * @param {object} p.task     the aggregator's proposed task
 * @param {string} p.payload  its preimage — REQUIRED: without it calldataHash is unverifiable
 * @param {object} p.cfg      the operator's OWN pinned config (never the aggregator's word);
 *                            multichain shape: { legs: { <name>: {chainId, ...} }, ... }
 * @param {object} p.chains   this operator's OWN chain readers, keyed by String(chainId) —
 *                            one per configured leg. Never fall back to another chain's RPC.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function verifyProposal({ task, payload, cfg, chains }) {
  if (typeof payload !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payload)) return deny("payload missing or malformed");
  try { encodeTask(task); } catch (error) { return deny(`malformed task: ${error.message}`); }
  // Read a dynamic inventory getter ONCE per verification, before the first await. The
  // reconciler may atomically replace the file during RPC reads; never mix those versions.
  try {
    if (PRICE_SETTING.has(task.taskType) && cfg.navAccounting) {
      cfg = { ...cfg, navAccounting: { ...cfg.navAccounting } };
    }
  } catch {
    return deny("canonical NAV inventory unreadable");
  }

  // ---- domain: bind to a leg I actually know, not the one the proposal claims ----
  const [legName, leg] = legEntryFor(cfg, task.chainId, task.contractAddr);
  if (!leg) return deny(`chainId ${task.chainId} is not a leg I am configured for`);
  const chain = chains[legName] ?? chains[String(task.chainId)];
  if (!chain) return deny(`no chain reader configured for chainId ${task.chainId}`);
  // The Ethereum leg, identified structurally (has receiver+usdc) rather than by the "eth"
  // key name -- legs are matched by chainId everywhere else in this file, not by name. Used
  // only by the independent-NAV recomputation below; a Mezo-only deployment simply has none
  // (same "missing config == 0" convention as ethReceiverIdle/ethVenueManaged elsewhere).
  const ethLeg = Object.values(cfg.legs).find((l) => l.receiver && l.usdc);
  const ethChain = ethLeg ? chains[String(ethLeg.chainId)] : null;
  const canonicalAccounting = PRICE_SETTING.has(task.taskType) && !!cfg.navAccounting?.inventory;
  if (PRICE_SETTING.has(task.taskType) && !canonicalAccounting && !cfg.allowLegacyNavAccountingForTests) {
    return deny("canonical NAV accounting configuration is required");
  }
  if (canonicalAccounting && PRICE_SETTING.has(task.taskType)) {
    const economicWords = 2;
    const actualWords = payload.replace(/^0x/, "").length / 64;
    if (actualWords !== economicWords + 4) return deny("price-setting payload is missing canonical snapshot pins");
  }

  const expectTarget = task.taskType === TaskType.HEARTBEAT ? (leg.receiver ?? leg.executor)
    : ETH_LEG.has(task.taskType) ? leg.receiver : leg.executor;
  if (String(task.contractAddr).toLowerCase() !== String(expectTarget).toLowerCase()) {
    return deny(`contractAddr ${task.contractAddr} is not my ${ETH_LEG.has(task.taskType) ? "receiver" : "executor"}`);
  }
  // The signature commits to calldataHash, so an unchecked hash = signing a blank cheque.
  if (keccak256Hex(Buffer.from(payload.replace(/^0x/, ""), "hex")) !== task.calldataHash) {
    return deny("calldataHash does not match the payload");
  }

  // ---- timing: the submitter must not get to choose the moment (risk #11) ----
  const now = await chain.now();
  if (BigInt(task.expiry) <= now) return deny("already expired");
  if (EXECUTION_WINDOWED.has(task.taskType)) {
    if (BigInt(task.expiry) > now + SWAP_EXPIRY_WINDOW) return deny("windowed task expiry beyond the 5-min window");
    if (BigInt(task.maxBlock) === 0n) return deny("windowed task without maxBlock");
    if (BigInt(task.maxBlock) < (await chain.blockNumber())) return deny("maxBlock already passed");
  } else if (canonicalAccounting && PRICE_SETTING.has(task.taskType)) {
    if (BigInt(task.expiry) > now + SWAP_EXPIRY_WINDOW) return deny("canonical NAV task expiry beyond the 5-min window");
    if (BigInt(task.maxBlock) === 0n) return deny("canonical NAV task without maxBlock");
    if (BigInt(task.maxBlock) < (await chain.blockNumber())) return deny("canonical NAV task maxBlock already passed");
  } else {
    const max = BigInt(cfg.adminExpiryMaxSecs ?? ADMIN_EXPIRY_MAX_DEFAULT);
    if (BigInt(task.expiry) > now + max) {
      return deny(`admin task expiry ${task.expiry} more than ${max}s out — it would stay executable at a holder's choosing`);
    }
  }

  // ---- content: would I have proposed these numbers? ----
  // ONE slippage number in the system, and it is the one the proposer used, because both sides read
  // the same constant rather than their own config key. This used to be `cfg.maxSlippageBps ?? 100`
  // against the proposer's `minOutBps` 50 — two names for one knob, so an operator would have
  // co-signed a min-out twice as slack as the proposer builds, in the exact check that exists to
  // stop a starved min-out. Defaulted from the shared constant, not from a loose literal: a cfg
  // that forgot the key must not thereby loosen the bound.
  const slip = BigInt(cfg.minOutBps ?? SHARED_SWAP_POLICY.minOutBps);
  const requireDepthAware = cfg.requireDepthAwareQuote ?? SHARED_SWAP_POLICY.requireDepthAwareQuote;

  // The sandwich bound for every swap-bearing task, derived through the SAME function the
  // proposer used (ops/task-engine/swap-quote.mjs). Sharing it is the point: when the two sides
  // compute a floor by different arithmetic, the operator either rubber-stamps a starved minOut
  // or denies an honest one — and the second failure is the one that stops a live vault.
  //
  // 2026-08-07: this used to be an inline `quote * (10_000 - slip) / 10_000` at three call
  // sites, over TigrisCLSwapAdapter.quote(), which reads slot0 and returns a pure MID — no fee
  // tier, no price impact. Proposer and operator shared the blind spot, so operator
  // verification could never catch it. The quote is still independently read here; what is
  // shared is only how a quote becomes a floor.
  const swapFloor = async (tokenIn, tokenOut, amountIn, label) => {
    let quotedOut = (await chain.depthQuote?.(tokenIn, tokenOut, amountIn)) ?? null;
    const depthAware = quotedOut !== null && quotedOut > 0n;
    if (!depthAware) quotedOut = await chain.quote(tokenIn, tokenOut, amountIn);
    try {
      return { quotedOut, depthAware, floor: resolveMinOut({
        quotedOut, slippageBps: slip, depthAware,
        requireDepthAware, feeBps: cfg.poolFeeBps, label,
      }).minOut };
    } catch (e) {
      // Fail CLOSED on a floor we cannot justify: requireDepthAwareQuote with no quoter on THIS
      // operator is a misconfiguration, and falling back to the mid it exists to reject would be
      // worse than refusing to sign.
      if (e instanceof SpotQuoteRefused) return { denyReason: e.message };
      throw e;
    }
  };

  /** The price half of a price-setting task, shared by POST_NAV and FIX_BATCH.
   *
   * Shared deliberately rather than written twice: a close now publishes a price, so it must be
   * held to exactly the standard a post is — same monotonic epoch, same exact match against this
   * operator's own recomputation at the payload's pinned blocks. Two copies of this would be two
   * chances for a close to end up judged more loosely than a post, which is the whole thing the
   * merge must not cost us.
   *
   * @returns {Promise<{ok:true, ray:bigint, epoch:bigint} | {ok:false, reason:string}>}
   */
  const verifyProposedPrice = async () => {
    const decoded = priceWords(payload, 2, canonicalAccounting);
    const [epoch, ray] = decoded;
    if (ray === 0n) return deny("NAV of zero");
    const lastEpoch = await chain.lastNavEpoch();
    if (epoch !== lastEpoch + 1n || epoch >= 1n << 64n) {
      return deny(`navEpoch ${epoch} must be exactly ${lastEpoch + 1n} and fit uint64`);
    }
    if (canonicalAccounting) {
      const canonical = await verifyCanonicalPrice({ cfg, chains, payloadWords: decoded, candidate: ray });
      if (!canonical.ok) return canonical;
    } else {
      const live = await chain.currentNAV();
      if (live !== 0n && !withinNavGuard(ray, live, cfg)) return deny(`NAV ${ray} deviates from current ${live} beyond the band`);
      const independent = await computeLegacyTestNav(chain, ethChain, ethLeg?.venueClassId);
      if (!withinNavGuard(ray, independent, cfg)) return deny(`NAV ${ray} deviates from my INDEPENDENTLY recomputed NAV ${independent} beyond the band`);
    }
    return { ok: true, ray, epoch };
  };

  switch (task.taskType) {
    case TaskType.HEARTBEAT: {
      try {
        const { previousActivity, issuedAt } = heartbeatFields(payload);
        const state = await chain.heartbeatState();
        if (!isUint(state.now, 64) || !isUint(state.lastActivity, 64) || state.active !== false) return deny("heartbeat state unreadable or dead-man active");
        if (previousActivity !== state.lastActivity) return deny("heartbeat activity changed");
        if (issuedAt < previousActivity + HEARTBEAT_INTERVAL || issuedAt > state.now) return deny("heartbeat not due or issued in the future");
        if (BigInt(task.expiry) !== issuedAt + HEARTBEAT_TTL || state.now >= BigInt(task.expiry) || BigInt(task.maxBlock) !== 0n) return deny("heartbeat execution window invalid");
        return ok();
      } catch {
        return deny("heartbeat state or payload unreadable");
      }
    }
    case TaskType.SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH: {
      const [amountIn, minOut] = words(payload, 2);
      if (amountIn === 0n) return deny("placement of zero");
      // Two bounds. The first is the chain's and is about solvency. The second is the buffer floor,
      // which exists ONLY here — the vault has no floor of its own any more — so an operator that
      // trusted the proposer for it would leave the cushion enforced by nothing at all. Git-tracked
      // (threshold-config.mjs) so a host-local edit cannot widen it either.
      const surplus = await chain.placeableSurplus();
      if (amountIn > surplus) return deny(`amountIn ${amountIn} > my placeableSurplus ${surplus}`);
      const targetFloorBps = BigInt(cfg.placementBufferFloorBps ?? 0);
      if (targetFloorBps > 0n) {
        const bound = placeableAfterBufferFloor({
          onchainPlaceable: surplus, totalAssets: await chain.totalAssets(), targetFloorBps,
        });
        if (amountIn > bound) {
          return deny(`amountIn ${amountIn} > ${bound} placeable under the ${targetFloorBps}bps buffer floor`);
        }
      }
      // The economic minimum, enforced HERE too. The proposer holds surplus back below it; an operator
      // that trusted the proposer for that would leave the whole policy resting on the party it exists
      // to check. Judged on the amount actually being placed, since a clip or a depth refit is what
      // could drop a placement under the minimum after the proposer decided it was over.
      const minEconomic = BigInt(cfg.minEconomicPlacementMusd ?? SHARED_PLACEMENT_POLICY.minEconomicPlacementMusd);
      const econ = evaluateEconomicMinimum({ deployableSurplus: amountIn, minEconomicMusd: minEconomic });
      if (!econ.ok) return deny(`placement ${amountIn} below the economic minimum ${minEconomic}`);
      // The one that matters: a starved min-out is how a swap gets sandwiched. NOTE the
      // limit above — this quote comes from the pool the swap will cross, so it bounds a
      // dishonest PROPOSAL, not a manipulated venue.
      const { floor, denyReason, quotedOut, depthAware } = await swapFloor(leg.musd, leg.musdc, amountIn, "placement");
      if (denyReason) return deny(denyReason);
      if (minOut < floor) return deny(`minOut ${minOut} below my quote floor ${floor}`);
      // The round trip, recomputed HERE from this operator's own quoter in both directions — the
      // proposer's figure is not an input. A different question from the floor above: that one asks
      // whether this swap is honestly priced against the pool right now, this asks whether the pool's
      // standing spread makes crossing it worth doing at all. Nothing on chain asks it, so an
      // operator that skipped it would leave the whole check resting on the proposer alone.
      const maxRoundTripLossBps = BigInt(cfg.maxRoundTripLossBps ?? SHARED_SWAP_POLICY.maxRoundTripLossBps);
      try {
        const { back } = await roundTripQuote({
          quote: (a, b, amt) => chain.depthQuote?.(a, b, amt) ?? null,
          tokenIn: leg.musd, tokenOut: leg.musdc, amountIn,
          // Reuse the forward quote the floor was derived from when it was depth-aware, so the two
          // checks judge one and the same quote instead of two reads of a pool that may have moved.
          forwardOut: depthAware ? quotedOut : null, label: "placement round trip",
        });
        const roundTrip = evaluateRoundTrip({ amountIn, amountBack: back, maxLossBps: maxRoundTripLossBps });
        if (!roundTrip.ok) return deny(roundTrip.reason);
      } catch (e) {
        // Fail CLOSED, same as the floor: an unquotable return leg means this operator cannot tell
        // what the placement costs, and signing on that basis is worse than refusing.
        if (e instanceof SpotQuoteRefused) return deny(e.message);
        throw e;
      }
      const quote = await chain.quote(leg.musd, leg.musdc, amountIn); // inventory guard below
      // §06 launch-blocking guard, enforced operator-side too: the aggregator applies it when
      // proposing, but an operator that only trusts the aggregator to apply it is trusting
      // the party it exists to check.
      if (leg.swapPool) {
        const inventory = await chain.tokenBalance(leg.musdc, leg.swapPool);
        if (inventory < quote * 2n) return deny(`venue inventory ${inventory} < 2x the clip ${quote}`);
      }
      return ok();
    }
    case TaskType.FIX_BATCH: {
      // `fix_batch(nav)` publishes a price AND strikes the batch's obligation against it in one
      // transaction, so this operator has two independent things to be satisfied about.
      //
      // 1. The price. Judged exactly as a POST_NAV is — re-derived from this operator's own reads
      //    at the payload's pinned blocks and exact-matched. There is deliberately no staleness
      //    check anywhere below: the NAV this batch closes at is the one this very task posts, so
      //    there is no window in which it could go stale.
      const priced = await verifyProposedPrice();
      if (!priced.ok) return priced;
      const closeNavRay = priced.ray;

      // 2. Whether the close should happen at all. There must be an open batch with something in
      //    it — closing an empty one burns a batch id and a signing round on nothing.
      const batchId = await chain.currentBatchId();
      const b = await chain.batchInfo(batchId);
      if (b.status !== 1n) return deny(`batch ${batchId} is not Open`);
      if (b.totalShares === 0n) return deny(`batch ${batchId} is empty`);

      // 3. The batch must actually be DUE, by the same size-or-age rule the aggregator triggers on
      //    and this operator carries in git (threshold-config.mjs). Without this the operator would
      //    co-sign closing a batch the moment one request landed, and the git-tracked threshold
      //    would bind nothing — the aggregator would be the only thing enforcing its own trigger.
      const sumThreshold = BigInt(cfg.withdrawBatchSumThreshold ?? 0);
      const maxAgeSecs = BigInt(cfg.withdrawQueueMaxAgeSecs ?? 0);
      {
        const notional = (b.totalShares * closeNavRay) / RAY;
        const bigEnough = sumThreshold > 0n && notional >= sumThreshold;
        const now = await chain.now();
        const oldEnough = maxAgeSecs > 0n && b.openedAt > 0n && now >= b.openedAt + maxAgeSecs;
        if (!bigEnough && !oldEnough) {
          return deny(
            `batch ${batchId} is not due: notional ${notional} < ${sumThreshold} and age `
              + `${now - b.openedAt}s < ${maxAgeSecs}s`,
          );
        }
      }
      return ok();
    }
    case TaskType.POST_NAV: {
      // The price on its own — the heartbeat that keeps the DEPOSIT path open between closes.
      // Identical judgement to the price half of a close, and the same code, so the two can never
      // drift into holding a published price to two different standards.
      const priced = await verifyProposedPrice();
      return priced.ok ? ok() : priced;
    }
    case TaskType.ALLOCATE: {
      // (bytes32 venueClassId, uint256 amount)
      const venue = "0x" + payload.replace(/^0x/, "").slice(0, 64);
      const [amount] = words("0x" + payload.replace(/^0x/, "").slice(64), 1);
      if (amount === 0n) return deny("zero amount");
      if (leg.venueClassId && venue.toLowerCase() !== String(leg.venueClassId).toLowerCase()) {
        return deny(`venue ${venue} is not the one I am configured for`);
      }
      // Security model: receiver balance is the authority. Placing more than the receiver
      // physically holds cannot be honest, and — as importantly — physically holding it IS
      // sufficient: `_place()` itself gates on nothing but this same balance (BridgeReceiver.
      // sol:188, no bucket/notifier pre-credit), so mirroring it here is not a downgrade from
      // some stronger check, it is the real backstop restated. A prior revision additionally
      // cross-checked a source-chain BridgeSent log scan (removed 2026-07-19): that scan was
      // never load-bearing against double-spend (task nonces are unique per task, not per
      // proof, so two distinct tasks could cite the same cumulative log total; only the
      // on-chain balance check — `_place` reverts once the physical USDC is gone — actually
      // stops a second placement from moving funds that already left) and it was buggy on
      // top of being redundant: unbounded accumulation with no token filter and no window
      // cursor beyond the RPC's 10k-block eth_getLogs cap. Removing it costs exactly one
      // thing: an anomalous/unexpected balance (e.g. a stray direct transfer to the receiver,
      // not a real bridge arrival) is now placeable with zero paper trail correlating it to a
      // specific source-chain send. Accepted for E's fungible-liquidity design (same
      // rationale as BridgeReceiver.sol:179-184's "no bucket/notifier" decision) — not a new
      // hole, since balance was always the actual gate, but worth stating plainly rather than
      // silently dropping.
      const balance = await chain.tokenBalance(leg.usdc, leg.receiver);
      if (amount > balance) return deny(`ALLOCATE ${amount} > receiver balance ${balance}`);
      return ok();
    }
    case TaskType.DEALLOCATE: {
      const venue = "0x" + payload.replace(/^0x/, "").slice(0, 64);
      const [amount] = words("0x" + payload.replace(/^0x/, "").slice(64), 1);
      if (amount === 0n) return deny("zero amount");
      if (leg.venueClassId && venue.toLowerCase() !== String(leg.venueClassId).toLowerCase()) {
        return deny(`venue ${venue} is not the one I am configured for`);
      }
      // Unbonding more than the venue actually holds is either a bug or an attempt to
      // manufacture an exit the position cannot cover.
      const managed = await chain.venueTotalManaged(venue);
      if (managed === null || managed === undefined || managed < 0n) return deny("venue totalManaged is unreadable");
      if (amount > managed) return deny(`unbond ${amount} > venue holds ${managed}`);
      return ok();
    }
    case TaskType.BRIDGE_BACK: {
      const [ticketId] = words(payload, 1);
      if (ticketId === 0n || !isUint(ticketId, 64)) return deny("ticket id must be a nonzero uint64");
      let ticket;
      try { ticket = await chain.unbondTicket(ticketId); }
      catch { return deny(`ticket ${ticketId} is unreadable`); }
      if (!ticket || ticket.id !== ticketId || !isUint(ticket.amount, 256) || ticket.amount === 0n
        || !isUint(ticket.requestedAt, 64) || !isUint(ticket.claimableAt, 64)
        || typeof ticket.claimed !== "boolean") return deny(`ticket ${ticketId} is invalid or does not exist`);
      if (ticket.claimed) return deny(`ticket ${ticketId} was already claimed`);
      if (ticket.claimableAt === 0n || ticket.requestedAt > ticket.claimableAt || ticket.claimableAt > now) {
        return deny(`ticket ${ticketId} is not mature`);
      }
      // The receiver retains the adapter for THIS ticket across venue changes. Do not gate
      // an old valid withdrawal on the current venue, nor substitute aggregate unbondState.
      // On-chain maturity, claimed state, exact amount and fixed recipient remain the backstop.
      return ok();
    }
    case TaskType.SWAP_USDC_TO_MUSD_ON_MEZO: {
      // `swap_usdc_to_musd_on_mezo(amount)`. The DESTINATION is hardcoded on-chain
      // (the vault), so there is no recipient to bound — but this one crosses a
      // pool, so it carries the same sandwich bound as SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH.
      const [musdcIn, minMusdOut] = words(payload, 2);
      if (musdcIn === 0n) return deny("swap-back of zero");
      let held, fundingFloor;
      try {
        // One snapshot of CLOSED debt and physical balances, independently of the proposer.
        const block = await chain.blockNumber();
        if (!isUint(block, 256)) throw new Error("invalid funding block");
        held = await chain.executorMusdcBalance(block);
        if (isUint(held, 256) && musdcIn > held) return deny(`swap-back ${musdcIn} > executor mUSDC balance ${held}`);
        fundingFloor = swapBackFundingFloor({ amount: musdcIn, held,
          outstanding: await chain.withdrawalQueueTotalReserved(block),
          buffer: await chain.mezoBufferBalance(block),
        });
      } catch (e) {
        return deny(`swap-back funding state unreadable: ${e.message}`);
      }
      if (musdcIn > held) return deny(`swap-back ${musdcIn} > executor mUSDC balance ${held}`);
      const { floor, denyReason, quotedOut, depthAware } = await swapFloor(leg.musdc, leg.musd, musdcIn, "swap-back");
      if (denyReason) return deny(denyReason);
      if (minMusdOut < floor) return deny(`minMusdOut ${minMusdOut} below my quote floor ${floor}`);
      if (minMusdOut < fundingFloor || quotedOut < fundingFloor) {
        return deny(`swap-back funding floor ${fundingFloor} exceeds minMusdOut ${minMusdOut} or quote ${quotedOut}; wait for backing or price recovery`);
      }
      // The cap (usdc-valuation.mjs capSwapBack), against THIS seat's own read of the pool's TWAP
      // exit rate at the head. Every NAV refusal (band, spot off the TWAP, short window) holds the
      // swap too: the pool is not to be sold into while it cannot be priced.
      let rate;
      try {
        rate = await usdcExitRate({
          reader: {
            uintCall: (_leg, target, sig, args) => chain.pinnedUintCall(target, sig, args, "latest"),
            addressCall: (_leg, target, sig, args) => chain.pinnedAddressCall(target, sig, args, "latest"),
            tickCumulatives: (_leg, pool, secondsAgo) => chain.pinnedTickCumulatives(pool, secondsAgo, "latest"),
          },
          ...usdcValuation(leg), musd: leg.musd, musdc: leg.musdc, block: "latest",
        });
      } catch (e) {
        return deny(`swap-back held: ${e.message}`);
      }
      // In exact amounts, on the SIGNED min-out as well as the quote: bounding only the quote let a
      // min-out another 50 bps lower through, so a swap could land ~100 bps under the TWAP
      // (Codex, 2026-09-30).
      const cap = BigInt(cfg.maxSwapBackImpactBps ?? SHARED_SWAP_POLICY.maxSwapBackImpactBps);
      const twapFloor = twapFloorOut(musdcIn, rate, cap);
      if (!depthAware) return deny("swap-back cap needs a depth-aware quote; a mid cannot show size impact");
      if (quotedOut < twapFloor) {
        return deny(`swap-back of ${musdcIn} quotes ${quotedOut}, under the pool's TWAP floor ${twapFloor} `
          + `(cap ${cap} bps); the rest must wait for the pool to refill`);
      }
      if (minMusdOut < twapFloor) {
        return deny(`minMusdOut ${minMusdOut} is under the pool's TWAP floor ${twapFloor} (cap ${cap} bps)`);
      }
      return ok();
    }
    case TaskType.CLEAR_BATCH: {
      // `clear_batch(batch_number)`: a purely local buffer -> queue move, no swap, no bridge.
      // Nothing here can leave the protocol, so the bounds are the two ways it could still be
      // wrong — paying a batch that is not closed, and paying more than it is owed.
      const [batchId, amount] = words(payload, 2);
      if (amount === 0n) return deny("buffer fulfillment of zero");
      if (batchId === 0n || !isUint(batchId, 64)) return deny("batch id must be a nonzero uint64");
      let b;
      try { b = await chain.batchInfo(batchId); }
      catch { return deny(`batch ${batchId} is unreadable`); }
      if (!b || b.batchId !== batchId || !isUint(b.obligation, 256) || !isUint(b.funded, 256)) {
        return deny(`batch ${batchId} has invalid funding data`);
      }
      if (b.status === 0n) return deny(`batch ${batchId} does not exist`);
      if (b.status === 1n) return deny(`batch ${batchId} is still Open — fix_batch must close it first`);
      if (b.status === 6n) return deny(`batch ${batchId} already Fulfilled`);
      if (!isFundableBatchStatus(b.status)) return deny(`batch ${batchId} has unknown funding status ${b.status}`);
      const outstanding = b.obligation > b.funded ? b.obligation - b.funded : 0n;
      if (amount > outstanding) return deny(`amount ${amount} exceeds batch ${batchId} outstanding ${outstanding}`);
      // The RAW buffer, not placeableSurplus(): releaseForWithdrawalFunding bounds itself by
      // _bufferBalance() precisely because placeableSurplus() nets out reservedForWithdrawals,
      // which for a closed batch is this very obligation. Checking the surplus here would
      // refuse to pay a batch out of the money reserved for it.
      const buffer = await chain.tokenBalance(leg.musd, leg.vault);
      if (amount > buffer) return deny(`amount ${amount} > vault buffer ${buffer}`);
      return ok();
    }
    default:
      // Default deny: an operator must never sign a type it cannot reason about.
      return deny(`unknown task type ${task.taskType}`);
  }
}

/** Chain reader backed by the operator's OWN RPC (injectable so the checks are testable).
 * One reader per leg — `legCfg` is that leg's own slice of OPERATOR_CONFIG.legs.
 * `cast` may be sync (returns a string) or async (returns a Promise<string>) — every call
 * site here `await`s it, so an async `cast` (e.g. non-blocking execFile) no longer stalls
 * Node's single event loop for the RPC round-trip, letting the OTHER leg's reads/requests
 * interleave instead of queuing behind a slow-but-not-dead leg. */
export function castChainReader(cast, legCfg) {
  const u = async (...a) => BigInt((await cast(...a)).split(/\s/)[0]);
  const pinnedArgs = (target, sig, args, block) => ["call", target, sig, ...args.map(String), "--block", String(block)];
  return {
    now: async () => BigInt(await cast("block", "latest", "--field", "timestamp")),
    heartbeatState: async () => {
      // Activity, armed flag and timestamp belong to the SAME block on THIS leg.
      const head = JSON.parse(await cast("block", "latest", "--json"));
      const block = BigInt(head.number), now = BigInt(head.timestamp);
      const target = legCfg.receiver ?? legCfg.executor;
      const clock = legCfg.receiver ? "lastTaskActivity()(uint64)" : "lastKeeperActivity()(uint64)";
      const lastActivity = await u(...pinnedArgs(target, clock, [], block));
      const flag = (await cast(...pinnedArgs(target, "deadMansActive()(bool)", [], block))).trim();
      if (flag !== "true" && flag !== "false") throw new Error("invalid deadMansActive response");
      return { now, lastActivity, active: flag === "true" };
    },
    blockNumber: async () => BigInt(await cast("block-number")),
    snapshotPin: async (number) => {
      const [hash, timestamp, headNumber, headTimestamp] = await Promise.all([
        cast("block", String(number), "--field", "hash"),
        u("block", String(number), "--field", "timestamp"),
        u("block-number"),
        u("block", "latest", "--field", "timestamp"),
      ]);
      const confirmedHash = await cast("block", String(number), "--field", "hash");
      return { number: BigInt(number), hash: hash.trim(), confirmedHash: confirmedHash.trim(), timestamp, headNumber, headTimestamp };
    },
    confirmSnapshotPin: async (pin) => {
      const current = (await cast("block", String(pin.number), "--field", "hash")).trim();
      if (current.toLowerCase() !== String(pin.hash).toLowerCase()) throw new Error("snapshot block reorged during read");
    },
    pinnedUintCall: async (target, sig, args, block) => u(...pinnedArgs(target, sig, args, block)),
    pinnedAddressCall: async (target, sig, args, block) => (await cast(...pinnedArgs(target, sig, args, block))).split(/\s/)[0],
    pinnedTokenDecimals: async (token, block) => u(...pinnedArgs(token, "decimals()(uint8)", [], block)),
    pinnedTokenBalance: async (token, owner, block) => u(...pinnedArgs(token, "balanceOf(address)(uint256)", [owner], block)),
    pinnedTickCumulatives: async (pool, secondsAgo, block) =>
      decodeTickCumulatives(decodeWords((await cast(...pinnedArgs(pool, "observe(uint32[])", [`[${secondsAgo},0]`], block))).trim())),
    pinnedUnbondState: async (adapter, block) => {
      const raw = await cast(...pinnedArgs(adapter, "unbondState()((uint256,uint64,uint256))", [], block));
      const f = raw.replace(/[()]/g, "").split(",").map((v) => v.trim().split(/\s/)[0]);
      if (f.length !== 3) throw new Error(`invalid unbondState from ${adapter}`);
      return { requested: BigInt(f[0]), claimableAt: BigInt(f[1]), claimable: BigInt(f[2]) };
    },
    placeableSurplus: async () => u("call", legCfg.vault, "placeableSurplus()(uint256)"),
    // For the buffer floor: the target lives in git, the TVL it is a share of is read from chain.
    totalAssets: async () => u("call", legCfg.vault, "totalAssets()(uint256)"),
    currentNAV: async () => u("call", legCfg.nav, "currentNAV()(uint256)"),
    lastNavEpoch: async () => u("call", legCfg.nav, "lastNavEpoch()(uint64)"),
    currentBatchId: async () => u("call", legCfg.queue, "currentBatchId()(uint64)"),
    quote: async (a, b, amt) => u("call", legCfg.swapAdapter, "quote(address,address,uint256)(uint256)", a, b, String(amt)),
    // Depth-aware counterpart, present only when this operator has been given a quoter of its
    // own. Null (not a spot fallback) when unconfigured, so swapFloor can apply policy rather
    // than silently degrading — the whole point is that the operator knows WHICH kind of
    // number it is bounding with.
    // Depth-aware counterpart, present only when this operator has been given a quoter of its
    // own. Null (not a spot fallback) when unconfigured, so swapFloor can apply policy rather
    // than silently degrading — the whole point is that the operator knows WHICH kind of number
    // it is bounding with. Reads only; the fee/require policy lives in swapFloor, which is the
    // one place that has `cfg` (an earlier version referenced it from here, where it is not in
    // scope, and threw on every call).
    depthQuote: async (a, b, amt) => {
      if (!legCfg.swapQuoter) return null;
      const ts = legCfg.swapTickSpacing ?? DEFAULT_TICK_SPACING;
      const raw = await cast("call", legCfg.swapQuoter, QUOTER_V2_SIG, `(${a},${b},${amt},${ts},0)`);
      return BigInt(String(raw).trim().split(/\s+/)[0]);
    },
    executorMusdBalance: async (block) => u("call", legCfg.musd, "balanceOf(address)(uint256)", legCfg.executor, ...(block === undefined ? [] : ["--block", String(block)])),
    executorMusdcBalance: async (block) => !legCfg.musdc ? 0n : u("call", legCfg.musdc, "balanceOf(address)(uint256)", legCfg.executor, ...(block === undefined ? [] : ["--block", String(block)])),
    tokenBalance: async (token, who) => u("call", token, "balanceOf(address)(uint256)", who),
    // Both reads live on the Ethereum leg; a Mezo-only leg config leaves them null and the
    // corresponding bound is simply not asserted (rather than silently passing as 0).
    venueTotalManaged: async (venueClassId) => {
      if (!legCfg.receiver) return null;
      const raw = await cast("call", legCfg.receiver, "venueClass(bytes32)((uint64,uint64,uint16,uint16,address,bool))", venueClassId);
      const adapter = raw.replace(/[()]/g, "").split(",")[4]?.trim();
      if (!adapter || /^0x0+$/.test(adapter)) return null;
      return u("call", adapter, "totalManaged()(uint256)");
    },
    unbondTicket: async (id) => {
      const raw = await cast("call", legCfg.receiver,
        "unbondTicket(uint64)((uint64,bytes32,uint256,uint64,uint64,bool))", String(id));
      // Strip cast's scientific annotations per field, never parse integers through Number.
      const f = raw.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s/)[0]);
      if (f.length !== 6 || !/^0x[0-9a-fA-F]{64}$/.test(f[1]) || !["true", "false"].includes(f[5])) {
        throw new Error("invalid unbondTicket tuple");
      }
      return { id: BigInt(f[0]), venueClassId: f[1], amount: BigInt(f[2]),
        requestedAt: BigInt(f[3]), claimableAt: BigInt(f[4]), claimed: f[5] === "true" };
    },
    batchInfo: async (id) => {
      const raw = await cast("call", legCfg.queue, "batchInfo(uint64)((uint64,uint8,uint8,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256))", String(id));
      const f = raw.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s/)[0]);
      if (f.length !== 11) throw new Error("invalid batchInfo tuple");
      // fields: (batchId, status, reason, openedAt, closedAt, eta, totalShares, closeNavRay,
      // obligation, funded, claimed) — see IWithdrawalQueue.BatchInfo.
      return { batchId: BigInt(f[0]), status: BigInt(f[1]), openedAt: BigInt(f[3]), totalShares: BigInt(f[6]), obligation: BigInt(f[8]), funded: BigInt(f[9]) };
    },
    // ---- independent-NAV recomputation reads ----
    // Mirrors aggregator.mjs's computeClearingNavRay reads exactly, driven by THIS operator's
    // own RPC instead of the aggregator's. "Missing config == 0" convention throughout, same
    // as every other optional-leg read in this file.
    mezoBufferBalance: async (block) => u("call", legCfg.musd, "balanceOf(address)(uint256)", legCfg.vault, "--block", String(block)),
    assetDecimals: async (block) => u("call", legCfg.usdc ?? legCfg.musd, "decimals()(uint8)", "--block", String(block)),
    musdcDecimals: async (block) => !legCfg.musdc ? 18n : u("call", legCfg.musdc, "decimals()(uint8)", "--block", String(block)),
    withdrawalQueueTotalReserved: async (block) => u("call", legCfg.queue, "totalReserved()(uint256)", "--block", String(block)),
    vaultTotalSupply: async (block) => u("call", legCfg.vault, "totalSupply()(uint256)", "--block", String(block)),
    ethReceiverIdle: async (block) =>
      !legCfg.usdc || !legCfg.receiver ? 0n : u("call", legCfg.usdc, "balanceOf(address)(uint256)", legCfg.receiver, "--block", String(block)),
    ethVenueManagedAndHaircut: async (venueClassId, block) => {
      if (!legCfg.receiver || !venueClassId) return { managed: 0n, pendingUnbondHaircut: 0n };
      const raw = await cast("call", legCfg.receiver, "venueClass(bytes32)((uint64,uint64,uint16,uint16,address,bool))", venueClassId, "--block", String(block));
      // Per-field `.split(/\s/)[0]` (same as batchInfo above, NOT the
      // simpler adapter-only `.split(",")[4]?.trim()` venueTotalManaged uses) -- required
      // because `cast` appends a bare "[1.23e4]"-style annotation TOKEN after a
      // large-looking number (confirmed live: navHaircutBps===10000, a 100% haircut, is
      // enough), and that annotation lands INSIDE this field's own comma-delimited segment
      // here (unlike the plain-tuple format aggregator.mjs reads, where it lands as a
      // SEPARATE whitespace token and shifts every later field -- see aggregator.mjs's
      // readEthVenueFn fix, same underlying cast behavior, different failure shape).
      const f = raw.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s/)[0]);
      const [, , , navHaircutBps, adapter, enabled] = f;
      if (enabled !== "true" || !adapter || /^0x0+$/.test(adapter)) return { managed: 0n, pendingUnbondHaircut: 0n };
      const managed = await u("call", adapter, "totalManaged()(uint256)", "--block", String(block));
      const pendingUnbond = await u("call", legCfg.receiver, "pendingUnbondTotal()(uint256)", "--block", String(block));
      const pendingUnbondHaircut = (pendingUnbond * (10_000n - BigInt(navHaircutBps))) / 10_000n;
      return { managed, pendingUnbondHaircut };
    },
  };
}

/** Build one reader per configured leg, keyed by String(chainId). */
export function multiChainReader(castFactory, cfg) {
  const chains = {};
  for (const [name, leg] of Object.entries(cfg.legs)) {
    // Pinned reads go over batched JSON-RPC; everything else keeps the cast path. Each pinned
    // read used to be a process spawn plus a fresh TLS handshake, and one canonical snapshot
    // makes ~30 of them — measured 8.1s via cast against 153ms batched for the same ten reads,
    // which is why NAV rounds were expiring before their operators had answered. The cast reader
    // stays underneath so the methods the RPC reader does not implement behave exactly as before.
    const viaCast = castChainReader(castFactory(leg.rpcUrl, leg.rpcFallbacks ?? []), leg);
    const reader = { ...viaCast, ...rpcChainReader(leg.rpcUrl, leg) };
    // Keyed by leg NAME first. Keying only by chainId silently dropped a leg whenever two shared
    // a chain — the second overwrote the first, and every reader call then ran against the wrong
    // leg's addresses (`cast call undefined placeableSurplus()`, surfaced to the aggregator as a
    // bare leg_unavailable). The chainId alias is kept for callers that still resolve that way,
    // but is deliberately NOT overwritten once set, so a collision degrades to "first leg wins"
    // instead of "last leg silently wins".
    chains[name] = reader;
    if (!(String(leg.chainId) in chains)) chains[String(leg.chainId)] = reader;
  }
  return chains;
}
