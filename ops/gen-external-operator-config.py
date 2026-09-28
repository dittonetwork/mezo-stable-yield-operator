#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Generate ONE external operator seat's config, on that operator's own host.

Ditto's internal generator cannot be used for this, which is why this file exists: that one writes
five seats to a fixed path, points every seat at 127.0.0.1 and assumes Ditto's own RPC providers. An
external operator runs one seat, on their own machine, on their own endpoints — which is the entire
point of them existing. (That generator is not part of the operator distribution; if you are reading
this in the operator repository, nothing is missing.)

WHAT THIS DOES THAT COPYING A FILE WOULD NOT. The addresses that anchor the deployment are
corroborated against the chain THROUGH THE OPERATOR'S OWN RPCS before anything is written, and
nothing is written if one disagrees. That is not ceremony: an operator who takes Ditto's word for the
address table has not added independence to the set, because where the money is held is the one input
consensus structurally cannot check. Five operators fed a wrong inventory all re-derive the same
confidently wrong price and all sign it.

BE PRECISE ABOUT THE COVERAGE, because "every address is verified" would be false. The wiring checks
below walk the contract graph -- vault -> executor/queue/nav, executor -> verifier/swapAdapter/
ethReceiver, receiver -> verifier/usdc/mezoFulfillmentRecipient/bridgeAdapter -- so anything reachable
from the vault by a getter is proven. NOT proven here, and written from this file's table:

  * the tokens (musd, musdc, usdc) and the venue class id,
  * the venue adapter and the two bridge endpoints used only by the reconciler.

`gen-mainnet-nav-inventory.py`, which you run next, corroborates the venue adapter and token wiring
against the receiver's own venue class -- so between the two, everything in the money path is checked
against the chain.

The swap adapter's pool, its token pair and tick spacing are read on chain. The quoter must report
the same factory as that pool. This checks wiring, not the authenticity of arbitrary quoter code:
a malicious contract can lie about its factory. If you want an
independent check of the deployed contracts themselves, ask Ditto for the audit package -- runtime
code hashes are verified there, and that tooling is not part of this distribution.

Deliberately NOT included, so nobody provisions infrastructure they do not need:
  * `apyEstimator` — aggregator-only (`resolveEthProjectedApyBps` lives in aggregator.mjs and is
    called nowhere else). The operator still needs historical state and logs for reconciliation
    from deployment blocks, including the balance at the preceding block; see ONBOARD.
  * every git-tracked threshold (withdraw triggers, buffer floor, swap policy, economic minimum) —
    `resolveTrackedThresholds` overlays those from the repo, so a host cannot restate or contradict
    them. Their absence here is the mechanism, not an omission.

Usage:

    ADDRESSES_JSON=/path/to/<deployment>.addresses.json \\
    SEAT_INDEX=5 \\
    MEZO_RPC=https://<your-mezo-endpoint> \\
    ETH_RPC=https://<your-ethereum-endpoint> \\
    MEZO_RPC_FALLBACK=https://<second-mezo-endpoint> \\
    ETH_RPC_FALLBACK=https://<second-ethereum-endpoint> \\
    REPORT_URL=http://<aggregator-wireguard-ip>:4500/report \\
    OUT=/etc/ditto-operator \\
    sudo -E python3 ops/gen-external-operator-config.py   # -E keeps the env above

The report URL is **plain http over the WireGuard tunnel**, not https: the aggregator's /report
listener is `node:http` with no TLS (`ops/aggregator/reports.mjs`), so an `https://` URL cannot
connect at all. Confidentiality and authentication come from the tunnel plus the per-seat HMAC, not
from transport TLS.

Use TWO DISTINCT PROVIDERS per chain. The fallbacks are for reads only and exist because a socket
dropping mid-read is indistinguishable from a genuine disagreement: on 2026-08-12 one seat denied a
fix-batch every other seat signed, for exactly that reason. Quorum absorbed it at 4-of-5; a second
unlucky seat would have stalled the round. This is safe against a lying endpoint because a canonical
price is pinned by block number AND hash and verified by exact match, so a wrong history fails the
hash check and the seat denies rather than signs.
"""
import json
import os
import subprocess
import sys
from config_safety import valid_address, same_address, private_json, safe_url, cast_read

# THE DEPLOYMENT RECORD, handed to you by Ditto: `ops/deployment-addresses.py`'s output for the
# deployment you are joining (for the 2026-08-11 pilot, ops/deployments/mainnet-2026-08-11.addresses.json
# in this repository). Required, and deliberately NOT defaulted to any deployment — a default table
# is one deployment's addresses, and a seat run against another deployment would corroborate them
# through its own endpoints, pass every check, and be watching the wrong contracts. Every address in
# the record is re-read from the chain below; a wrong file is refused, not written.
REQUIRED = ("vault", "executor", "queue", "nav", "mezoVerifier", "swapAdapter", "ethBridgeAdapter",
            "mezoBridgeAdapter", "receiver", "ethVerifier", "musd", "musdc", "usdc", "swapPool",
            "swapQuoter", "venueAdapter", "assetsBridge", "mezoBridgeL1")
_rec = os.environ.get("ADDRESSES_JSON")
if not _rec:
    sys.exit("FATAL: ADDRESSES_JSON is required — the deployment record Ditto handed you (see the usage block)")
with open(_rec) as f:
    A = json.load(f)
_missing = sorted(set(REQUIRED) - set(A))
if _missing:
    sys.exit(f"FATAL: ADDRESSES_JSON lacks {_missing} — not a deployment record")
for key in REQUIRED:
    if not valid_address(A[key]):
        sys.exit(f"FATAL: ADDRESSES_JSON {key} is not a nonzero address")
DEPLOYMENT = A.get("deployment", "<unnamed>")
VENUE = "0x" + b"spark-savings".hex().ljust(64, "0")


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"FATAL: {name} is required — see the usage block at the top of this file")
    return v


def call(rpcs, to, sig):
    """Read through the operator's endpoints, trying each in turn.

    Takes the FULL list, not just the primary. An earlier version accepted fallback endpoints, wrote
    them into the config, and then corroborated against the primary alone -- so a fallback that was
    throttled, on the wrong chain, or simply wrong was never exercised until it was serving live
    reads. Checking them at generation time is the cheapest moment to find that out.
    """
    return cast_read(rpcs, to, sig)


# Optional on purpose: the index is assigned by `_enroll` on chain, which happens in step 6, while
# this config is built in step 2. Requiring it here forced operators to invent a number or to run the
# steps out of order. It is metadata in this file -- the aggregator's own config is what binds an
# index to a pubkey -- so leaving it null until enrolment is the honest state.
seat = env("SEAT_INDEX", required=False)
mezo_rpc, eth_rpc = env("MEZO_RPC"), env("ETH_RPC")
report_url = env("REPORT_URL")
out = env("OUT", default="/etc/ditto-operator")
mezo_fb = env("MEZO_RPC_FALLBACK", required=False)
eth_fb = env("ETH_RPC_FALLBACK", required=False)

if seat is not None and seat != "":
    if not str(seat).isdigit() or not (0 <= int(seat) <= 30):
        sys.exit(f"FATAL: SEAT_INDEX must be 0..30 (the aggregator's runtime bitmap limit), got {seat!r}")
    seat = int(seat)
else:
    seat = None
    print("note: SEAT_INDEX unset — written as null. Set it after enrolment assigns one, or leave it:")
    print("      the aggregator config is what binds index to pubkey, not this file.")

mezo_rpcs = [mezo_rpc] + ([mezo_fb] if mezo_fb else [])
eth_rpcs = [eth_rpc] + ([eth_fb] if eth_fb else [])

if not mezo_fb or not eth_fb:
    print("WARNING: no fallback endpoint for", "mezo" if not mezo_fb else "", "eth" if not eth_fb else "")
    print("         One dropped socket then reads as a genuine disagreement and this seat denies a")
    print("         task the rest of the set signs. Strongly recommended: a second, DIFFERENT provider.")

print(f"=== corroborating deployment {DEPLOYMENT} through YOUR endpoints (seat {seat}) ===")
fail = []
for label, rpcs, to, sig, want in [
    ("vault.executor()", mezo_rpcs, A["vault"], "executor()(address)", A["executor"]),
    ("vault.queue()", mezo_rpcs, A["vault"], "queue()(address)", A["queue"]),
    ("vault.nav()", mezo_rpcs, A["vault"], "nav()(address)", A["nav"]),
    ("executor.verifier()", mezo_rpcs, A["executor"], "verifier()(address)", A["mezoVerifier"]),
    ("executor.swapAdapter()", mezo_rpcs, A["executor"], "swapAdapter()(address)", A["swapAdapter"]),
    ("executor.ethReceiver()", mezo_rpcs, A["executor"], "ethReceiver()(address)", A["receiver"]),
    ("receiver.verifier()", eth_rpcs, A["receiver"], "verifier()(address)", A["ethVerifier"]),
    ("receiver.usdc()", eth_rpcs, A["receiver"], "usdc()(address)", A["usdc"]),
    ("receiver.mezoFulfillmentRecipient()", eth_rpcs, A["receiver"],
     "mezoFulfillmentRecipient()(address)", A["executor"]),
    # Read through the ETH leg specifically — see the collision note above.
    ("receiver.bridgeAdapter()", eth_rpcs, A["receiver"], "bridgeAdapter()(address)", A["ethBridgeAdapter"]),
]:
    got = call(rpcs, to, sig)
    ok = same_address(got, want)
    print(f"  {'ok      ' if ok else 'MISMATCH'} {label} = {got}")
    if not ok:
        fail.append(f"{label}: chain says {got}, config says {want}")

# Chain-id check: an endpoint pointed at the wrong network answers every eth_call with 0x for an
# address holding no code there, which would otherwise read as a clean set of mismatches rather than
# the one thing actually wrong.
for leg, rpcs, want_chain in [("mezo", mezo_rpcs, "31612"), ("eth", eth_rpcs, "1")]:
    for rpc in rpcs:  # EVERY endpoint, including fallbacks: a fallback on the wrong chain is a
        # time bomb that only goes off when the primary blips.
        try:
            p = subprocess.run(["cast", "chain-id", "--rpc-url", rpc], capture_output=True, text=True, timeout=15)
        except subprocess.TimeoutExpired:
            fail.append(f"{leg} endpoint {safe_url(rpc)} timed out")
            continue
        got = p.stdout.strip()
        if got != want_chain:
            fail.append(f"{leg} endpoint {safe_url(rpc)} returned the wrong/unreadable chain id, expected {want_chain}")

# Corroborate the quote's market, not just the adapter's address. Factory equality does
# not authenticate arbitrary code; code provenance remains part of deployment review.
pool = call(mezo_rpcs, A["swapAdapter"], "pool()(address)")
if not same_address(pool, A["swapPool"]):
    fail.append("swapAdapter.pool does not match deployment record")
pool_factory = call(mezo_rpcs, A["swapPool"], "factory()(address)")
quoter_factory = call(mezo_rpcs, A["swapQuoter"], "factory()(address)")
if not same_address(pool_factory, quoter_factory):
    fail.append("pool/quoter factory mismatch or unreadable")
tokens = [call(mezo_rpcs, A["swapPool"], sig) for sig in ["token0()(address)", "token1()(address)"]]
if not all(valid_address(t) for t in tokens) or {t.lower() for t in tokens} != {A["musd"].lower(), A["musdc"].lower()}:
    fail.append("pool tokens do not match MUSD/mUSDC")
spacing = call(mezo_rpcs, A["swapPool"], "tickSpacing()(int24)")
if not spacing.isdigit() or not 0 < int(spacing) < 1 << 23:
    fail.append("pool tickSpacing unreadable or invalid")
elif "swapTickSpacing" in A and A["swapTickSpacing"] != int(spacing):
    fail.append("pool tickSpacing does not match deployment record")

if fail:
    print("\n=== REFUSING TO WRITE ===")
    for f in fail:
        print("  -", f)
    print("\nDo not hand-edit around this. A mismatch means either your endpoint is wrong or you are")
    print("looking at a different deployment; both are reasons to stop and ask, not to proceed.")
    sys.exit(1)

os.makedirs(out, exist_ok=True)

cfg = {
    "_generated": f"ops/gen-external-operator-config.py — deployment {DEPLOYMENT} — do not hand-edit; regenerate",
    "_seat": seat,
    "legs": {
        "mezo": {
            "chainId": 31612, "rpcUrl": mezo_rpc,
            "rpcFallbacks": [mezo_fb] if mezo_fb else [],
            "executor": A["executor"], "vault": A["vault"], "nav": A["nav"], "queue": A["queue"],
            "swapAdapter": A["swapAdapter"], "musd": A["musd"], "musdc": A["musdc"],
            "swapPool": A["swapPool"], "swapQuoter": A["swapQuoter"], "swapTickSpacing": int(spacing),
            "verifier": A["mezoVerifier"],
        },
        "eth": {
            "chainId": 1, "rpcUrl": eth_rpc,
            "rpcFallbacks": [eth_fb] if eth_fb else [],
            "receiver": A["receiver"], "usdc": A["usdc"], "venueClassId": VENUE,
            "bridgeAdapter": A["ethBridgeAdapter"], "verifier": A["ethVerifier"],
        },
    },
    # WITHOUT navAccounting an operator silently falls into the legacy NAV path and denies every
    # price-setting task. The shipped matsnet example omits it, which is the trap this file avoids.
    "navAccounting": {
        # ABSOLUTE, and pointing at /var/lib deliberately. The operator resolves a relative path
        # against its own config directory (/etc), which is where the AUDITED TEMPLATE lives -- and
        # the template's `bridge` block is frozen at derivation time. The reconciler publishes the
        # live inventory to /var/lib. Reading the template instead would give this seat a stale
        # bridge attribution: a NAV that looks well-formed, disagrees with the set, and denies every
        # price-setting task for a reason nothing on the host explains.
        "inventoryFile": os.path.join(env("STATE_DIR", default="/var/lib/ditto-operator"), "nav-inventory.json"),
        # See ops/gen-mainnet-configs.py for why these are three numbers and how they constrain
        # each other. The reconciler refuses to start unless
        # scanConfirmations + maxHealthyLagBlocks <= minConfirmations on both legs.
        "policy": {
            "minConfirmations": {"mezo": 6, "eth": 12},
            "maxHealthyLagBlocks": {"mezo": 4, "eth": 6},
            "maxSnapshotAgeSecs": 300,
            "maxCrossChainSkewSecs": 30,
        },
    },
    # Where this seat POSTs its verdict. Required even in shadow mode: the server exits at startup
    # without it, because a shadow seat whose verdict nobody can read is not being commissioned.
    "reportUrl": report_url,
    "adminExpiryMaxSecs": 3600,
    "poolFeeBps": 0,
}

path = os.path.join(out, "operator-config.json")
private_json(path, cfg)
print(f"\nwrote {path}")

# The reconciler reads a DIFFERENT shape from the operator config (per-leg `rpc` + bridge endpoints),
# so emit it here rather than leave the operator to hand-write a file whose key names are only
# discoverable by reading the reconciler's source.
recon_addresses = {
    "mezo": {
        "chainId": 31612, "rpc": mezo_rpc, "rpcFallbacks": [mezo_fb] if mezo_fb else [],
        "musdc": A["musdc"], "executor": A["executor"],
        "assetsBridge": A["assetsBridge"], "bridgeMezo": A["mezoBridgeAdapter"],
    },
    "eth": {
        "chainId": 1, "rpc": eth_rpc, "rpcFallbacks": [eth_fb] if eth_fb else [],
        "usdc": A["usdc"], "receiver": A["receiver"],
        "mezoBridge": A["mezoBridgeL1"], "bridgeEth": A["ethBridgeAdapter"],
    },
}
recon_path = os.path.join(out, "reconciler-addresses.json")
private_json(recon_path, recon_addresses)
print(f"wrote {recon_path}")

start_m = A.get("deployedAtBlock", {}).get("mezo", "<deployedAtBlock.mezo>")
start_e = A.get("deployedAtBlock", {}).get("eth", "<deployedAtBlock.eth>")
print(f"""
NEXT — the inventory, which is NOT optional and NOT shipped with the repo:

    docker compose run --rm \\
      -e VAULT={A['vault']} \\
      -e EXECUTOR={A['executor']} \\
      -e QUEUE={A['queue']} \\
      -e NAVC={A['nav']} \\
      -e SWAP_ADAPTER={A['swapAdapter']} \\
      -e BRIDGE_ADAPTER={A['mezoBridgeAdapter']} \\
      -e ETH_RECEIVER={A['receiver']} \\
      -e VENUE_ADAPTER={A['venueAdapter']} \\
      -e MEZO_RPC=$MEZO_RPC -e ETH_RPC=$ETH_RPC \\
      tools python3 ops/gen-mainnet-nav-inventory.py /config/nav-inventory.json

Derive it on THIS host through YOUR endpoints. Do not accept a copy: the inventory is the list of
custody addresses the canonical NAV sums over, and it is the one input the 4-of-5 threshold cannot
check for you. If it is wrong, every seat re-derives the same wrong price and every seat signs it.

THEN — the reconciler. It is a SUPERVISED SERVICE, not a job and not a timer: bridge-reconciler.py
polls in a `while True:` loop and never returns. compose.yaml already declares it with exactly these
values and starts it before the operator, so normally you just bring the stack up:

    docker compose up -d
    docker compose run --rm tools ops/check-operator-ready.sh /var/lib/ditto-operator/nav-inventory.json

The env it uses, spelled out — note the SPLIT, which the service sandbox enforces
(ReadWritePaths=/var/lib only, so a write under /etc fails at runtime, not at start):

    RECON_ADDRESSES={out}/reconciler-addresses.json      # input
    RECON_TEMPLATE={out}/nav-inventory.json              # input, the AUDITED template — read-only
    RECON_INVENTORY=/var/lib/ditto-operator/nav-inventory.json   # output, what the operator reads
    RECON_MIRROR=/var/lib/ditto-operator/nav-inventory.json      # output
    RECON_STATE=/var/lib/ditto-operator/fifo-cursors.json        # cursors
    RECON_START_MEZO={start_m} RECON_START_ETH={start_e}      # this deployment's blocks

Template and output must be DIFFERENT files. Pointed at one path the reconciler re-reads its own
output and the audited-template property is gone. RECON_START_* are `deployedAtBlock` in the
deployment record you passed as ADDRESSES_JSON — the blocks before which nothing of this deployment
existed. compose.yaml REQUIRES them in the environment (export them, or put them in `.env`); without
them a never-run seat starts ~1500 blocks back and silently misses anything older, which surfaces
only as this seat denying every price-setting task.

Bring BOTH up together, as above -- do not try to hold the operator back until READY. The operator
denies price-setting tasks on its own while attribution is incomplete, which is the real guard;
`depends_on` is start-order only and cannot express "wait for ready" anyway. Expect several minutes
of NOT READY on a first run while the reconciler replays from the deployment blocks.
""".format(out=out))
