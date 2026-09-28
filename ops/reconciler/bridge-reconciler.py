#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Two-chain bridge NAV attribution reconciler — FIFO correlation.

NAV cannot be computed at all without this. `ops/task-engine/nav-snapshot.mjs` refuses to build
a proposal unless the ownership inventory declares `bridge.attributionCertain` AND
`bridge.reconciledThrough[leg]` has reached the pinned block on BOTH legs; four places in this
repo validate those fields and nothing else writes them. Capital that is mid-bridge exists on
neither chain, so without a writer NAV fails closed the moment the first transfer is in flight.

Attribution by EXCLUSION was wrong twice (mints, then a router's pool), and both times it
failed in the unsafe direction: it invented arrivals that never happened, which would let NAV
count in-flight capital as delivered. Enumerating every legitimate sender to a protocol
address is not a property you can hold true as the deployment changes.

FIFO instead, which is what real bridge indexers do:

  * departures are unambiguous -- our own adapters emit BridgeSent, with the purpose tag bound
    into transferId for exactly this reason.
  * an arrival is any incoming transfer to the destination protocol address. It CONSUMES the
    oldest outstanding departure of the matching amount, and only one we have already observed.
  * an arrival matching nothing is not a delivery. It is a swap output, a venue withdrawal, or
    something else entirely -- and it is ignored rather than guessed at.

Matching is fee-tolerant PER DIRECTION, and that is not a testnet-observable requirement.
Testnet charges zero on both legs (measured: 123.806719 mUSDC out arrived as 123.806719 USDC),
so exact-amount matching held through the whole pilot. Mainnet's native bridge deducts a FLAT
fee of ~3 USD equivalent on Mezo->Ethereum (docs: withdrawing 1,000 USDC pays a 3 dollar flat
fee and receives ~997 USDC) while Ethereum->Mezo is gas-only and free. Under exact matching a
1,000 departure arriving as 997 matches NOTHING, every transfer sits permanently in flight and
NAV halts — unreachable on testnet, so it is closed by construction here: the queue carries the
EXPECTED NET and an arrival matches within a configured per-direction tolerance of it.

FAILING TO MATCH IS NOT SAFE IN EITHER DIRECTION, and an earlier draft of this file claimed it
was. `nav-snapshot.mjs` pushes every `inFlight` entry onto the ASSET side, and the destination
address is itself a counted owner in the same inventory. So a real arrival we fail to match is
counted TWICE — once as the balance that just landed, once as a transfer still in the air — and
NAV is overstated by the transfer. (The opposite error, matching something that did not arrive,
understates nothing and overstates nothing only because the balance is not there yet; it too is
wrong.) Neither side of a mismatch is conservative, which is why matching maximises the number
of arrivals paired rather than settling for a greedy pass, and why anything the fee model cannot
explain sets `attributionCertain` false and stops NAV instead of guessing.

This file authors ONLY the `bridge` block of the ownership inventory. Ownership — which
addresses hold protocol funds, and at what haircut — comes from an audited template
(`RECON_TEMPLATE`, e.g. ops/nav-accounting-mainnet.snapshot.json) and is copied through
untouched. Re-deriving that list here is how a reconciler silently drops an owner and understates
NAV; the template is reviewed, this process is not.

Run as a SUPERVISED service (see README.md) before any capital moves. Needs `cast` on PATH.
"""
import copy, json, os, subprocess, sys, time
from contextvars import ContextVar
from functools import wraps

# Overrides so the same reconciler serves the testnet pilot and mainnet. Amounts are in mUSDC/
# USDC base units (6 decimals).
#   RECON_ADDRESSES  deployed-addresses JSON (per-leg rpc, rpcFallbacks, chainId, contracts)
#   RECON_TEMPLATE   AUDITED ownership inventory; everything but `bridge` is copied verbatim
#   RECON_INVENTORY / RECON_MIRROR  ownership-inventory outputs consumed by the operators
#   RECON_STATE      durable cursors + in-flight queues
#   RECON_FEE_OUT / RECON_TOL_OUT   Mezo->Ethereum flat bridge fee and match tolerance
#   RECON_FEE_IN  / RECON_TOL_IN    Ethereum->Mezo (free leg: exact match)
#   RECON_START_MEZO / RECON_START_ETH  FIRST-RUN start blocks. Set these on a seat that has never
#                    run -- the default lookback is for recovering a lost state file, not for
#                    bootstrapping, and it silently misses anything older. See load().
ADDRESSES = os.getenv("RECON_ADDRESSES", "/opt/mezo-xchain/addresses.json")
TEMPLATE = os.getenv("RECON_TEMPLATE", "/etc/ditto-xchain/nav-accounting.template.json")
INVENTORY = os.getenv("RECON_INVENTORY", "/etc/ditto-xchain/nav-accounting-xchain.snapshot.json")
# Retired cross-chain-testnet default, kept only so an import does not fail. Every deployment
# sets this explicitly (compose.yaml / reconciler.env), and it must point at the WRITTEN
# inventory, not the audited template.
MIRROR = os.getenv("RECON_MIRROR", "/var/lib/ditto-operator/nav-inventory.json")
STATE = os.getenv("RECON_STATE", "/var/lib/ditto-xchain/fifo-cursors.json")
# The operator config, read ONLY for its finality policy: minConfirmations is the depth the
# aggregator pins a canonical NAV at and every operator re-checks, so taking it from there rather
# than duplicating it here is what keeps the two halves from drifting apart.
OPERATOR_CONFIG = os.getenv(
    "RECON_OPERATOR_CONFIG", os.getenv("OPERATOR_CONFIG", "/etc/ditto-operator/operator-config.json")
)
# How far behind LATEST this reconciler stops scanning. A DIFFERENT question from minConfirmations,
# and conflating the two is the defect in the distribution's PR #2:
#
#   scanConfirmations  how far back the cursor stops, so a reorg cannot rewrite blocks already
#                      folded in -- the cursor only moves forward and there is no rewind engine.
#   minConfirmations   how far back the aggregator PINS a canonical NAV read.
#
# nav-snapshot.mjs requires reconciledThrough >= pin, ALWAYS. reconciledThrough is
# (our latest - scanConfirmations) and the pin is (the aggregator's latest - minConfirmations),
# sampled at different moments; setting both to the same number collapses the margin to zero, and
# since we poll every POLL seconds while the aggregator reads head at proposal time, we are behind
# more often than not. Five independent seats each rolling that die, four of which must pass, is a
# price-setting path that mostly fails. finality_policy() below refuses to start without a margin.
#
# Mezo is 0 because mezod is a Cosmos SDK chain on CometBFT: a committed block is final under the
# consensus assumptions, and a violation of those assumptions is a chain halt or fork, which no
# depth of N blocks helps with either. Ethereum's finality is probabilistic and 1-2 block reorgs
# are ordinary, so 5 covers them with room to spare.
SCAN_CONF = {
    "mezo": int(os.getenv("RECON_SCAN_CONF_MEZO", "0")),
    "eth": int(os.getenv("RECON_SCAN_CONF_ETH", "5")),
}
# v2 added safeAfter (bridge watermarks); v3 the per-direction ambiguity flag; v4 turned the
# queues from bare amounts into transfer RECORDS -- {net, block, tx} and, inbound, the native
# AssetsLocked `seq` -- so a transfer can be classified, traced and aged on its own. A v3 file with
# anything outstanding cannot be upgraded (the records were never stored) and is refused; see
# migrate().
STATE_VERSION = 4
# Tolerated so the matching logic can be imported (and tested) off a host that has no
# deployment config; main() cannot run without it and will fail loudly on the missing keys.
A = json.load(open(ADDRESSES)) if os.path.exists(ADDRESSES) else {"mezo": {}, "eth": {}}
MEZO, ETH = A["mezo"], A["eth"]
OUT, IN = "mezo->eth", "eth->mezo"
# Tolerance must stay BELOW the fee: it absorbs drift in the ~3 USD equivalent as the peg
# moves, and keeping it under the fee is what makes a sub-fee departure (expected net negative)
# unmatchable rather than matched by dust.
FEES = {
    OUT: {"fee": int(os.getenv("RECON_FEE_OUT", "3000000")), "tol": int(os.getenv("RECON_TOL_OUT", "500000"))},
    IN: {"fee": int(os.getenv("RECON_FEE_IN", "0")), "tol": int(os.getenv("RECON_TOL_IN", "0"))},
}
for _d, _c in FEES.items():
    # A free leg is exact-match by definition — a tolerance there would let an arbitrary nearby
    # transfer consume a departure. On a fee-bearing leg the tolerance absorbs drift in the ~3 USD
    # equivalent as the peg moves, and holding it strictly under the fee is what keeps the two
    # windows apart. Checked at import so a bad RECON_TOL_* dies at startup, not mid-reconcile.
    if _c["fee"] < 0 or _c["tol"] < 0 or _c["tol"] >= max(_c["fee"], 1):
        raise SystemExit(
            "reconciler config: %s tolerance %d must be >= 0 and strictly below the fee %d "
            "(a zero-fee leg must have zero tolerance)" % (_d, _c["tol"], _c["fee"])
        )
BRIDGE_SENT = "0x9396795510cf61beb3c9cb848d28d510c6fad5cd9e29b1ac225f6a1dd9221730"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# AssetsLocked(uint256 seq, address recipient, address token, uint256 amount) on the L1 MezoBridge.
# All three leading fields are indexed: topic1 = sequence, topic2 = recipient, topic3 = token.
# Verified against the real stalled transfer (Sepolia block 11438368): topic1 0x53e3 = 21475,
# topic2 = our Mezo executor, topic3 = Sepolia USDC, data = 82537813.
ASSETS_LOCKED = "0x75aa5616721471b8ab0c49ce59500cbad2b7ef1ad10e5eb9449c693c0a5c8fd1"
# The OUTBOUND crossing's identity, read off the pilot's real receipts (sequence 9345, 2026-09):
#   Mezo, the AssetsBridge precompile, same tx as our BridgeSent (log 12, BridgeSent 13):
#     AssetsUnlocked(uint256 indexed seq, bytes indexed recipient, address indexed token,
#                    address sender, uint256 amount, uint8 chain)
#   Ethereum, the L1 MezoBridge, before the USDC Transfer to the recipient (log 426, Transfer 429):
#     AssetsUnlockConfirmed(uint256 indexed seq, bytes indexed recipient, address indexed token,
#                           uint256 amount, uint8 chain)
# `recipient` is a `bytes` topic, so it is keccak256 of the 20 address bytes (recipient_topic);
# `token` is the L1 token on both sides; `amount` is GROSS -- the flat fee is its own event.
MEZO_ASSETS_UNLOCKED = "0x018e20d97c5c8ad507a796cdc5eadfee3d30de1fa9b13231094211f18134e7c8"
L1_UNLOCK_CONFIRMED = "0xf3c1d15f8136332d14fce7c55a0179e59c44cb75d928d363b05cb22a1c36e9fd"
# The inbound settlement enumerates subsets of the sequences the tip passed inside one range. A
# stranger can lock as many dust transfers to our address as they like, so the search is bounded:
# above this it is an ambiguity, reported and left for a human, never a 2^n loop on the price path.
MAX_SETTLE_CANDIDATES = 16
# The most Mezo blocks one tick folds. A first run (or a restart after a long outage) catches
# history up in ranges of at most this many blocks, so the residual any one settlement must
# explain is the bridge traffic of that span, not of the whole past -- and a history settles the
# same way whether it is restored whole, in parts, or after a restart. main() does not sleep
# between ticks while the cursor is still behind the safe head.
try:
    MEZO_RANGE_MAX = int(os.getenv("RECON_MEZO_RANGE_MAX", "5000"))
    if MEZO_RANGE_MAX <= 0:
        raise ValueError
except ValueError:
    raise SystemExit("reconciler config: RECON_MEZO_RANGE_MAX must be a positive integer")
try:
    ETH_RANGE_MAX = int(os.getenv("RECON_ETH_RANGE_MAX", "1500"))
    if ETH_RANGE_MAX <= 0:
        raise ValueError
except ValueError:
    raise SystemExit("reconciler config: RECON_ETH_RANGE_MAX must be a positive integer")
# Haircut applied to an inbound transfer once the destination has PROCESSED its sequence without
# the balance arriving. Default 10000 bps = valued at zero, because at that point it is not late:
# mezod's AcceptAssetsLocked logs a failed mint, advances the tip and never reprocesses, so the
# funds are locked on L1 behind an interface with no claim, retry or cancel entrypoint. Carrying
# them at face value overstates NAV indefinitely and lets withdrawals settle against them.
UNDELIVERED_HAIRCUT_BPS = int(os.getenv("RECON_UNDELIVERED_HAIRCUT_BPS", "10000"))
if not 0 <= UNDELIVERED_HAIRCUT_BPS <= 10000:
    raise SystemExit("reconciler config: RECON_UNDELIVERED_HAIRCUT_BPS must be 0..10000")
POLL, MEZO_STEP, ETH_STEP = 12, 5000, 150


def _positive_rpc_setting(name, default):
    try:
        value = int(os.getenv(name, str(default)))
        if value > 0:
            return value
    except ValueError:
        pass
    raise SystemExit("reconciler config: %s must be a positive integer" % name)


RPC_BUDGET_SECS = _positive_rpc_setting("RECON_RPC_BUDGET_SECS", 60)
RPC_MAX_ATTEMPTS = _positive_rpc_setting("RECON_RPC_MAX_ATTEMPTS", 32)
RPC_TIMEOUT_SECS = _positive_rpc_setting("RECON_RPC_TIMEOUT_SECS", 15)
LOG_MAX_DEPTH = _positive_rpc_setting("RECON_LOG_MAX_DEPTH", 8)
_rpc_budget = ContextVar("reconciler_rpc_budget", default=None)
_read_view = ContextVar("reconciler_read_view", default=None)
_provider_offset = {}


def consistent_tick(fn):
    """Never splice one leg from different providers. On failure retry the WHOLE tick on
    the next provider, with old cursors. Tests replacing chain readers do not need RPCs."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        views = {}
        token = _read_view.set(views)
        try:
            return fn(*args, **kwargs)
        except Exception:
            failed = [key for key, view in views.items() if view.get("failed")]
            # Keep a healthy leg's provider. Rotating both legs together can alternate
            # (healthy, failed) and (failed, healthy) forever without trying the good pair.
            for key in failed:
                _provider_offset[key] = (_provider_offset.get(key, 0) + 1) % len(key)
            if not failed:
                # Cross-leg inconsistency has no identified faulty provider. Enumerate
                # combinations, rather than advancing both pools in lockstep.
                for key in views:
                    _provider_offset[key] = (_provider_offset.get(key, 0) + 1) % len(key)
                    if _provider_offset[key]:
                        break
            raise
        finally:
            _read_view.reset(token)
    return wrapped


def view_pool(pool):
    views = _read_view.get()
    if views is None or not pool:
        return pool
    key = tuple(pool)
    if key not in views:
        views[key] = {"rpc": pool[_provider_offset.get(key, 0) % len(pool)], "blocks": {}}
    return [views[key]["rpc"]]


def verify_read_views():
    for view in (_read_view.get() or {}).values():
        for number, expected in list(view["blocks"].items()):
            if block_hash(view["rpc"], number, refresh=True) != expected:
                view["failed"] = True
                raise RuntimeError("RPC block view changed or became unreadable; cursor held")


def identify_failed_pool(fn):
    @wraps(fn)
    def wrapped(pool, *args, **kwargs):
        try:
            result = fn(pool, *args, **kwargs)
            if result is not None:
                return result
        except Exception:
            view = (_read_view.get() or {}).get(tuple(pool))
            if view is not None:
                view["failed"] = True
            raise
        view = (_read_view.get() or {}).get(tuple(pool))
        if view is not None:
            view["failed"] = True
        return result
    return wrapped


class RpcBudgetExceeded(RuntimeError):
    pass


def bounded_rpc(fn):
    """One logical read, including every fallback and recursive split, has ONE budget.
    Successful historical chunks get fresh budgets; an outage cannot explode into 2^depth
    full-timeout requests. This is not a timeout on the entire historical rebuild."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if _rpc_budget.get() is not None:
            return fn(*args, **kwargs)
        token = _rpc_budget.set({"deadline": time.monotonic() + RPC_BUDGET_SECS, "attempts": 0})
        try:
            return fn(*args, **kwargs)
        finally:
            _rpc_budget.reset(token)
    return wrapped


def rpcs(leg):
    """Redundant endpoints per leg: one failed eth_getLogs used to stall the cursor, and a
    stalled cursor halts NAV exactly like no reconciler at all."""
    return [leg["rpc"]] + list(leg.get("rpcFallbacks", []))


def log(e, **k):
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": e, **k}), flush=True)


def sh(*a, timeout=60):
    budget = _rpc_budget.get()
    timeout = min(timeout, RPC_TIMEOUT_SECS)
    if budget is not None:
        remaining = budget["deadline"] - time.monotonic()
        if remaining <= 0 or budget["attempts"] >= RPC_MAX_ATTEMPTS:
            raise RpcBudgetExceeded("RPC read budget exhausted; cursor held (time/attempt limit)")
        budget["attempts"] += 1
        timeout = min(timeout, remaining)
    try:
        r = subprocess.run(a, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else ""
    except subprocess.TimeoutExpired:
        return ""


@bounded_rpc
def head(pool):
    """Latest block, or None when every endpoint of the leg is unreachable.

    None rather than 0: block 0 is a real height at genesis, and returning it as a sentinel made
    "the chain is unreadable" indistinguishable from "the chain is empty".
    """
    for rpc in pool:
        o = sh("cast", "block-number", "--rpc-url", rpc, timeout=30)
        if o.strip().isdigit():
            return int(o)
    return None


def _nonneg_int(value, label):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer, got {value!r}")
    return value


def finality_policy(path=None):
    """Both depths and the lag budget between them, checked against each other before we start.

    The invariant is `scanConfirmations + maxHealthyLagBlocks <= minConfirmations`: the reconciler
    is allowed to trail the aggregator by the lag budget and STILL satisfy nav-snapshot's
    `reconciledThrough >= pin`. maxHealthyLagBlocks must describe measured polling drift, so the
    only correct way out of a failure here is to pin deeper -- see the error text.
    """
    path = OPERATOR_CONFIG if path is None else path
    try:
        policy = json.load(open(path))["navAccounting"]["policy"]
    except Exception as ex:
        raise SystemExit(f"FATAL: cannot read the finality policy from operator config {path}: {ex}")
    out = {}
    try:
        for leg in ("mezo", "eth"):
            pin = _nonneg_int((policy.get("minConfirmations") or {}).get(leg), f"minConfirmations.{leg}")
            lag = _nonneg_int((policy.get("maxHealthyLagBlocks") or {}).get(leg), f"maxHealthyLagBlocks.{leg}")
            scan = _nonneg_int(SCAN_CONF[leg], f"scanConfirmations.{leg}")
            if scan + lag > pin:
                raise ValueError(
                    f"{leg} leaves no margin: scanConfirmations {scan} + maxHealthyLagBlocks {lag} "
                    f"> minConfirmations {pin}. reconciledThrough would fall behind the NAV pin and "
                    f"price-setting rounds would be refused. Raise minConfirmations rather than "
                    f"lowering maxHealthyLagBlocks: the lag budget has to describe the polling drift "
                    f"this seat actually has, not be tuned until this check passes"
                )
            out[leg] = {"scan": scan, "pin": pin, "lag": lag}
    except ValueError as ex:
        raise SystemExit(f"FATAL: finality policy in {path}: {ex}")
    return out


def safe_scan_range(cursor, latest, scan_conf):
    """(safe_head, inclusive range to scan) -- or None for the range when there is nothing safe yet.

    None is also the correct answer right after scanConfirmations is raised, while a persisted
    cursor still sits above the new safe head. That is a WAIT, not a fault: see load().
    """
    safe_head = max(0, latest - scan_conf)
    return safe_head, ((cursor + 1, safe_head) if safe_head > cursor else None)


def find_evidence_window(pool, addr, topic0, safe_head, step, floor_block, max_chunks=40):
    """Walk back from the safe head for a range the PRIMARY endpoint says has events.

    Taking the most recent chunk and comparing it is what an earlier version did, and on a
    deployment that bridges rarely that window is almost always empty -- so the canary agreed on
    nothing and reported a pass. A window with no events cannot detect an endpoint that returns no
    events, which is the whole failure being guarded against.

    Bounded: `max_chunks` back, and never below the deployment block, so a chain that genuinely has
    no history costs a fixed number of reads rather than a walk to genesis. Returns None when
    there is no evidence to be had, which the caller reports as INCONCLUSIVE.
    """
    hi = safe_head
    for _ in range(max_chunks):
        lo = max(floor_block, hi - step)
        if lo >= hi:
            return None
        # ANY endpoint, not just the primary. Searching through the primary alone is powerless
        # against exactly the failure being hunted: an endpoint that answers `[]` reports every
        # window as empty, the search walks to its floor finding nothing, and the canary shrugs and
        # says INCONCLUSIVE -- with the liar's silence as the reason it found nothing to compare.
        for rpc in pool:
            got = _try(rpc, addr, [topic0], lo, hi)
            if got:
                return (lo, hi)
        hi = lo
    return None


def endpoint_canary(pool, leg_name, chain_id, addr, topic0, frm, to):
    """Startup check across EVERY endpoint of a leg, not just the primary. Returns log lines.

    WHAT FALLBACKS ARE FOR, precisely: liveness, not integrity. `logs()` rotates when an endpoint
    ERRORS, and an endpoint that answers `[]` has not errored — it has said "no events here", which
    is indistinguishable from the truth. That is not hypothetical for this deployment: a Mezo RPC
    silently returned empty logs, and attribution by exclusion was wrong twice on the strength of
    answers that looked fine.

    Nothing here can prove an endpoint COMPLETE — there is no oracle to compare against. What it can
    prove is AGREEMENT, and disagreement is the shape the silent-empty failure actually takes:

      * chain id, per endpoint. A fallback pointed at the wrong network answers every call, and its
        `eth_getLogs` is empty for our addresses because our contracts are not there. The config
        generator checks this once at generation time; nothing re-checks it at run time, and an
        endpoint URL can be edited afterwards.
      * one historical window of our own bridge events, per endpoint, compared. Two endpoints
        returning different counts for a settled range means at least one is lying, and continuing
        would mean picking a story at random.

    An EMPTY-but-agreed window proves nothing and says so rather than reading as a pass: on a chain
    where nothing has bridged yet there is no evidence to be had.
    """
    lines = []
    for rpc in pool:
        got = sh("cast", "chain-id", "--rpc-url", rpc, timeout=30).strip()
        if got != str(chain_id):
            raise SystemExit(
                f"FATAL: {leg_name} endpoint {redact_url(rpc)} reports chain {got or '<unreadable>'}, "
                f"expected {chain_id}. Its logs would be empty for our addresses and read as 'nothing "
                "happened'"
            )

    counts = {}
    for rpc in pool:
        got = _try(rpc, addr, [topic0], frm, to)
        if got is None:
            lines.append(("canary-endpoint-unreadable", {"leg": leg_name, "rpc": redact_url(rpc),
                                                         "action": "not fatal; rotation covers it"}))
            continue
        counts[redact_url(rpc)] = len(got)

    distinct = set(counts.values())
    if len(distinct) > 1:
        raise SystemExit(
            f"FATAL: {leg_name} endpoints disagree on a settled range [{frm}, {to}]: {counts}. "
            "One of them is not returning the events it has. Do not reconcile against either until "
            "it is resolved — picking the first answer is picking a story at random"
        )
    observed = next(iter(distinct), 0)
    if observed == 0:
        lines.append(("canary-inconclusive", {
            "leg": leg_name, "frm": frm, "to": to, "endpoints": len(pool),
            "detail": "every endpoint agrees this window is empty, which proves agreement and not "
                      "completeness; there is no evidence to be had until something bridges",
        }))
    else:
        lines.append(("canary-ok", {"leg": leg_name, "events": observed, "endpoints": len(counts)}))
    return lines


def redact_url(u):
    """Host only. The RPC URL carries the provider credential in its userinfo or its path, and
    everything this process logs is read by people and shipped to alerting."""
    try:
        rest = u.split("://", 1)[1] if "://" in u else u
        host = rest.split("/", 1)[0]
        return host.split("@")[-1]
    except Exception:
        return "<malformed rpc url>"


def _try(rpc, addr, topics, frm, to):
    """One eth_getLogs, filtered by the NODE. `topics` is the JSON-RPC topic list: None is a
    wildcard. `cast logs` takes topics positionally and cannot skip one, which is why arrivals
    used to be every USDC Transfer on Ethereum filtered in Python -- and why a sender filter,
    topic 1 with the recipient in topic 2, was not expressible at all."""
    # A fallback may answer [] for a range it has not reached. Serving the actual upper
    # block is a prerequisite, not proof of log completeness from a dishonest provider.
    if block_hash(rpc, to) is None:
        return None
    params = [{"fromBlock": hex(frm), "toBlock": hex(to), "address": addr, "topics": topics}]
    o = sh("cast", "rpc", "--rpc-url", rpc, "--raw", "eth_getLogs", json.dumps(params), timeout=60)
    if not o:
        return None
    try:
        got = json.loads(o)
    except Exception:
        # A provider's HTML error page, a truncated body. This used to come back as `[]` --
        # "answered, no events" -- so the rotation never tried the next endpoint and the range
        # was scanned past for good. Not parseable is not an answer.
        return None
    return got if isinstance(got, list) else None


@bounded_rpc
def block_hash(rpc, number, refresh=False):
    view = next((v for v in (_read_view.get() or {}).values() if v["rpc"] == rpc), None)
    if view is not None and number in view["blocks"] and not refresh:
        return view["blocks"][number]
    raw = sh("cast", "rpc", "--rpc-url", rpc, "--raw", "eth_getBlockByNumber",
             json.dumps([hex(number), False]))
    try:
        b = json.loads(raw)
        if int(b["number"], 16) != number or len(b["hash"]) != 66:
            return None
        result = b["hash"].lower()
        if view is not None and not refresh:
            view["blocks"][number] = result
        return result
    except (ValueError, TypeError, KeyError):
        return None


@identify_failed_pool
@bounded_rpc
def logs(pool, addr, topics, frm, to, _depth=0):
    for ep in view_pool(pool):
        r = _try(ep, addr, topics, frm, to)
        if r is not None:
            return r
    if to > frm:
        if _depth >= LOG_MAX_DEPTH:
            raise RpcBudgetExceeded("getLogs split depth exhausted; cursor held")
        mid = frm + (to - frm) // 2
        return logs(pool, addr, topics, frm, mid, _depth + 1) + logs(pool, addr, topics, mid + 1, to, _depth + 1)
    raise RuntimeError("getLogs block %s failed on all endpoints" % frm)


def scan(pool, addr, topics, frm, to, step):
    out, b = [], frm
    while b <= to:
        e = min(b + step - 1, to)
        out.extend(logs(pool, addr, topics, b, e))
        b = e + 1
    # A provider may repeat a log at a pagination boundary. Its identity is stable;
    # contradictory payloads for the same identity invalidate the range.
    by_id = {}
    for entry in out:
        key = (entry["transactionHash"], entry["logIndex"])
        if entry.get("removed"):
            raise ValueError("removed log in finalized range")
        if key in by_id and entry != by_id[key]:
            raise ValueError("conflicting duplicate RPC log")
        by_id[key] = entry
    return list(by_id.values())


def w(d, i):
    d = d[2:] if d.startswith("0x") else d
    return int(d[i * 64:(i + 1) * 64] or "0", 16)


def pad(a):
    return "0x" + "0" * 24 + a[2:].lower()


_KECCAK_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_KECCAK_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]


def _keccak_f(a):
    m = (1 << 64) - 1
    for rc in _KECCAK_RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & m) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                r = _KECCAK_ROT[x][y]
                b[y][(2 * x + 3 * y) % 5] = ((a[x][y] << r) | (a[x][y] >> (64 - r))) & m if r else a[x][y]
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data):
    """Keccak-256 (the pre-NIST padding Ethereum uses; hashlib's sha3 is not it). Needed once per
    deployment, for the bridge's `bytes recipient` topic; forty lines beat one more subprocess on
    the price path. Checked against the standard vectors and a real topic in the test suite."""
    rate = 136
    padded = bytearray(data) + b"\x01" + b"\x00" * ((rate - (len(data) + 1) % rate) % rate)
    padded[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _keccak_f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def recipient_topic(addr):
    """The bridge indexes `bytes recipient`, so the topic is keccak256 of the 20 address bytes."""
    return "0x" + keccak256(bytes.fromhex(addr[2:])).hex()


def _word_hex(d, i):
    d = d[2:] if d.startswith("0x") else d
    return "0x" + d[i * 64:(i + 1) * 64].lower()


def _hexint(v):
    return int(v, 16) if isinstance(v, str) else int(v)


def unique_records(records, key):
    """Identical RPC duplicates are harmless; conflicting records for one identity are not."""
    seen = {}
    for record in records:
        identity = record[key]
        if identity in seen and seen[identity] != record:
            raise ValueError(f"conflicting bridge records for {key}={identity}")
        seen[identity] = record
    return list(seen.values())


def departures(pool, adapter, dest, token, recipient, frm, to, step):
    """Our departures off the adapter, as records {amount, block, tx}.

    BridgeSent(bytes32 indexed transferId, address indexed token, uint256 amount, uint256
    destChainId, address recipient, BucketPurpose purpose): topic2 is the token, data words are
    amount / destChainId / recipient / purpose. `send()` has no caller gate and the adapters are
    shared between deployments, so the destination chain alone proves nothing: a departure is
    ours only when the token is ours AND the recipient is our address on the other leg. Filtering
    on the chain only put a stranger's transfer in our queue, priced it as our in-flight capital,
    and left it there -- its arrival, at THEIR address, never came to retire it.
    """
    want_token, want_to = pad(token).lower(), pad(recipient).lower()
    out = []
    # The node filters on the token; the recipient sits in the data and is checked here. Both
    # are re-checked in Python regardless: a node that ignores its filter must not slip a
    # stranger's log through.
    for l in scan(pool, adapter, [BRIDGE_SENT, None, want_token], frm, to, step):
        topics, data = l.get("topics", []), l.get("data", "0x")
        if len(topics) < 3 or topics[2].lower() != want_token:
            continue
        if w(data, 1) != dest or _word_hex(data, 2) != want_to:
            continue
        out.append({"amount": w(data, 0), "block": _hexint(l["blockNumber"]), "tx": l["transactionHash"],
                    "logIndex": _hexint(l["logIndex"])})
    return out


def incoming(pool, token, sender, to_addr, frm, to, step):
    """Bridge deliveries into `to_addr`: Transfers of `token` FROM `sender`, the L1 MezoBridge,
    as records {amount, tx, block, logIndex} -- the tx is what joins a Transfer to the bridge's
    own AssetsUnlockConfirmed in the same transaction (join_arrivals).

    Every Transfer into the receiver used to be a candidate, and a stranger's transfer of the
    matching amount retired our departure -- the real delivery then landed against an empty
    queue and was ignored, unpriced for the whole crossing. On the real route both pilot
    deliveries were Transfers from the L1 bridge (blocks 25885464, 25891092) and the receiver's
    other two inbound Transfers were venue withdrawals: exactly what must never match. The
    sender is the bridge, or it is not a delivery. Filtered by the node and re-checked here.
    `sender` None (no bridge configured) filters on the recipient only, the legacy behaviour.
    """
    want_from = pad(sender).lower() if sender else None
    want_to = pad(to_addr).lower()
    out = []
    for l in scan(pool, token, [TRANSFER, want_from, want_to], frm, to, step):
        topics = l.get("topics", [])
        if len(topics) < 3 or topics[2].lower() != want_to:
            continue
        if want_from and topics[1].lower() != want_from:
            continue
        out.append({"amount": w(l.get("data", "0x"), 0), "tx": l.get("transactionHash"),
                    "block": _hexint(l["blockNumber"]), "logIndex": _hexint(l["logIndex"])})
    return out


def unlock_events(pool, precompile, sender, recipient, token, frm, to, step):
    """Our OUTBOUND crossings' identities: the AssetsBridge precompile's AssetsUnlocked for locks
    sent by our adapter (`sender`, data word 0) to our receiver (`recipient`, the bytes topic) of
    `token` (the L1 token, topic 3). Emitted in the same tx as our BridgeSent, before it, so
    join_sequences pairs them exactly as it pairs the inbound leg. Records {seq, tx, logIndex,
    amount} with the GROSS amount."""
    want_to, want_token, want_sender = recipient_topic(recipient), pad(token).lower(), pad(sender).lower()
    out = []
    for l in scan(pool, precompile, [MEZO_ASSETS_UNLOCKED, None, want_to, want_token], frm, to, step):
        topics, data = l.get("topics", []), l.get("data", "0x")
        if len(topics) < 4 or topics[2].lower() != want_to or topics[3].lower() != want_token:
            continue
        if _word_hex(data, 0) != want_sender:
            continue
        out.append({"seq": int(topics[1], 16), "tx": l.get("transactionHash"),
                    "logIndex": _hexint(l["logIndex"]), "amount": w(data, 1)})
    return out


def unlock_confirmations(pool, bridge, recipient, token, frm, to, step):
    """The L1 MezoBridge's AssetsUnlockConfirmed into our receiver: the bridge's own statement
    that sequence `seq` was delivered, with its GROSS amount. Records {seq, tx, logIndex,
    amount, block}. The net that landed is the USDC Transfer in the same tx (join_arrivals)."""
    want_to, want_token = recipient_topic(recipient), pad(token).lower()
    out = []
    for l in scan(pool, bridge, [L1_UNLOCK_CONFIRMED, None, want_to, want_token], frm, to, step):
        topics = l.get("topics", [])
        if len(topics) < 4 or topics[2].lower() != want_to or topics[3].lower() != want_token:
            continue
        out.append({"seq": int(topics[1], 16), "tx": l.get("transactionHash"),
                    "logIndex": _hexint(l["logIndex"]), "amount": w(l.get("data", "0x"), 0),
                    "block": _hexint(l["blockNumber"])})
    return out


def join_arrivals(confirmations, transfers):
    """An outbound ARRIVAL is a confirmation joined with the Transfer that follows it in the same
    tx: {seq, gross, net, block, tx}. A confirmation with no Transfer to us in its tx is an
    ORPHAN -- the bridge says it delivered and nothing landed where the ledger can see it -- and
    is returned separately, never guessed into an arrival."""
    by_tx = {}
    for t in transfers:
        by_tx.setdefault(t["tx"], []).append(t)
    arrivals, orphans = [], []
    for c in sorted(confirmations, key=lambda c: (c["tx"], c["logIndex"])):
        later = sorted((t for t in by_tx.get(c["tx"], []) if t["logIndex"] > c["logIndex"]), key=lambda t: t["logIndex"])
        if not later:
            orphans.append(c)
            continue
        t = later[0]
        by_tx[c["tx"]].remove(t)
        arrivals.append({"seq": c["seq"], "gross": c["amount"], "net": t["amount"], "block": c["block"], "tx": c["tx"]})
    if orphans or any(by_tx.values()):
        raise ValueError("incomplete bridge arrival evidence: confirmation/Transfer mismatch; cursor held")
    return arrivals, orphans


@identify_failed_pool
@bounded_rpc
def token_balance(pool, token, owner, block):
    """Pinned balance read. None when every endpoint failed -- callers must treat that as
    UNKNOWN, never as zero: a zero here would read as "nothing arrived"."""
    for rpc in view_pool(pool):
        if block_hash(rpc, block) is None:
            continue
        o = sh("cast", "call", token, "balanceOf(address)(uint256)", owner,
               "--rpc-url", rpc, "--block", str(block), timeout=30)
        first = o.split()[0] if o else ""
        if first.isdigit():
            return int(first)
    return None


def transfer_deltas(pool, token, owner, frm, to, step):
    """Every EVM-VISIBLE movement of `token` for `owner` over the range, as (credits, debits)."""
    want = pad(owner).lower()
    credits = sum(w(l.get("data", "0x"), 0) for l in scan(pool, token, [TRANSFER, None, want], frm, to, step))
    debits = sum(w(l.get("data", "0x"), 0) for l in scan(pool, token, [TRANSFER, want], frm, to, step))
    return credits, debits


def native_arrivals(pool, token, owner, frm, to, step):
    """Mezo bridge deliveries, found as the balance change that NO EVM Transfer explains.

    `incoming()` cannot see these at all. Mezo-token mints happen inside the mezod Go node, not
    the EVM, so a delivery emits NO ERC-20 Transfer from 0x0 -- the trap recorded in
    ops/testnet/deployments/2026-08-07-real-bridge-xchain/. The consequence, flagged by an
    external mainnet-readiness review on 2026-08-08, is not a missing log line: an eth->mezo
    transfer joins qIn on departure and is priced as an in-flight asset, then lands and is ALSO
    counted in `mezo:executor:musdc`. Nothing ever clears qIn, so NAV over-states by the
    delivered amount permanently -- and over-stating is the dangerous direction, because
    withdrawals then settle against assets that were counted twice.

    A raw balance delta would be wrong too: the executor's mUSDC also moves on swap output and
    bridge burns. But every one of those IS an EVM Transfer, and the native mint is exactly the
    part no Transfer explains, so the residual is the delivery -- no new contract required. (A
    dedicated landing escrow, per the review's §4.2, is still the better end state: it would make
    the balance itself unambiguous instead of reconstructing it by subtraction.)

    Returns the unexplained amount, or None when a balance read was unavailable -- the caller
    must then leave the cursor where it is rather than skip the range.
    """
    before = token_balance(pool, token, owner, frm - 1)
    after = token_balance(pool, token, owner, to)
    if before is None or after is None:
        return None
    credits, debits = transfer_deltas(pool, token, owner, frm, to, step)
    unexplained = (after - before) - (credits - debits)
    if unexplained < 0:
        # Every EVM Transfer is accounted for and the balance still FELL further: the balance
        # model is wrong for this range -- an endpoint answered from two histories, or a debit
        # path we do not model. Any residual computed from it is a guess, including a smaller
        # positive one hiding a real mint. This used to return 0 ("nothing arrived") and the
        # cursor moved on; a delivery skipped that way stays in flight while the money is
        # counted on the destination -- overstated, not conservative. Unknown holds the cursor,
        # exactly like an unreadable balance; if it persists, price-setting stops and a human
        # looks, which is the only honest outcome for a balance the model cannot explain.
        log("unexplained-balance-drop", token=token, owner=owner, frm=frm, to=to,
            delta=after - before, credits=credits, debits=debits, unexplained=unexplained,
            action="cursor held; the residual cannot be trusted")
        return None
    return unexplained


@identify_failed_pool
@bounded_rpc
def uint_call(pool, target, sig, *args, block=None):
    """One `cast call` returning a uint, or None when every endpoint failed (unknown, not zero).
    `block` pins the read: a tip compared against arrivals folded through the cursor must be
    read AT the cursor, not at whatever height the endpoint is on now."""
    pin = ["--block", str(block)] if block is not None else []
    for rpc in view_pool(pool):
        if block is not None and block_hash(rpc, block) is None:
            continue
        o = sh("cast", "call", target, sig, *[str(a) for a in args], "--rpc-url", rpc, *pin, timeout=30)
        first = o.split()[0] if o else ""
        if first.isdigit():
            return int(first)
    return None


def locked_sequences(pool, bridge, recipient, token, frm, to, step):
    """Native `AssetsLocked` locks of `token` addressed to `recipient`, as {seq, tx}.

    This is the number the Mezo validators actually consume, and it is NOT the adapter's local
    `_transferSeq`/`transferId` -- those are ours, informational, and prove nothing about
    settlement. topic1 is the sequence, topic2 the recipient, topic3 the token (see
    ASSETS_LOCKED). The token matters: a lock of some other token to our address is not our
    transfer, and it must not lend its sequence to one of ours in the same tx.
    """
    want, want_token = pad(recipient).lower(), pad(token).lower()
    out = []
    for l in scan(pool, bridge, [ASSETS_LOCKED, None, want, want_token], frm, to, step):
        topics = l.get("topics", [])
        if len(topics) > 3 and topics[2].lower() == want and topics[3].lower() == want_token:
            out.append({"seq": int(topics[1], 16), "tx": l.get("transactionHash"),
                        "logIndex": _hexint(l["logIndex"]), "amount": w(l.get("data", "0x"), 0)})
    return out


def join_sequences(deps, locks, transfers=None):
    """Attach each Ethereum departure's native sequence.

    The adapter's BridgeSent and the bridge's AssetsLocked are emitted by the SAME transaction,
    the lock first: send() calls bridgeERC20 and then emits. Two sends in one transaction
    therefore interleave lock, sent, lock, sent by log index, and that order is the pairing.
    Keyed on the transaction alone, both departures took the first lock's sequence.

    `locks` is None when no bridge is configured to read them from: every departure then
    carries seq=None, which is "unknown" downstream (a backlog, never a haircut). With a bridge
    configured, a departure without a lock in its transaction, or events that do not interleave,
    is not a shape our adapter produces -- it is refused, not guessed at.
    """
    if locks is None:
        return [dict(d, seq=None) for d in deps]
    locks_by_tx = {}
    for lock in locks:
        locks_by_tx.setdefault(lock["tx"], []).append(lock)
    deps_by_tx = {}
    for i, d in enumerate(deps):
        deps_by_tx.setdefault(d["tx"], []).append(i)
    seq_of = {}
    for tx, idx in deps_by_tx.items():
        ours = sorted(idx, key=lambda i: deps[i]["logIndex"])
        theirs = sorted(locks_by_tx.get(tx, []), key=lambda l: l["logIndex"])
        prev = -1
        for i in ours:
            # send() emits immediately after its bridge call returns. Extra direct bridge
            # calls by the transaction's relayer may precede/follow that call, but cannot
            # interleave inside it (fixed bridge + fixed non-callback asset). The LAST
            # matching native event before BridgeSent is its lock; earlier ones are foreign.
            before = [l for l in theirs if prev < l["logIndex"] < deps[i]["logIndex"]]
            if not before:
                raise ValueError(f"tx {tx}: missing native lock before BridgeSent; cannot pair")
            lock = before[-1]
            gap = deps[i]["logIndex"] - lock["logIndex"]
            # L1 emits AssetsLocked BEFORE transferring USDC into the bridge. The real
            # pilot receipt 0x4e8d0b... has lock 170, Transfer 171, BridgeSent 172.
            # Accept this exact token movement, not an arbitrary gap that could hide
            # an omitted native lock and lend an earlier foreign lock its identity.
            l1_transfer = gap == 2 and any(
                t["tx"] == tx and t["logIndex"] == lock["logIndex"] + 1
                and t["amount"] == deps[i]["amount"] for t in (transfers or [])
            )
            if gap != 1 and not l1_transfer:
                raise ValueError(f"tx {tx}: missing adjacent native lock before BridgeSent; cannot pair")
            if lock["amount"] != deps[i]["amount"]:
                raise ValueError(f"tx {tx}: native lock amount differs from BridgeSent; cannot pair")
            prev = deps[i]["logIndex"]
            seq_of[i] = lock["seq"]
    return [dict(d, seq=seq_of[i]) for i, d in enumerate(deps)]


def classify_inbound(entry, tip):
    """Is this inbound transfer delayed, or is the money not coming?

    mezod's `AcceptAssetsLocked` requires the first event of a batch to equal tip + 1 and every
    later one to increase by exactly one, so ONE unprocessed sequence stalls every subsequent
    transfer regardless of who sent it. That is the 2026-08-07 incident: our sequence 21475 sat
    behind 21471, an unrelated EOA deposit from 3.5 hours earlier, with the destination tip at
    21470 against a source sequence of 21478.

    The same function has a much worse mode. A failed mint is LOGGED, the tip is ADVANCED, and the
    event is never reprocessed -- so a tip at or past our sequence with nothing delivered means the
    transfer is gone, not late. Per ENTRY, against a tip read at the block the arrivals were
    folded through: one scalar for the whole queue let a newer send lift the haircut off an
    older lost transfer, and a tip read at latest called a live transfer lost while its mint sat
    in blocks not yet scanned. Returns:

      "backlog"               tip has not reached this sequence; legitimately in flight, no haircut
      "processed-undelivered" the destination accepted this sequence and the entry is STILL
                              queued; haircut it and page a human

    A loss is confirmed ONCE, by settle_inbound, and is durable on the record (`lost`): a tick
    that cannot read the tip must not restore value to money that is gone. Unknown inputs for an
    entry not yet confirmed (no tip read, or no sequence observed) return "backlog": that never
    invents a haircut from missing data.
    """
    # Only a settlement is a verdict. The tip alone used to be one -- tip past the sequence with
    # the entry still queued read as processed-undelivered -- and that wrote a transfer down with
    # no settlement behind it whenever settlement had refused to decide (an ambiguity, a
    # bounded search). An undecided entry is in flight at face value; whether NAV may be priced
    # at all while it is undecided is update_ambiguity's call, not a haircut's.
    return "processed-undelivered" if entry.get("lost") else "backlog"


def settle_outbound(st, arrivals, tol):
    """Settle the outbound leg against sequenced arrivals. Pure. Returns the events to log.

    An arrival retires the departure with ITS sequence and nothing else: a stranger's crossing to
    our receiver through the real bridge has a different sequence, and is remembered
    (`pendingOut`) rather than matched -- it may also be OUR departure that the Mezo endpoints
    have not served yet (resolve_pending_out settles it on read). What landed is what counts:
    the Transfer's net is delivered; the fee actually paid (gross - net) is compared with the
    configured flat fee and reported when it drifts beyond the tolerance.
    """
    events, delivered, seqs = [], 0, []
    by_seq = {e["seq"]: e for e in st["qOut"] if e.get("seq") is not None}
    for a in unique_records(arrivals, "seq"):
        entry = by_seq.get(a["seq"])
        if entry is None:
            if not any(p["seq"] == a["seq"] for p in st["pendingOut"]):
                st["pendingOut"].append(dict(a))
            events.append(("bridge-arrival-before-departure", {
                "seq": a["seq"], "net": a["net"], "block": a["block"], "tx": a["tx"],
                "detail": "a crossing to our receiver with no departure of ours read yet: remembered; "
                          "settled on read if the departure turns out to be ours, else a stranger's "
                          "money in our balance"}))
            continue
        st["qOut"].remove(entry)
        st["outDelivered"] += a["net"]
        delivered += a["net"]
        seqs.append(a["seq"])
        fee_paid = a["gross"] - a["net"]
        if abs(fee_paid - FEES[OUT]["fee"]) > tol:
            events.append(("bridge-fee-drift", {"seq": a["seq"], "feePaid": fee_paid, "feeExpected": FEES[OUT]["fee"],
                                                "gross": a["gross"], "net": a["net"],
                                                "detail": "settled on the sequence; check RECON_FEE_OUT sizing"}))
    if delivered:
        events.append(("eth-arrivals", {"matched": delivered, "unmatched": 0, "sequences": seqs}))
    return events


def orphaned_confirmations(st, orphans):
    """Confirmations of OUR sequences with no Transfer to us in their tx: the count, which closes
    the outbound direction through update_ambiguity. Nothing is retired on the bridge's word alone."""
    ours = {e["seq"] for e in st["qOut"] if e.get("seq") is not None}
    return sum(1 for o in orphans if o["seq"] in ours)


def resolve_pending_out(st, departed):
    """Mezo departures whose arrival was already read on Ethereum (endpoint lag): settled on read,
    never queued. Returns (departures still to fold, events). The watermark moves to the
    arrival's block: between the departure and the arrival the money was on neither chain and
    nothing knew it was in flight, so a pin inside that window prices low."""
    remaining, events = [], []
    for d in departed:
        pending = next((p for p in st["pendingOut"] if d.get("seq") is not None and p["seq"] == d["seq"]), None)
        if pending is None:
            remaining.append(d)
            continue
        st["pendingOut"].remove(pending)
        st["outSent"] += d["amount"]
        st["outDelivered"] += pending["net"]
        st["safeAfter"]["eth"] = max(st["safeAfter"]["eth"], pending["block"])
        fee_paid = d["amount"] - pending["net"]
        events.append(("bridge-departure-read-late", {"direction": OUT, "seq": d["seq"], "gross": d["amount"],
                                                      "net": pending["net"], "arrivalBlock": pending["block"],
                                                      "feePaid": fee_paid}))
    return remaining, events


def _unique_settlement_mask(nets, residual, tol):
    """The sole subset within tolerance, or None if undecidable within the search bound.

    Nets are non-negative. For positive nets the empty/full set can be proved unique
    in O(n), but only if the nearest non-empty/proper subset is OUTSIDE tolerance.
    A zero net gives two indistinguishable subsets; a tiny positive net can do the
    same with tolerance. Neither may be hidden by the all/none-landed fast paths.
    """
    total = sum(nets)
    smallest = min(nets, default=0)
    if smallest > 0:
        if residual <= tol and smallest > residual + tol:
            return 0
        if abs(total - residual) <= tol and total - smallest < residual - tol:
            return (1 << len(nets)) - 1
    if len(nets) > MAX_SETTLE_CANDIDATES:
        return None
    match = None
    for mask in range(1 << len(nets)):
        if abs(sum(n for i, n in enumerate(nets) if mask >> i & 1) - residual) <= tol:
            if match is not None:
                return None  # the second fit is enough to prove ambiguity
            match = mask
    return match


def resolve_pending_in(st, departed):
    """Stage late departures exactly once. Settlement happens AFTER both legs are folded,
    against every retained member of the window, not just this call's departures.

    A processed departure with no remembered window belongs to a range with zero residual.
    Previous versions could DROP nonzero ambiguous windows: existing states with that history
    need an explicit rebuild, not an invented reconstruction (see README).
    """
    remaining, events, unresolved = [], [], 0
    tip_at = st.get("tipAt")
    for d in departed:
        d = dict(d)
        seq = d.get("seq")
        window = next((p for p in st["pendingIn"] if seq is not None and p["tipPrev"] < seq <= p["tipNow"]), None)
        if window is not None:
            d["unresolved"] = True
            unresolved += 1
        elif seq is not None and tip_at is not None and seq <= tip_at:
            d["lost"], d["reason"] = True, "processed-before-known"
            st["safeAfter"]["mezo"] = max(st["safeAfter"]["mezo"], st["m"])
            log("bridge-processed-before-known", seq=seq, amount=expected_net(d["amount"], IN), tx=d["tx"], tipAt=tip_at,
                detail="processed before we knew of it and no mint was remembered for its window: nothing landed")
        remaining.append(d)
    return remaining, events, unresolved


def settle_pending_in(st, tol, source_seq=None):
    """Reconsider durable windows using ALL known own/foreign locks, including previous ticks.

    `source_seq` is L1 sequence() AT the scanned Ethereum cursor. Until it covers tipNow,
    a unique subset of the currently known locks is not a proof: a late equal-value foreign
    lock could make it ambiguous. Zero residual is the exception: no positive mint landed.
    Pure callers can prove coverage with an observed sequence; production supplies the pinned
    source counter even for quiet ticks. No latest-head counter is accepted as coverage.
    """
    events = []
    covered = source_seq if source_seq is not None else max(
        [0] + [e["seq"] for e in st["qIn"] + st["foreignIn"] if e.get("seq") is not None])
    resolved = False
    for window in list(st["pendingIn"]):
        lo, hi, residual = window["tipPrev"], window["tipNow"], window["residual"]
        ours = [e for e in st["qIn"] if not e.get("lost") and e["seq"] is not None and lo < e["seq"] <= hi]
        theirs = [e for e in st["foreignIn"] if lo < e["seq"] <= hi]
        candidates = [(e, True) for e in ours] + [(e, False) for e in theirs]
        mask = None if residual > tol and covered < hi else _unique_settlement_mask(
            [e["net"] for e, _ in candidates], residual, tol)
        if mask is None:
            for e in ours:
                e["unresolved"] = True
            events.append(("bridge-inbound-unexplained", {
                "unmatched": residual, "unresolved": len(candidates), "tipPrev": lo, "tipNow": hi,
                "sourceThrough": covered, "processed": [e["seq"] for e, _ in candidates],
                "detail": "source history incomplete" if covered < hi else
                          "missing or ambiguous bounded subset; window retained for later evidence",
            }))
            continue
        delivered, settled = 0, []
        for i, (entry, mine) in enumerate(candidates):
            if mine:
                entry.pop("unresolved", None)
                if mask >> i & 1:
                    delivered += entry["net"]
                    settled.append(entry["seq"])
                    st["qIn"].remove(entry)
                else:
                    entry["lost"], entry["reason"] = True, "processed-undelivered"
                    events.append(("bridge-processed-undelivered", {
                        "seq": entry["seq"], "amount": entry["net"], "tx": entry["tx"], "tipNow": hi,
                        "haircutBps": UNDELIVERED_HAIRCUT_BPS,
                        "detail": "complete window explains the residual without this mint; escalate, do not resend",
                    }))
            else:
                st["foreignIn"].remove(entry)
                if not (mask >> i & 1):
                    events.append(("bridge-foreign-undelivered", {
                        "seq": entry["seq"], "amount": entry["net"], "tx": entry["tx"]}))
        if ours:
            st["safeAfter"]["mezo"] = max(st["safeAfter"]["mezo"], window["block"])
        if delivered:
            st["inDelivered"] += delivered
            events.append(("mezo-arrivals", {"matched": delivered, "unattributed": 0,
                                             "mintedObserved": residual, "sequences": settled}))
        st["pendingIn"].remove(window)
        resolved = True
    # Clear only on positive settlement evidence. A later unrelated backlog must not keep an
    # already-resolved ambiguity latched, but legacy unresolved rows with no window stay closed.
    if resolved and not st["pendingIn"] and not any(
        not e.get("lost") and (e["seq"] is None or e["seq"] <= st["tipAt"]) for e in st["qIn"]
    ):
        st["ambiguous"][IN] = False
    return events


def settle_inbound(st, residual, tip_prev, tip_now, tol, block=0, source_seq=None):
    """Retain the complete destination window before advancing its cursor. Both partly known
    and entirely unknown arrivals survive; later Ethereum ranges can complete either case.
    Native mint residuals are still attributed by a bounded UNIQUE subset, never FIFO guesses.
    """
    st["tipAt"] = tip_now
    # Preserve the legacy unsequenced/test transport only when no ordered candidate is in
    # this range. The production reader requires both bridge addresses and joins sequences.
    legacy = [e for e in st["qIn"] if e["seq"] is None and not e.get("lost")]
    ordered = [e for e in st["qIn"] + st["foreignIn"]
               if e.get("seq") is not None and tip_prev < e["seq"] <= tip_now]
    events = []
    if legacy and not ordered:
        delivered, residual = drain_total(legacy, residual, tol)
        kept = set(map(id, legacy))
        st["qIn"] = [e for e in st["qIn"] if e["seq"] is not None or e.get("lost") or id(e) in kept]
        st["inDelivered"] += delivered
        if delivered:
            events.append(("mezo-arrivals", {"matched": delivered, "unattributed": residual}))
    if residual or tip_now > tip_prev:
        st["pendingIn"].append({"tipPrev": tip_prev, "tipNow": tip_now, "residual": residual, "block": block})
    return events + settle_pending_in(st, tol, source_seq)


def split_inbound(queue, tip):
    """(backlog total, processed-undelivered total) of the inbound queue at this tip."""
    backlog = undelivered = 0
    for e in queue:
        if classify_inbound(e, tip) == "backlog":
            backlog += e["net"]
        else:
            undelivered += e["net"]
    return backlog, undelivered


def _net(entry):
    """The expected net of a queue entry. Entries are records ({net, block, tx, ...}); a bare
    int is accepted so the matching logic can be exercised on amounts alone."""
    return entry["net"] if isinstance(entry, dict) else entry


def drain_total(queue, total, tol):
    """Retire in-flight departures FIFO against an aggregate delivered amount.

    `consume()` pairs individual arrivals to individual departures, which needs each arrival's
    own amount. A native mint is only ever observed as one aggregate for the whole block range,
    so pairing cannot apply: two deliveries in one range would produce a sum that matches neither
    departure and both would strand in flight. Draining oldest-first by total is the right
    semantics for a figure that is known in aggregate and fungible.

    A final partial is retired when it is within `tol`, so per-transfer fee rounding does not
    leave a permanent dust entry in the queue. Anything beyond the queue's own sum is returned as
    unattributed rather than silently absorbed -- at that point the money is not ours to book.
    """
    delivered = 0
    while queue and total > 0:
        head_amount = _net(queue[0])
        if total >= head_amount or abs(head_amount - total) <= tol:
            delivered += head_amount
            total -= head_amount
            queue.pop(0)
            if total < 0:
                total = 0
        else:
            break
    return delivered, total


def expected_net(amount, direction):
    """Queue what we expect to LAND, not what left. Pricing in-flight capital at the net is
    also the conservative side for NAV: the flat fee is a real loss the instant the transfer is
    submitted, so it must not keep being counted as vault assets while in transit.

    CLAMPED AT ZERO, never negative, and deliberately NOT fatal. A departure at or below the
    flat fee is economically worth nothing on arrival, and zero is the truthful figure to price
    it at. An earlier version raised instead and set `attributionCertain` false, which halts NAV
    for the whole vault — and stays halted until a human clears a state file. That is the
    fail-forever shape this project has rejected before: a dust transfer must not be able to
    stop valuation. It is logged loudly at the call site and costs nothing in the total.
    """
    return max(0, amount - FEES[direction]["fee"])


def consume(queue, arrivals, tol):
    """Pair arrivals with outstanding departures, maximising the number of pairs.

    Each arrival may consume any departure whose expected net is within `tol` of it; each
    departure serves at most one arrival. Unmatched arrivals are deliberately dropped -- they
    are not evidence of a bridge delivery (a venue withdrawal lands at the same address).

    MAXIMUM matching, not a greedy closest-first pass, because tolerance windows overlap and
    greedy strands pairs that a different assignment would have made. With departures expecting
    [996.80, 996.90] and tol 0.15, arrivals 996.90 then 997.00 go: greedy gives 996.90 its exact
    twin, and 997.00 is then 0.20 from the only departure left -- outside tolerance, unmatched.
    Pairing 996.90->996.80 and 997.00->996.90 matches both. That stranded arrival is not a
    harmless conservatism: the money IS on the destination chain and counted there, so leaving
    its departure in flight double-counts it and overstates NAV.

    Kuhn's augmenting-path algorithm over a handful of in-flight transfers. Candidates are tried
    closest-first so a maximum matching is also the natural one, and ties resolve to the oldest
    departure (queue order) for determinism.
    """
    candidates = []
    for amt in arrivals:
        near = sorted((abs(_net(exp) - amt), i) for i, exp in enumerate(queue) if abs(_net(exp) - amt) <= tol)
        candidates.append([i for _, i in near])

    taken = {}  # queue index -> index of the arrival holding it

    def augment(a, seen):
        for i in candidates[a]:
            if i in seen:
                continue
            seen.add(i)
            if i not in taken or augment(taken[i], seen):
                taken[i] = a
                return True
        return False

    for a in range(len(arrivals)):
        augment(a, set())

    # An augmenting path reassigns earlier arrivals but never unmatches one, so the holders of
    # `taken` at the end are exactly the arrivals that matched.
    matched = set(taken.values())
    delivered = sum(arrivals[a] for a in matched)
    for i in sorted(taken, reverse=True):
        queue.pop(i)
    return delivered, len(arrivals) - len(matched)


def migrate(st):
    """Bring a persisted state up to STATE_VERSION. Returns (state, note) -- note is logged.

    v1 -> v2 introduces `safeAfter`, the per-leg block of the last observed bridge state
    transition. It cannot be reconstructed from a v1 file, and both obvious defaults are wrong:
    zero re-opens the very window the watermark exists to close, and refusing to start forever
    turns a schema addition into an outage.

    The cursor is the correct seed. We have reconciled through it, so any flight that ends after
    it is still in the queues -- and a non-empty queue already makes attribution uncertain and
    halts NAV independently. Seeding here therefore asserts nothing we have not observed. It does
    hold NAV closed until the pin climbs past the old cursor, which is bounded by the pin depth:
    a couple of minutes, not an intervention.
    """
    version = st.get("version")
    if version is None:
        # Only a v1 file has no version key. A later file that lost it -- a truncated or
        # hand-edited write -- would otherwise take the v1 hops, and the v2 hop seeds the
        # ambiguity flags CLEAR: a durable ambiguity silently erased.
        if "ambiguous" in st or "safeAfter" in st:
            sys.exit(f"FATAL: reconciler state {STATE} has no version but carries v2+ fields; it is "
                     "not a v1 file. Restore it from a backup or rebuild from the deployment blocks")
        version = 1
    if version == STATE_VERSION:
        return st, None
    if version not in (1, 2, 3):
        sys.exit(f"FATAL: reconciler state {STATE} has unsupported version {version!r}")

    notes = []
    if version < 2:
        st["safeAfter"] = {"mezo": st["m"], "eth": st["e"]}
        notes.append("v1: safeAfter seeded from the cursors; NAV stays closed until the pin passes them")
    if version < 3:
        # Seeded CLEAR, and that is a real limitation rather than a safe default. Before this flag
        # existed an unmatched arrival was ignored and left no record, so there is nothing to
        # recover: a direction that was already ambiguous comes back reading clean. The rollout
        # procedure in README.md rebuilds state from the deployment blocks for exactly this reason,
        # and rebuilding reconstructs the flags from the events themselves.
        st["ambiguous"] = {OUT: False, IN: False}
        notes.append("v2: ambiguity flags seeded CLEAR — rebuild from the deployment blocks to reconstruct them")
    if version < 4:
        # A bare amount cannot become a record: its block, tx and native sequence were never
        # stored. Inventing them or dropping the entry would be the silent-clean failure the
        # rebuild procedure exists to prevent.
        if st.get("qOut") or st.get("qIn"):
            sys.exit(f"FATAL: reconciler state {STATE} is v{version} with transfers outstanding, which "
                     "cannot be upgraded to transfer records. Rebuild from the deployment blocks "
                     "(ops/reconciler/README.md, 'Raising the scan depth on a running seat')")
        st["qOut"], st["qIn"], st["foreignIn"], st["tipAt"] = [], [], [], None
        st["pendingOut"], st["pendingIn"] = [], []
        st.pop("inSeqHigh", None)
        notes.append("v3: queues became transfer records (nothing was outstanding)")
    st["version"] = STATE_VERSION
    return st, f"v{version}->v{STATE_VERSION}: " + "; ".join(notes)


def _invalid_state(reason, *, fatal):
    # Stored corruption needs explicit operator recovery. A new, uncommitted
    # candidate instead holds the cursors and uses consistent_tick's RPC fallback.
    if fatal:
        sys.exit(f"FATAL: reconciler state {STATE} is invalid: {reason}")
    raise ValueError(f"reconciler candidate is invalid; cursor held: {reason}")


def _validate_state(st, *, fatal=True):
    """Structural check before a persisted file is trusted as authoritative.

    Parseable JSON is not a valid state. The fields below decide attribution, and a malformed one
    does not announce itself: a negative queue entry makes a total look reconciled that never was,
    and delivered exceeding sent is arithmetic that cannot happen from any sequence of ticks. Both
    would be published as `attributionCertain` and signed by every seat that read the same file.

    Unknown extra keys are left alone -- they are forward-compatible diagnostics, not errors.
    Only uncommitted tick candidates opt out of fatal startup validation.
    """
    if not isinstance(st, dict):
        _invalid_state("not an object", fatal=fatal)
    try:
        for field in ("m", "e", "outDelivered", "inDelivered", "outSent", "inSent"):
            _nonneg_int(st.get(field), field)
        for field in ("qOut", "qIn"):
            queue = st.get(field)
            if not isinstance(queue, list):
                raise ValueError(f"{field} must be a list")
            for i, entry in enumerate(queue):
                if not isinstance(entry, dict):
                    raise ValueError(f"{field}[{i}] must be a transfer record, got {entry!r}")
                _nonneg_int(entry.get("net"), f"{field}[{i}].net")
                _nonneg_int(entry.get("block"), f"{field}[{i}].block")
                if not isinstance(entry.get("tx"), str) or not entry["tx"]:
                    raise ValueError(f"{field}[{i}].tx must be the transaction hash")
                if "seq" not in entry:
                    raise ValueError(f"{field}[{i}] has no seq field (None when the bridge event was not found)")
                if entry["seq"] is not None:
                    _nonneg_int(entry["seq"], f"{field}[{i}].seq")
                if field == "qOut":
                    _nonneg_int(entry.get("gross"), f"{field}[{i}].gross")
        foreign = st.get("foreignIn")
        if not isinstance(foreign, list):
            raise ValueError("foreignIn must be a list")
        for i, entry in enumerate(foreign):
            if not isinstance(entry, dict):
                raise ValueError(f"foreignIn[{i}] must be a record, got {entry!r}")
            for key in ("net", "block", "seq"):
                _nonneg_int(entry.get(key), f"foreignIn[{i}].{key}")
        if st.get("tipAt") is not None:
            _nonneg_int(st["tipAt"], "tipAt")
        for field, keys in (("pendingOut", ("seq", "gross", "net", "block")), ("pendingIn", ("tipPrev", "tipNow", "residual", "block"))):
            if not isinstance(st.get(field), list):
                raise ValueError(f"{field} must be a list")
            for i, entry in enumerate(st[field]):
                if not isinstance(entry, dict):
                    raise ValueError(f"{field}[{i}] must be a record, got {entry!r}")
                for key in keys:
                    _nonneg_int(entry.get(key), f"{field}[{i}].{key}")
                if field == "pendingIn" and entry["tipPrev"] >= entry["tipNow"]:
                    raise ValueError("inbound window has no forward sequence range; "
                                     "rebuild from deployment blocks using consistent RPC reads")
        for fields in (("qIn", "foreignIn"), ("qOut", "pendingOut")):
            seqs = [e["seq"] for field in fields for e in st[field] if e.get("seq") is not None]
            if len(seqs) != len(set(seqs)):
                raise ValueError(f"duplicate sequence in {fields}")
        # The pre-recovery code could advance past a PARTLY explained mint without retaining
        # its residual. Those bytes cannot be recovered from this state: explicitly rebuild.
        if st.get("tipAt") is not None:
            for entry in st["qIn"]:
                seq = entry["seq"]
                if not entry.get("lost") and seq is not None and seq <= st["tipAt"] and not any(
                    p["tipPrev"] < seq <= p["tipNow"] for p in st["pendingIn"]
                ):
                    raise ValueError(f"processed inbound sequence {seq} has no retained mint window; "
                                     "rebuild from deployment blocks")
        if st["outDelivered"] > st["outSent"]:
            raise ValueError(f"outDelivered {st['outDelivered']} exceeds outSent {st['outSent']}")
        if st["inDelivered"] > st["inSent"]:
            raise ValueError(f"inDelivered {st['inDelivered']} exceeds inSent {st['inSent']}")
    except ValueError as ex:
        _invalid_state(str(ex), fatal=fatal)
    return st


def _validate_watermarks(st, *, fatal=True):
    """The v2-only half, checked AFTER migrate() so a v1 file is upgraded rather than condemned.

    Held to the same standard as the rest of the state, for a sharper reason: nav-snapshot's guard
    is `bridgeSafeAfter <= pin`, so a NEGATIVE watermark passes it silently and the guard stops
    existing. That is not a hypothetical shape — it is what a hand-edit or a truncated write
    produces, and neither announces itself.

    A watermark ABOVE its own cursor is wrong in the other direction: it names a bridge transition
    at a block this reconciler has not scanned, which no tick can produce, and it would hold NAV
    closed on evidence that does not exist.
    """
    try:
        version = st.get("version")
        if version != STATE_VERSION:
            raise ValueError(f"version must be {STATE_VERSION} after migration, got {version!r}")
        ambiguous = st.get("ambiguous")
        if not isinstance(ambiguous, dict) or any(not isinstance(ambiguous.get(d), bool) for d in (OUT, IN)):
            raise ValueError(f"ambiguous must carry a boolean for {OUT} and {IN}")
        safe_after = st.get("safeAfter")
        if not isinstance(safe_after, dict):
            raise ValueError("safeAfter must be an object carrying both mezo and eth")
        for leg, cursor in (("mezo", st["m"]), ("eth", st["e"])):
            mark = _nonneg_int(safe_after.get(leg), f"safeAfter.{leg}")
            if mark > cursor:
                raise ValueError(
                    f"safeAfter.{leg} {mark} is ahead of the {leg} cursor {cursor}: it names a bridge "
                    "transition at a block this reconciler has not scanned"
                )
    except ValueError as ex:
        _invalid_state(str(ex), fatal=fatal)
    return st


def _validate_cursors(st, mh, eh):
    """Fatal ONLY when a cursor is ahead of LATEST.

    That is impossible on the chain it claims to describe, so it means the state file belongs to
    another deployment or is corrupt -- do not sign against it.

    A cursor between the safe head and latest is NORMAL and this distinction is what the
    distribution's PR #2 got wrong: it failed on `cursor > safe_head`, which EVERY existing seat
    trips the moment scanConfirmations rises above zero, because every existing cursor sits at the
    head. With systemd Restart=always that is a crash loop, and a stopped reconciler stops NAV.
    Clamping the cursor down instead would be worse than the crash: the skipped range would be
    rescanned and every arrival in it counted twice. Waiting is correct and needs no migration --
    reconciledThrough keeps reporting the older, deeper cursor, which still satisfies
    nav-snapshot's `through >= pin`.
    """
    for leg, cur, latest in (("mezo", st["m"], mh), ("eth", st["e"], eh)):
        if cur > latest:
            sys.exit(
                f"FATAL: {leg} cursor {cur} is ahead of the chain head {latest} -- the state file "
                "is for a different chain or deployment, or it is corrupt. Do not start signing"
            )


def load(mh, eh):
    if os.path.exists(STATE):
        try:
            with open(STATE) as f:
                return json.load(f)
        except (OSError, ValueError) as ex:
            sys.exit(f"FATAL: reconciler state {STATE} cannot be read: {ex}. "
                     "Restore the file or explicitly rebuild from deployment blocks; not a first run")
    # FIRST RUN. The lookback default suits a reconciler that has been running and lost its state
    # file: it re-reads the recent past and picks the queues back up. It is WRONG for a seat that has
    # never run, which is the external-operator case — a transfer that departed more than 1500 Mezo
    # blocks ago is simply invisible to it, so its canonical NAV omits that capital, differs from the
    # rest of the set, and it denies every price-setting task. Fails closed, but the seat never
    # commissions and the reason is not obvious from the outside.
    #
    # So a new seat starts from the DEPLOYMENT blocks instead, before which nothing had ever bridged,
    # and replays forward to the head. That is deterministic and needs no trusted checkpoint from
    # Ditto. Mainnet 2026-08-11: RECON_START_MEZO=11195721 RECON_START_ETH=25775990
    # (`observedAtBlock` in ops/deployments/mainnet-2026-08-11.json).
    start_m = os.getenv("RECON_START_MEZO")
    start_e = os.getenv("RECON_START_ETH")
    m0 = int(start_m) if start_m else max(0, mh - 1500)
    e0 = int(start_e) if start_e else max(0, eh - 400)
    for label, v, latest in (("RECON_START_MEZO", m0, mh), ("RECON_START_ETH", e0, eh)):
        if v > latest:
            sys.exit(f"FATAL: {label}={v} is ahead of the chain head {latest}")
    return {"version": STATE_VERSION, "m": m0, "e": e0, "qOut": [], "qIn": [],
            # Strangers' AssetsLocked to our executor's address, pending at the destination, and
            # the destination tip as of the Mezo cursor (None until first read): settle_inbound.
            "foreignIn": [], "tipAt": None, "pendingOut": [], "pendingIn": [],
            "outDelivered": 0, "inDelivered": 0, "outSent": 0, "inSent": 0,
            # A first run starts before anything had bridged, so no flight can predate the cursor
            # and nothing can be outstanding for an unmatched arrival to have been.
            "safeAfter": {"mezo": m0, "eth": e0},
            "ambiguous": {OUT: False, IN: False}}


def _same(a, b):
    return str(a).lower() == str(b).lower()


def load_template():
    """The AUDITED ownership inventory this reconciler decorates with a `bridge` block.

    Also the place to prove the reconciler and the inventory describe the SAME deployment. They
    are configured independently, and a reconciler pointed at deployment A while writing
    deployment B's inventory would publish a confident, precisely wrong bridge section — every
    field well-formed, every number about the wrong chain state.
    """
    inv = json.load(open(TEMPLATE))
    if not inv.get("complete"):
        raise SystemExit("RECON_TEMPLATE %s is not complete=true; refusing to build on it" % TEMPLATE)
    checks = [
        ("tokens.musdc", inv.get("tokens", {}).get("musdc", {}).get("address"), MEZO.get("musdc")),
        ("tokens.usdc", inv.get("tokens", {}).get("usdc", {}).get("address"), ETH.get("usdc")),
        ("ethereum.receiver", inv.get("ethereum", {}).get("receiver"), ETH.get("receiver")),
    ]
    for field, tmpl, addrs in checks:
        if not (tmpl and addrs and _same(tmpl, addrs)):
            raise SystemExit(
                "RECON_TEMPLATE %s describes a different deployment than RECON_ADDRESSES: %s is "
                "%s in the template, %s in the addresses file" % (TEMPLATE, field, tmpl, addrs)
            )
    # The Mezo executor is where inbound mUSDC lands, so it must be a counted owner or every
    # completed inbound bridge would vanish from NAV the moment we stop calling it in-flight.
    owners = [o.get("address") for o in inv.get("mezo", {}).get("musdcOwners", [])]
    if not any(_same(o, MEZO.get("executor")) for o in owners):
        raise SystemExit(
            "RECON_TEMPLATE %s does not list the Mezo executor %s as an mUSDC owner: inbound "
            "bridge deliveries would leave the in-flight queue and be counted nowhere"
            % (TEMPLATE, MEZO.get("executor"))
        )
    return inv


def build_inventory(template, mb, eb, inflight, certain, note, safe_after):
    """Audited inventory + our `bridge` block. Ownership is copied, never re-derived here.

    `bridgeSafeAfter` closes a window that neither of the 2026-08-30 reviews named: the queue can
    be EMPTY -- attribution certain, nothing in flight -- while the NAV pin, which sits a pin-depth
    in the past, falls inside a crossing that has since COMPLETED. At that pin the money had left
    the source and not yet reached the destination, and `inFlight` computed now is empty, so NAV
    comes out LOW and deposits mint too many shares. A crossing takes ~951s against a pin depth of
    ~144s, so it is reachable rather than theoretical.

    The watermark is the block of the last bridge state transition we observed on that leg, and
    nav-snapshot refuses a pin older than it. It needs no per-transfer block stamps: with the queue
    empty, every flight that started has ended, and the last one ended at or before this block.
    """
    inv = dict(template)
    inv["bridge"] = {
        "attributionCertain": bool(certain), "note": note,
        "reconciledThrough": {"mezo": mb, "eth": eb},
        "bridgeSafeAfter": {"mezo": safe_after["mezo"], "eth": safe_after["eth"]},
        "inFlight": inflight,
    }
    return inv


def _write_durably(path, text):
    """tmp, fsync, rename. Without the fsync a power loss can leave a zero-length file behind a
    rename that already succeeded, and an empty state file is a first run: every transfer in
    flight is forgotten."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def persist_state(st):
    _write_durably(STATE, json.dumps(st))


def write_inventory(inv):
    """Publish the inventory the operators read. Called AFTER persist_state: the state is what
    the next start folds from, so it must be on disk before an inventory describes it. A failed
    publish is logged and RAISED -- swallowed, it left the operators on a stale inventory with
    nothing in the journal but a line; raised, the tick retries the publish from a cursor that
    has already moved and folds nothing twice."""
    b = json.dumps(inv, indent=1)
    for p in (INVENTORY, MIRROR):
        try:
            _write_durably(p, b)
        except Exception as ex:
            log("inventory-write-failed", path=p, error=str(ex))
            raise


QUEUE = {OUT: "qOut", IN: "qIn"}
SENT = {OUT: "outSent", IN: "inSent"}
DELIVERED = {OUT: "outDelivered", IN: "inDelivered"}


def apply_tick(st, leg, departed, arrived):
    """Fold one leg's block range into the durable state. Pure: no chain reads, no clock.

    `leg` names the chain these events were READ ON, and the two directions it touches are
    OPPOSITES. A departure seen on Mezo is money leaving FOR Ethereum, so it joins the outbound
    queue; an arrival seen on Mezo is an Ethereum->Mezo transfer LANDING, so it consumes the
    INBOUND queue. Ethereum is the mirror image. Cross the two and nothing ever matches: every
    transfer strands in flight and NAV is wrong in both directions at once. The whole reason
    this is a function rather than eight lines inside the poll loop is that the mapping below
    can then be asserted directly, which a test over `consume()` alone cannot do.

    DETECTION is asymmetric too, and for a reason in the chains rather than in this code. An
    Ethereum arrival is a real ERC-20 Transfer from the MezoBridge, so `arrived` is a list of
    individual amounts and pairing them is the precise thing to do. A Mezo arrival is a native
    mint inside mezod that emits no Transfer at all, so it can only be observed as one aggregate
    for the whole range (see native_arrivals) and is drained FIFO. Pass an int for the aggregate
    form and a list for the paired form.
    """
    leaving, landing = (OUT, IN) if leg == "mezo" else (IN, OUT)

    for d in departed:
        net = expected_net(d["amount"], leaving)
        st[SENT[leaving]] += d["amount"]  # gross: sent - delivered includes the fees paid
        if net == 0:
            # Worth nothing on arrival, and nothing can arrive to retire it -- so it is counted
            # as sent, logged, and NOT queued. Queued as a zero it made the direction undrainable:
            # the first unmatched arrival while it sat there set `ambiguous`, and only the queue
            # emptying clears that. The dust stopped NAV after all, one tick later.
            log("sub-fee-departure", leg=leg, direction=leaving, amount=d["amount"], tx=d["tx"],
                fee=FEES[leaving]["fee"], action="counted as sent, not queued")
            continue
        entry = {"net": net, "block": d["block"], "tx": d["tx"]}
        if leaving == OUT:
            entry["seq"] = d.get("seq")  # the bridge's unlock sequence; None when not found
            entry["gross"] = d["amount"]
        if leaving == IN:
            entry["seq"] = d.get("seq")  # the native AssetsLocked sequence; None when not found
            tip_at = st.get("tipAt")
            if d.get("lost"):
                entry["lost"], entry["reason"] = True, d["reason"]  # decided by resolve_pending_in
            elif d.get("unresolved"):
                entry["unresolved"] = True  # decided by nothing yet; NAV is closed while it stands
            elif entry["seq"] is not None and tip_at is not None and entry["seq"] <= tip_at:
                # The destination processed this sequence before we learned of the departure
                # (an outage on the Ethereum leg longer than a crossing): its mint, if any, sat
                # in a residual already folded and reported unexplained. Minted, it is in the
                # balance; failed, it is gone -- the in-flight value is zero either way.
                entry["lost"] = True
                entry["reason"] = "processed-before-known"
                log("bridge-processed-before-known", seq=entry["seq"], amount=net, tx=d["tx"], tipAt=tip_at,
                    detail="valued at zero: already in the balance or gone; check the earlier "
                           "bridge-inbound-unexplained event")
        st[QUEUE[leaving]].append(entry)

    if isinstance(arrived, int):
        matched, unmatched = drain_total(st[QUEUE[landing]], arrived, FEES[landing]["tol"])
    else:
        matched, unmatched = consume(st[QUEUE[landing]], arrived, FEES[landing]["tol"])
    st[DELIVERED[landing]] += matched
    return matched, unmatched


def wait_for_heads(mezo_rpcs, eth_rpcs):
    """Both heads, retrying while any leg is unreadable. Startup must fail closed exactly the way
    the steady-state loop does: validating a persisted cursor against a head we could not read is
    how a good state file gets condemned for a network blip."""
    while True:
        mh, eh = head(mezo_rpcs), head(eth_rpcs)
        if mh is not None and eh is not None:
            return mh, eh
        log("heads-unavailable", mezoHead=mh, ethHead=eh, action="startup held")
        time.sleep(POLL)


def update_ambiguity(st, un_out, un_in):
    """Fold this tick's unmatched arrivals into the durable ambiguity flags. Pure: no chain reads,
    no clock. Returns (certain, note, events-to-log).

    An arrival matching nothing is one of two very different things, and the QUEUE tells them apart.

    With that direction's queue EMPTY it cannot be a delivery of ours — there is nothing outstanding
    for it to deliver. It is a swap output, a venue withdrawal, someone else's transfer. Ignore it,
    which is what this file has always done.

    With the queue NON-EMPTY the same arrival is ambiguous, and the module docstring already spells
    out the cost: if it really was our delivery and the fee model could not explain the amount, the
    money is now in the destination balance AND its departure is still sitting in `inFlight`.
    nav-snapshot pushes every in-flight entry onto the asset side while the destination address is
    itself a counted owner, so the transfer is counted TWICE and NAV is OVERSTATED — the direction
    that pays out more than there is.

    So the ambiguity is remembered rather than logged and dropped, and it clears when that direction
    drains, because at that point there is nothing left for the unmatched arrival to have been. One
    flag per direction, set by the unexplained arrival and cleared by the queue emptying: no state
    machine, and no file for a human to edit on a box at 3am.
    """
    events = []
    for direction, unmatched_now in ((OUT, un_out), (IN, un_in)):
        outstanding = [e for e in st[QUEUE[direction]] if not e.get("lost")]
        if direction == IN and st.get("pendingIn"):
            outstanding = outstanding + st["pendingIn"]
            unmatched_now = max(1, unmatched_now)
        if unmatched_now and outstanding:
            if not st["ambiguous"].get(direction):
                events.append(("bridge-ambiguous", {
                    "direction": direction, "unmatched": unmatched_now, "outstanding": len(outstanding),
                    "detail": "an arrival matched nothing while transfers are outstanding; it may be a "
                              "delivery the fee model cannot explain, which would be counted twice. "
                              "NAV is closed until this direction drains",
                }))
            st["ambiguous"][direction] = True
        elif not outstanding and st["ambiguous"].get(direction):
            events.append(("bridge-ambiguity-cleared", {
                "direction": direction,
                "detail": "the direction drained; nothing was left for the unmatched arrival to be",
            }))
            st["ambiguous"][direction] = False

    ambiguous = [d for d in (OUT, IN) if st["ambiguous"].get(d)]
    if not ambiguous:
        return True, "reconciled (fifo)", events
    return False, (
        "unexplained arrival on " + ", ".join(ambiguous) + " while transfers are outstanding; "
        "NAV closed until the direction drains"
    ), events


def read_tick(st, mh, eh, policy, mezo_rpcs, eth_rpcs):
    """EVERY chain read of one tick, before anything is folded.

    Reading and folding used to be interleaved per leg: apply_tick had already queued the
    Ethereum departures when locked_sequences() raised, the cursor stayed put, and the retry
    over the same range queued them again -- one transfer of 100 became inSent 200, with
    attributionCertain still true. Here a failed read raises (logs() does) or returns None (a
    balance was unreadable) with the state untouched, so a retry is a retry and not a second
    counting.

    Returns (mezo, eth), each None when that leg has nothing safe to scan yet, else the range
    and what was read in it.
    """
    # Replay callers can override the module constant after the startup config check.
    # A zero/negative cap would repeat or rewind the cursor instead of catching up.
    if type(MEZO_RANGE_MAX) is not int or MEZO_RANGE_MAX <= 0:
        raise ValueError("RECON_MEZO_RANGE_MAX must be a positive integer")
    if type(ETH_RANGE_MAX) is not int or ETH_RANGE_MAX <= 0:
        raise ValueError("RECON_ETH_RANGE_MAX must be a positive integer")
    _, mezo_range = safe_scan_range(st["m"], mh, policy["mezo"]["scan"])
    _, eth_range = safe_scan_range(st["e"], eh, policy["eth"]["scan"])
    mezo = eth = None
    tip_sig = "getCurrentSequenceTip()(uint256)"
    if mezo_range:
        lo, hi = mezo_range
        hi = min(hi, lo + MEZO_RANGE_MAX - 1)  # bounded: see MEZO_RANGE_MAX
        # Native mints are invisible to a log scan, so the inbound leg is measured as the balance
        # change no Transfer explains. None means a balance read failed or the balance model did
        # not add up: hold the whole tick, because skipping the range loses the arrival for good
        # and NAV would then double-count it forever. Recovers on its own when the endpoints do.
        minted = native_arrivals(mezo_rpcs, MEZO["musdc"], MEZO["executor"], lo, hi, MEZO_STEP)
        if minted is None:
            log("mezo-balance-unreadable", frm=lo - 1, to=hi, action="tick held")
            return None
        # The destination tip at the range's upper bound: the sequences it passed since the
        # previous tick's bound (st["tipAt"]) are the only ones the residual can belong to
        # (settle_inbound). Read at the bound, never at latest -- read at latest it ran ahead of
        # the scan and a live transfer whose mint sat in unscanned blocks was declared lost.
        # Unreadable holds the tick like an unreadable balance: without it the residual cannot be
        # settled. A FIRST run has no previous bound and needs none: it starts from the deployment
        # blocks, before which nothing of ours could have been locked, so every sequence of ours
        # the tip has passed was processed inside this range. (Reading it at lo-1 instead needs
        # archive state weeks back on mainnet and, on a fork, a precompile the stub had not yet
        # replaced -- both held the first tick forever.)
        tip_prev = st.get("tipAt")
        if tip_prev is None:
            tip_prev = 0
        tip_now = uint_call(mezo_rpcs, MEZO["assetsBridge"], tip_sig, block=hi)
        if tip_now is None:
            log("mezo-tip-unreadable", block=hi, action="tick held")
            return None
        deps = departures(mezo_rpcs, MEZO["bridgeMezo"], ETH["chainId"], MEZO["musdc"], ETH["receiver"],
                          lo, hi, MEZO_STEP)
        # The crossing's identity: the precompile's AssetsUnlocked in the same tx as our
        # BridgeSent, paired by log order exactly like the inbound leg's AssetsLocked.
        unlocks = unlock_events(mezo_rpcs, MEZO["assetsBridge"], MEZO["bridgeMezo"], ETH["receiver"], ETH["usdc"],
                                lo, hi, MEZO_STEP) if deps else []
        mezo = {"lo": lo, "hi": hi, "departed": join_sequences(deps, unlocks), "minted": minted,
                "tipPrev": tip_prev, "tip": tip_now}
    if eth_range:
        lo, hi = eth_range
        hi = min(hi, lo + ETH_RANGE_MAX - 1)
        deps = departures(eth_rpcs, ETH["bridgeEth"], MEZO["chainId"], ETH["usdc"], MEZO["executor"],
                          lo, hi, ETH_STEP)
        locks = locked_sequences(eth_rpcs, ETH["mezoBridge"], MEZO["executor"], ETH["usdc"], lo, hi, ETH_STEP)
        locks_paid = incoming(eth_rpcs, ETH["usdc"], ETH["bridgeEth"], ETH["mezoBridge"], lo, hi, ETH_STEP) if deps else []
        deps = join_sequences(deps, locks, locks_paid)
        own_seqs = {d["seq"] for d in deps}
        foreign = [{"net": expected_net(l["amount"], IN), "block": _hexint(l.get("block", lo)),
                    "tx": l["tx"], "seq": l["seq"]}
                   for l in locks if l["seq"] not in own_seqs and expected_net(l["amount"], IN) > 0]
        # Outbound arrivals: the bridge's AssetsUnlockConfirmed joined with the USDC Transfer it
        # made to us in the same tx. A confirmation with no Transfer is an orphan, never an arrival.
        transfers = incoming(eth_rpcs, ETH["usdc"], ETH["mezoBridge"], ETH["receiver"], lo, hi, ETH_STEP)
        confirmations = unlock_confirmations(eth_rpcs, ETH["mezoBridge"], ETH["receiver"], ETH["usdc"], lo, hi, ETH_STEP)
        arrived, orphans = join_arrivals(confirmations, transfers)
        eth = {"lo": lo, "hi": hi, "departed": deps, "arrived": arrived,
               "orphans": orphans, "foreign": foreign}
    return mezo, eth


def fold_tick(st, mezo, eth, source_seq=None):
    """Fold one tick's reads into the durable state. Pure: no chain reads.

    DEPARTURES ON BOTH LEGS FIRST, then arrivals. The Mezo range is where an eth->mezo transfer
    LANDS and the Ethereum range where it DEPARTS; folding Mezo first meant that whenever both
    halves of a crossing fell inside one tick's ranges -- a first run over history, a restart
    after any outage longer than a crossing -- the arrival met an empty queue and was ignored as
    not ours, then the departure was queued with nothing left to retire it. Forever.

    Returns (unmatched outbound arrivals, unmatched inbound arrivals) for update_ambiguity.
    """
    if mezo:
        # A departure whose arrival was already read on the other leg (endpoint lag) is settled
        # on read, never queued -- rc1 dropped the arrival and queued the departure forever.
        deps, events = resolve_pending_out(st, mezo["departed"])
        for event, fields in events:
            log(event, **fields)
        apply_tick(st, "mezo", deps, [])
    if eth:
        deps, events, _ = resolve_pending_in(st, eth["departed"])
        for event, fields in events:
            log(event, **fields)
        apply_tick(st, "eth", deps, [])
        for f in eth.get("foreign", []):
            tip_at = st.get("tipAt")
            if tip_at is not None and f["seq"] <= tip_at and not any(
                p["tipPrev"] < f["seq"] <= p["tipNow"] for p in st["pendingIn"]
            ):
                log("bridge-foreign-processed-before-known", seq=f["seq"], amount=f["net"], tx=f["tx"], tipAt=tip_at)
                continue
            st["foreignIn"].append(dict(f))
            log("bridge-foreign-inbound", seq=f["seq"], amount=f["net"], tx=f["tx"],
                detail="a stranger's lock to our executor's address; its mint will look like ours "
                       "and is settled by sequence order")
    un_out, un_in = 0, 0
    if mezo:
        lost = 0
        if mezo.get("tip") is not None:
            before = st["inDelivered"]
            events = settle_inbound(st, mezo["minted"], mezo.get("tipPrev", st.get("tipAt")), mezo["tip"],
                                    FEES[IN]["tol"], block=mezo["hi"], source_seq=source_seq)
            for event, fields in events:
                log(event, **fields)
            got = st["inDelivered"] - before
            lost = sum(1 for e, _ in events if e == "bridge-processed-undelivered")
            # An unexplained residual is an ambiguity whether or not any money was involved: the
            # count of undecided sequences, not the amount, is what closes NAV.
            un_in += sum(max(1, f.get("unresolved", 0)) for e, f in events if e == "bridge-inbound-unexplained")
        else:
            got, un_in = apply_tick(st, "mezo", [], mezo["minted"])
        st["m"] = mezo["hi"]
        # A confirmed loss is a bridge state transition too -- the entry goes from priced in flight
        # to zero -- and the watermark must cover it, or a pin older than the decision is priced
        # with a write-down from the future while at that pin the money was genuinely in flight.
        if mezo["departed"] or got or lost:
            st["safeAfter"]["mezo"] = mezo["hi"]
        if mezo.get("tip") is None and (got or un_in):
            log("mezo-arrivals", matched=got, unattributed=un_in, mintedObserved=mezo["minted"])
    else:
        # A quiet destination must not prevent evidence from a recovering source settling a
        # retained window. Gross departures were already counted once by apply_tick above.
        events = settle_pending_in(st, FEES[IN]["tol"], source_seq)
        for event, fields in events:
            log(event, **fields)
        un_in = sum(max(1, f.get("unresolved", 0)) for e, f in events if e == "bridge-inbound-unexplained")
    if eth:
        arrived = eth["arrived"]
        if arrived and all(isinstance(a, dict) for a in arrived) or eth.get("orphans"):
            # Sequenced arrivals: the bridge's own confirmation joined with its Transfer. Settled by
            # sequence; a confirmation of OUR sequence with nothing landed closes the direction.
            before = st["outDelivered"]
            events = settle_outbound(st, arrived, FEES[OUT]["tol"])
            for event, fields in events:
                log(event, **fields)
            got = st["outDelivered"] - before
            un_out = orphaned_confirmations(st, eth.get("orphans", []))
        else:
            got, un_out = apply_tick(st, "eth", [], [a["amount"] if isinstance(a, dict) else a for a in arrived])
            if got or un_out:
                log("eth-arrivals", matched=got, unmatched=un_out)
        st["e"] = eth["hi"]
        if eth["departed"] or got:
            st["safeAfter"]["eth"] = eth["hi"]
        if eth["departed"]:
            log("bridge-locked", sequences=[d["seq"] for d in eth["departed"]])
    return un_out, un_in


def _inflight(entry_id, total, haircut):
    return {"id": entry_id, "status": "in-flight", "attribution": "protocol",
            "expectedAmount": str(total), "decimals": 6, "haircutBps": haircut}


def inflight_entries(st, tip):
    """The `inFlight` list nav-snapshot prices. Keyed on entries being outstanding, never on a
    total being positive. Inbound is reported as TWO entries when both states are present -- the
    backlog at face value and the processed-undelivered at the haircut -- because one aggregate
    entry carried one haircut for the whole direction, so a lost transfer and a live one were
    either both haircut or both carried at face value."""
    out = []
    if st["qOut"]:
        out.append(_inflight(OUT, sum(e["net"] for e in st["qOut"]), 0))
    live = [e for e in st["qIn"] if classify_inbound(e, tip) == "backlog"]
    lost = [e for e in st["qIn"] if classify_inbound(e, tip) != "backlog"]
    if live:
        out.append(_inflight(IN, sum(e["net"] for e in live), 0))
    if lost:
        out.append(_inflight(IN + ":processed-undelivered", sum(e["net"] for e in lost), UNDELIVERED_HAIRCUT_BPS))
    return out


def oldest_block(queue):
    """Source block of the oldest outstanding transfer, or None. A stuck transfer used to be
    invisible: the queue carried amounts and nothing else."""
    return min((e["block"] for e in queue if not e.get("lost")), default=None)


def consistent_inbound_reads(st, mezo, eth, source_seq):
    """Reject contradictions BEFORE fold/persist; a retry must reread the same ranges.

    An ordinary ERC20 donation is subtracted by native_arrivals' Transfer accounting. A positive
    native residual without any processed lock is NOT evidence of free cash: it can be missing
    logs or inconsistent pinned RPC state. Never drop it and force attribution certain. Retain
    the old cursors/files and alert until consistent evidence is readable. Incomplete source
    history and genuinely ambiguous candidate sets still follow the durable-window logic.
    """
    windows = list(st["pendingIn"])
    if mezo and mezo.get("tip") is not None:
        lo, hi = mezo.get("tipPrev", st.get("tipAt")), mezo["tip"]
        if lo is not None and hi < lo:
            log("bridge-inbound-read-inconsistent", tipPrev=lo, tipNow=hi,
                action="tick held before fold: destination tip regressed")
            return False
        windows.append({"tipPrev": lo, "tipNow": hi, "residual": mezo["minted"]})
    entries = st["qIn"] + st["foreignIn"]
    if eth:
        entries = entries + eth["departed"] + eth.get("foreign", [])
    for window in windows:
        lo, hi, residual = window["tipPrev"], window["tipNow"], window["residual"]
        if residual <= FEES[IN]["tol"] or lo is None:
            continue
        # The unsequenced transport is only a legacy/test path; production joins bridge logs.
        candidates = any(not e.get("lost") and
                         (e.get("seq") is None or lo < e["seq"] <= hi) for e in entries)
        if hi == lo or (source_seq >= hi and not candidates):
            log("bridge-inbound-read-inconsistent", tipPrev=lo, tipNow=hi, residual=residual,
                sourceThrough=source_seq,
                action="tick held before fold: positive residual without a processed lock; reread, never assume donation")
            return False
    return True


@consistent_tick
def tick(st, mh, eh, policy, template, mezo_rpcs, eth_rpcs):
    """One iteration: read everything, fold, classify at the folded height, persist, publish.
    Returns (certain, note), or None when the tick was held on an unreadable balance. Raises on
    a failed read, persist or publish -- with the state on disk consistent in every case."""
    # A committed tick whose publication failed is retried WITHOUT requiring the RPC to
    # recover. This transient field is never serialized. Restart uses committed cursors.
    if "_pending_inventory" in st:
        inv = st["_pending_inventory"]
        write_inventory(inv)
        del st["_pending_inventory"]
        return inv["bridge"]["attributionCertain"], inv["bridge"]["note"]
    live = st
    st = copy.deepcopy(live)
    reads = read_tick(st, mh, eh, policy, mezo_rpcs, eth_rpcs)
    if reads is None:
        if _read_view.get():
            raise RuntimeError("RPC view incomplete; cursor held for whole-tick retry")
        return None
    mezo, eth = reads
    # Source coverage is evidence, not a latest-head diagnostic. An apparently unique subset
    # is undecidable until ALL locks through the destination tip have been scanned on L1.
    # This read remains before fold; failure cannot mutate/persist a partial tick.
    source_block = eth["hi"] if eth else st["e"]
    source_seq = uint_call(eth_rpcs, ETH["mezoBridge"], "sequence()(uint256)", block=source_block)
    if source_seq is None:
        log("eth-sequence-unreadable", block=source_block, action="tick held")
        if _read_view.get():
            raise RuntimeError("RPC source counter unreadable; cursor held")
        return None
    verify_read_views()
    if not consistent_inbound_reads(st, mezo, eth, source_seq):
        if _read_view.get():
            raise RuntimeError("RPC evidence inconsistent; cursor held for whole-tick retry")
        return None
    un_out, un_in = fold_tick(st, mezo, eth, source_seq=source_seq)

    # Totals cannot go negative — expected nets are clamped at zero — but that was never
    # the whole of attribution, and an earlier version of this comment said it was. An
    # arrival the fee model cannot explain, arriving while transfers are outstanding, is the
    # case that overstates NAV, and update_ambiguity is what now holds it. The flag IS
    # durable, and the earlier objection to a durable flag ("NAV halting until someone edits
    # a file on a box") does not apply: nothing here needs a human to clear it — the
    # direction draining clears it.
    certain, note, events = update_ambiguity(st, un_out, un_in)
    for event, fields in events:
        log(event, **fields)

    # Is an inbound transfer late, or is it gone? Backlog carries at face value; a sequence
    # the destination has already PROCESSED without delivering is haircut, because mezod
    # never reprocesses it and no claim entrypoint exists. Losses are confirmed by
    # settle_inbound at the folded cursor and are durable on the record; the tip here is the
    # one that settlement left behind, so a tick that cannot read the chain restores nothing.
    tip = st.get("tipAt")
    lost = [e for e in st["qIn"] if classify_inbound(e, tip) == "processed-undelivered"]
    if lost:
        note += "; inbound PROCESSED_UNDELIVERED haircut %d bps" % UNDELIVERED_HAIRCUT_BPS
    if tip is not None and source_seq is not None and source_seq != tip:
        # Not our failure and not actionable from here: one unprocessed sequence stalls
        # every later transfer, whoever sent it. Logged so a stall is diagnosable as a
        # global backlog instead of investigated as our calldata for a second time.
        ours = [e["seq"] for e in st["qIn"] if e.get("seq") is not None]
        log("bridge-backlog", sourceSequence=source_seq, destinationTip=tip,
            lag=source_seq - tip, oursAt=max(ours) if ours else None)

    _validate_state(st, fatal=False)
    _validate_watermarks(st, fatal=False)
    inv = build_inventory(template, st["m"], st["e"], inflight_entries(st, tip), certain, note, st["safeAfter"])
    persist_state(st)
    live.clear()
    live.update(st)
    live["_pending_inventory"] = inv
    write_inventory(inv)
    del live["_pending_inventory"]
    return certain, note


def main():
    mezo_rpcs, eth_rpcs = rpcs(MEZO), rpcs(ETH)
    for leg, key, why in (("eth", "mezoBridge", "arrival provenance and the native sequences"),
                          ("mezo", "assetsBridge", "sequence settlement of the inbound leg")):
        if not A[leg].get(key):
            raise SystemExit(f"FATAL: RECON_ADDRESSES {ADDRESSES} lacks {leg}.{key}, needed for {why}")
    template = load_template()
    policy = finality_policy()
    mh, eh = wait_for_heads(mezo_rpcs, eth_rpcs)
    st = load(mh, eh)
    # Migrate before validating: the queue shape depends on the version, and a v3 file with
    # transfers outstanding must be refused with the rebuild named, not as a shape error.
    st, migration = migrate(st)
    _validate_state(st)
    _validate_cursors(st, mh, eh)
    _validate_watermarks(st)
    if migration:
        log("state-migrated", detail=migration, safeAfter=st["safeAfter"])

    # Every endpoint, once, before the first tick. The window is the most recent settled CHUNK on
    # each leg, which is cheap and — on a live deployment — contains our own bridge events.
    for leg_name, pool, cfg, latest, step in (
        ("mezo", mezo_rpcs, MEZO, mh, MEZO_STEP),
        ("eth", eth_rpcs, ETH, eh, ETH_STEP),
    ):
        safe_head, _ = safe_scan_range(0, latest, policy[leg_name]["scan"])
        adapter = cfg.get("bridgeMezo") if leg_name == "mezo" else cfg.get("bridgeEth")
        if not adapter:
            continue
        # Never below the deployment block: before it nothing had bridged, so there is no
        # evidence further back and walking there is a long way to the same answer.
        start_env = os.getenv("RECON_START_MEZO" if leg_name == "mezo" else "RECON_START_ETH")
        floor_block = int(start_env) if start_env else 0
        window = find_evidence_window(pool, adapter, BRIDGE_SENT, safe_head, step, floor_block)
        lo, hi = window if window else (max(floor_block, safe_head - step), safe_head)
        for event, fields in endpoint_canary(pool, leg_name, cfg["chainId"], adapter, BRIDGE_SENT, lo, hi):
            log(event, **fields)
    log("start", mode="real-bridge-fifo", mezoCursor=st["m"], ethCursor=st["e"],
        mezoScanConf=policy["mezo"]["scan"], ethScanConf=policy["eth"]["scan"],
        mezoPinConf=policy["mezo"]["pin"], ethPinConf=policy["eth"]["pin"],
        feeOut=FEES[OUT]["fee"], feeIn=FEES[IN]["fee"], template=TEMPLATE)
    last = None
    while True:
        try:
            result = None
            mh, eh = head(mezo_rpcs), head(eth_rpcs)
            if mh is None or eh is None:
                time.sleep(POLL)
                continue
            result = tick(st, mh, eh, policy, template, mezo_rpcs, eth_rpcs)
            if result is not None:
                certain, _ = result
                fo, fi = sum(e["net"] for e in st["qOut"]), sum(e["net"] for e in st["qIn"])
                if (fo, fi) != last:
                    log("reconciled", mezoBlock=st["m"], ethBlock=st["e"], attributionCertain=certain,
                        outSent=st["outSent"], outDelivered=st["outDelivered"], inFlightMezoToEth=fo,
                        inSent=st["inSent"], inDelivered=st["inDelivered"], inFlightEthToMezo=fi,
                        oldestOutBlock=oldest_block(st["qOut"]), oldestInBlock=oldest_block(st["qIn"]))
                    last = (fo, fi)
        except Exception as ex:
            log("tick-error", error=str(ex)[:160])
        if result is not None and (st["m"] < mh - policy["mezo"]["scan"] or
                                   st["e"] < eh - policy["eth"]["scan"]):
            continue  # catching up in bounded ranges: no pause between them
        time.sleep(POLL)


if __name__ == "__main__":
    main()
