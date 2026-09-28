#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# Is this seat actually ready, or merely running?
#
# `systemctl is-active` and a green /health both answer "the process started", which is a much weaker
# statement than it looks: the operator's startup does not contact either RPC, does not read the NAV
# inventory and does not check the reconciler. A seat can be up, healthy and still deny every
# price-setting task because its bridge attribution has not caught up -- and from the outside that is
# indistinguishable from a broken seat.
#
# This checks the thing that actually gates commissioning: the published inventory declares
# attribution certain, and its reconciled heights have reached both chain heads.
#
#   ops/check-operator-ready.sh [/var/lib/ditto-operator/nav-inventory.json]
#
# exit 0 ready · 1 not ready yet · 2 cannot tell
set -euo pipefail
trap 'echo "UNKNOWN: readiness RPC/configuration read failed"; exit 2' ERR

INV=${1:-/var/lib/ditto-operator/nav-inventory.json}
ETC=${ETC:-/etc/ditto-operator}
# PER-CHAIN, because a block is not a unit of time. The reconciler deliberately trails LATEST by
# RECON_SCAN_CONF_* so a reorg cannot rewrite blocks it has already folded in, so the lag measured
# below is from that SAFE head, not from latest. What remains is polling latency: POLL=12s against
# ~3.6s Mezo blocks is ~3.3 blocks a cycle, and ~1 Ethereum block. These allow a few cycles of drift
# (~1 minute either side) and no more.
#
# Still NOT derived from navAccounting minConfirmations. Three different numbers, and collapsing any
# two of them is how the distribution's PR #2 broke price-setting:
#   scanConfirmations    how far behind latest the reconciler stops (subtracted below)
#   minConfirmations     the minimum finality depth; proposals add maxHealthyLagBlocks
#   READY_MAX_LAG_*      how far behind the safe head a seat may be and still commission (here)
# Mezo's 6-block pin would flap as a readiness bar on a healthy seat: normal drift already exceeds it.
MEZO_LAG=${READY_MAX_LAG_MEZO:-20}
ETH_LAG=${READY_MAX_LAG_ETH:-5}
# Defaults mirror bridge-reconciler.py's SCAN_CONF. Mezo is 0: CometBFT commits are final under the
# consensus assumptions, so there is nothing there for a buffer to protect against.
SCAN_MEZO=${RECON_SCAN_CONF_MEZO:-0}
SCAN_ETH=${RECON_SCAN_CONF_ETH:-5}

# Check the OPERATOR'S OWN configured path, not just the one passed in. A misconfigured
# navAccounting.inventoryFile is invisible at startup: the operator starts, answers /health "ok" and
# only fails when a price-setting task arrives. Verified 2026-08-19 with the file deliberately absent.
CFG=${OPERATOR_CONFIG:-$ETC/operator-config.json}
if [ -f "$CFG" ]; then
  want=$(python3 -c "import json,os,sys;c=json.load(open('$CFG'));f=c.get('navAccounting',{}).get('inventoryFile','');print(f if os.path.isabs(f) else os.path.join(os.path.dirname('$CFG'),f))" 2>/dev/null || true)
  if [ -n "$want" ] && [ "$want" != "$INV" ]; then
    echo "NOT READY: the operator is configured to read $want but the live inventory is $INV."
    echo "           A relative inventoryFile resolves against $ETC — the FROZEN audited template."
    echo "           Set navAccounting.inventoryFile to the reconciler's output under /var/lib."
    exit 1
  fi
fi

[ -f "$INV" ] || { echo "NOT READY: $INV does not exist yet — has the reconciler run?"; exit 1; }
command -v cast >/dev/null || { echo "UNKNOWN: cast not on PATH"; exit 2; }

ADDR=$ETC/reconciler-addresses.json
[ -f "$ADDR" ] || { echo "UNKNOWN: $ADDR missing — run gen-external-operator-config.py first"; exit 2; }
MEZO_RPC=$(python3 -c "import json;print(json.load(open('$ADDR'))['mezo']['rpc'])")
ETH_RPC=$(python3 -c "import json;print(json.load(open('$ADDR'))['eth']['rpc'])")

certain=$(python3 -c "import json;print(json.load(open('$INV')).get('bridge',{}).get('attributionCertain'))")
if [ "$certain" != "True" ]; then
  echo "NOT READY: bridge.attributionCertain=$certain — the reconciler has an unexplained transfer."
  echo "           Check the journal for 'sub-fee-departure' or an unmatched arrival before signing."
  exit 1
fi

# The config stopped being optional the moment READY started meaning "can sign a price": the pin
# depth is what decides whether the watermark is behind the block a proposal would use, and there
# is no honest default for it.
[ -f "$CFG" ] || { echo "UNKNOWN: $CFG missing — cannot read the pin depth this seat signs against"; exit 2; }

# Use the proposer's policy validation and include its healthy-reader lag allowance.
# Otherwise READY accepts watermarks newer than the actual (deeper) proposal pin.
PIN_MODULE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/task-engine/nav-snapshot.mjs
depths=$(node --input-type=module - "$CFG" "$PIN_MODULE" <<'JS'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
try {
  const { pinPolicy } = await import(pathToFileURL(process.argv[3]));
  const policy = JSON.parse(readFileSync(process.argv[2], "utf8")).navAccounting.policy;
  const p = pinPolicy(policy);
  console.log(["mezo", "eth"].map(leg =>
    p.minConfirmations[leg] + p.maxHealthyLagBlocks[leg]).join(" "));
} catch (error) {
  console.error("UNKNOWN: invalid proposal pin policy:", error.message);
  process.exit(2);
}
JS
) || { echo "UNKNOWN: cannot determine proposal pin policy"; exit 2; }
read -r md ed <<<"$depths"

mh=$(cast block-number --rpc-url "$MEZO_RPC")
eh=$(cast block-number --rpc-url "$ETH_RPC")
rm_=$(python3 -c "import json;print(json.load(open('$INV'))['bridge']['reconciledThrough']['mezo'])")
re_=$(python3 -c "import json;print(json.load(open('$INV'))['bridge']['reconciledThrough']['eth'])")

ms=$(( mh > SCAN_MEZO ? mh - SCAN_MEZO : 0 ))
es=$(( eh > SCAN_ETH ? eh - SCAN_ETH : 0 ))

printf 'mezo: reconciled %s / safe %s / latest %s   (lag %s)\n' "$rm_" "$ms" "$mh" "$((ms - rm_))"
printf 'eth : reconciled %s / safe %s / latest %s   (lag %s)\n' "$re_" "$es" "$eh" "$((es - re_))"

mlag=$((ms - rm_)); elag=$((es - re_))

# A cursor ahead of LATEST is impossible and means the state file belongs to another chain or
# deployment, or is corrupt. Ahead of the SAFE head is merely a cursor written before the scan depth
# was raised -- normal, transient, and the reconciler simply waits for the safe head to catch up. Do
# not commission on either, but say which one it is.
if [ "$((mh - rm_))" -lt 0 ] || [ "$((eh - re_))" -lt 0 ]; then
  echo "UNKNOWN: reconciled height is AHEAD of chain head (mezo $((mh - rm_)), eth $((eh - re_)))."
  echo "         The state file is for a different chain/deployment, or corrupt. Do not start signing."
  exit 2
fi
if [ "$mlag" -lt 0 ] || [ "$elag" -lt 0 ]; then
  echo "NOT READY: the cursor is above the safe head (mezo $mlag, eth $elag) -- written before the"
  echo "           scan depth was raised. The reconciler waits it out; nothing to do."
  exit 1
fi

# READY has to mean "this seat can sign a price", not "its cursors look fresh". The watermark is
# the other half of that: nav-snapshot refuses a pin OLDER than bridgeSafeAfter, so a seat can be
# certain, current and still deny every round. That is exactly the state a v1->v2 state migration
# leaves behind — safeAfter is seeded from the cursor, and the pin needs a pin-depth of blocks to
# climb past it — and without this check the seat would report READY throughout.
wm=$(python3 - "$INV" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))["bridge"]
sa = b.get("bridgeSafeAfter")
if not isinstance(sa, dict):
    print("MISSING"); raise SystemExit
try:
    m, e = int(sa["mezo"]), int(sa["eth"])
except Exception:
    print("MALFORMED"); raise SystemExit
print("MISSING" if m < 0 or e < 0 else f"{m} {e}")
PY
)
case "$wm" in
  MISSING|MALFORMED)
    echo "NOT READY: the inventory carries no usable bridgeSafeAfter watermark ($wm)."
    echo "           A reconciler older than state-v2 cannot say whether a snapshot block falls"
    echo "           inside a completed crossing, and nav-snapshot fails closed on it. Upgrade the"
    echo "           reconciler and let it write one tick."
    exit 1 ;;
esac
wm_m=${wm% *}; wm_e=${wm#* }

# The pin a proposal will ACTUALLY use, derived the same way the aggregator derives it — including
# the step this check used to skip.
#
# head-minus-depth is only the first half. computeCanonicalClearingNav then ALIGNS the two pins by
# timestamp: the older of the two becomes the target, and the newer leg is walked back to the block
# at that timestamp. With the generated RC2 policy Ethereum starts 18 blocks (~216s) back, so the
# Mezo pin is aligned further back as well; minConfirmations alone is not the proposed depth.
#
# Skipping that made this check weaker than the thing it claims to predict: it compared the
# watermark against head-6 while the round would use head-40, so a seat could report READY and then
# deny every proposal.
#
# This is a SECOND implementation, and calling it "the same algorithm" would be a claim it cannot
# carry -- it is bash against `cast`, the aggregator is JS against a JSON-RPC batch, and the two
# sample the heads at different moments. What it IS: conservative in the one direction that
# matters. It only ever moves a pin BACKWARDS, so it can refuse a seat the round would have
# accepted and never the reverse. A find-block answer AHEAD of the pin is treated as UNKNOWN rather
# than clamped, because that is the shape a wrong answer takes and clamping it would restore
# exactly the weakness above.
pin_m=$(( mh > md ? mh - md : 0 ))
pin_e=$(( eh > ed ? eh - ed : 0 ))
ts_m=$(cast block "$pin_m" --field timestamp --rpc-url "$MEZO_RPC")
ts_e=$(cast block "$pin_e" --field timestamp --rpc-url "$ETH_RPC")
if [ "$ts_m" -gt "$ts_e" ]; then
  # Mezo is the newer pin: walk it back to Ethereum's timestamp, exactly as the aggregator does.
  aligned=$(cast find-block "$ts_e" --rpc-url "$MEZO_RPC" 2>/dev/null | awk '{print $1}')
  case "$aligned" in
    ''|*[!0-9]*) echo "UNKNOWN: could not align the Mezo pin to the Ethereum timestamp"; exit 2 ;;
  esac
  if [ "$aligned" -gt "$pin_m" ]; then
    echo "UNKNOWN: aligning the Mezo pin moved it FORWARD ($pin_m -> $aligned), which alignment"
    echo "         never does. The endpoint's find-block answer is wrong; do not commission on it."
    exit 2
  fi
  pin_m=$aligned
elif [ "$ts_e" -gt "$ts_m" ]; then
  aligned=$(cast find-block "$ts_m" --rpc-url "$ETH_RPC" 2>/dev/null | awk '{print $1}')
  case "$aligned" in
    ''|*[!0-9]*) echo "UNKNOWN: could not align the Ethereum pin to the Mezo timestamp"; exit 2 ;;
  esac
  if [ "$aligned" -gt "$pin_e" ]; then
    echo "UNKNOWN: aligning the Ethereum pin moved it FORWARD ($pin_e -> $aligned)."
    exit 2
  fi
  pin_e=$aligned
fi
# Use the price verifier's actual predicate, including the UPPER bound and exact-height
# requirement while a transfer carries NAV value. Small lag alone is not proof of READY.
node --input-type=module - "$INV" "$PIN_MODULE" "$pin_m" "$pin_e" <<'JS' || exit 1
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
try {
  const { validateBridgePins } = await import(pathToFileURL(process.argv[3]));
  const inventory = JSON.parse(readFileSync(process.argv[2], "utf8"));
  validateBridgePins(inventory.bridge, {
    mezo: { number: BigInt(process.argv[4]) }, eth: { number: BigInt(process.argv[5]) },
  });
} catch (error) {
  console.error("NOT READY:", error.message);
  process.exit(1);
}
JS

if [ "$mlag" -gt "$MEZO_LAG" ] || [ "$elag" -gt "$ETH_LAG" ]; then
  echo "NOT READY: still catching up (allowed: mezo $MEZO_LAG, eth $ETH_LAG)."
  echo "           Leave the reconciler running; this closes on its own."
  exit 1
fi

# A seat can be perfectly ready to VERIFY and still be reporting into a hole. docs/ONBOARD.md tells
# you to point REPORT_URL at a local sink before the WireGuard exchange exists, which is right --
# but a seat left on that value after enrolment verifies every proposal correctly and posts its
# verdict nowhere, and to the aggregator that is indistinguishable from a seat that never answers.
# Warned, not fatal: the loopback value is CORRECT during the documented dry run, and a readiness
# check that fails the procedure it ships with is a check people learn to ignore.
if [ -f "$CFG" ]; then
  report=$(python3 -c "import json;print(json.load(open('$CFG')).get('reportUrl',''))" 2>/dev/null || true)
  case "$report" in
    *//127.0.0.1[:/]*|*//localhost[:/]*|*//\[::1\][:/]*|*//127.0.0.1|*//localhost|*//\[::1\])
      echo "WARNING: reportUrl is $report — a loopback sink, not Ditto's aggregator."
      echo "         Correct before enrolment: re-run gen-external-operator-config.py with the real"
      echo "         REPORT_URL. Until you do, this seat's verdicts reach nobody."
      ;;
  esac
fi

echo "READY: attribution certain, watermarks behind the pin, mezo within $MEZO_LAG and eth within $ETH_LAG blocks of safe head."
