# Bridge attribution reconciler

## Second-scan bridge integrity (2026-09-22)

New deployments use caller-bound adapters, verified in the canonical ceremony. Do not install
this release on the pilot and claim the origin problem fixed: its existing public adapters have
no such restriction. The read-only pilot replay remains a historical regression, not a proof
that strangers could not have emitted their own sends on those old adapters.

Within a tick each leg uses one provider; failed/inconsistent reads rotate the whole tick to
the next provider without committing either cursor. A logs provider must serve the upper block;
observed block hashes are checked again before accounting. Incomplete confirmation/Transfer
pairs refuse the range. These checks catch lag/reorg/inconsistent evidence, **not a provider
that consistently lies or omits every trace of an event**. Endpoint integrity remains a trust
assumption. RPC attempt/time budgets still apply to each logical read.

Native lock -> adapter send pairs use exact gross amounts and the validated route's log order.
On Mezo the events are adjacent. On Ethereum, `AssetsLocked` is followed by a USDC `Transfer`
from this adapter to the L1 bridge and then `BridgeSent`; the intermediate transfer must match
token, sender, recipient, transaction, index and gross amount. This ordering is present in real
pilot receipt `0x4e8d0b3a2e1773aed6841f520df1ed324a20ec2983f437a89366f52426717913`.
Extra locks belong to foreign traffic, including in the same transaction. Arbitrary gaps are
not accepted: a missing actual lock must not borrow an earlier foreign one. Backend ordering
changes require revalidation, not dropping the range. Foreign nets use the same fee model as ours.

The fold runs on a copy, validates it and commits before adopting it in memory. Publication
failure retries the committed inventory without RPC; it never reapplies the transfers. Duplicate
log identities/sequence payloads are deduplicated if identical and rejected if conflicting.
Ethereum catch-up now also commits bounded chunks (`RECON_ETH_RANGE_MAX`, default 1500).
Lost records remain audit evidence but are excluded from outstanding-age diagnostics.
Genuine ambiguous mint windows still stop NAV: no arbitrary window deletion or sequence-only split.

### Incident procedure: rejected ranges and restart recovery

- **Candidate validation / `tick-error`:** an invalid newly folded state (including duplicate
  sequences or impossible watermarks) is discarded before either file or live accounting changes.
  The process stays alive and retries the whole range using provider rotation. The fallback is
  sticky: a healthy selected provider remains selected until it fails; list order is not automatic
  failback priority. On an unidentified cross-leg inconsistency, provider pairs are tried in turn.
  Each logical read has the budgets below, not an unlimited split/retry loop.
- **Persisted state `FATAL`:** corruption or an unsupported historical state still stops startup.
  Preserve the state, inventory, configuration and logs; stop signing and use the explicit
  backup/rebuild procedure below. Restarting indefinitely, deleting queues, or moving cursors
  forward is not recovery. Candidate retry does not make corrupt stored state trustworthy.
- **Bridge backend changed event order:** repeated pairing failures after an L1 bridge or Mezo
  precompile upgrade can be a format change, not an RPC outage. Compare the raw receipt and exact
  log order against the validated route, on an independent provider. Keep the range held; obtain
  a reviewed parser regression and historical replay before resuming. Never relax pairing or
  skip the transaction merely to reopen pricing.
- **Persistent `bridge-inbound-read-inconsistent` or ambiguous mint window:** check both providers'
  historical coverage, source sequence at the scanned Ethereum block, destination tip and balance
  residual at the Mezo cursor. Rebuild in shadow mode from the deployment blocks with finer
  ranges only if needed and with the original files backed up. Finer ranges may resolve a window;
  they do not guarantee a unique attribution. If evidence remains ambiguous, keep price-setting
  closed and escalate. Confirmed losses retain evidence and the launch write-down is 10000 bps;
  lowering the haircut or clearing flags is not an incident workaround.
- **Publication failure after commit:** the next tick republishes the already committed inventory
  without requiring RPC or folding again. A restarted process loads committed state. Verify READY
  and the published pins before resuming signing; process liveness alone is not accounting health.

Acceptance regressions in `SecondScanIntegrity` cover an invalid primary candidate, unchanged
committed files, successful fallback with exactly-once accounting, watermark rejection, and a
still-fatal corrupt stored watermark. This is fault-injected evidence, not an observed pilot incident.

## RC2 inbound recovery follow-up (2026-09-16)

Contradictory reads are held **before** fold/persist/publish: a regressing destination tip,
a positive mint residual with an unchanged tip, or a positive residual with no candidate lock
despite complete source coverage cannot advance either cursor or change the published inventory.
The next tick rereads the same range. Consistent evidence recovers automatically; a persistent
contradiction still stops accounting. This is not proof that an unexplained balance is a donation.
An old stored positive window with no sequence interval refuses startup and requires an explicit
rebuild. `InboundReadConsistency` tests both file/in-memory immutability and successful retry.

The review's synthetic unchanged-tip residual reproduced an absorbing state. Its separate claim
that an arbitrary sender can produce that residual through a bank-level mUSDC donation has not
been demonstrated on the deployed route. Ordinary ERC-20 transfers are already subtracted when
computing the native-mint residual. No unexplained window is discarded to force NAV open.

The same successful history must settle whether source locks arrive together, in several
catch-up ticks, or across restarts. Both entirely unknown and partly known Mezo mint windows
remain in `pendingIn` until they can be explained by **all** retained own and foreign locks.
Late locks are no longer discarded or compared only to other departures from the current tick.
Gross sends enter the ledger once; revisiting a window never counts them again.

Completeness matters as much as matching amounts: `sequence()` is read at the **scanned Ethereum
block**, before any fold, not at latest. For a positive residual, settlement waits until that
source counter covers the destination window. Otherwise a known 100 could be declared delivered
before a late foreign 100 makes attribution ambiguous. A missing source read holds the whole tick.
Providers must support this historical call as well as the existing historical balances/logs.
Zero residual still proves that no positive mint landed, without an exponential search.

Confirmed `lost` records remain durable and valued at zero; they are not live backlog that keeps
an otherwise resolved ambiguity latched. Unexplained windows still block pricing even when no
own departure has been discovered yet. Genuine ambiguity and the bounded-search limit remain
fail-closed. This changes neither bridge fees nor the loss policy.

The JSON shape remains v4. This is **not** permission to hot-update the pilot. Old ambiguous states
may lack mint windows that the previous code discarded; a processed non-lost row without its
window now refuses startup and names the required rebuild from deployment blocks. For a rollout
from the earlier implementation, use the explicit shadow/backup/rebuild procedure below before
signing, rather than trusting old loss/ambiguity decisions. A corrupt or unreadable existing
state file is FATAL, never an implicit empty ledger. Missing files still follow configured start
blocks. Never delete the state under a running reconciler or clear ambiguity flags by hand.

Regressions: `InboundRecovery` / `UnreadableState` in the Python suite, and
`inventory-nav.test.mjs` through the real `recomputeCanonicalNav`. Synthetic scenarios include
all interleavings of source/destination reads, late foreign locks, genuine ambiguity, loss plus
donation, >16 fully delivered transfers, pinned source-read failure and restart/persistence.
Range-end watermarks can conservatively differ with range sizes; economic totals and admission
at common final pins agree, and pre-transition pins remain refused.

## RPC failure budgets (RC2 / L21)

A logical read has one budget shared across providers and recursive `eth_getLogs` splits:
`RECON_RPC_BUDGET_SECS=60`, `RECON_RPC_MAX_ATTEMPTS=32`,
`RECON_RPC_TIMEOUT_SECS=15` per subprocess, `RECON_LOG_MAX_DEPTH=8`.
All must be positive integers. The remaining wall-clock budget caps each child timeout.
Exhaustion raises an error; no partially read tick is folded or published.
Successful historical chunks receive fresh budgets, so this is NOT a 60-second limit on a
whole rebuild. If a healthy provider needs smaller ranges, reduce `MEZO_STEP/ETH_STEP`
(or replay `--step`) instead of hiding a total provider outage with unbounded splitting.

These defaults bound a single exhausted read, not service lifetime: the supervised service
logs failures and retries on its normal poll. No transaction is sent. A stale inventory stays
subject to the existing pin/age guards; an RPC error is never a zero balance.

Writes the `bridge` section of the ownership inventory — `attributionCertain`,
`reconciledThrough.{mezo,eth}` and `inFlight` — by correlating our adapters' `BridgeSent`
departures with the incoming ERC-20 transfers that are their arrivals.

**NAV fails closed without it.** `ops/task-engine/nav-snapshot.mjs` refuses to compute NAV
unless `bridge.attributionCertain` is true and `bridge.reconciledThrough[leg]` has reached the
pinned block on BOTH legs; four places in this repo validate those fields and nothing else
writes them. Capital that is mid-bridge sits on neither chain, so the first transfer in flight
halts NAV permanently until this component is running.

```bash
python3 ops/reconciler/bridge-reconciler.py       # needs cast on PATH; loops until killed
python3 ops/reconciler/bridge-reconciler.test.py  # matching logic, no network
ADDRESSES_JSON=ops/deployments/<name>.addresses.json MEZO_RPC=… ETH_RPC=… \
  python3 ops/reconciler/replay.py                # the deployment's REAL history through tick(); read-only
```

Run it as a **supervised service (systemd, restart=always) before any capital moves**, not as a
manual step: cursors are durable, but a stopped reconciler is a stopping NAV, and the operators
have no way to distinguish "not yet reconciled" from "reconciler dead".

### Finality: three numbers, not one

| | Where | Mezo | Ethereum |
|---|---|---:|---:|
| `scanConfirmations` | `RECON_SCAN_CONF_*`, here | **0** | **5** |
| `minConfirmations` | operator config, read by the aggregator and every operator | **6** | **12** |
| `maxHealthyLagBlocks` | operator config, the drift budget between them | **4** | **6** |

The reconciler stops scanning `scanConfirmations` blocks short of latest, because its cursor only
moves forward and there is no rewind engine: a reorg that rewrites a block already folded in either
strands a departure in flight forever or double-counts an arrival, and the second one overstates
NAV. Mezo is **0** — `mezod` is a Cosmos SDK chain on CometBFT, so a committed block is final under
the consensus assumptions, and a violation of those assumptions is a chain halt or fork that no
depth of N blocks helps with either.

**Do not set `scanConfirmations` from `minConfirmations`.** They answer different questions, and
`nav-snapshot.mjs` requires `reconciledThrough >= pin` on every round. `reconciledThrough` is
*our* latest minus the scan depth; the pin is the *aggregator's* latest minus `minConfirmations`,
sampled at a different moment. Set them equal and the margin is zero, so ordinary polling drift
puts the seat behind — on five seats independently, four of which must agree. `finality_policy()`
enforces `scanConfirmations + maxHealthyLagBlocks <= minConfirmations` at startup and refuses to
run without it.

If that check ever fails, **raise `minConfirmations`** — do not lower `maxHealthyLagBlocks`. The
lag budget has to describe the polling drift the seat actually has; tuning it until the check
passes makes the invariant confirm itself.

### Raising the scan depth on a running seat

Two separate things, and an earlier version of this page conflated them into "no migration needed".

**The code needs nothing.** An existing cursor sits at latest, so on the first tick it is above the
new safe head — a wait, not a fault. `safe_scan_range` returns nothing, the loop idles, and
`reconciledThrough` keeps reporting the older and *deeper* cursor, which still satisfies the pin
rule. NAV never pauses. (Clamping the cursor down instead would rescan the skipped range and count
every arrival in it twice, which is why the cursor is left where it is.)

**The already-scanned tail still needs an operational migration.** Everything folded in under
`scanConfirmations = 0` was accepted at the tip, and the cursor does not rewind. If one of the last
few Ethereum blocks reorganises after the rollout, this reconciler has no record of the old block
hashes and cannot undo the accounting — the new depth protects what comes next, not what is already
in the state file. The exposed window is small (about `scanConfirmations` blocks, ~60s of Ethereum)
and it closes on its own, but it is real and it is not what waiting fixes.

The same rollout also seeds the v3 ambiguity flags CLEAR, and they cannot be recovered from a v2
file: before they existed an unmatched arrival was ignored and left no record. So a direction that
was already ambiguous comes back reading clean.

Both are closed by one procedure, run once, and it needs no rewind engine:

1. **stop signing** on the seat (`OPERATOR_SHADOW_ONLY=1`, restart);
2. **stop the reconciler too** — `systemctl stop ditto-operator-reconciler`. Deleting the state file
   under a running process does nothing: it holds the state in memory and writes it back on the next
   tick, so the rebuild would start from exactly what it was meant to discard;
3. **back up** `RECON_STATE` somewhere outside `/var/lib`;
4. **rebuild from the deployment blocks** with the new depth in force: remove the state file, set
   `RECON_START_MEZO` / `RECON_START_ETH` to `observedAtBlock` from
   `ops/deployments/mainnet-2026-08-11.json`, and let it replay forward. Deterministic, and it needs
   no trusted checkpoint from anyone;
5. **compare** the rebuilt inventory against the backup — `reconciledThrough`, `inFlight`, the
   delivered/sent counters. A difference is the answer to what the tail was hiding, and it is worth
   understanding before step 6 rather than after;
6. **wait for the watermark** to fall behind the pin (`ops/check-operator-ready.sh` now says so
   explicitly rather than reporting READY while every round is refused);
7. **resume signing.**

Do it seat by seat. At `n=5, m=4` one seat down still signs; two do not.

### `bridgeSafeAfter`

State schema v2 adds a per-leg watermark: the block of the last bridge state transition observed on
that leg. It closes a window `reconciledThrough` alone does not. The queue can be **empty** —
attribution certain, nothing in flight — while the NAV pin, a pin-depth in the past, falls inside a
crossing that has since **completed**. At that pin the capital had left the source and not reached
the destination, and the in-flight ledger is computed now, so nothing fills the gap: NAV comes out
low by the whole transfer, and a low NAV mints too many shares to the next depositor. A crossing
takes ~951s against a ~144s pin depth.

`nav-snapshot.mjs` refuses a pin older than the watermark, so the admissible pin is sandwiched:
`bridgeSafeAfter <= pin <= reconciledThrough`. The cost is a pause of roughly one pin-depth after
each delivery. A v1 state file is migrated by seeding the watermarks from the cursors — sound,
because anything ending after the cursor is still queued and a non-empty queue halts NAV anyway.

Configure via `RECON_*` (see the header block in the script). Each leg **must** be given
redundant RPC endpoints — `rpcFallbacks` alongside `rpc` in the addresses JSON. A single failed
`eth_getLogs` previously stalled the cursor and therefore halted NAV; the reconciler now retries
the whole range across every endpoint of that leg and bisects the range before giving up.

`RECON_TEMPLATE` must point at the **audited** ownership inventory for this deployment (mainnet:
`ops/nav-accounting-mainnet.snapshot.json`). Everything outside the `bridge` block is copied
through untouched, and the reconciler refuses to start if that template describes a different
deployment than `RECON_ADDRESSES`, or if it does not count the Mezo executor as an mUSDC owner.
An earlier version re-derived the ownership lists itself and silently shipped four fewer owners
and a zeroed haircut — understating NAV, which is the direction that dilutes existing holders.

Matching notes, all load-bearing and none of them provable on testnet:

- an arrival that matches nothing is **not** a delivery (it is a swap output or a venue
  withdrawal) and is ignored — attribution by exclusion invented arrivals twice;
- matching is **fee-tolerant per direction**. Mainnet Mezo→Ethereum deducts a flat ~3 USD
  (1,000 USDC out ≈ 997 USDC in), Ethereum→Mezo is gas-only and free, and testnet is free both
  ways — so exact matching survives the pilot and halts NAV on mainnet. The queue carries the
  expected net and matching accepts departures within `RECON_TOL_*`, which must stay strictly
  below that leg's fee (enforced at startup);
- matching is **maximum, not greedy**. Tolerance windows of two near-size departures overlap,
  and a greedy pass strands pairs an alternative assignment would have made. A stranded arrival
  is not conservative: the money is on the destination chain and counted there, so leaving its
  departure in flight makes NAV count it twice;
- a departure **at or below the leg's fee** cannot be explained by the fee model — nothing can
  arrive to match it. It is counted in `outSent`, logged as `sub-fee-departure` with the leg,
  direction, amount, tx and fee, and **not queued**. **Corrected 2026-09-10** (MixBytes scan,
  operator H1): from 2026-08-18 the zero WAS queued, and `[0]` is a non-empty queue that nothing can
  ever drain — so the first unmatched arrival while it sat there set the direction ambiguous for
  good, and the dust stopped NAV after all, one tick later. (The 2026-08-18 correction itself
  replaced an earlier revision that halted NAV immediately.) Treat the log line as a signal to check
  `RECON_FEE_*` sizing or chase the stray transfer: it means our own sizing bridged dust or the
  configured fee is wrong, and both make every other match on that leg suspect. On mainnet the
  Mezo bridge's 20 mUSDC minimum makes a sub-fee departure unreachable through our adapter;
  the minimum is Mezo's parameter, not ours, so the handling stays;
- a departure is **ours only by proven origin**. New deployments use dedicated caller-bound
  adapters; token/recipient filtering remains required. The old pilot adapters are public and
  shared: token plus recipient alone does NOT prove that their caller was the protocol. Historical
  replay tests the known pilot transfers, not immunity to additional foreign sends. Direct native
  locks remain possible and are tracked as foreign even with the new adapters.

### State schema v4: transfer records (2026-09-10)

The queues carry **records**, not amounts: `{net, block, tx}` outbound and `{net, block, tx, seq}`
inbound, where `seq` is the native `AssetsLocked` sequence joined to the departure by transaction
hash (`None` when no lock was found, which classifies as a backlog and never a haircut). Three
things needed a per-transfer identity and had none:

- **inbound classification is per entry**, against a tip read `--block <mezo cursor>` — the height
  the arrivals were folded through. One `inSeqHigh` scalar classified the whole queue by its highest
  sequence, so a newer send lifted the haircut off an older transfer the destination had already
  processed without delivering; and a tip read at latest ran ahead of the scan, so a live transfer
  whose mint sat in unscanned blocks was declared lost and haircut to zero. Inbound is now reported
  as two `inFlight` entries when both states exist: `eth->mezo` at face value and
  `eth->mezo:processed-undelivered` at the haircut;
- **a stuck transfer is visible**: `reconciled` logs `oldestOutBlock` / `oldestInBlock`;
- **a v3 file with anything outstanding is refused** — its records were never stored and cannot be
  invented. Rebuild from the deployment blocks (the procedure above). A v3 file with empty queues
  upgrades in place, flags intact. A file with no `version` but v2+ fields is refused rather than
  read as v1, because the v1 hop seeds the ambiguity flags CLEAR.

**Inbound settlement is by sequence, not FIFO by amount** (second review round, 2026-09-10). The
Mezo leg cannot see who minted — a native mint is only the balance residual, and a stranger who
bridges USDC to our executor's address produces one that looks exactly like ours — but mezod
processes `AssetsLocked` sequences strictly in order. So the reconciler reads the destination tip
at the **upper bound** of each scanned range (`tipAt` in the state carries the previous range's; a
first run needs none, since it starts from the deployment blocks before which nothing of ours could
have been locked — and a read at the block before the range needs archive state weeks back on
mainnet), and the residual over the range is settled against the sequences the tip passed inside it: ours, and every
stranger's lock to our address (`foreignIn`, read from the same `AssetsLocked` scan). The unique
subset whose amounts add up to the residual minted; the rest failed — ours are marked `lost`
(**durable**: a later tick that cannot read the tip restores nothing), a stranger's is dropped. No
unique subset retires nothing and writes nothing off: `bridge-inbound-unexplained`, and NAV closes
through the ambiguity flag while its window is unresolved. A late departure is first matched to
its retained window; only a processed departure with no mint window is classified as zero-residual
`processed-before-known`. Existing states that discarded windows require the explicit rebuild
above. Sequences pair with departures **by log order within the transaction**
(lock before BridgeSent, interleaved for several sends in one tx); a transaction whose events do
not pair is refused, not guessed at.

**Arrivals on Ethereum are Transfers FROM the L1 MezoBridge only.** Confirmed on the pilot's real
route: both deliveries (blocks 25885464 and 25891092) came from `0xF6680EA3…`, and the receiver's
other two inbound Transfers were venue withdrawals from `0x944c…` — exactly the transfers that must
never match a departure. Log queries carry their topic filters to the node (`eth_getLogs` with
`null` wildcards) and are re-checked in Python, so a node that ignores its filter cannot slip a
stranger's log through either.

The tick itself is ordered so a retry is a retry: **every chain read of a tick completes before
anything folds** (a raise or an unreadable balance leaves the state untouched — interleaved, a
read that failed after the Ethereum departures were queued counted them again on the next
pass); **departures on both legs fold before arrivals** (Mezo-first folded an eth→mezo arrival
against an empty queue whenever both halves of a crossing fell inside one tick — a first run, or a
restart after an outage longer than a crossing — and the departure then queued with nothing to
retire it); **the state is fsynced and renamed into place before the inventory is published**, and a
failed publish raises rather than logging and moving on. An unparseable `cast logs` answer is
"unreadable, rotate", never "no events"; a balance that fell further than every `Transfer` explains
holds the cursor, never "zero arrived".

### Outbound by sequence, and departures read late (2026-09-10, round 3)

The pilot's real receipts show the outbound crossing has **one identity on both chains**: on Mezo
the AssetsBridge precompile emits `AssetsUnlocked(seq, recipient, token, sender, amount, chain)` in
the same transaction as our `BridgeSent`, before it; on Ethereum the L1 MezoBridge emits
`AssetsUnlockConfirmed(seq, recipient, token, amount, chain)` before the USDC `Transfer` to the
recipient. Sequence 9345 carried 108.040261 gross on both sides, 105.040261 landed, and the
3.000000 fee is its own event. So the outbound leg now settles the way the inbound leg does:

- a departure record carries the unlock `seq` and its `gross`, paired with `BridgeSent` by log order
  (`join_sequences`, the same rule as `AssetsLocked`);
- an arrival is the bridge's confirmation joined with the `Transfer` it made to us in the same
  transaction (`join_arrivals`); a confirmation with no `Transfer` is an orphan that closes the
  direction, never an arrival;
- an arrival retires the departure with **its** sequence and nothing else. A stranger's crossing to
  our receiver through the real bridge has a different sequence. What landed is what counts; the fee
  actually paid is compared with `RECON_FEE_OUT` and reported as `bridge-fee-drift` when it differs
  beyond `RECON_TOL_OUT`. The tolerance is no longer load-bearing for matching.

`recipient` is a `bytes` topic, so the filter is keccak256 of the address bytes — a forty-line
Keccak lives in the reconciler for that one constant, tested against the standard vectors and a real
topic. **A departure read after its arrival** (one leg's endpoints lagging by more than a crossing)
is settled on read instead of being queued forever: an outbound arrival with no departure of ours is
remembered (`pendingOut`) and a mint with no known sequence is remembered by its tip window
(`pendingIn`); when the departure arrives, the ledger delivers it and moves the watermark to the
arrival's block, because between departure and arrival the money was on neither chain and nothing
knew it was in flight. The inbound subset search is bounded (`MAX_SETTLE_CANDIDATES`): beyond it a
stranger's dust locks are an ambiguity to escalate, not a `2^n` loop on the price path.

`ops/reconciler/replay.py` replays a deployment's real history through `tick()` read-only and then
**audits the ledger transfer by transfer** against the bridge's own events read back off both
chains: every sequence unlocked by our adapter settled exactly once against the bridge's
confirmation of that sequence, with the same gross on both sides and the configured fee actually
paid; every sequence locked to our executor settled exactly once. Queues empty and attribution
certain is not enough — that was true of a ledger that had settled the right totals against the
wrong transfers.

**Three corrections from the review of the first round-3 cut (2026-09-11).** A confirmed loss is a
bridge state transition too — the entry goes from priced in flight to zero — so it moves the Mezo
watermark to the range it was decided in; before that, a pin older than the decision was priced with a
write-down from the future while at that pin the money was genuinely in flight. Departures read late
are settled against their remembered mint window the way a range is: the unique subset whose amounts
add up to the residual was delivered, the rest failed; no unique subset queues them **unresolved**,
which closes NAV, and writes nothing off (an earlier revision wrote both of 100 + 200 off against a
remembered 300 with attribution still certain). And the tip alone is no longer a verdict anywhere: a
zero residual proves every processed sequence failed without a search, a non-zero residual above the
enumeration bound is an ambiguity that closes NAV, and `classify_inbound` writes down only what
`lost` marks — never "tip past the sequence, entry still queued", which had haircut transfers no
settlement had decided. The tests assert what a price-setting round could sign: the published
inventory and `nav-snapshot`'s pin admission rules, mirrored in the suite.

**One history, one answer (2026-09-11).** Seventeen fully delivered inbound crossings replayed in one
range hit the enumeration bound and closed NAV, while the same history folded tick by tick settled
every transfer. Two things fix that without touching the bound. Settlement needs no search for the two
common cases: a zero residual proves every processed sequence failed, and a residual equal to the sum
of every candidate proves every one of them minted (nets are positive, so no proper subset reaches
it) — both O(n), now shared by `settle_pending_in` for current and late departures. The common
subset helper checks uniqueness including tolerance: a zero-net candidate or a proper subset still
within tolerance must not be hidden by these shortcuts. The bound applies only when a subset search
is actually needed; tests compare the helper with exhaustive enumeration of small inputs and cover
fully delivered histories larger than the bound. And the
service never folds an unbounded Mezo range: a first run, or a restart after a long outage, catches
history up in ranges of at most `MEZO_RANGE_MAX` blocks (`RECON_MEZO_RANGE_MAX`, default 5000,
strictly positive; invalid values refuse startup)
without pausing between them, so the residual any one settlement must explain is the bridge traffic
of that span, not of the whole past. The acceptance is in the suite (`HistoryEquivalence`): the same
synthetic history restored whole, in parts, across a persist-and-reload, and in capped ranges gives
the same totals, the same transfer statuses and no unexplained entries. And
`ops/reconciler/inventory-nav.test.mjs` hands inventories the real reconciler produced to the real
`recomputeCanonicalNav`: a confirmed loss is refused before its watermark and contributes nothing at
it; a live transfer prices at the reconciled pin, adds exactly its amount, and refuses a pin one block
earlier. The same integration test prices 17 completed deliveries only in the destination balance
and rejects a large unresolved window without inventing a haircut. These tests use synthetic chain
reads; they are not an additional mainnet replay or deployment rehearsal.
