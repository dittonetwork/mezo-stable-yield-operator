// SPDX-License-Identifier: BUSL-1.1
import test from "node:test";
import assert from "node:assert/strict";

import { computeOwnershipNav, normalizeTo18 } from "./nav-estimator.mjs";
import { alignPins, recomputeCanonicalNav, pinPolicy, proposalPinNumber } from "./nav-snapshot.mjs";

test("proposal pin keeps the finality depth for a seat up to the declared lag behind", () => {
  const policy = { minConfirmations: { mezo: 6, eth: 12 },
    maxHealthyLagBlocks: { mezo: 4, eth: 6 }, maxSnapshotAgeSecs: 300 };
  for (const leg of ["mezo", "eth"]) {
    const pin = proposalPinNumber(1000n, leg, policy);
    assert.equal(1000n - BigInt(policy.maxHealthyLagBlocks[leg]) - pin,
      BigInt(policy.minConfirmations[leg]));
  }
  assert.throws(() => pinPolicy({ ...policy, maxSnapshotAgeSecs: 180 }), /age budget/);
  assert.throws(() => pinPolicy({ ...policy, maxHealthyLagBlocks: { mezo: -1, eth: 6 } }), /invalid/);
  assert.throws(() => proposalPinNumber(10n, "eth", policy), /too short/);
});
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MUSD = "0x0000000000000000000000000000000000000018";
const MUSDC = "0x0000000000000000000000000000000000000006";
const USDC = "0x00000000000000000000000000000000000000c6";
const VAULT = "0x0000000000000000000000000000000000000101";
const EXECUTOR = "0x0000000000000000000000000000000000000102";
const RECEIVER = "0x0000000000000000000000000000000000000201";
const SPARK = "0x0000000000000000000000000000000000000202";
const AAVE_OLD = "0x0000000000000000000000000000000000000203";
const WQ = "0x0000000000000000000000000000000000000302";
const retiredInventoryPath = join(
  dirname(fileURLToPath(import.meta.url)), "..", "nav-accounting-mainnet.snapshot.json",
);

const pins = {
  mezo: { number: 10n, hash: "0xaaa", confirmedHash: "0xaaa", timestamp: 1000n, headNumber: 16n, headTimestamp: 1000n },
  eth: { number: 20n, hash: "0xbbb", confirmedHash: "0xbbb", timestamp: 995n, headNumber: 32n, headTimestamp: 1000n },
};

function fixture(over = {}) {
  const balances = new Map([
    [`mezo:${MUSD}:${VAULT}`, 1_250_000_000_000_000_050n],
    [`mezo:${MUSD}:${EXECUTOR}`, 12_703_244_756_623_291_277n],
    [`mezo:${MUSDC}:${EXECUTOR}`, 0n],
    [`eth:${USDC}:${RECEIVER}`, 0n],
    [`eth:${USDC}:${SPARK}`, 0n],
    [`eth:${USDC}:${AAVE_OLD}`, 0n],
  ]);
  const uintValues = new Map([
    [`eth:${SPARK}:totalManaged()(uint256)`, 1n],
    [`eth:${AAVE_OLD}:totalManaged()(uint256)`, 0n],
    [`eth:${RECEIVER}:pendingUnbondTotal()(uint256)`, 0n],
    [`mezo:${WQ}:totalReserved()(uint256)`, 0n],
    [`mezo:${VAULT}:totalSupply()(uint256)`, 17_000_000_000_000_000_000n],
    [`mezo:${VAULT}:VIRTUAL_SHARES()(uint256)`, 1000n],
  ]);
  const states = new Map([[SPARK, { requested: 0n, claimable: 0n }], [AAVE_OLD, { requested: 0n, claimable: 0n }]]);
  Object.assign(over, { balances: over.balances ?? balances, uintValues: over.uintValues ?? uintValues, states: over.states ?? states });
  const reader = {
    tokenDecimals: async (_leg, token) => token === MUSD ? 18 : 6,
    tokenBalance: async (leg, token, owner) => over.balances.get(`${leg}:${token}:${owner}`) ?? 0n,
    uintCall: async (leg, target, sig) => over.uintValues.get(`${leg}:${target}:${sig}`) ?? 0n,
    addressCall: async (_leg, _target, sig) => sig === "executor()(address)" ? EXECUTOR : USDC,
    unbondState: async (_leg, adapter) => over.states.get(adapter) ?? { requested: 0n, claimable: 0n },
    confirmPin: async () => {},
  };
  const inventory = {
    complete: true,
    virtualShares: "1000",
    tokens: { musd: { address: MUSD }, musdc: { address: MUSDC }, usdc: { address: USDC } },
    mezo: {
      vault: VAULT, withdrawalQueue: WQ,
      musdOwners: [{ id: "mezo:vault:musd", address: VAULT }, { id: "mezo:executor:musd", address: EXECUTOR }],
      musdcOwners: [{ id: "mezo:executor:musdc", address: EXECUTOR }],
    },
    ethereum: {
      receiver: RECEIVER,
      registryMode: "audited-static",
      adaptersAuditedThrough: "20",
      usdcOwners: [{ id: "eth:receiver:usdc", address: RECEIVER }],
      adapters: [
        { id: "adapter:spark-active", address: SPARK, navHaircutBps: 0, status: "active" },
        { id: "adapter:aave-replaced", address: AAVE_OLD, navHaircutBps: 500, status: "replaced" },
      ],
    },
    bridge: {
      attributionCertain: true,
      reconciledThrough: { mezo: "10", eth: "20" },
      bridgeSafeAfter: { mezo: "0", eth: "0" },
      inFlight: [],
    },
  };
  return { reader, inventory };
}

test("second scan: required custody locations cannot silently disappear", async () => {
  for (const [leg, key, address] of [["mezo", "musdOwners", VAULT], ["mezo", "musdOwners", EXECUTOR],
    ["mezo", "musdcOwners", EXECUTOR], ["ethereum", "usdcOwners", RECEIVER]]) {
    const { reader, inventory } = fixture();
    inventory[leg][key] = inventory[leg][key].filter(owner => owner.address !== address);
    await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /required custody/);
  }
});

test("second scan: virtual shares must agree with the pinned vault", async () => {
  const { reader, inventory } = fixture();
  inventory.virtualShares = "0";
  await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /virtual shares/);
});

test("second scan: malformed decimals are not coercible integers", () => {
  for (const invalid of [null, false, "", [], 1.5]) {
    assert.throws(() => normalizeTo18(1n, invalid), /decimals/);
  }
});

test("live snapshot reproduces exact backing and NAV ray", async () => {
  const { reader, inventory } = fixture();
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n);
  assert.equal(result.navRay, 820_779_162_154_311_206_248_284_579n);
});

test("normalization is exact once: one raw USDC is 1e12 MUSD wei", () => {
  assert.equal(normalizeTo18(1n, 6, "USDC"), 1_000_000_000_000n);
  assert.equal(normalizeTo18(20_545_659n, 6, "USDC"), 20_545_659_000_000_000_000n);
  assert.throws(() => normalizeTo18(1n, 19, "ambiguous"), /unsupported or ambiguous/);
});

test("custody movement is NAV-neutral across executor, bridge, receiver, adapters, pending and return", () => {
  const locations = ["executor", "outbound-flight", "receiver", "spark", "aave-disabled", "pending", "return-flight", "executor-musdc"];
  for (const location of locations) {
    const result = computeOwnershipNav({
      inventoryComplete: true,
      bridgeAttributionCertain: true,
      assets: [{ id: location, amount: 100_000_000n, decimals: 6 }],
      liabilities: [], totalSupply: 100n * 10n ** 18n, virtualShares: 0n,
    });
    assert.equal(result.navRay, 10n ** 27n, location);
  }
});

test("per-adapter pending haircut and direct dust are counted once", async () => {
  const { reader, inventory } = fixture();
  const balances = new Map([
    [`mezo:${MUSD}:${VAULT}`, 100n * 10n ** 18n], [`mezo:${MUSD}:${EXECUTOR}`, 0n],
    [`mezo:${MUSDC}:${EXECUTOR}`, 0n], [`eth:${USDC}:${RECEIVER}`, 0n],
    [`eth:${USDC}:${SPARK}`, 10_000_001n], [`eth:${USDC}:${AAVE_OLD}`, 10_000_002n],
  ]);
  const uintValues = new Map([
    [`eth:${SPARK}:totalManaged()(uint256)`, 30_000_000n], [`eth:${AAVE_OLD}:totalManaged()(uint256)`, 40_000_000n],
    [`eth:${RECEIVER}:pendingUnbondTotal()(uint256)`, 30_000_000n],
    [`mezo:${WQ}:totalReserved()(uint256)`, 0n], [`mezo:${VAULT}:totalSupply()(uint256)`, 200n * 10n ** 18n],
    [`mezo:${VAULT}:VIRTUAL_SHARES()(uint256)`, 1000n],
  ]);
  const states = new Map([[SPARK, { requested: 0n, claimable: 10_000_000n }], [AAVE_OLD, { requested: 10_000_000n, claimable: 10_000_000n }]]);
  const rebuilt = fixture({ balances, uintValues, states });
  const result = await recomputeCanonicalNav({ reader: rebuilt.reader, pins, inventory });
  // 100 MUSD + 30 Spark managed + 10 claimable + 1 dust + 40 Aave managed
  // + (10 requested + 10 claimable)*95% + 2 dust = 199.000003 MUSD.
  assert.equal(result.netAssets, 199_000_003_000_000_000_000n);
});




test("fails closed on stale/reorged snapshots, incomplete inventory and uncertain bridge state", async () => {
  const { reader, inventory } = fixture();
  await assert.rejects(() => recomputeCanonicalNav({ reader, pins: { ...pins, eth: { ...pins.eth, confirmedHash: "0xccc" } }, inventory }), /hash changed/);
  await assert.rejects(() => recomputeCanonicalNav({ reader, pins, inventory: { ...inventory, complete: false } }), /complete=true/);
  await assert.rejects(() => recomputeCanonicalNav({
    reader,
    pins,
    inventory: {
      ...inventory,
      bridge: {
        attributionCertain: false,
        reconciledThrough: { mezo: "10", eth: "20" },
        bridgeSafeAfter: { mezo: "0", eth: "0" },
        inFlight: [inFlightEntry],
      },
    },
  }), /attribution/);
});

test("on-chain registry reconciles every adapter and values historical ticket haircut buckets", async () => {
  const { reader, inventory } = fixture();
  inventory.ethereum.registryMode = "onchain";
  delete inventory.ethereum.adaptersAuditedThrough;
  for (const adapter of inventory.ethereum.adapters) delete adapter.navHaircutBps;
  const originalUint = reader.uintCall;
  reader.uintCall = async (leg, target, sig, args) => {
    if (target === RECEIVER && sig.startsWith("adapterCount")) return 2n;
    if (target === RECEIVER && sig.startsWith("pendingUnbondTotal")) return 20_000_000n;
    if (target === RECEIVER && sig.startsWith("pendingUnbondByAdapter(address)")) return args[0] === AAVE_OLD ? 20_000_000n : 0n;
    if (target === RECEIVER && sig.startsWith("pendingHaircutCount")) return args[0] === AAVE_OLD ? 2n : 0n;
    if (target === RECEIVER && sig.startsWith("pendingHaircutAt")) return args[1] === 0n ? 0n : 500n;
    if (target === RECEIVER && sig.startsWith("pendingUnbondByAdapterAndHaircut")) return 10_000_000n;
    return originalUint(leg, target, sig, args);
  };
  reader.addressCall = async (_leg, target, sig, args) => {
    if (sig === "executor()(address)") return EXECUTOR;
    if (target === RECEIVER && sig.startsWith("adapterAt")) return args[0] === 0n ? SPARK : AAVE_OLD;
    return USDC;
  };
  reader.unbondState = async (_leg, adapter) => adapter === AAVE_OLD
    ? { requested: 20_000_000n, claimable: 0n }
    : { requested: 0n, claimable: 0n };
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.grossAssets, 33_453_245_756_623_291_327n);
  for (const adapter of inventory.ethereum.adapters) adapter.navHaircutBps = 0;
  assert.equal((await recomputeCanonicalNav({ reader, pins, inventory })).navRay, result.navRay);
  inventory.ethereum.adapters[0].navHaircutBps = 5000;
  await assert.rejects(() => recomputeCanonicalNav({ reader, pins, inventory }), /onchain.*haircut/i);
});

test("empty historical haircut buckets do not poison NAV; nonzero invalid buckets refuse", async () => {
  const { reader, inventory } = fixture();
  inventory.ethereum.registryMode = "onchain";
  inventory.ethereum.adapters = [{ id: "spark", address: SPARK }];
  const original = reader.uintCall;
  let amount = 0n;
  reader.uintCall = async (leg, target, sig, args) => {
    if (sig.startsWith("adapterCount") || sig.startsWith("pendingHaircutCount")) return 1n;
    if (sig.startsWith("pendingHaircutAt")) return 20000n;
    if (sig.startsWith("pendingUnbond")) return amount;
    return original(leg, target, sig, args);
  };
  reader.addressCall = async (_leg, _target, sig) => sig.startsWith("executor") ? EXECUTOR : sig.startsWith("adapterAt") ? SPARK : USDC;
  reader.unbondState = async () => ({ requested: amount, claimable: 0n });
  await recomputeCanonicalNav({ reader, pins, inventory });
  amount = 1n;
  await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /invalid haircut/);
});

test("rejects duplicate physical custody even when caller supplies different ids", async () => {
  const { reader, inventory } = fixture();
  inventory.mezo.musdOwners.push({ id: "same-vault-second-name", address: VAULT });
  await assert.rejects(() => recomputeCanonicalNav({ reader, pins, inventory }), /duplicate physical custody/);
});

// Regression, 2026-08-06 (found by the pilot E2E, caught live by the off-chain NAV guard).
// A funded-but-unclaimed batch's MUSD sits on the withdrawal queue with its shares already
// burned and totalReserved() already decremented, so listing the queue as an asset owner
// overstates NAV by unclaimed/supply — 1.0331 instead of 1.0 on 40 MUSD against 1210 supply.
// The shipped mainnet inventory never listed it; a hand-edited pilot inventory did.
test("REFUSES an inventory that counts the withdrawal queue as a MUSD asset owner", async () => {
  const { reader, inventory } = fixture();
  inventory.mezo.musdOwners.push({ id: "mezo:withdrawal-queue:musd", address: WQ });
  await assert.rejects(
    () => recomputeCanonicalNav({ reader, pins, inventory }),
    /withdrawal queue .* as a MUSD owner/,
  );
});

test("the shipped mainnet inventory does not list the withdrawal queue as a MUSD owner", {
  skip: !existsSync(retiredInventoryPath)
    ? "retired internal inventory is intentionally excluded from the operator distribution"
    : false,
}, () => {
  const inv = JSON.parse(readFileSync(retiredInventoryPath, "utf8"));
  const wq = String(inv.mezo.withdrawalQueue ?? "").toLowerCase();
  for (const o of inv.mezo.musdOwners ?? []) {
    assert.notEqual(String(o.address).toLowerCase(), wq, `${o.id} must not be an asset owner`);
  }
});

// External mainnet-readiness review, 2026-08-08: this file is the retired v1/v2 deployment and was
// the only mainnet inventory in the tree, so a fresh deploy would have picked it up and priced the
// wrong contracts. It stays as that deployment's audited record; the point of this test is that
// nobody can quietly re-point it at a new deployment by editing addresses in place — a fresh
// deployment gets a fresh file, generated from its deployment record.
test("the retired mainnet inventory stays labelled as retired and keeps its own addresses", {
  skip: !existsSync(retiredInventoryPath)
    ? "retired internal inventory is intentionally excluded from the operator distribution"
    : false,
}, () => {
  const inv = JSON.parse(readFileSync(retiredInventoryPath, "utf8"));
  assert.match(inv._RETIRED ?? "", /DO NOT USE FOR THE FRESH MAINNET DEPLOY/);
  assert.equal(inv._deployment, "mainnet-v2-retired-2026-07-29");
  assert.equal(inv.mezo.vault, "0xE02361773B6ab26bEEb20BcCb0De0626C213E7e0");
  assert.equal(inv.ethereum.receiver, "0x9D582abC15592Df25f95A7731d5A59804EC623b3");
});

// --- the 2026-08-12 double count -----------------------------------------------------------------
// The first real mainnet crossing produced a candidate NAV of 1.8176 (and, a tick earlier, ~9.99)
// because the in-flight ledger was a snapshot at the send block while the balances were read one
// block earlier, where the same capital was still in the vault. All five operators would have
// re-derived that number identically and signed it, so nothing downstream could have caught it.

const inFlightEntry = { id: "mezo->eth", status: "in-flight", attribution: "protocol", expectedAmount: "98931790", decimals: 6, haircutBps: 0 };

test("REFUSES when the bridge ledger is AHEAD of the pin and anything is in flight", async () => {
  const { reader, inventory } = fixture();
  // Exactly the incident: ledger at the send block, snapshot pinned one block behind it.
  inventory.bridge.reconciledThrough = { mezo: "11", eth: "20" };
  inventory.bridge.inFlight = [inFlightEntry];
  await assert.rejects(
    recomputeCanonicalNav({ reader, pins, inventory }),
    /reconciled through 11 but the snapshot is pinned at 10.*double counting/s,
  );
});

test("REFUSES on the eth leg too — the arrival side has the same failure", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "10", eth: "21" };
  inventory.bridge.inFlight = [inFlightEntry];
  await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /eth bridge ledger/);
});

test("prices normally when the ledger and the pin are the SAME instant", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "10", eth: "20" };
  inventory.bridge.inFlight = [inFlightEntry];
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  // The in-flight transfer is counted exactly once, on the asset side, scaled 6 -> 18 decimals.
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n + 98_931_790_000_000_000_000n);
});

test("an AHEAD ledger is still fine when nothing is in flight — nothing to double count", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "11", eth: "21" };
  inventory.bridge.inFlight = [];
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n);
});

test("an AHEAD ledger is fine when in-flight entries carry zero NAV value", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "11", eth: "21" };
  inventory.bridge.inFlight = [
    { ...inFlightEntry, id: "zero-dust", expectedAmount: "0" },
    { ...inFlightEntry, id: "fully-haircut", haircutBps: 10_000 },
  ];
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n);
});

test("a BEHIND ledger is refused regardless — a send before the pin would be counted zero times", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "9", eth: "20" };
  inventory.bridge.inFlight = [];
  await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /not reconciled through snapshot block 10/);
});

// --- the window an empty queue leaves open --------------------------------------------------------
// Neither of the 2026-08-30 reviews named this one. Everything above can be satisfied — attribution
// certain, nothing in flight, ledger at or past the pin — while the pin itself, a pin-depth in the
// past, sits INSIDE a crossing that has since completed. There the capital had left the source and
// not reached the destination, and the in-flight ledger is computed at `reconciledThrough`, not at
// the pin, so nothing fills the gap. NAV comes out LOW by the whole transfer, and a low NAV mints
// too many shares to the next depositor. A crossing takes ~951s against a ~144s pin depth, so the
// pin lands inside one often enough to matter.
//
// `bridgeSafeAfter` is the last bridge state transition the reconciler observed on that leg. The
// three tests below are the three positions a pin can take relative to a crossing.

test("prices normally when the pin is AFTER the last bridge transition", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.bridgeSafeAfter = { mezo: "8", eth: "18" }; // crossing closed before the pin
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n);
});

test("REFUSES when the pin falls BEFORE a completed crossing — the empty-queue undercount", async () => {
  const { reader, inventory } = fixture();
  // Sent at 9, delivered at 12, pin at 10: the queue is empty NOW and says nothing about then.
  inventory.bridge.reconciledThrough = { mezo: "12", eth: "20" };
  inventory.bridge.bridgeSafeAfter = { mezo: "12", eth: "18" };
  inventory.bridge.inFlight = [];
  await assert.rejects(
    recomputeCanonicalNav({ reader, pins, inventory }),
    /mezo snapshot is pinned at 10, before the last bridge state transition at 12.*understate NAV/s,
  );
});

test("REFUSES on the eth leg too — the delivery side has the same window", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.reconciledThrough = { mezo: "10", eth: "22" };
  inventory.bridge.bridgeSafeAfter = { mezo: "0", eth: "22" };
  inventory.bridge.inFlight = [];
  await assert.rejects(recomputeCanonicalNav({ reader, pins, inventory }), /eth snapshot is pinned at 20/);
});

test("the pin may sit exactly ON the last transition", async () => {
  const { reader, inventory } = fixture();
  inventory.bridge.bridgeSafeAfter = { mezo: "10", eth: "20" };
  const result = await recomputeCanonicalNav({ reader, pins, inventory });
  assert.equal(result.netAssets, 13_953_245_756_623_291_327n);
});

test("a reconciler too old to publish a watermark cannot price at all", async () => {
  // Fail closed rather than assume zero: a missing field is a v1 reconciler, which cannot say
  // whether the pin falls inside a closed crossing. The v1->v2 migration seeds the watermark from
  // the cursor, so this state is transient by construction — but while it lasts, no signing.
  const { reader, inventory } = fixture();
  delete inventory.bridge.bridgeSafeAfter;
  await assert.rejects(
    recomputeCanonicalNav({ reader, pins, inventory }),
    /no bridgeSafeAfter watermark.*state-v2 schema/s,
  );
});

// --- pin alignment ---------------------------------------------------------------------------
// Promised a direct test in the plan and it was not written, which is how the readiness check ended
// up predicting a pin the system never uses. The mechanism is deliberate; what was undocumented and
// untested is that it decides a leg's EFFECTIVE depth.

test("the older pin is the target and the newer leg walks back to it", () => {
  const p = {
    mezo: { number: 1000n, timestamp: 1000n, hash: "0xa" }, // ~22s old
    eth: { number: 5000n, timestamp: 900n, hash: "0xb" },   // ~144s old — the older, so the target
  };
  const out = alignPins(p, 30n, (leg, ts) => {
    assert.equal(leg, "mezo", "only the newer leg moves");
    assert.equal(ts, 900n);
    return 962n; // ~38 Mezo blocks back
  });
  assert.equal(out.mezo.number, 962n);
  assert.equal(out.mezo.alignedTo, 900n);
  assert.equal(out.eth.number, 5000n, "the target leg is untouched");
  assert.equal(out.eth.alignedTo, null);
});

test("a leg's DECLARED depth is not its effective one", () => {
  // The consequence worth stating: at minConfirmations mezo=6 the pin is nominally 6 blocks deep,
  // and after alignment against a 12-block Ethereum pin it is ~40. Anything reasoning from the
  // declared number alone — a readiness check, say — is predicting a pin no round will use.
  const p = {
    mezo: { number: 1000n, timestamp: 1000n, hash: "0xa" },
    eth: { number: 5000n, timestamp: 856n, hash: "0xb" },
  };
  const out = alignPins(p, 30n, () => 960n);
  assert.equal(1000n - out.mezo.number, 40n);
});

test("within the skew tolerance nothing moves", () => {
  const p = {
    mezo: { number: 1000n, timestamp: 1000n, hash: "0xa" },
    eth: { number: 5000n, timestamp: 980n, hash: "0xb" }, // 20s apart, inside 30
  };
  const out = alignPins(p, 30n, () => { throw new Error("must not look up a block"); });
  assert.equal(out.mezo.number, 1000n);
  assert.equal(out.eth.number, 5000n);
});

test("alignment REFUSES to walk a pin forward", () => {
  // Moving a pin toward the tip would undo the finality depth the other checks just enforced, so a
  // find-block answer above the pin is an error rather than something to clamp.
  const p = {
    mezo: { number: 1000n, timestamp: 1000n, hash: "0xa" },
    eth: { number: 5000n, timestamp: 900n, hash: "0xb" },
  };
  assert.throws(() => alignPins(p, 30n, () => 1001n), /mezo timestamp alignment exceeded finalized block/);
});
