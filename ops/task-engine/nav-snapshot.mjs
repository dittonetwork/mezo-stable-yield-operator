// SPDX-License-Identifier: BUSL-1.1
import { computeOwnershipNav, integerValue } from "./nav-estimator.mjs";
import { usdcExitRate, usdcExitImpact, usdcMarkRate } from "./usdc-valuation.mjs";

const ZERO = /^0x0+$/i;

export function pinPolicy(policy = {}) {
  const out = {
    minConfirmations: { mezo: 6, eth: 12, ...policy.minConfirmations },
    maxHealthyLagBlocks: { mezo: 0, eth: 0, ...policy.maxHealthyLagBlocks },
    maxCrossChainSkewSecs: policy.maxCrossChainSkewSecs ?? 30,
    maxSnapshotAgeSecs: policy.maxSnapshotAgeSecs ?? 180,
  };
  for (const leg of ["mezo", "eth"]) {
    for (const key of ["minConfirmations", "maxHealthyLagBlocks"]) {
      const n = out[key][leg];
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${key}.${leg}`);
    }
  }
  for (const key of ["maxCrossChainSkewSecs", "maxSnapshotAgeSecs"]) {
    if (!Number.isSafeInteger(out[key]) || out[key] < (key === "maxSnapshotAgeSecs" ? 1 : 0)) {
      throw new Error(`invalid ${key}`);
    }
  }
  // Nominal mainnet cadence is a configuration sanity check, never a substitute for
  // validating the actual timestamps. Account for alignment as well as pin depth.
  const nominalAge = Math.max(...["mezo", "eth"].map((leg) =>
    (out.minConfirmations[leg] + out.maxHealthyLagBlocks[leg]) * (leg === "eth" ? 12 : 4)));
  if (nominalAge + out.maxCrossChainSkewSecs > out.maxSnapshotAgeSecs) {
    throw new Error("pin depth + healthy lag + alignment exceeds maxSnapshotAgeSecs; configure a coherent age budget");
  }
  return out;
}

export function proposalPinNumber(head, leg, policy) {
  const p = pinPolicy(policy);
  const depth = BigInt(p.minConfirmations[leg] + p.maxHealthyLagBlocks[leg]);
  if (BigInt(head) <= depth) throw new Error(`${leg} chain is too short for configured pin depth`);
  return BigInt(head) - depth;
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value) || ZERO.test(value)) throw new Error(`${label} address is required`);
  return value;
}

function validatePins(pins, policy) {
  for (const name of ["mezo", "eth"]) {
    const pin = pins?.[name];
    if (!pin || !pin.hash || pin.number === undefined || pin.timestamp === undefined) {
      throw new Error(`${name} snapshot block number/hash/timestamp is required`);
    }
    if (pin.confirmedHash && String(pin.hash).toLowerCase() !== String(pin.confirmedHash).toLowerCase()) {
      throw new Error(`${name} snapshot block hash changed`);
    }
    if (pin.headTimestamp !== undefined && BigInt(pin.headTimestamp) - BigInt(pin.timestamp) > BigInt(policy.maxSnapshotAgeSecs)) {
      throw new Error(`${name} snapshot is stale`);
    }
    const confirmations = BigInt(pin.headNumber) - BigInt(pin.number);
    if (confirmations < BigInt(policy.minConfirmations[name])) throw new Error(`${name} snapshot lacks finality depth`);
  }
  const skew = BigInt(pins.mezo.timestamp) > BigInt(pins.eth.timestamp)
    ? BigInt(pins.mezo.timestamp) - BigInt(pins.eth.timestamp)
    : BigInt(pins.eth.timestamp) - BigInt(pins.mezo.timestamp);
  if (skew > BigInt(policy.maxCrossChainSkewSecs)) throw new Error(`cross-chain snapshot skew ${skew}s exceeds policy`);
}

/**
 * Pull the two pins onto one instant, which is what makes a cross-chain NAV a single measurement
 * rather than two readings stapled together.
 *
 * The OLDER pin is the target and the newer leg walks back to the block at that timestamp. Both
 * halves of that matter and only one of them is obvious:
 *
 *  - it is the reason `validatePins`' skew check passes at all in normal running;
 *  - and it means a leg's DECLARED depth is not its effective one. Ethereum at 12 blocks is ~144s
 *    old while Mezo at 6 is ~22s, so Ethereum is always the target and the Mezo pin is dragged back
 *    roughly forty blocks. Anything reasoning about "how deep is the Mezo pin" from minConfirmations
 *    alone gets a number the system never uses — which is exactly the mistake that produced a
 *    readiness check weaker than the round it was predicting.
 *
 * Walking a pin FORWARD is refused rather than clamped: alignment exists to make both readings at
 * least as settled as the older one, and moving a pin toward the tip would undo the finality depth
 * the other checks just enforced.
 *
 * @param findBlock (leg, timestamp) => block number at or before that timestamp on that leg.
 */
export function alignPins(pins, maxCrossChainSkewSecs, findBlock) {
  const target = BigInt(pins.mezo.timestamp) < BigInt(pins.eth.timestamp)
    ? BigInt(pins.mezo.timestamp)
    : BigInt(pins.eth.timestamp);
  const out = {};
  for (const leg of ["mezo", "eth"]) {
    const pin = pins[leg];
    if (BigInt(pin.timestamp) - target <= BigInt(maxCrossChainSkewSecs)) {
      out[leg] = { ...pin, alignedTo: null };
      continue;
    }
    const aligned = BigInt(findBlock(leg, target));
    if (aligned > BigInt(pin.number)) {
      throw new Error(`${leg} timestamp alignment exceeded finalized block`);
    }
    out[leg] = { ...pin, number: aligned, alignedTo: target };
  }
  return out;
}

/**
 * Shared accounting-height admission rule for price verification and commissioning READY.
 */
export function validateBridgePins(bridge, pins) {
  const inventory = { bridge };
  if (!inventory.bridge?.attributionCertain) throw new Error("bridge attribution must be explicitly certain");
  // The in-flight ledger is a SNAPSHOT AT `reconciledThrough`, and balances are read AT `pins`.
  // Mixing two different heights miscounts the capital in the air, in whichever direction they
  // differ, because `inFlight` and the chain balances are two views of the SAME money:
  //
  //   through > pin  -> the ledger already knows about a send that, at the pin, had not happened.
  //                     The capital is in the source balances AND in inFlight: counted TWICE.
  //   through < pin  -> a send that happened before the pin is not in the ledger yet. The capital
  //                     has left the source balances and is in no bucket at all: counted ZERO times.
  //
  // The second was already guarded. The first was not, and it is what fired on the first real
  // mainnet crossing (2026-08-12): the reconciler published `inFlight: 98.931790` with
  // reconciledThrough.mezo = 11081619, the block of the send, while the aggregator pinned at
  // head-2 = 11081618, where the vault still held the pre-swap 121 MUSD. 121 + 98.93 = 219.93,
  // against a supply of 121 -> a candidate NAV of 1.8176, and an earlier tick reached ~9.99.
  //
  // WHY CONSENSUS CANNOT SAVE US HERE, and why this must fail closed rather than warn: all five
  // operators call THIS function, over the same inventory, at the payload's pins. They would each
  // re-derive the same wrong number, agree exactly, and sign it. Exact-match verification defends
  // against a lying proposer, not against a consistent miscount. Nothing downstream would notice.
  //
  // So: when anything carrying NAV value is in the air, refuse unless the two heights are the SAME
  // instant. A refused round is a `round-error` and costs a tick; a posted 10x NAV reprices every
  // holder and the next claim drains the vault. Diagnostic entries whose amount is zero or whose
  // haircut is 100% carry no NAV value, so a height mismatch cannot double-count them.
  //
  // The liveness cost is real and deliberate: through a crossing the heights rarely coincide, so
  // NAV declines to price until the transfer is delivered and reconciled, which blocks a batch
  // close for that window. Removing that cost needs per-transfer block stamps (`sentAtBlock` /
  // `deliveredAtBlock`) so each transfer's bucket is decidable at any pin; until the reconciler
  // emits them there is nothing here to decide it with, and guessing is the bug.
  const inFlight = inventory.bridge.inFlight ?? [];
  const valuedInFlight = inFlight.filter((transfer) =>
    integerValue(transfer.expectedAmount, "in-flight amount") !== 0n && integerValue(transfer.haircutBps ?? 0, "in-flight haircut") !== 10_000n
  );
  for (const leg of ["mezo", "eth"]) {
    const through = inventory.bridge.reconciledThrough?.[leg];
    if (through === undefined || BigInt(through) < BigInt(pins[leg].number)) {
      throw new Error(`${leg} bridge events are not reconciled through snapshot block ${pins[leg].number}`);
    }
    // The OTHER side of the sandwich: bridgeSafeAfter <= pin <= reconciledThrough.
    //
    // `through >= pin` alone leaves a window that neither 2026-08-30 review named. The queue can
    // be EMPTY — attribution certain, `inFlight` empty, everything above satisfied — while the
    // pin, which sits a pin-depth in the past, falls INSIDE a crossing that has since completed.
    // At that pin the capital had left the source chain and had not yet reached the destination,
    // and the in-flight ledger is computed at `reconciledThrough`, not at the pin, so it has
    // nothing to put in the gap. NAV comes out LOW by the whole transfer, and a low NAV mints too
    // many shares to whoever deposits next — the direction that dilutes existing holders.
    //
    // Reachable, not theoretical: a crossing takes ~951s and the Ethereum pin sits ~144s back.
    // `bridgeSafeAfter` is the last bridge state transition the reconciler observed on this leg,
    // so refusing a pin older than it puts the pin outside every flight interval that has closed.
    // The cost is a pause of roughly one pin-depth after each delivery, which is bounded and
    // visible, unlike the miscount it replaces.
    const safeAfter = inventory.bridge.bridgeSafeAfter?.[leg];
    if (safeAfter === undefined) {
      throw new Error(
        `${leg} bridge ledger has no bridgeSafeAfter watermark; the reconciler predates the `
        + "state-v2 schema and cannot say whether the snapshot block falls inside a completed crossing",
      );
    }
    if (BigInt(safeAfter) > BigInt(pins[leg].number)) {
      throw new Error(
        `${leg} snapshot is pinned at ${pins[leg].number}, before the last bridge state transition `
        + `at ${safeAfter}; the pin may fall inside a crossing that has since completed, which `
        + "would understate NAV by the transfer",
      );
    }
    if (valuedInFlight.length > 0 && BigInt(through) !== BigInt(pins[leg].number)) {
      throw new Error(
        `${leg} bridge ledger is reconciled through ${through} but the snapshot is pinned at `
        + `${pins[leg].number}; ${valuedInFlight.length} valued transfer(s) in flight cannot be attributed to one `
        + "height without double counting",
      );
    }
  }

}

/**
 * Value every custody location at pinned blocks, never at latest.
 *
 * `valuation` (usdc-valuation.mjs valuationFromPolicy) values USDC-family assets at the pool's
 * time-weighted exit rate into MUSD, refusing when the pool is out of band or recently moved. The
 * aggregator and every operator pass it; omitting it keeps the old 1:1 convention, which only
 * tests and offline tooling still rely on.
 */
export async function recomputeCanonicalNav({ reader, pins, inventory, policy = {}, valuation }) {
  const p = {
    maxSnapshotAgeSecs: policy.maxSnapshotAgeSecs ?? 180,
    maxCrossChainSkewSecs: policy.maxCrossChainSkewSecs ?? 30,
    minConfirmations: {
      mezo: policy.minConfirmations?.mezo ?? 6,
      eth: policy.minConfirmations?.eth ?? 12,
    },
  };
  validatePins(pins, p);
  if (!inventory?.complete) throw new Error("NAV inventory complete=true is required");
  validateBridgePins(inventory.bridge, pins);
  const tokens = inventory.tokens ?? {};
  const musd = requireAddress(tokens.musd?.address, "MUSD");
  const musdc = requireAddress(tokens.musdc?.address, "mUSDC");
  const usdc = requireAddress(tokens.usdc?.address, "USDC");
  const tokenSpecs = [
    ["mezo", musd, 18, pins.mezo.number, "MUSD"],
    ["mezo", musdc, 6, pins.mezo.number, "mUSDC"],
    ["eth", usdc, 6, pins.eth.number, "USDC"],
  ];
  for (const [leg, token, expected, block, label] of tokenSpecs) {
    const actual = Number(integerValue(await reader.tokenDecimals(leg, token, block), `${label} decimals`));
    if (actual !== expected) throw new Error(`${label} decimals ${actual}, expected ${expected}`);
  }

  // The template must at least contain the live custody core. Extra historical owners
  // remain allowed; this is not a current-adapter-only inventory restriction.
  const vault = requireAddress(inventory.mezo?.vault, "vault");
  const executor = requireAddress(await reader.addressCall("mezo", vault, "executor()(address)", [], pins.mezo.number), "executor");
  for (const [owners, address, label] of [
    [inventory.mezo?.musdOwners, vault, "vault MUSD"],
    [inventory.mezo?.musdOwners, executor, "executor MUSD"],
    [inventory.mezo?.musdcOwners, executor, "executor mUSDC"],
    [inventory.ethereum?.usdcOwners, inventory.ethereum?.receiver, "receiver USDC"],
  ]) {
    if (!Array.isArray(owners) || !owners.some(owner => String(owner.address).toLowerCase() === String(address).toLowerCase())) {
      throw new Error(`missing required custody: ${label}`);
    }
  }
  const virtualShares = integerValue(await reader.uintCall("mezo", vault, "VIRTUAL_SHARES()(uint256)", [], pins.mezo.number), "vault virtual shares");
  if (virtualShares < 0n || virtualShares !== integerValue(inventory.virtualShares, "inventory virtual shares")) {
    throw new Error("inventory virtual shares disagree with pinned vault");
  }

  const usdcRate = valuation
    ? await usdcExitRate({ reader, ...valuation, musd, musdc, block: pins.mezo.number })
    : null;

  const assets = [];
  const physicalLocations = new Set();
  const addBalances = async (leg, token, decimals, owners, block, usdc) => {
    for (const owner of owners ?? []) {
      requireAddress(owner.address, owner.id);
      const physical = `${leg}:${token.toLowerCase()}:${owner.address.toLowerCase()}`;
      if (physicalLocations.has(physical)) throw new Error(`duplicate physical custody location ${physical}`);
      physicalLocations.add(physical);
      assets.push({ id: owner.id, amount: await reader.tokenBalance(leg, token, owner.address, block), decimals, usdc });
    }
  };
  // The withdrawal queue is NEVER a MUSD asset owner, and listing it silently overstates NAV.
  // Everything it holds is one of two things: reserved for a closed-but-unfunded batch, which
  // is ALREADY on the liability side as `liability:withdraw-reserved` (totalReserved()); or
  // funded and waiting to be claimed, whose shares were burned at close while totalReserved
  // decremented as the tranche landed — so it backs nobody and is owed to a claimant.
  //
  // Counting it as an asset inflates NAV by unclaimed/supply for as long as anyone delays a
  // claim: on the pilot, 40 MUSD of stale claim against 1210 supply marked NAV at 1.0331
  // instead of 1.0. The off-chain guard caught it and refused to post, which is a stall, not a
  // fix. The shipped mainnet inventory has always been correct — this was a pilot-only
  // misconfiguration — so the point of failing loudly here is that it cannot be reintroduced
  // by hand-editing an inventory for a new deployment.
  const wq = inventory.mezo?.withdrawalQueue;
  if (wq) {
    for (const owner of inventory.mezo?.musdOwners ?? []) {
      if (String(owner.address).toLowerCase() === String(wq).toLowerCase()) {
        throw new Error(
          `inventory lists the withdrawal queue (${owner.id}) as a MUSD owner: its balance is `
          + `either already counted as liability:withdraw-reserved or owed to a claimant, so `
          + `counting it as an asset overstates NAV by the unclaimed amount`,
        );
      }
    }
  }
  await addBalances("mezo", musd, 18, inventory.mezo?.musdOwners, pins.mezo.number, false);
  await addBalances("mezo", musdc, 6, inventory.mezo?.musdcOwners, pins.mezo.number, true);
  await addBalances("eth", usdc, 6, inventory.ethereum?.usdcOwners, pins.eth.number, true);

  // The `asset:withdraw-advance` term that used to live here is gone with NET_CLEAR (2026-08-08).
  // It corrected for a batch whose shares were paid for but not yet burned, which only happened
  // because advance-funding paid before the close. `fix_batch` now always closes first, so the case
  // cannot arise: a batch is either open and unfunded, or closed with its obligation reserved.
  for (const location of inventory.requireZero ?? []) {
    const token = tokens[location.token]?.address;
    const block = pins[location.leg]?.number;
    requireAddress(token, location.token);
    const amount = BigInt(await reader.tokenBalance(location.leg, token, location.address, block));
    if (amount !== 0n) throw new Error(`${location.id}: nonzero balance has ambiguous ownership (${amount})`);
  }

  const receiver = requireAddress(inventory.ethereum?.receiver, "BridgeReceiver");
  let adapterPending = 0n;
  const adapterAddresses = new Set();
  const registryMode = inventory.ethereum?.registryMode;
  if (registryMode === "onchain") {
    const count = BigInt(await reader.uintCall("eth", receiver, "adapterCount()(uint256)", [], pins.eth.number));
    const registered = new Set();
    for (let i = 0n; i < count; i++) {
      registered.add(String(await reader.addressCall("eth", receiver, "adapterAt(uint256)(address)", [i], pins.eth.number)).toLowerCase());
    }
    const configured = new Set((inventory.ethereum.adapters ?? []).map((adapter) => String(adapter.address).toLowerCase()));
    if (registered.size !== configured.size || [...registered].some((address) => !configured.has(address))) {
      throw new Error("configured adapter inventory does not match BridgeReceiver registry");
    }
  } else if (registryMode === "audited-static") {
    if (BigInt(inventory.ethereum.adaptersAuditedThrough ?? 0) < BigInt(pins.eth.number)) {
      throw new Error("static historical adapter inventory is stale");
    }
  } else {
    throw new Error("adapter inventory registryMode must be onchain or audited-static");
  }
  for (const adapter of inventory.ethereum?.adapters ?? []) {
    const address = requireAddress(adapter.address, adapter.id);
    const key = address.toLowerCase();
    if (adapterAddresses.has(key)) throw new Error(`duplicate adapter ${address}`);
    adapterAddresses.add(key);
    const physical = `eth:${usdc.toLowerCase()}:${key}`;
    if (physicalLocations.has(physical)) throw new Error(`${adapter.id}: adapter underlying is already an owned-balance location`);
    physicalLocations.add(physical);
    const asset = await reader.addressCall("eth", address, "asset()(address)", [], pins.eth.number);
    if (String(asset).toLowerCase() !== usdc.toLowerCase()) throw new Error(`${adapter.id}: adapter asset is not configured USDC`);
    const managed = await reader.uintCall("eth", address, "totalManaged()(uint256)", [], pins.eth.number);
    const state = await reader.unbondState("eth", address, pins.eth.number);
    const requested = BigInt(state.requested);
    const claimable = BigInt(state.claimable);
    const direct = BigInt(await reader.tokenBalance("eth", usdc, address, pins.eth.number));
    if (direct < claimable) throw new Error(`${adapter.id}: direct underlying below reported claimable`);
    assets.push({ id: `${adapter.id}:managed`, amount: managed, decimals: 6, usdc: true });
    if (registryMode === "onchain") {
      // Only historical ticket buckets on the receiver price pending unbonds in this mode.
      // Accept the old generated zero placeholder, but refuse an attempted local override.
      if (adapter.navHaircutBps != null && BigInt(adapter.navHaircutBps) !== 0n) {
        throw new Error(`${adapter.id}: onchain mode does not accept a local haircut; omit navHaircutBps or use 0`);
      }
      const receiverPendingForAdapter = BigInt(await reader.uintCall(
        "eth", receiver, "pendingUnbondByAdapter(address)(uint256)", [address], pins.eth.number,
      ));
      if (receiverPendingForAdapter !== requested + claimable) {
        throw new Error(`${adapter.id}: receiver pending-by-adapter does not match adapter state`);
      }
      const haircutCount = BigInt(await reader.uintCall(
        "eth", receiver, "pendingHaircutCount(address)(uint256)", [address], pins.eth.number,
      ));
      let haircutPending = 0n;
      for (let i = 0n; i < haircutCount; i++) {
        const ticketHaircut = BigInt(await reader.uintCall(
          "eth", receiver, "pendingHaircutAt(address,uint256)(uint16)", [address, i], pins.eth.number,
        ));
        const amount = BigInt(await reader.uintCall(
          "eth", receiver, "pendingUnbondByAdapterAndHaircut(address,uint16)(uint256)",
          [address, ticketHaircut], pins.eth.number,
        ));
        if (amount !== 0n) assets.push({ id: `${adapter.id}:pending:${ticketHaircut}`, amount, decimals: 6, haircutBps: ticketHaircut, usdc: true });
        haircutPending += amount;
      }
      if (haircutPending !== receiverPendingForAdapter) throw new Error(`${adapter.id}: pending haircut buckets do not reconcile`);
    } else {
      const haircutBps = BigInt(adapter.navHaircutBps);
      assets.push({ id: `${adapter.id}:requested`, amount: requested, decimals: 6, haircutBps, usdc: true });
      assets.push({ id: `${adapter.id}:claimable`, amount: claimable, decimals: 6, haircutBps, usdc: true });
    }
    assets.push({ id: `${adapter.id}:underlying-dust`, amount: direct - claimable, decimals: 6, usdc: true });
    adapterPending += requested + claimable;
  }

  const receiverPending = BigInt(await reader.uintCall("eth", receiver, "pendingUnbondTotal()(uint256)", [], pins.eth.number));
  if (receiverPending !== adapterPending) {
    throw new Error(`receiver pendingUnbondTotal ${receiverPending} != adapter inventory pending ${adapterPending}`);
  }

  for (const transfer of inventory.bridge.inFlight ?? []) {
    if (transfer.status !== "in-flight" || transfer.attribution !== "protocol") {
      throw new Error(`${transfer.id}: unresolved bridge transfer state`);
    }
    // Only mUSDC/USDC cross the native bridge (MUSD is not bridgeable there), so a transfer in
    // the air is USDC-family; anything else would be an inventory this code does not understand.
    if (Number(transfer.decimals) !== 6) throw new Error(`${transfer.id}: in-flight transfer is not a 6-decimal USDC-family amount`);
    assets.push({
      id: `bridge:${transfer.id}`,
      amount: transfer.expectedAmount,
      decimals: transfer.decimals,
      haircutBps: transfer.haircutBps ?? 0,
      usdc: true,
    });
  }

  const mq = inventory.mezo;
  const liabilities = [
    { id: "liability:withdraw-reserved", amount: await reader.uintCall("mezo", mq.withdrawalQueue, "totalReserved()(uint256)", [], pins.mezo.number), decimals: 18 },
  ];
  const totalSupply = await reader.uintCall("mezo", mq.vault, "totalSupply()(uint256)", [], pins.mezo.number);
  // The whole USDC position, quoted at the pinned block, and the mark it sets (usdcMarkRate).
  const usdcExit = usdcRate
    ? await usdcExitImpact({
        reader, quoter: valuation.quoter, musd, musdc, block: pins.mezo.number, tickSpacing: usdcRate.tickSpacing,
        amount: assets.filter((a) => a.usdc).reduce((sum, a) => sum + BigInt(a.amount), 0n), rate: usdcRate,
      })
    : null;
  const usdcMark = usdcExit
    ? usdcMarkRate({ rate: usdcRate, amount: usdcExit.amount, quotedOut: usdcExit.quotedOut, maxImpactBps: valuation.maxLiquidationImpactBps })
    : null;
  const snapshot = {
    inventoryComplete: true,
    bridgeAttributionCertain: true,
    assets,
    liabilities,
    totalSupply,
    virtualShares,
    usdcRate: usdcMark,
  };
  const result = { ...computeOwnershipNav(snapshot), snapshot, pins, usdcRate, usdcExit, usdcMark };
  await Promise.all([reader.confirmPin("mezo", pins.mezo), reader.confirmPin("eth", pins.eth)]);
  return result;
}
