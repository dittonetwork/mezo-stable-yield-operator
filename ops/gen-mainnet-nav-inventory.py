#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Generate the MAINNET NAV inventory from a deployment, verifying every address on chain.

The inventory is the list of custody addresses `recomputeCanonicalNav` sums balances over, and
every operator loads the same file. It is the ONE input consensus structurally cannot check: if
the list is wrong, all five operators re-derive the same confidently wrong price and sign it. No
exact-match rule helps, because they all agree.

`ops/nav-accounting-mainnet.snapshot.json` is what that failure looks like in practice — it
asserted `"complete": true` while listing a superseded deployment's addresses. It was hand-written.
So this tool exists to make the file DERIVED, and it refuses to emit anything unless the chain
agrees with every address it was handed.

Usage — addresses from the three deploy steps' console output:

    VAULT=0x.. EXECUTOR=0x.. QUEUE=0x.. NAVC=0x.. SWAP_ADAPTER=0x.. BRIDGE_ADAPTER=0x.. \\
    ETH_RECEIVER=0x.. VENUE_ADAPTER=0x.. \\
    MEZO_RPC=https://.. ETH_RPC=https://.. \\
    python3 ops/gen-mainnet-nav-inventory.py <output-path>

Ditto's own hosts write /etc/ditto-mainnet/nav-inventory.json; an EXTERNAL operator writes
/etc/ditto-operator/nav-inventory.json (or ./config/nav-inventory.json under Compose). The
generator does not care -- but a copied command that writes to the wrong path produces an
inventory the operator then cannot find, which looks like the generator failing.

Add `--allow-unverified` only to inspect what it would write; it then marks the file
`"complete": false`, which the operators treat as unusable, so it cannot be used by accident.
"""
import json
import os
import subprocess
import sys
from config_safety import cast_read, same_address, private_json

# Token and venue constants — these must match script/DeployMainnetPilot.s.sol MainnetCfg.
MUSD = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186"
MUSDC = "0x04671C72Aab5AC02A03c1098314b1BB6B560c197"
USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
VENUE_CLASS_ID = "0x" + b"spark-savings".hex().ljust(64, "0")

FAILURES: list[str] = []


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"{name} is required — take it from the deploy step's console output")
    return v


def call(rpc: str, to: str, sig: str, *args: str) -> str:
    return cast_read([rpc], to, sig, *args)


def head(rpc: str) -> int:
    try:
        result = subprocess.run(["cast", "block-number", "--rpc-url", rpc],
                                capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout.strip().isdigit():
            return int(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    raise SystemExit("FATAL: RPC head unreadable; no inventory written")


def expect(label: str, got: str, want: str) -> None:
    """Every address in the output must be corroborated by the chain, not just supplied."""
    if not same_address(got, want):
        FAILURES.append(f"{label}: chain says {got}, was given {want}")
        print(f"  MISMATCH  {label}: chain={got} given={want}")
    else:
        print(f"  ok        {label} = {want}")


def main() -> None:
    allow_unverified = "--allow-unverified" in sys.argv
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_path = argv[0] if argv else sys.exit("usage: gen-mainnet-nav-inventory.py <output.json> [--allow-unverified]")

    mezo_rpc, eth_rpc = env("MEZO_RPC"), env("ETH_RPC")
    vault, executor = env("VAULT"), env("EXECUTOR")
    queue, navc = env("QUEUE"), env("NAVC")
    swap, bridge = env("SWAP_ADAPTER"), env("BRIDGE_ADAPTER")
    receiver, venue_adapter = env("ETH_RECEIVER"), env("VENUE_ADAPTER")

    # Getter names taken from the compiled ABIs, not guessed. Two of them are not what you would
    # assume and a first draft of this file had both wrong: the vault exposes `queue()` rather than
    # `withdrawalQueue()`, and the receiver names its Mezo counterparty
    # `mezoFulfillmentRecipient()` rather than `mezoExecutor()`.
    print("=== verifying the Mezo leg against the chain ===")
    expect("vault.executor()", call(mezo_rpc, vault, "executor()(address)"), executor)
    expect("vault.queue()", call(mezo_rpc, vault, "queue()(address)"), queue)
    expect("vault.nav()", call(mezo_rpc, vault, "nav()(address)"), navc)
    expect("vault.asset()", call(mezo_rpc, vault, "asset()(address)"), MUSD)
    expect("executor.vault()", call(mezo_rpc, executor, "vault()(address)"), vault)
    expect("executor.queue()", call(mezo_rpc, executor, "queue()(address)"), queue)
    expect("executor.navConsumer()", call(mezo_rpc, executor, "navConsumer()(address)"), navc)
    expect("executor.swapAdapter()", call(mezo_rpc, executor, "swapAdapter()(address)"), swap)
    expect("executor.bridgeAdapter()", call(mezo_rpc, executor, "bridgeAdapter()(address)"), bridge)
    expect("executor.musd()", call(mezo_rpc, executor, "musd()(address)"), MUSD)
    expect("executor.musdc()", call(mezo_rpc, executor, "musdc()(address)"), MUSDC)

    print("=== verifying the Ethereum leg, and that the two legs point at each other ===")
    expect("receiver.usdc()", call(eth_rpc, receiver, "usdc()(address)"), USDC)
    # The two cross-chain links. These are what make a mixed-up pair of deployments detectable:
    # each leg names the other, and a wrong inventory almost always breaks one of these first.
    expect("executor.ethReceiver()  -> the Ethereum leg",
           call(mezo_rpc, executor, "ethReceiver()(address)"), receiver)
    expect("receiver.mezoFulfillmentRecipient()  -> the Mezo leg",
           call(eth_rpc, receiver, "mezoFulfillmentRecipient()(address)"), executor)

    # venueClass returns a flat tuple; call() keeps only the first token, so read it whole.
    #
    # Do NOT index this positionally as printed. `cast` annotates large integers with a bracketed
    # scientific form as a SEPARATE whitespace token — `86400 [8.64e4]` — so the adapter sat at
    # index 5, not 4, and a first draft of this file reported a live, correctly-wired deployment as
    # a mismatch. Drop the annotations, then index.
    vc_out = subprocess.run(
        ["cast", "call", receiver, "venueClass(bytes32)(uint64,uint64,uint16,uint16,address,bool)",
         VENUE_CLASS_ID, "--rpc-url", eth_rpc], capture_output=True, text=True)
    fields = [t for t in vc_out.stdout.split() if not (t.startswith("[") and t.endswith("]"))]
    # (unbondWindowSecs, redemptionSlaSecs, bufferTargetBps, navHaircutBps, adapter, enabled)
    if len(fields) == 6 and fields[4].lower() == venue_adapter.lower() and fields[5] == "true":
        print(f"  ok        receiver.venueClass(spark-savings) -> adapter {venue_adapter}, enabled, "
              f"sla {fields[1]}s")
    else:
        FAILURES.append("receiver.venueClass(spark-savings) does not name an enabled "
                        f"{venue_adapter}: {' '.join(fields) or vc_out.stderr.strip()[:80]}")
        print(f"  MISMATCH  venueClass: {' '.join(fields)[:90] or vc_out.stderr.strip()[:90]}")

    # A fresh deploy is the ONE moment a reconciliation height is honestly the current head: no
    # bridge transfer has ever been made, so there is nothing unreconciled behind it. Never
    # head+margin on a live system — a fixed future number goes stale and froze NAV on the
    # 2026-08-05 testnet pilot.
    #
    # An EXTERNAL operator runs this against the live pilot, where that is no longer true: plenty has
    # bridged. It stays harmless because these heights are a template placeholder — the reconciler
    # overwrites the whole `bridge` block from RECON_START_* and its own cursors, and never reads
    # this value back. But the message used to assert "nothing has bridged yet" to an operator for
    # whom it was plainly false, so it now says what it is instead of what it was written for.
    m_head, e_head = head(mezo_rpc), head(eth_rpc)
    print(f"=== reconciliation heights: PLACEHOLDER, overwritten by the reconciler ===\n"
          f"  mezo {m_head}   eth {e_head}\n"
          f"  These are current heads, written into the TEMPLATE only. They are honest as-is only on\n"
          f"  a fresh deploy. The reconciler replays from RECON_START_* and rewrites `bridge`, so do\n"
          f"  NOT copy this template anywhere as live state.")

    complete = not FAILURES
    inv = {
        "_deployment": "mainnet-pilot-2026-08",
        "_generatedBy": "ops/gen-mainnet-nav-inventory.py — derived and chain-verified, never hand-edited",
        "complete": complete,
        "virtualShares": "1000",
        "tokens": {"musd": {"address": MUSD}, "musdc": {"address": MUSDC}, "usdc": {"address": USDC}},
        "mezo": {
            "vault": vault,
            "withdrawalQueue": queue,
            "musdOwners": [
                {"id": "mezo:vault:musd", "address": vault},
                {"id": "mezo:executor:musd", "address": executor},
                {"id": "mezo:swap-adapter:musd", "address": swap},
                {"id": "mezo:bridge-adapter:musd", "address": bridge},
            ],
            "musdcOwners": [
                {"id": "mezo:executor:musdc", "address": executor},
                {"id": "mezo:swap-adapter:musdc", "address": swap},
                {"id": "mezo:bridge-adapter:musdc", "address": bridge},
            ],
        },
        "ethereum": {
            "receiver": receiver,
            # "onchain", NOT "audited-static". audited-static trusts a human-asserted
            # `adaptersAuditedThrough` block and goes STALE the moment the chain passes it — which it
            # did within minutes of the real deploy, halting every NAV round with "static historical
            # adapter inventory is stale". onchain reads adapterCount()/adapterAt() from the receiver
            # at the pinned block and requires the configured set to match exactly, so it verifies
            # more and cannot expire. The receiver exposes both getters (checked against the live
            # deployment: adapterCount() == 1 == the Spark Savings adapter).
            "registryMode": "onchain",
            "usdcOwners": [{"id": "eth:receiver:usdc", "address": receiver}],
            "adapters": [{"id": "adapter:spark-savings", "address": venue_adapter,
                          "navHaircutBps": 0, "status": "active"}],
        },
        "requireZero": [],
        "bridge": {"attributionCertain": True,
                   "reconciledThrough": {"mezo": str(m_head), "eth": str(e_head)},
                   "inFlight": []},
    }

    if FAILURES and not allow_unverified:
        print("\n=== REFUSING TO WRITE ===")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit("the chain does not corroborate the addresses given; fix the inputs, do not edit the output")

    private_json(out_path, inv)
    print(f"\nwrote {out_path}  complete={complete}")
    if not complete:
        print("  marked complete=false — operators refuse it, which is the intended outcome of an "
              "unverified run")


if __name__ == "__main__":
    main()
