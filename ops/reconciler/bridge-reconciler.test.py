#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Matching logic of the bridge attribution reconciler.  python3 ops/reconciler/bridge-reconciler.test.py

The mainnet fee case is UNREACHABLE on testnet (both legs are free there), so these are the
only thing standing between a fee-bearing mainnet bridge and a permanent NAV halt.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# Loaded by path: the ops scripts are hyphenated, which is not an importable module name.
_spec = importlib.util.spec_from_file_location("bridge_reconciler", os.path.join(HERE, "bridge-reconciler.py"))
recon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(recon)

USDC = 1000000
OUT, IN = recon.OUT, recon.IN
TOL_OUT, TOL_IN = recon.FEES[OUT]["tol"], recon.FEES[IN]["tol"]


class ExpectedNet(unittest.TestCase):
    def test_outbound_leg_deducts_the_flat_fee(self):
        self.assertEqual(recon.expected_net(1000 * USDC, OUT), 997 * USDC)

    def test_inbound_leg_is_free(self):
        self.assertEqual(recon.expected_net(1000 * USDC, IN), 1000 * USDC)


class Consume(unittest.TestCase):
    def test_exact_match_on_the_free_leg(self):
        q = [recon.expected_net(123806719, IN)]
        self.assertEqual(recon.consume(q, [123806719], TOL_IN), (123806719, 0))
        self.assertEqual(q, [])

    def test_fee_bearing_departure_is_matched_by_its_net_arrival(self):
        q = [recon.expected_net(1000 * USDC, OUT)]
        delivered, unmatched = recon.consume(q, [997 * USDC], TOL_OUT)
        self.assertEqual((delivered, unmatched), (997 * USDC, 0))
        self.assertEqual(q, [])

    def test_arrival_outside_tolerance_stays_in_flight(self):
        q = [recon.expected_net(1000 * USDC, OUT)]
        self.assertEqual(recon.consume(q, [996 * USDC], TOL_OUT), (0, 1))
        self.assertEqual(q, [997 * USDC])

    def test_unmatched_arrival_is_ignored_not_counted(self):
        q = [500 * USDC]
        self.assertEqual(recon.consume(q, [42 * USDC], TOL_IN), (0, 1))
        self.assertEqual(q, [500 * USDC])

    def test_same_amount_departures_are_consumed_one_per_arrival(self):
        q = [500 * USDC, 500 * USDC]
        self.assertEqual(recon.consume(q, [500 * USDC], TOL_IN), (500 * USDC, 0))
        self.assertEqual(q, [500 * USDC])
        self.assertEqual(recon.consume(q, [500 * USDC], TOL_IN), (500 * USDC, 0))
        self.assertEqual(q, [])

    def test_equidistant_departures_break_the_tie_fifo(self):
        q = [996900000, 997100000]
        self.assertEqual(recon.consume(q, [997 * USDC], TOL_OUT), (997 * USDC, 0))
        self.assertEqual(q, [997100000])

    def test_near_amount_departures_pick_the_closest(self):
        # First-within-tolerance would spend 996.8 on the 996.95 arrival, and the 996.80 arrival
        # that follows is then 0.20 away from the only departure left -- outside tolerance, so
        # BOTH legs strand in flight and NAV never advances. Closest-first pairs them correctly.
        q = [996800000, 997000000]
        delivered, unmatched = recon.consume(q, [996950000, 996800000], 150000)
        self.assertEqual((delivered, unmatched), (996950000 + 996800000, 0))
        self.assertEqual(q, [])

    def test_free_leg_does_not_accept_a_fee_bearing_net(self):
        q_in, q_out = [recon.expected_net(1000 * USDC, IN)], [recon.expected_net(1000 * USDC, OUT)]
        self.assertEqual(recon.consume(q_in, [1000 * USDC], TOL_IN), (1000 * USDC, 0))
        self.assertEqual(recon.consume(q_out, [1000 * USDC], TOL_OUT), (0, 1))
        self.assertEqual(q_out, [997 * USDC])

    def test_overlapping_windows_match_maximally_not_greedily(self):
        # Greedy closest-first hands 996.90 its exact twin, stranding 997.00 outside tolerance of
        # the only departure left. A stranded arrival is money sitting on the destination chain
        # AND still priced as in-flight -- NAV counts it twice.
        q = [996800000, 996900000]
        delivered, unmatched = recon.consume(q, [996900000, 997000000], 150000)
        self.assertEqual((delivered, unmatched), (996900000 + 997000000, 0))
        self.assertEqual(q, [])

    def test_surplus_arrivals_cannot_consume_one_departure_twice(self):
        q = [500 * USDC]
        self.assertEqual(recon.consume(q, [500 * USDC, 500 * USDC], TOL_IN), (500 * USDC, 1))
        self.assertEqual(q, [])


class SubFeeDeparture(unittest.TestCase):
    """A departure worth nothing after the fee. It must not corrupt the total, and it must not
    stop NAV: an earlier version halted valuation for the whole vault until a human edited a
    state file on the host, which is a worse failure than the dust it was reacting to.

    MixBytes scan 2026-09-09, operator H1: the previous fix queued the zero, and `[0]` is a
    non-empty queue. Nothing can ever arrive to retire it, so the direction never drains — and
    the FIRST unmatched arrival while it sits there sets `ambiguous` and nothing clears it. The
    dust did stop NAV after all, one tick later. A zero-net departure is counted as sent and
    logged, but it is not a transfer anyone can match, so it does not enter the queue."""

    def test_a_sub_fee_departure_prices_at_zero_never_negative(self):
        self.assertEqual(recon.expected_net(USDC // 2, OUT), 0)
        self.assertEqual(recon.expected_net(3 * USDC, OUT), 0)

    def test_expected_net_is_never_negative_across_the_fee_boundary(self):
        for amount in range(0, 6 * USDC, 250000):
            self.assertGreaterEqual(recon.expected_net(amount, OUT), 0)

    def test_a_sub_fee_departure_is_counted_as_sent_but_never_queued(self):
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(USDC // 2)], [])
        self.assertEqual(st["qOut"], [], "a zero-net entry can never be matched; it must not be queued")
        self.assertEqual(st["outSent"], USDC // 2)  # still counted as gross sent

    def test_an_unmatched_arrival_after_dust_does_not_latch_ambiguity(self):
        # The reproduced latch: dust departs (nothing can arrive for it), a stray arrival lands
        # while the zero sits in the queue, `ambiguous` is set, and the queue never drains.
        st = _state()
        st["ambiguous"] = {OUT: False, IN: False}
        recon.apply_tick(st, "mezo", [_dep(3 * USDC)], [])
        _, unmatched = recon.apply_tick(st, "eth", [], [42 * USDC])
        certain, _, _ = recon.update_ambiguity(st, un_out=unmatched, un_in=0)
        self.assertTrue(certain, "with nothing outstanding the arrival cannot be ours")
        certain, _, _ = recon.update_ambiguity(st, un_out=0, un_in=0)
        self.assertTrue(certain, "and the next quiet tick must still price")


class FeeToleranceInvariant(unittest.TestCase):
    def test_shipped_config_keeps_every_tolerance_below_its_fee(self):
        for direction, c in recon.FEES.items():
            self.assertGreaterEqual(c["tol"], 0, direction)
            self.assertLess(c["tol"], max(c["fee"], 1), direction)

    def test_a_tolerance_at_or_above_the_fee_refuses_to_start(self):
        # Re-imports the module under a bad RECON_TOL_OUT; the guard is at import time so a
        # misconfigured host dies at startup rather than matching departures by dust.
        env = dict(os.environ, RECON_TOL_OUT="3000000", RECON_FEE_OUT="3000000")
        import subprocess
        r = subprocess.run(["python3", os.path.join(HERE, "bridge-reconciler.py")],
                           env=env, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("strictly below the fee", r.stderr)


class CatchupRangeConfig(unittest.TestCase):
    def test_invalid_runtime_override_refuses_before_reading_or_moving_the_cursor(self):
        for value in (0, -1, True):
            with self.subTest(value=value), _patched(MEZO_RANGE_MAX=value):
                st = _full_state(m=100, e=200)
                before = json.dumps(st, sort_keys=True)
                with self.assertRaisesRegex(ValueError, "RECON_MEZO_RANGE_MAX must be a positive integer"):
                    recon.read_tick(st, 120, 240, POLICY, [], [])
                self.assertEqual(json.dumps(st, sort_keys=True), before)

    def test_invalid_range_refuses_import_before_any_rpc(self):
        driver = "import runpy,sys; runpy.run_path(sys.argv[1], run_name='config_check')"
        for value in ("0", "-1", "not-a-number"):
            with self.subTest(value=value):
                result = subprocess.run(
                    [sys.executable, "-c", driver, os.path.join(HERE, "bridge-reconciler.py")],
                    env=dict(os.environ, RECON_MEZO_RANGE_MAX=value, RECON_ADDRESSES="/nonexistent/addresses.json"),
                    capture_output=True, text=True, timeout=10,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("RECON_MEZO_RANGE_MAX must be a positive integer", result.stderr)


class SettlementMaskOracle(unittest.TestCase):
    def test_fast_paths_agree_with_exhaustive_subsets_including_zero_and_tolerance(self):
        from itertools import product
        for size in range(5):
            for nets in product(range(4), repeat=size):
                sums = [sum(n for i, n in enumerate(nets) if mask >> i & 1) for mask in range(1 << size)]
                for residual in range(sum(nets) + 3):
                    for tol in range(3):
                        fits = [mask for mask, total in enumerate(sums) if abs(total - residual) <= tol]
                        expected = fits[0] if len(fits) == 1 else None
                        self.assertEqual(recon._unique_settlement_mask(nets, residual, tol), expected,
                                         (nets, residual, tol))

    def test_large_unambiguous_histories_do_not_require_enumeration(self):
        for size in (17, 128, 4096):
            with self.subTest(size=size):
                nets = [100] * size
                self.assertEqual(recon._unique_settlement_mask(nets, sum(nets), 0), (1 << size) - 1)
                self.assertEqual(recon._unique_settlement_mask(nets, 0, 0), 0)
                self.assertIsNone(recon._unique_settlement_mask(nets, 100, 0))


class DirectionWiring(unittest.TestCase):
    """The mapping from "chain these events were read on" to "which queue they touch" is
    inverted between departures and arrivals. Tests over consume() alone cannot see it: swapping
    the two queues in the poll loop left the whole matching suite green while every real
    transfer stranded."""

    def test_a_mezo_departure_queues_outbound_and_leaves_inbound_alone(self):
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(1000 * USDC, block=7, tx="0xab")], [])
        self.assertEqual(st["qOut"], [{"net": 997 * USDC, "block": 7, "tx": "0xab", "seq": None, "gross": 1000 * USDC}])
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["outSent"], 1000 * USDC)
        self.assertEqual(st["inSent"], 0)

    def test_an_eth_departure_queues_inbound_at_par_with_its_sequence(self):
        st = _state()
        recon.apply_tick(st, "eth", [_dep(1000 * USDC, block=9, tx="0xcd", seq=21475)], [])
        # Free leg, no fee deducted. The native sequence rides with the entry: classification
        # is per transfer, never one scalar for the whole queue (operator M9/M10).
        self.assertEqual(st["qIn"], [{"net": 1000 * USDC, "block": 9, "tx": "0xcd", "seq": 21475}])
        self.assertEqual(st["qOut"], [])
        self.assertEqual(st["inSent"], 1000 * USDC)

    def test_an_eth_arrival_settles_the_mezo_departure_that_caused_it(self):
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(1000 * USDC)], [])
        matched, unmatched = recon.apply_tick(st, "eth", [], [997 * USDC])
        self.assertEqual((matched, unmatched), (997 * USDC, 0))
        self.assertEqual(st["qOut"], [])
        self.assertEqual(st["outDelivered"], 997 * USDC)
        self.assertEqual(st["inDelivered"], 0)  # the OTHER direction must not have moved

    def test_a_mezo_arrival_settles_the_eth_departure_that_caused_it(self):
        st = _state()
        recon.apply_tick(st, "eth", [_dep(250 * USDC, seq=1)], [])
        matched, unmatched = recon.apply_tick(st, "mezo", [], [250 * USDC])
        self.assertEqual((matched, unmatched), (250 * USDC, 0))
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["inDelivered"], 250 * USDC)
        self.assertEqual(st["outDelivered"], 0)


class NativeMintDetection(unittest.TestCase):
    """External mainnet-readiness review, 2026-08-08. Mezo-token mints happen in mezod, not the
    EVM, so a bridge DELIVERY emits no ERC-20 Transfer and the log scan `incoming()` saw nothing.
    The eth->mezo departure therefore sat in qIn as an in-flight asset forever while the minted
    mUSDC was ALSO counted in mezo:executor:musdc -- NAV over-stated by the delivered amount,
    permanently, in the dangerous direction. The mint is exactly the balance change no Transfer
    explains, so it is recoverable by subtraction without a new contract."""

    def _patch(self, before, after, credits, debits):
        recon.token_balance = lambda pool, token, owner, block: before if block == 99 else after
        recon.transfer_deltas = lambda *a: (credits, debits)

    def setUp(self):
        self._saved = (recon.token_balance, recon.transfer_deltas)

    def tearDown(self):
        recon.token_balance, recon.transfer_deltas = self._saved

    def test_a_delivery_with_no_transfer_event_is_still_found(self):
        # The exact real case: balance rose, no EVM Transfer explains any of it.
        self._patch(before=0, after=250 * USDC, credits=0, debits=0)
        self.assertEqual(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000), 250 * USDC)

    def test_a_swap_output_is_not_mistaken_for_a_bridge_arrival(self):
        # Same balance rise, but a Transfer accounts for all of it -- SWAP_MUSD_TO_USDC_ON_MEZO_N_BRIDGE_TO_ETH's mUSDC
        # lands at the same address. A raw balance delta would have booked this as a delivery
        # and retired an in-flight transfer that is still in the air.
        self._patch(before=0, after=250 * USDC, credits=250 * USDC, debits=0)
        self.assertEqual(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000), 0)

    def test_a_swap_and_a_delivery_in_one_range_separate_cleanly(self):
        self._patch(before=0, after=400 * USDC, credits=150 * USDC, debits=0)
        self.assertEqual(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000), 250 * USDC)

    def test_a_bridge_out_burn_in_the_same_range_does_not_hide_the_delivery(self):
        # Burned 150 (an EVM Transfer debit) and received a 250 native mint: net +100.
        self._patch(before=0, after=100 * USDC, credits=0, debits=150 * USDC)
        self.assertEqual(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000), 250 * USDC)

    def test_an_unreadable_balance_is_unknown_not_zero(self):
        recon.token_balance = lambda *a: None
        recon.transfer_deltas = lambda *a: (0, 0)
        self.assertIsNone(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000))

    def test_an_unexplained_drop_is_unknown_not_zero_arrivals(self):
        # Operator H3. Every Transfer is accounted for and the balance still fell further: the
        # balance model is wrong for this range (an endpoint answered from two different
        # histories, or a debit path we do not model). Any residual computed from it — including
        # a smaller positive one hiding a real mint — is a guess. "Zero arrivals" advanced the
        # cursor past a range whose deliveries are unknown, and a departure whose delivery is
        # skipped stays in flight while the money is counted on the destination: NAV overstated.
        # None holds the cursor, exactly like an unreadable balance.
        self._patch(before=500 * USDC, after=0, credits=0, debits=100 * USDC)
        self.assertIsNone(recon.native_arrivals([], "0xtok", "0xown", 100, 200, 1000))


class DrainTotal(unittest.TestCase):
    """A native mint is only ever known as one aggregate for the block range, so it cannot be
    PAIRED the way consume() pairs individual ERC-20 arrivals. Two deliveries in one range would
    sum to a figure matching neither departure and both would strand in flight."""

    def test_one_aggregate_retires_several_departures_oldest_first(self):
        q = [100 * USDC, 150 * USDC]
        self.assertEqual(recon.drain_total(q, 250 * USDC, TOL_IN), (250 * USDC, 0))
        self.assertEqual(q, [])

    def test_a_partial_aggregate_retires_only_what_it_covers(self):
        q = [100 * USDC, 150 * USDC]
        delivered, left = recon.drain_total(q, 100 * USDC, TOL_IN)
        self.assertEqual((delivered, left), (100 * USDC, 0))
        self.assertEqual(q, [150 * USDC])  # the second is still genuinely in the air

    def test_a_final_dust_shortfall_within_tolerance_still_retires_the_entry(self):
        # Tolerance passed explicitly: the inbound leg's shipped tol is 0 (the free leg), so this
        # is testing drain_total's contract, not the mainnet fee config.
        q = [100 * USDC]
        delivered, left = recon.drain_total(q, 100 * USDC - (TOL_OUT // 2), TOL_OUT)
        self.assertEqual(delivered, 100 * USDC)
        self.assertEqual(q, [])

    def test_a_shortfall_beyond_tolerance_leaves_the_departure_in_flight(self):
        q = [100 * USDC]
        delivered, left = recon.drain_total(q, 50 * USDC, TOL_OUT)
        self.assertEqual(delivered, 0)
        self.assertEqual(q, [100 * USDC])
        self.assertEqual(left, 50 * USDC)

    def test_more_than_the_queue_is_reported_unattributed_not_absorbed(self):
        q = [100 * USDC]
        delivered, left = recon.drain_total(q, 175 * USDC, TOL_IN)
        self.assertEqual(delivered, 100 * USDC)
        self.assertEqual(left, 75 * USDC)  # not ours to book
        self.assertEqual(q, [])

    def test_an_empty_queue_absorbs_nothing(self):
        q = []
        self.assertEqual(recon.drain_total(q, 500 * USDC, TOL_IN), (0, 500 * USDC))


class AggregateArrivalWiring(unittest.TestCase):
    def test_an_int_arrival_drains_the_inbound_queue_and_a_list_still_pairs(self):
        st = _state()
        recon.apply_tick(st, "eth", [_dep(250 * USDC, seq=1)], [])       # departs Ethereum for Mezo
        matched, left = recon.apply_tick(st, "mezo", [], 250 * USDC)  # lands as a native mint
        self.assertEqual((matched, left), (250 * USDC, 0))
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["inDelivered"], 250 * USDC)
        self.assertEqual(st["outDelivered"], 0)

        # The list form must keep working -- the Ethereum leg still reads real Transfer events.
        st2 = _state()
        recon.apply_tick(st2, "mezo", [_dep(1000 * USDC)], [])
        self.assertEqual(recon.apply_tick(st2, "eth", [], [997 * USDC]), (997 * USDC, 0))

    def test_the_event_scan_alone_leaves_a_native_delivery_in_flight_forever(self):
        # The shape of the bug, kept executable. `incoming()` returns [] for a native mint
        # because there is no Transfer to find, so this is what every tick did after a real
        # eth->mezo delivery: qIn never empties, while the minted mUSDC is simultaneously counted
        # in mezo:executor:musdc. Both sides of the same money, in NAV, indefinitely.
        st = _state()
        recon.apply_tick(st, "eth", [_dep(250 * USDC, seq=1)], [])
        recon.apply_tick(st, "mezo", [], [])  # an empty log scan -- what the chain actually gives
        self.assertEqual([e["net"] for e in st["qIn"]], [250 * USDC])
        self.assertEqual(st["inDelivered"], 0)


class InboundClassification(unittest.TestCase):
    """Bridge-reconciliation review, 2026-08-08. mezod's AcceptAssetsLocked needs the first event of
    a batch to equal tip+1 and each later one to increase by exactly one, so ONE unprocessed
    sequence stalls every later transfer whoever sent it -- that is the 2026-08-07 incident, where
    our 21475 sat behind an unrelated EOA's 21471 with the tip at 21470 and the source at 21478.

    The dangerous mode is the other one: a FAILED mint is logged, the tip is ADVANCED, and the event
    is never reprocessed. So tip >= our sequence with nothing delivered means the money is gone, not
    late -- and carrying it at face value overstates NAV forever while withdrawals settle against
    it. These two states must never be conflated."""

    def test_tip_behind_our_sequence_is_a_backlog(self):
        # The real incident's numbers.
        self.assertEqual(recon.classify_inbound(_dep(82537813, seq=21475), 21470), "backlog")

    def test_the_tip_alone_is_not_a_verdict(self):
        # Codex, 9d832cc case 3: a tip past the sequence with the entry still queued was classified
        # processed-undelivered and haircut to zero on that comparison alone. Only a settlement
        # (`lost`, written by settle_inbound from the residual) is a verdict; until then the entry
        # is in flight, and whether NAV may be priced at all is update_ambiguity's call.
        self.assertEqual(recon.classify_inbound(_dep(82537813, seq=21475), 21475), "backlog")
        self.assertEqual(recon.classify_inbound(_dep(82537813, seq=21475), 21480), "backlog")
        self.assertEqual(recon.classify_inbound(dict(_dep(82537813, seq=21475), lost=True), 21480), "processed-undelivered")

    def test_unknown_inputs_stay_a_backlog_and_never_invent_a_haircut(self):
        # No tip read (every RPC down) and no sequence observed for the entry must both fall back
        # to the pre-existing behaviour rather than haircutting real assets on missing data.
        self.assertEqual(recon.classify_inbound(_dep(82537813, seq=21475), None), "backlog")
        self.assertEqual(recon.classify_inbound(_dep(82537813, seq=None), 21480), "backlog")

    def test_a_newer_transfer_does_not_reclassify_an_older_undelivered_one(self):
        # Operator M9. The scalar `inSeqHigh` classified the WHOLE queue by its highest sequence:
        # a second inbound send (seq 21480) raised the bar above the tip, the old failed one
        # (21475, already PROCESSED without delivery) flipped back to "backlog", and its haircut
        # was lifted — NAV overstated by the lost transfer for as long as the newer one was in
        # the air. Classification is per entry.
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21470
        recon.apply_tick(st, "eth", [_dep(82537813, seq=21475), _dep(500 * USDC, seq=21480)], [])
        recon.settle_inbound(st, residual=0, tip_prev=21470, tip_now=21475, tol=0, block=110)  # 21475 processed, nothing landed
        old, new = st["qIn"]
        self.assertEqual(recon.classify_inbound(old, 21475), "processed-undelivered")
        self.assertEqual(recon.classify_inbound(new, 21475), "backlog")
        backlog, undelivered = recon.split_inbound(st["qIn"], 21475)
        self.assertEqual((backlog, undelivered), (500 * USDC, 82537813))

    def test_an_empty_queue_splits_to_nothing(self):
        self.assertEqual(recon.split_inbound([], 21480), (0, 0))

    def test_a_confirmed_loss_survives_an_unreadable_tip(self):
        # Codex review of #36, case 1: a transfer haircut to zero at tip 21475 came back to full
        # value on the next tick when the tip could not be read — attributionCertain=true, NAV
        # up by money that is gone. Missing data must not restore value: the loss is confirmed
        # once (tip past the sequence, entry still queued after folding through that height;
        # mezod never reprocesses) and it is DURABLE on the record.
        st = _full_state(m=100, e=200)
        recon.apply_tick(st, "eth", [_dep(100 * USDC, seq=21475)], [])
        events = recon.settle_inbound(st, residual=0, tip_prev=21470, tip_now=21475, tol=0)
        self.assertTrue(st["qIn"][0]["lost"])
        self.assertEqual([e[0] for e in events], ["bridge-processed-undelivered"])
        self.assertEqual(recon.classify_inbound(st["qIn"][0], None), "processed-undelivered")
        self.assertEqual(recon.classify_inbound(st["qIn"][0], 21470), "processed-undelivered",
                         "not even a tip that has apparently gone backwards restores it")
        self.assertEqual([e["haircutBps"] for e in recon.inflight_entries(st, None)], [recon.UNDELIVERED_HAIRCUT_BPS])


class InboundSettlement(unittest.TestCase):
    """The Mezo leg cannot see WHO minted: a native mint is only the balance residual no Transfer
    explains, and a stranger who bridges USDC to our executor's address produces one that looks
    exactly like ours. What the leg does have is ORDER: mezod processes AssetsLocked sequences
    strictly in order, so the residual over a scanned range is the sum of the SUCCESSFUL mints
    among the sequences the tip passed inside that range — ours and anyone else's addressed to
    us. Settlement is therefore exact: the unique subset of those sequences whose amounts add up
    to the residual minted; the rest failed. Anything else is an ambiguity, not a guess."""

    def _st(self, ours, foreign=(), tip_at=9):
        st = _full_state(m=100, e=200)
        st["tipAt"] = tip_at
        for net, seq in ours:
            st["qIn"].append({"net": net, "block": 1, "tx": f"0x{seq}", "seq": seq})
            st["inSent"] += net
        for net, seq in foreign:
            st["foreignIn"].append({"net": net, "block": 1, "tx": f"0xf{seq}", "seq": seq})
        return st

    def test_every_processed_sequence_minted(self):
        st = self._st([(100 * USDC, 10), (50 * USDC, 11)])
        events = recon.settle_inbound(st, residual=150 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["inDelivered"], 150 * USDC)
        self.assertEqual(st["tipAt"], 11)
        self.assertEqual([e[0] for e in events], ["mezo-arrivals"])

    def test_a_failed_mint_is_lost_and_the_others_settle(self):
        st = self._st([(100 * USDC, 10), (50 * USDC, 11)])
        recon.settle_inbound(st, residual=50 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual([(e["seq"], e.get("lost")) for e in st["qIn"]], [(10, True)])
        self.assertEqual(st["inDelivered"], 50 * USDC)

    def test_unprocessed_sequences_are_untouched(self):
        st = self._st([(100 * USDC, 10), (50 * USDC, 12)])
        recon.settle_inbound(st, residual=100 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual([(e["seq"], e.get("lost")) for e in st["qIn"]], [(12, None)])

    def test_a_strangers_lock_to_our_address_is_settled_from_the_same_residual(self):
        # Their 100 and our 50 both minted: 150 arrived. Without the foreign record the 150
        # would have drained our 50 and left 100 unmatched — or, worse, matched a 100 of ours.
        st = self._st([(50 * USDC, 11)], foreign=[(100 * USDC, 10)])
        recon.settle_inbound(st, residual=150 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["foreignIn"], [])
        self.assertEqual(st["inDelivered"], 50 * USDC, "theirs is not our delivery")

    def test_a_strangers_failed_mint_does_not_take_our_delivery(self):
        st = self._st([(50 * USDC, 11)], foreign=[(100 * USDC, 10)])
        events = recon.settle_inbound(st, residual=50 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["foreignIn"], [], "dropped: not ours, and nothing more will come of it")
        self.assertIn("bridge-foreign-undelivered", [e[0] for e in events])

    def test_a_residual_no_subset_explains_is_unmatched_not_absorbed(self):
        st = self._st([(100 * USDC, 10)])
        events = recon.settle_inbound(st, residual=70 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual([(e["seq"], e.get("lost")) for e in st["qIn"]], [(10, None)], "neither retired nor written off")
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")
        self.assertEqual(events[0][1]["unmatched"], 70 * USDC)

    def test_two_equal_processed_amounts_and_one_mint_is_an_ambiguity(self):
        st = self._st([(100 * USDC, 10), (100 * USDC, 11)])
        events = recon.settle_inbound(st, residual=100 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual([e.get("lost") for e in st["qIn"]], [None, None])
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")
        self.assertIn("ambiguous", events[0][1]["detail"])

    def test_a_rounding_shortfall_within_tolerance_still_settles(self):
        st = self._st([(100 * USDC, 10)])
        recon.settle_inbound(st, residual=100 * USDC - 1000, tip_prev=9, tip_now=10, tol=2000)
        self.assertEqual(st["qIn"], [])

    def test_all_landed_shortcut_must_not_hide_a_second_fit_within_tolerance(self):
        # Both {100} and {100, 1} explain 101 +/- 1: a positive net alone does not
        # prove that the full set is unique once a fee-bearing policy allows tolerance.
        st = self._st([(100, 10), (1, 11)])
        events = recon.settle_inbound(st, residual=101, tip_prev=9, tip_now=11, tol=1)
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual([e.get("lost") for e in st["qIn"]], [None, None])
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")

    def test_zero_landed_shortcut_must_not_hide_a_small_candidate_within_tolerance(self):
        # Both the empty set and {1} fit 0 +/- 1. This is not a proven loss.
        st = self._st([(1, 10)])
        events = recon.settle_inbound(st, residual=0, tip_prev=9, tip_now=10, tol=1)
        self.assertFalse(st["qIn"][0].get("lost", False))
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")

    def test_zero_net_foreign_candidate_is_not_evidence_of_unique_delivery(self):
        st = self._st([(100, 10)], foreign=[(0, 11)])
        events = recon.settle_inbound(st, residual=100, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual(len(st["foreignIn"]), 1)
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")

    def test_a_transfer_the_tip_had_already_passed_when_we_learned_of_it_is_valued_at_zero(self):
        # An outage on the Ethereum leg longer than a crossing: the mint landed in a residual
        # we folded before the departure was read. Whether it minted (already in the balance)
        # or failed (gone), the right in-flight value is zero — and it is flagged for a human.
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21480
        recon.apply_tick(st, "eth", [_dep(100 * USDC, seq=21475)], [])
        self.assertTrue(st["qIn"][0]["lost"])
        self.assertEqual(st["qIn"][0]["reason"], "processed-before-known")

    def test_every_processed_sequence_delivered_settles_without_a_search(self):
        # Codex on 93fbf96: seventeen fully delivered inbound transfers replayed in one range hit
        # the enumeration bound and closed NAV, while the same history processed tick by tick
        # passed. No search is needed when the residual is the sum of EVERY candidate: nets are
        # positive, so no proper subset can reach it -- all minted, uniquely, in O(n).
        n = recon.MAX_SETTLE_CANDIDATES + 1
        st = self._st([(10 * USDC * (i + 1), 10 + i) for i in range(n)])
        events = recon.settle_inbound(st, residual=sum(10 * USDC * (i + 1) for i in range(n)),
                                      tip_prev=9, tip_now=9 + n, tol=0)
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["inDelivered"], sum(10 * USDC * (i + 1) for i in range(n)))
        self.assertEqual([e[0] for e in events], ["mezo-arrivals"])
        self.assertEqual(sorted(events[0][1]["sequences"]), list(range(10, 10 + n)))

    def test_a_sequence_without_a_lock_settles_fifo_from_the_leftover(self):
        # seq=None (no bridge configured) has no place in the order, so it keeps the old
        # behaviour: drained FIFO from whatever residual the ordered settlement left over.
        st = self._st([(100 * USDC, None)])
        recon.settle_inbound(st, residual=100 * USDC, tip_prev=9, tip_now=11, tol=0)
        self.assertEqual(st["qIn"], [])
        self.assertEqual(st["inDelivered"], 100 * USDC)


class LockedSequences(unittest.TestCase):
    """topic1 is the sequence and topic2 the recipient. Pinned against the real stalled transfer
    (Sepolia block 11438368): seq 0x53e3 = 21475, recipient our executor, amount 82537813."""

    EXECUTOR = "0x0775dAB6F31316b6A94607778Ca7177F14Dd1E7A"
    OTHER = "0x1111111111111111111111111111111111111111"
    USDC_ADDR = "0x2dEe9e2ac7c361aB50C5D19111D2B60743C9E9b3"

    def _log(self, seq, recipient, token=USDC_ADDR, tx="0xt1"):
        return {"topics": ["0x" + "00" * 32, hex(seq), recon.pad(recipient), recon.pad(token)],
                "data": "0x" + format(82537813, "064x"), "transactionHash": tx,
                "blockNumber": "0x10", "logIndex": "0x10"}

    def test_only_locks_addressed_to_us_are_ours(self):
        logs = [self._log(21471, self.OTHER), self._log(21475, self.EXECUTOR, tx="0xours"),
                self._log(21476, self.OTHER)]
        with _patched(scan=lambda *a, **k: logs):
            seqs = recon.locked_sequences([], "0xbridge", self.EXECUTOR, self.USDC_ADDR, 1, 2, 100)
        self.assertEqual([(s["seq"], s["tx"], s["amount"], s["logIndex"]) for s in seqs],
                         [(21475, "0xours", 82537813, 16)], "an EOA's stalled deposit is not our transfer")

    def test_a_lock_of_another_token_to_our_address_is_not_ours(self):
        # Operator M11. Recipient alone let any token locked to the executor's address claim a
        # sequence; a lock of the wrong token carried by the same tx would then ride on a
        # departure it does not belong to. topic3 is the token.
        logs = [self._log(21475, self.EXECUTOR, token=self.OTHER)]
        with _patched(scan=lambda *a, **k: logs):
            self.assertEqual(recon.locked_sequences([], "0xb", self.EXECUTOR, self.USDC_ADDR, 1, 2, 100), [])

    def test_the_real_stalled_transfer_decodes_to_21475(self):
        self.assertEqual(int("0x53e3", 16), 21475)
        logs = [self._log(0x53E3, self.EXECUTOR)]
        with _patched(scan=lambda *a, **k: logs):
            got = recon.locked_sequences([], "0xb", self.EXECUTOR, self.USDC_ADDR, 1, 2, 100)
        self.assertEqual([g["seq"] for g in got], [21475])

    def test_sequences_join_departures_by_transaction(self):
        # The adapter's BridgeSent and the bridge's AssetsLocked are emitted by the same tx, the
        # lock BEFORE the BridgeSent (send() calls bridgeERC20 and then emits).
        deps = [_dep(100 * USDC, tx="0xa", logIndex=5), _dep(200 * USDC, tx="0xb", logIndex=8)]
        joined = recon.join_sequences(deps, [{"seq": 21475, "tx": "0xb", "logIndex": 7, "amount": 200 * USDC},
                                             {"seq": 21474, "tx": "0xa", "logIndex": 4, "amount": 100 * USDC}])
        self.assertEqual([d["seq"] for d in joined], [21474, 21475])
        self.assertEqual(deps[0].get("seq", "absent"), "absent", "inputs are not mutated")

    def test_without_a_bridge_to_read_every_departure_carries_none(self):
        deps = [_dep(100 * USDC, tx="0xa", logIndex=5)]
        self.assertEqual([d["seq"] for d in recon.join_sequences(deps, None)], [None])

    def test_two_sends_in_one_transaction_pair_by_log_order(self):
        # Codex review of #36, case 2: keyed on the tx alone, both departures of one transaction
        # took the FIRST lock's sequence — 10, 10 instead of 10, 11. Within a transaction the
        # events interleave lock, sent, lock, sent by log index; that is the pairing.
        deps = [_dep(1 * USDC, tx="0xa", logIndex=5), _dep(2 * USDC, tx="0xa", logIndex=9)]
        locks = [{"seq": 11, "tx": "0xa", "logIndex": 8, "amount": 2 * USDC},
                 {"seq": 10, "tx": "0xa", "logIndex": 4, "amount": USDC}]
        self.assertEqual([d["seq"] for d in recon.join_sequences(deps, locks)], [10, 11])

    def test_a_transaction_whose_events_do_not_pair_is_refused(self):
        # Ambiguity is a refusal, not a pick. Two departures with one lock, or a lock logged
        # AFTER the departure it would pair with, is not a shape our adapter produces.
        deps = [_dep(1 * USDC, tx="0xa", logIndex=5), _dep(2 * USDC, tx="0xa", logIndex=9)]
        with self.assertRaises(ValueError):
            recon.join_sequences(deps, [{"seq": 10, "tx": "0xa", "logIndex": 3, "amount": USDC}])
        with self.assertRaises(ValueError):
            recon.join_sequences(deps, [{"seq": 10, "tx": "0xa", "logIndex": 3, "amount": USDC},
                                        {"seq": 11, "tx": "0xa", "logIndex": 12, "amount": 2 * USDC}])
        with self.assertRaises(ValueError):
            # the bridge is configured and answered, yet a departure has no lock in its tx
            recon.join_sequences([_dep(1 * USDC, tx="0xa", logIndex=5)], [])


class UndeliveredHaircut(unittest.TestCase):
    def test_the_default_haircut_values_an_undelivered_transfer_at_zero(self):
        # nav-estimator applies amount * (10000 - haircutBps) / 10000, so 10000 bps is exactly zero.
        self.assertEqual(recon.UNDELIVERED_HAIRCUT_BPS, 10000)

    def test_a_haircut_entry_survives_the_inventory_round_trip(self):
        infl = [{"id": recon.IN, "status": "in-flight", "attribution": "protocol",
                 "expectedAmount": "82537813", "decimals": 6, "haircutBps": 10000}]
        inv = recon.build_inventory(_TEMPLATE, 10, 20, infl, True, "n", {"mezo": 10, "eth": 20})
        self.assertEqual(inv["bridge"]["inFlight"][0]["haircutBps"], 10000)


class InventoryAuthorship(unittest.TestCase):
    """The reconciler owns the `bridge` block and nothing else. It once re-derived the ownership
    lists too, and dropped four of the audited owners plus their 1000bp haircut on the way."""

    def test_every_audited_field_is_copied_through_untouched(self):
        inv = recon.build_inventory(_TEMPLATE, 10, 20, [], True, "reconciled (fifo)", {"mezo": 10, "eth": 20})
        for k, v in _TEMPLATE.items():
            if k != "bridge":
                self.assertEqual(inv[k], v, k)

    def test_only_the_bridge_block_is_authored(self):
        inv = recon.build_inventory(_TEMPLATE, 10, 20, [], True, "n", {"mezo": 10, "eth": 20})
        self.assertEqual(inv["bridge"]["reconciledThrough"], {"mezo": 10, "eth": 20})
        self.assertNotEqual(inv["bridge"], _TEMPLATE["bridge"])
        self.assertIsNot(inv, _TEMPLATE)
        self.assertEqual(_TEMPLATE["bridge"]["reconciledThrough"]["mezo"], "1")  # template intact

    # Skipped where the fixture is absent — deliberately, because that fixture is NOT exported to
    # external operators. It is the RETIRED snapshot: it asserts `complete: true` while listing a
    # superseded deployment's addresses, which is precisely the failure the inventory generator
    # exists to prevent. Shipping a plausible-looking wrong inventory to seats that would then all
    # re-derive the same wrong price is the one mistake with no consensus defence.
    @unittest.skipUnless(
        os.path.exists(os.path.join(HERE, "..", "nav-accounting-mainnet.snapshot.json")),
        "SKIPPED BY DESIGN on an operator distribution: this fixture is a RETIRED inventory, "
        "deliberately not exported. Your copy is complete.",
    )
    def test_the_shipped_mainnet_inventory_survives_a_round_trip(self):
        audited = json.load(open(os.path.join(HERE, "..", "nav-accounting-mainnet.snapshot.json")))
        inv = recon.build_inventory(audited, 1, 2, [], True, "n", {"mezo": 1, "eth": 2})
        self.assertEqual(len(inv["mezo"]["musdOwners"]), 4)
        self.assertEqual(len(inv["mezo"]["musdcOwners"]), 3)
        self.assertEqual(len(inv["ethereum"]["usdcOwners"]), 2)
        self.assertEqual([a["navHaircutBps"] for a in inv["ethereum"]["adapters"]], [1000, 1000])

    def test_a_template_for_another_deployment_refuses_to_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.json")
            wrong = json.loads(json.dumps(_TEMPLATE))
            wrong["ethereum"]["receiver"] = "0x" + "9" * 40
            json.dump(wrong, open(path, "w"))
            with _patched(TEMPLATE=path):
                with self.assertRaises(SystemExit) as e:
                    recon.load_template()
            self.assertIn("different deployment", str(e.exception))

    def test_a_template_that_does_not_count_the_executor_refuses_to_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.json")
            wrong = json.loads(json.dumps(_TEMPLATE))
            wrong["mezo"]["musdcOwners"] = []
            json.dump(wrong, open(path, "w"))
            with _patched(TEMPLATE=path):
                with self.assertRaises(SystemExit) as e:
                    recon.load_template()
            self.assertIn("mUSDC owner", str(e.exception))


class InFlightReporting(unittest.TestCase):
    def test_an_outstanding_direction_is_reported_at_its_net(self):
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(1000 * USDC, block=5)], [])
        infl = recon.inflight_entries(st, tip=None)
        self.assertEqual(infl, [{"id": OUT, "status": "in-flight", "attribution": "protocol",
                                 "expectedAmount": str(997 * USDC), "decimals": 6, "haircutBps": 0}])

    def test_an_empty_queue_reports_nothing(self):
        self.assertEqual(recon.inflight_entries(_state(), tip=None), [])

    def test_backlog_and_undelivered_inbound_are_reported_separately(self):
        # Operator M9/M10: one aggregate entry carried ONE haircut for the whole direction, so a
        # lost transfer and a live one were either both haircut or both carried at face value.
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21470
        recon.apply_tick(st, "eth", [_dep(82537813, seq=21475), _dep(500 * USDC, seq=21480)], [])
        recon.settle_inbound(st, residual=0, tip_prev=21470, tip_now=21475, tol=0, block=110)
        infl = recon.inflight_entries(st, tip=21475)
        by_id = {e["id"]: e for e in infl}
        self.assertEqual(by_id[IN]["expectedAmount"], str(500 * USDC))
        self.assertEqual(by_id[IN]["haircutBps"], 0)
        lost = by_id[IN + ":processed-undelivered"]
        self.assertEqual((lost["expectedAmount"], lost["haircutBps"]), ("82537813", recon.UNDELIVERED_HAIRCUT_BPS))
        for e in infl:  # every entry keeps the shape nav-snapshot validates
            self.assertEqual((e["status"], e["attribution"], e["decimals"]), ("in-flight", "protocol", 6))

    def test_oldest_outstanding_block_is_visible(self):
        # Operator M13: a stuck outbound transfer was invisible — the queue only carried amounts.
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(1000 * USDC, block=50), _dep(1000 * USDC, block=40)], [])
        self.assertEqual(recon.oldest_block(st["qOut"]), 40)
        self.assertIsNone(recon.oldest_block([]))


def _state():
    return {"m": 0, "e": 0, "qOut": [], "qIn": [], "outDelivered": 0, "inDelivered": 0,
            "outSent": 0, "inSent": 0, "anomalies": []}


def _dep(amount, block=1, tx="0x1", seq="absent", logIndex="absent"):
    """A departure record as departures() reads it off the chain. `seq` only rides on the
    Ethereum leg, where join_sequences() attaches the native AssetsLocked sequence."""
    d = {"amount": amount, "block": block, "tx": tx}
    if seq != "absent":
        d["seq"] = seq
    if logIndex != "absent":
        d["logIndex"] = logIndex
    return d


class _patched:
    """Temporarily swap module-level config on the loaded reconciler."""

    def __init__(self, **kw):
        self.kw, self.old = kw, {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = getattr(recon, k)
            setattr(recon, k, v)

    def __exit__(self, *a):
        for k, v in self.old.items():
            setattr(recon, k, v)


_TEMPLATE = {
    "complete": True,
    "virtualShares": "1000",
    "tokens": {"musd": {"address": "0x" + "1" * 40}, "musdc": {"address": "0x" + "2" * 40},
               "usdc": {"address": "0x" + "3" * 40}},
    "mezo": {"vault": "0x" + "4" * 40,
             "withdrawalQueue": "0x" + "6" * 40,
             "musdOwners": [{"id": "mezo:vault:musd", "address": "0x" + "4" * 40}],
             "musdcOwners": [{"id": "mezo:executor:musdc", "address": "0x" + "7" * 40}]},
    "ethereum": {"receiver": "0x" + "8" * 40, "registryMode": "audited-static",
                 "usdcOwners": [{"id": "eth:receiver:usdc", "address": "0x" + "8" * 40}],
                 "adapters": [{"id": "a", "address": "0x" + "a" * 40, "navHaircutBps": 1000,
                               "status": "active"}]},
    "requireZero": [],
    "bridge": {"attributionCertain": True, "reconciledThrough": {"mezo": "1", "eth": "1"},
               "inFlight": []},
}

# load_template() cross-checks the template against the addresses file; point the module's
# deployment globals at the fixture above so those checks have something coherent to pass on.
recon.MEZO = {"musdc": _TEMPLATE["tokens"]["musdc"]["address"], "executor": "0x" + "7" * 40,
              "chainId": 31612, "bridgeMezo": "0x" + "b" * 40, "assetsBridge": "0x" + "c" * 40}
recon.ETH = {"usdc": _TEMPLATE["tokens"]["usdc"]["address"],
             "receiver": _TEMPLATE["ethereum"]["receiver"],
             "chainId": 1, "bridgeEth": "0x" + "d" * 40, "mezoBridge": "0x" + "e" * 40}
POLICY = {"mezo": {"scan": 0, "pin": 6, "lag": 4}, "eth": {"scan": 5, "pin": 12, "lag": 6}}


class DepartureProvenance(unittest.TestCase):
    """Operator M11 / canonical L2. `send()` on both adapters has no caller gate, and the new
    deployment's config reuses the pilot's adapters, so two stacks — and anyone at all — emit
    `BridgeSent` on the same contract. `departures()` filtered on the destination chain only:
    a stranger's transfer joined OUR queue, was priced as our in-flight capital, and its
    arrival at THEIR address never came to retire it. BridgeSent carries the token (topic2) and
    the recipient (data word 2); a departure is ours only when both are."""

    TOKEN, OTHER_TOKEN = "0x" + "2" * 40, "0x" + "f" * 40
    RECIPIENT, OTHER = "0x" + "8" * 40, "0x" + "9" * 40

    def _log(self, amount, dest=1, token=TOKEN, recipient=RECIPIENT, block=0x1a, tx="0xt"):
        data = "0x" + format(amount, "064x") + format(dest, "064x") + recon.pad(recipient)[2:] + format(0, "064x")
        return {"topics": [recon.BRIDGE_SENT, "0x" + "0" * 64, recon.pad(token)], "data": data,
                "blockNumber": hex(block), "transactionHash": tx, "logIndex": "0x2a"}

    def _departures(self, logs):
        with _patched(scan=lambda *a, **k: logs):
            return recon.departures([], "0xadapter", 1, self.TOKEN, self.RECIPIENT, 1, 2, 100)

    def test_our_departure_is_read_as_a_record(self):
        got = self._departures([self._log(1000 * USDC, block=26, tx="0xabc")])
        self.assertEqual(got, [{"amount": 1000 * USDC, "block": 26, "tx": "0xabc", "logIndex": 42}])

    def test_another_recipient_is_not_ours(self):
        self.assertEqual(self._departures([self._log(1000 * USDC, recipient=self.OTHER)]), [])

    def test_another_token_is_not_ours(self):
        self.assertEqual(self._departures([self._log(1000 * USDC, token=self.OTHER_TOKEN)]), [])

    def test_another_destination_is_not_ours(self):
        self.assertEqual(self._departures([self._log(1000 * USDC, dest=31612)]), [])

    def test_recipient_comparison_is_case_insensitive(self):
        got = self._departures([self._log(5 * USDC, recipient=self.RECIPIENT.upper().replace("0X", "0x"))])
        self.assertEqual(len(got), 1)

    def test_the_node_is_asked_for_our_token_only(self):
        seen = []

        def scan(pool, addr, topics, frm, to, step):
            seen.append((addr, topics))
            return []

        with _patched(scan=scan):
            recon.departures([], "0xadapter", 1, self.TOKEN, self.RECIPIENT, 1, 2, 100)
        self.assertEqual(seen, [("0xadapter", [recon.BRIDGE_SENT, None, recon.pad(self.TOKEN)])])


class ArrivalProvenance(unittest.TestCase):
    """Codex review of #36, case 3. `incoming()` took EVERY USDC Transfer into the receiver as a
    candidate arrival, so a stranger's transfer of the matching amount retired our departure
    with attributionCertain=true, and our real delivery then landed against an empty queue and
    was ignored — in flight for the crossing, unpriced. On the real route both pilot deliveries
    were Transfers FROM the L1 MezoBridge (blocks 25885464 and 25891092), and the receiver's
    other two inbound Transfers were venue withdrawals from 0x944c…: exactly the transfers that
    must never match. The sender is the L1 bridge, or it is not a delivery."""

    BRIDGE = "0xF6680EA3b480cA2b72D96ea13cCAF2cFd8e6908c"
    VENUE = "0x944c7f5e08686117a5bf66be56b2b4bae869642c"
    RECV = "0x7817548BE174C22DecDe831Ea9d514927fD0D286"
    USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

    def _log(self, amount, sender, block):
        return {"topics": [recon.TRANSFER, recon.pad(sender), recon.pad(self.RECV)],
                "data": "0x" + format(amount, "064x"), "blockNumber": hex(block),
                "transactionHash": "0xt", "logIndex": "0x1"}

    def test_the_node_is_asked_for_transfers_from_the_bridge_only(self):
        seen = []

        def scan(pool, addr, topics, frm, to, step):
            seen.append((addr, topics))
            return []

        with _patched(scan=scan):
            recon.incoming([], self.USDC_ADDR, self.BRIDGE, self.RECV, 1, 2, 100)
        self.assertEqual(seen, [(self.USDC_ADDR, [recon.TRANSFER, recon.pad(self.BRIDGE), recon.pad(self.RECV)])])

    def test_the_real_pilot_history_yields_exactly_the_two_bridge_deliveries(self):
        real = [self._log(116807526, self.VENUE, 25791463), self._log(105040261, self.BRIDGE, 25885464),
                self._log(61181408, self.VENUE, 25888941), self._log(814849234, self.BRIDGE, 25891092)]
        with _patched(scan=lambda *a, **k: real):  # a node that ignores the topic filter
            got = recon.incoming([], self.USDC_ADDR, self.BRIDGE, self.RECV, 1, 2, 100)
        self.assertEqual([(r["amount"], r["block"], r["tx"]) for r in got],
                         [(105040261, 25885464, "0xt"), (814849234, 25891092, "0xt")])

    def test_a_strangers_transfer_of_the_matching_amount_does_not_settle_our_departure(self):
        st = _state()
        recon.apply_tick(st, "mezo", [_dep(1000 * USDC)], [])
        with _patched(scan=lambda *a, **k: [self._log(997 * USDC, self.VENUE, 5)]):
            arrived = recon.incoming([], self.USDC_ADDR, self.BRIDGE, self.RECV, 1, 2, 100)
        matched, unmatched = recon.apply_tick(st, "eth", [], [r["amount"] for r in arrived])
        self.assertEqual((matched, unmatched), (0, 0))
        self.assertEqual([e["net"] for e in st["qOut"]], [997 * USDC], "still ours, still in flight")


class Keccak(unittest.TestCase):
    """The bridge indexes a `bytes` recipient, so the topic is keccak256 of the recipient's 20 bytes,
    not the padded address. Python has no keccak (hashlib's sha3 pads differently), and shelling
    out to `cast keccak` for a constant is one more process on the price path; the primitive is
    forty lines and checked here against the standard vectors and a real topic."""

    def test_standard_vectors(self):
        self.assertEqual(recon.keccak256(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(recon.keccak256(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        self.assertEqual(recon.keccak256(b"a" * 200).hex(), recon.keccak256(b"a" * 136 + b"a" * 64).hex())

    def test_the_recipient_topic_is_the_keccak_of_the_address_bytes(self):
        # topic2 of the pilot's real AssetsUnlockConfirmed at Ethereum block 25885464.
        self.assertEqual(recon.recipient_topic("0x7817548BE174C22DecDe831Ea9d514927fD0D286"),
                         "0x320f858e46b6204dd6e407ac0dbea0a3ba08db360801639aa16d0febec207001")


class OutboundSequences(unittest.TestCase):
    """Codex review of #36, round 3: a stranger's crossing through the REAL bridge to our receiver
    passes the sender filter, and amount-within-tolerance would retire our departure. The bridge
    itself gives every crossing one identity on both chains, read off the pilot's real receipts:
    on Mezo the AssetsBridge precompile emits `AssetsUnlocked(seq, recipient, token, sender,
    amount, chain)` in the same tx as our BridgeSent (log 12 before log 13), and on Ethereum the
    L1 MezoBridge emits `AssetsUnlockConfirmed(seq, recipient, token, amount, chain)` (log 426)
    before the USDC Transfer to the recipient (log 429). Sequence 9345 carried 108.040261 gross
    on both sides; 105.040261 landed; the fee, 3.000000, is its own event. Outbound therefore
    settles by sequence and gross amount: no tolerance, no guessing, and a stranger's crossing has
    a different sequence."""

    RECV = "0x7817548BE174C22DecDe831Ea9d514927fD0D286"
    ADAPTER = "0xE03d2DfB535662d2835210DB5909291C8Ccd78F9"
    OTHER = "0x" + "9" * 40
    USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    PRECOMPILE = "0x7B7C000000000000000000000000000000000012"
    BRIDGE = "0xF6680EA3b480cA2b72D96ea13cCAF2cFd8e6908c"

    def _unlocked(self, seq, sender=ADAPTER, amount=108040261, tx="0xu", log_index=12, recipient=RECV):
        data = "0x" + recon.pad(sender)[2:] + format(amount, "064x") + format(0, "064x")
        return {"topics": [recon.MEZO_ASSETS_UNLOCKED, hex(seq), recon.recipient_topic(recipient), recon.pad(self.USDC_ADDR)],
                "data": data, "transactionHash": tx, "logIndex": hex(log_index), "blockNumber": "0x1a"}

    def _confirmed(self, seq, amount=108040261, tx="0xe", log_index=426, block=25885464):
        data = "0x" + format(amount, "064x") + format(0, "064x")
        return {"topics": [recon.L1_UNLOCK_CONFIRMED, hex(seq), recon.recipient_topic(self.RECV), recon.pad(self.USDC_ADDR)],
                "data": data, "transactionHash": tx, "logIndex": hex(log_index), "blockNumber": hex(block)}

    def test_the_node_is_asked_for_unlocks_to_our_receiver_of_our_token(self):
        seen = []

        def scan(pool, addr, topics, frm, to, step):
            seen.append((addr, topics))
            return []

        with _patched(scan=scan):
            recon.unlock_events([], self.PRECOMPILE, self.ADAPTER, self.RECV, self.USDC_ADDR, 1, 2, 100)
        self.assertEqual(seen, [(self.PRECOMPILE, [recon.MEZO_ASSETS_UNLOCKED, None, recon.recipient_topic(self.RECV),
                                                    recon.pad(self.USDC_ADDR)])])

    def test_an_unlock_is_read_with_its_sequence_and_gross_amount(self):
        with _patched(scan=lambda *a, **k: [self._unlocked(9345)]):
            got = recon.unlock_events([], self.PRECOMPILE, self.ADAPTER, self.RECV, self.USDC_ADDR, 1, 2, 100)
        self.assertEqual(got, [{"seq": 9345, "tx": "0xu", "logIndex": 12, "amount": 108040261}])

    def test_an_unlock_sent_by_another_contract_is_not_ours(self):
        with _patched(scan=lambda *a, **k: [self._unlocked(9345, sender=self.OTHER)]):
            self.assertEqual(recon.unlock_events([], self.PRECOMPILE, self.ADAPTER, self.RECV, self.USDC_ADDR, 1, 2, 100), [])

    def test_the_departure_carries_the_sequence_and_the_gross(self):
        deps = recon.join_sequences([_dep(108040261, block=26, tx="0xu", logIndex=13)],
                                    [{"seq": 9345, "tx": "0xu", "logIndex": 12, "amount": 108040261}])
        st = _state()
        recon.apply_tick(st, "mezo", deps, [])
        self.assertEqual(st["qOut"], [{"net": 105040261, "block": 26, "tx": "0xu", "seq": 9345, "gross": 108040261}])
        self.assertEqual(st["outSent"], 108040261)

    def test_confirmations_are_read_from_the_l1_bridge(self):
        seen = []

        def scan(pool, addr, topics, frm, to, step):
            seen.append((addr, topics))
            return [self._confirmed(9345)]

        with _patched(scan=scan):
            got = recon.unlock_confirmations([], self.BRIDGE, self.RECV, self.USDC_ADDR, 1, 2, 100)
        self.assertEqual(seen, [(self.BRIDGE, [recon.L1_UNLOCK_CONFIRMED, None, recon.recipient_topic(self.RECV),
                                                recon.pad(self.USDC_ADDR)])])
        self.assertEqual(got, [{"seq": 9345, "tx": "0xe", "logIndex": 426, "amount": 108040261, "block": 25885464}])

    def test_an_arrival_is_the_confirmation_joined_with_its_transfer(self):
        confirmations = [{"seq": 9345, "tx": "0xe", "logIndex": 426, "amount": 108040261, "block": 25885464}]
        transfers = [{"amount": 105040261, "tx": "0xe", "block": 25885464, "logIndex": 429}]
        arrivals, orphans = recon.join_arrivals(confirmations, transfers)
        self.assertEqual(arrivals, [{"seq": 9345, "gross": 108040261, "net": 105040261, "block": 25885464, "tx": "0xe"}])
        self.assertEqual(orphans, [])

    def test_a_confirmation_without_its_transfer_holds_the_cursor(self):
        confirmations = [{"seq": 9345, "tx": "0xe", "logIndex": 426, "amount": 108040261, "block": 25885464}]
        with self.assertRaisesRegex(ValueError, "incomplete bridge arrival"):
            recon.join_arrivals(confirmations, [])


class OutboundSettlement(unittest.TestCase):
    def _st(self, *entries):
        st = _full_state(m=100, e=200)
        for net, seq in entries:
            st["qOut"].append({"net": net, "block": 1, "tx": f"0x{seq}", "seq": seq, "gross": net + 3 * USDC})
            st["outSent"] += net + 3 * USDC
        return st

    def _arrival(self, seq, net=105040261, gross=108040261, block=25885464):
        return {"seq": seq, "gross": gross, "net": net, "block": block, "tx": f"0xe{seq}"}

    def test_a_delivery_retires_its_own_sequence_only(self):
        st = self._st((105040261, 9345), (105040261, 9346))
        events = recon.settle_outbound(st, [self._arrival(9346)], tol=TOL_OUT)
        self.assertEqual([e["seq"] for e in st["qOut"]], [9345])
        self.assertEqual(st["outDelivered"], 105040261)
        self.assertEqual([e[0] for e in events], ["eth-arrivals"])
        self.assertEqual(events[0][1]["sequences"], [9346])

    def test_a_strangers_crossing_to_our_receiver_does_not_retire_ours(self):
        # Same amount, same recipient, sent through the real bridge by someone else: a different
        # sequence. It is remembered, not matched, and it is not an ambiguity either -- the money
        # is in the receiver's balance, which NAV counts, and nothing of ours is affected.
        st = self._st((105040261, 9345))
        events = recon.settle_outbound(st, [self._arrival(7777)], tol=TOL_OUT)
        self.assertEqual([e["seq"] for e in st["qOut"]], [9345])
        self.assertEqual(st["outDelivered"], 0)
        self.assertEqual([p["seq"] for p in st["pendingOut"]], [7777])
        self.assertEqual([e[0] for e in events], ["bridge-arrival-before-departure"])

    def test_a_departure_read_after_its_arrival_settles_on_read(self):
        # Codex round 3, "late departure and watermark": the Mezo endpoints lag, the Ethereum
        # confirmation is read first. rc1 dropped the arrival and queued the departure forever.
        st = _full_state(m=100, e=200)
        st["pendingOut"] = [self._arrival(9345)]
        recon.fold_tick(st, mezo={"lo": 101, "hi": 110,
                                  "departed": [_dep(108040261, block=105, tx="0xu", seq=9345)], "minted": 0},
                        eth=None)
        self.assertEqual(st["qOut"], [], "delivered on the spot, never queued")
        self.assertEqual((st["outSent"], st["outDelivered"]), (108040261, 105040261))
        self.assertEqual(st["pendingOut"], [])
        # Between the departure on Mezo and the arrival on Ethereum the money was on neither chain
        # and nothing knew it was in flight: a pin in that window prices low. The watermark closes it.
        self.assertEqual(st["safeAfter"], {"mezo": 110, "eth": 25885464})

    def test_the_landed_amount_is_what_counts_and_fee_drift_is_reported(self):
        st = self._st((105040261, 9345))
        events = recon.settle_outbound(st, [self._arrival(9345, net=104500000)], tol=TOL_OUT)
        self.assertEqual(st["qOut"], [])
        self.assertEqual(st["outDelivered"], 104500000, "what landed, not what the fee model expected")
        drift = [e for e in events if e[0] == "bridge-fee-drift"]
        self.assertEqual(len(drift), 1)
        self.assertEqual((drift[0][1]["seq"], drift[0][1]["feePaid"], drift[0][1]["feeExpected"]), (9345, 3540261, 3 * USDC))

    def test_an_orphan_confirmation_closes_the_direction(self):
        # The bridge says it delivered our sequence and no Transfer to us is in that tx: the
        # ledger cannot say what landed. Nothing is retired and the direction is ambiguous.
        st = self._st((105040261, 9345))
        un = recon.orphaned_confirmations(st, [{"seq": 9345, "tx": "0xe", "logIndex": 1, "amount": 108040261, "block": 5}])
        self.assertEqual(un, 1)
        self.assertEqual([e["seq"] for e in st["qOut"]], [9345])


class InboundPending(unittest.TestCase):
    """The inbound twin of the late departure: the Ethereum endpoints lag, the mint is folded from
    the Mezo balance before the AssetsLocked departure is read. The residual is money that landed;
    it is remembered by the tip window it fell in, and a departure read later whose sequence
    falls in that window and whose amount is that residual is delivered on read."""

    def test_a_mint_with_no_known_sequence_is_remembered_by_its_tip_window(self):
        st = _full_state(m=100, e=200)
        st["tipAt"] = 9
        events = recon.settle_inbound(st, residual=100 * USDC, tip_prev=9, tip_now=11, tol=0, block=110)
        self.assertEqual(st["pendingIn"], [{"tipPrev": 9, "tipNow": 11, "residual": 100 * USDC, "block": 110}])
        self.assertEqual(events[0][0], "bridge-inbound-unexplained")

    def test_a_departure_read_late_that_explains_a_window_is_delivered_on_read(self):
        st = _full_state(m=100, e=200)
        st["tipAt"] = 11
        st["pendingIn"] = [{"tipPrev": 9, "tipNow": 11, "residual": 100 * USDC, "block": 110}]
        recon.fold_tick(st, mezo=None,
                        eth={"lo": 201, "hi": 205, "departed": [_dep(100 * USDC, block=203, tx="0xa", seq=10)],
                             "arrived": [], "foreign": []}, source_seq=11)
        self.assertEqual(st["qIn"], [])
        self.assertEqual((st["inSent"], st["inDelivered"]), (100 * USDC, 100 * USDC))
        self.assertEqual(st["pendingIn"], [])
        self.assertEqual(st["safeAfter"]["mezo"], 110)

    def test_a_late_departure_that_does_not_explain_the_window_closes_nav_rather_than_being_written_off(self):
        # 60 read late against a remembered mint of 100: neither {} nor {60} explains the window,
        # so nothing is decided. Writing it off as processed-before-known (an earlier revision)
        # would have published "lost" over a mint that landed; the honest state is undecided, and
        # undecided closes NAV.
        st = _full_state(m=100, e=200)
        st["tipAt"] = 11
        st["pendingIn"] = [{"tipPrev": 9, "tipNow": 11, "residual": 100 * USDC, "block": 110}]
        un_out, un_in = recon.fold_tick(st, mezo=None,
                                        eth={"lo": 201, "hi": 205, "departed": [_dep(60 * USDC, block=203, tx="0xa", seq=10)],
                                             "arrived": [], "foreign": []})
        self.assertEqual([(e["seq"], e.get("lost"), e.get("unresolved")) for e in st["qIn"]], [(10, None, True)])
        self.assertEqual(len(st["pendingIn"]), 1, "the window is still unexplained")
        self.assertFalse(_inventory_of(st, un_out, un_in)["bridge"]["attributionCertain"])


def _pin_admissible(inv, leg, pin):
    """nav-snapshot.mjs's admission rules for a pin, mirrored: attribution certain,
    bridgeSafeAfter <= pin <= reconciledThrough, and with any VALUED transfer in flight the
    ledger must be reconciled exactly at the pin. What the tests below assert is not the queue
    but what a price-setting round would be allowed to sign."""
    b = inv["bridge"]
    if not b["attributionCertain"]:
        return False
    through, safe = int(b["reconciledThrough"][leg]), int(b["bridgeSafeAfter"][leg])
    if through < pin or safe > pin:
        return False
    valued = [t for t in b["inFlight"] if int(t["expectedAmount"]) != 0 and int(t["haircutBps"]) != 10000]
    return not valued or through == pin


def _inventory_of(st, un_out=0, un_in=0):
    certain, note, _ = recon.update_ambiguity(st, un_out, un_in)
    return recon.build_inventory(_TEMPLATE, st["m"], st["e"], recon.inflight_entries(st, st["tipAt"]), certain, note,
                                 st["safeAfter"])


class LossWatermark(unittest.TestCase):
    """Codex review of #36 on 9d832cc, case 1: a confirmed loss is a bridge state transition -- the
    entry goes from priced-in-flight to zero -- and the watermark did not move for it. A pin
    older than the block the loss was decided at then priced the transfer at zero while, at that
    pin, the money was genuinely in flight: a historical snapshot written down from the future."""

    def test_a_confirmed_loss_moves_the_watermark_so_no_earlier_pin_is_written_down(self):
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21474
        recon.apply_tick(st, "eth", [_dep(100 * USDC, block=203, tx="0xa", seq=21475)], [])
        un_out, un_in = recon.fold_tick(st, mezo={"lo": 101, "hi": 110, "departed": [], "minted": 0,
                                                  "tipPrev": 21474, "tip": 21480}, eth=None)
        self.assertTrue(st["qIn"][0]["lost"])
        self.assertEqual(st["safeAfter"]["mezo"], 110, "the loss was decided through block 110")
        inv = _inventory_of(st, un_out, un_in)
        self.assertTrue(inv["bridge"]["attributionCertain"])
        self.assertFalse(_pin_admissible(inv, "mezo", 105), "before the decision the transfer was in flight")
        self.assertTrue(_pin_admissible(inv, "mezo", 110))

    def test_a_departure_the_tip_had_passed_before_it_was_known_moves_the_watermark_to_the_cursor(self):
        # Its mint, if any, landed at or before the cursor; nothing knew it was in flight until now.
        st = _full_state(m=110, e=200)
        st["tipAt"] = 21480
        recon.fold_tick(st, mezo=None,
                        eth={"lo": 201, "hi": 205, "departed": [_dep(100 * USDC, block=203, tx="0xa", seq=21475)],
                             "arrived": [], "foreign": []})
        self.assertEqual([(e.get("lost"), e.get("reason")) for e in st["qIn"]], [(True, "processed-before-known")])
        self.assertEqual(st["safeAfter"]["mezo"], 110)


class LateDeparturesSubset(unittest.TestCase):
    """Codex case 2: two departures read late, 100 and 200, against one remembered mint of 300.
    resolve_pending_in matched one departure to one window by exact amount, so neither matched,
    both were written off as processed-before-known, and attribution stayed certain -- a ledger
    saying "lost" over money that had landed. The window is settled the way a range is: the
    unique subset of the late departures whose amounts add up to the residual was delivered, the
    rest failed; no unique subset is an ambiguity that CLOSES NAV, never a write-off."""

    def _st(self, residual):
        st = _full_state(m=110, e=200)
        st["tipAt"] = 11
        st["pendingIn"] = [{"tipPrev": 9, "tipNow": 11, "residual": residual, "block": 110}]
        return st

    def _fold(self, st):
        return recon.fold_tick(st, mezo=None,
                               eth={"lo": 201, "hi": 205, "arrived": [], "foreign": [],
                                    "departed": [_dep(100 * USDC, block=203, tx="0xa", seq=10),
                                                 _dep(200 * USDC, block=204, tx="0xb", seq=11)]})

    def test_two_late_departures_explain_one_remembered_mint_together(self):
        st = self._st(300 * USDC)
        un_out, un_in = self._fold(st)
        self.assertEqual(st["qIn"], [])
        self.assertEqual((st["inSent"], st["inDelivered"]), (300 * USDC, 300 * USDC))
        self.assertEqual(st["pendingIn"], [])
        self.assertEqual(st["safeAfter"]["mezo"], 110)
        inv = _inventory_of(st, un_out, un_in)
        self.assertTrue(inv["bridge"]["attributionCertain"])
        self.assertTrue(_pin_admissible(inv, "mezo", 110))

    def test_a_unique_subset_delivers_its_members_and_writes_off_the_rest(self):
        st = self._st(100 * USDC)
        un_out, un_in = self._fold(st)
        self.assertEqual([(e["seq"], e.get("lost"), e.get("reason")) for e in st["qIn"]], [(11, True, "processed-undelivered")])
        self.assertEqual(st["inDelivered"], 100 * USDC)
        self.assertEqual(st["pendingIn"], [])
        self.assertTrue(_inventory_of(st, un_out, un_in)["bridge"]["attributionCertain"])

    def test_many_late_departures_that_explain_the_window_together_settle_without_a_search(self):
        n = recon.MAX_SETTLE_CANDIDATES + 1
        amounts = [10 * USDC * (i + 1) for i in range(n)]
        st = _full_state(m=110, e=200)
        st["tipAt"] = 9 + n
        st["pendingIn"] = [{"tipPrev": 9, "tipNow": 9 + n, "residual": sum(amounts), "block": 110}]
        un_out, un_in = recon.fold_tick(st, mezo=None,
                                        eth={"lo": 201, "hi": 205, "arrived": [], "foreign": [],
                                             "departed": [_dep(a, block=201 + i, tx=f"0x{i}", seq=10 + i)
                                                          for i, a in enumerate(amounts)]})
        self.assertEqual(st["qIn"], [])
        self.assertEqual((st["inSent"], st["inDelivered"]), (sum(amounts), sum(amounts)))
        self.assertEqual(st["pendingIn"], [])
        self.assertTrue(_inventory_of(st, un_out, un_in)["bridge"]["attributionCertain"])

    def test_many_late_zero_net_departures_are_ambiguous_not_uniquely_delivered(self):
        # Expected nets are clamped at zero, so the fast path must not assume that
        # every member is positive. All 2^n subsets fit this remembered residual.
        n = recon.MAX_SETTLE_CANDIDATES + 1
        st = _full_state(m=110, e=200)
        st["tipAt"] = n
        st["pendingIn"] = [{"tipPrev": 0, "tipNow": n, "residual": 0, "block": 110}]
        with _patched(FEES={OUT: recon.FEES[OUT], IN: {"fee": 3, "tol": 0}}):
            departed = [_dep(3, block=201 + i, tx=f"0x{i}", seq=i + 1) for i in range(n)]
            remaining, _, unresolved = recon.resolve_pending_in(st, departed)
        self.assertEqual(unresolved, n)
        self.assertEqual(len(remaining), n)
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual(len(st["pendingIn"]), 1)

    def test_late_window_does_not_choose_all_when_a_proper_subset_also_fits(self):
        st = self._st(100)
        with _patched(FEES={OUT: recon.FEES[OUT], IN: {"fee": 2, "tol": 1}}):
            # Nets 99 and 1: both 99 and 100 explain residual 100 +/- 1.
            departed = [_dep(101, block=203, tx="0xa", seq=10), _dep(3, block=204, tx="0xb", seq=11)]
            remaining, _, unresolved = recon.resolve_pending_in(st, departed)
        self.assertEqual(unresolved, 2)
        self.assertEqual(len(remaining), 2)
        self.assertEqual(st["inDelivered"], 0)
        self.assertFalse(any(d.get("lost") for d in remaining))
        self.assertEqual(len(st["pendingIn"]), 1)

    def test_late_departures_that_do_not_explain_the_mint_close_nav_instead_of_being_written_off(self):
        st = self._st(250 * USDC)
        un_out, un_in = self._fold(st)
        self.assertEqual([(e["seq"], e.get("lost")) for e in st["qIn"]], [(10, None), (11, None)], "nothing written off")
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual(len(st["pendingIn"]), 1, "the window stays unexplained")
        inv = _inventory_of(st, un_out, un_in)
        self.assertFalse(inv["bridge"]["attributionCertain"], "unexplained money is an ambiguity, not a verdict")
        self.assertEqual([e["haircutBps"] for e in inv["bridge"]["inFlight"]], [0], "and no haircut is invented")


class _History:
    """A synthetic two-chain bridge history the tick reads by block range, so the same history
    can be folded whole, in parts, or across a persist-and-reload, and the outcomes compared.

    Seventeen inbound crossings (one more than the enumeration bound): Ethereum departures at
    blocks 201..217 with locks seq 101..117, native mints on Mezo at blocks 301..317 with the
    destination tip advancing one per mint. Two outbound crossings: Mezo departures at 305 and
    312 (unlock seq 9001, 9002), confirmed on Ethereum at 220 and 225 with the 3 USDC fee."""

    N = recon.MAX_SETTLE_CANDIDATES + 1
    MEZO_ADAPTER, ETH_ADAPTER = "0x" + "b" * 40, "0x" + "d" * 40

    def __init__(self):
        self.ranges = []  # every Mezo range native_arrivals was asked for
        self.in_amounts = [10 * USDC * (i + 1) for i in range(self.N)]
        self.eth_deps = [dict(_dep(a, block=201 + i, tx=f"0xin{i}", logIndex=9)) for i, a in enumerate(self.in_amounts)]
        self.locks = [{"seq": 101 + i, "tx": f"0xin{i}", "logIndex": 8, "amount": a, "block": 201 + i}
                      for i, a in enumerate(self.in_amounts)]
        self.mints = [(301 + i, a) for i, a in enumerate(self.in_amounts)]        # (mezo block, amount)
        self.mezo_deps = [dict(_dep(1000 * USDC, block=305, tx="0xout1", logIndex=13)),
                          dict(_dep(2000 * USDC, block=312, tx="0xout2", logIndex=13))]
        self.unlocks = [{"seq": 9001, "tx": "0xout1", "logIndex": 12, "amount": 1000 * USDC, "block": 305},
                        {"seq": 9002, "tx": "0xout2", "logIndex": 12, "amount": 2000 * USDC, "block": 312}]
        self.confirmations = [{"seq": 9001, "tx": "0xc1", "logIndex": 426, "amount": 1000 * USDC, "block": 220},
                              {"seq": 9002, "tx": "0xc2", "logIndex": 426, "amount": 2000 * USDC, "block": 225}]
        self.transfers = [{"amount": 997 * USDC, "tx": "0xc1", "block": 220, "logIndex": 429},
                          {"amount": 1997 * USDC, "tx": "0xc2", "block": 225, "logIndex": 429}]

    def fakes(self):
        h = self

        def departures(pool, adapter, dest, token, recipient, frm, to, step):
            src = h.mezo_deps if adapter == h.MEZO_ADAPTER else h.eth_deps
            return [dict(d) for d in src if frm <= d["block"] <= to]

        def locked_sequences(pool, bridge, recipient, token, frm, to, step):
            return [dict(l) for l in h.locks if frm <= l["block"] <= to]

        def unlock_events(pool, precompile, sender, recipient, token, frm, to, step):
            return [dict(u) for u in h.unlocks if frm <= u["block"] <= to]

        def unlock_confirmations(pool, bridge, recipient, token, frm, to, step):
            return [dict(c) for c in h.confirmations if frm <= c["block"] <= to]

        def incoming(pool, token, sender, to_addr, frm, to, step):
            return [dict(t) for t in h.transfers if frm <= t["block"] <= to]

        def native_arrivals(pool, token, owner, frm, to, step):
            h.ranges.append((frm, to))
            return sum(a for b, a in h.mints if frm <= b <= to)

        def uint_call(pool, target, sig, *args, block=None):
            if sig.startswith("getCurrentSequenceTip"):
                return 100 + sum(1 for b, _ in h.mints if b <= block)
            return 100 + h.N  # source sequence()

        return _patched(departures=departures, locked_sequences=locked_sequences, unlock_events=unlock_events,
                        unlock_confirmations=unlock_confirmations, incoming=incoming,
                        native_arrivals=native_arrivals, uint_call=uint_call)


class HistoryEquivalence(unittest.TestCase):
    """Acceptance for the review of 93fbf96: the SAME history must give the same totals, the same
    transfer statuses and no unexplained entries whether it is restored whole, in parts, or
    across a restart. Seventeen delivered inbound crossings folded in one range used to close
    NAV on the enumeration bound while tick-by-tick passed -- one history, two answers."""

    HEADS = (330, 240)

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.paths = _patched(STATE=os.path.join(self.dir, "state.json"), INVENTORY=os.path.join(self.dir, "inv.json"),
                              MIRROR=os.path.join(self.dir, "mirror.json"))
        self.paths.__enter__()
        self.history = _History()
        self.fakes = self.history.fakes()
        self.fakes.__enter__()

    def tearDown(self):
        self.fakes.__exit__(None, None, None)
        self.paths.__exit__(None, None, None)

    def _run_to(self, st, mh, eh):
        for _ in range(500):
            if st["m"] >= mh - POLICY["mezo"]["scan"] and st["e"] >= eh - POLICY["eth"]["scan"]:
                return
            self.assertIsNotNone(recon.tick(st, mh, eh, POLICY, _TEMPLATE, ["http://m"], ["http://e"]))
        self.fail("the cursors never caught up with the heads")

    def _ledger_of(self, st):
        inv = json.load(open(recon.INVENTORY))["bridge"]
        return {"inSent": st["inSent"], "inDelivered": st["inDelivered"], "outSent": st["outSent"],
                "outDelivered": st["outDelivered"], "qIn": st["qIn"], "qOut": st["qOut"], "foreignIn": st["foreignIn"],
                "pendingIn": st["pendingIn"], "pendingOut": st["pendingOut"], "ambiguous": st["ambiguous"],
                "certain": inv["attributionCertain"], "inFlight": inv["inFlight"],
                "reconciledThrough": inv["reconciledThrough"]}

    def _expected(self):
        h = self.history
        return {"inSent": sum(h.in_amounts), "inDelivered": sum(h.in_amounts), "outSent": 3000 * USDC,
                "outDelivered": 2994 * USDC, "qIn": [], "qOut": [], "foreignIn": [], "pendingIn": [], "pendingOut": [],
                "ambiguous": {OUT: False, IN: False}, "certain": True, "inFlight": [],
                "reconciledThrough": {"mezo": 330, "eth": 235}}

    def test_the_whole_history_in_one_range_settles_every_transfer(self):
        st = _full_state(m=200, e=200)
        self._run_to(st, *self.HEADS)
        self.assertEqual(self._ledger_of(st), self._expected())

    def test_the_history_in_parts_settles_identically(self):
        st = _full_state(m=200, e=200)
        for heads in ((305, 210), (312, 225), self.HEADS):
            self._run_to(st, *heads)
        self.assertEqual(self._ledger_of(st), self._expected())

    def test_a_restart_between_parts_settles_identically(self):
        st = _full_state(m=200, e=200)
        self._run_to(st, 305, 210)
        reloaded = json.load(open(recon.STATE))  # what a restart reads back
        self.assertEqual(reloaded, st)
        self._run_to(reloaded, *self.HEADS)
        self.assertEqual(self._ledger_of(reloaded), self._expected())

    def test_a_bounded_first_run_folds_the_history_in_capped_ranges(self):
        # The service never folds an unbounded Mezo range: history is caught up in ranges of at
        # most MEZO_RANGE_MAX blocks, so the residual any one settlement must explain is the
        # bridge traffic of that span, not of the whole past.
        st = _full_state(m=200, e=200)
        with _patched(MEZO_RANGE_MAX=5):
            self._run_to(st, *self.HEADS)
        self.assertEqual(self._ledger_of(st), self._expected())
        self.assertEqual(max(to - frm + 1 for frm, to in self.history.ranges), 5, "no range wider than the cap")
        self.assertGreater(len(self.history.ranges), 20, "the history was caught up in many bounded ticks")


class BoundedEnumeration(unittest.TestCase):
    """Codex round 3 and case 3 of the review on 9d832cc: the subset search was 2^n over every
    sequence the tip passed, and a stranger can lock as many dust transfers to our address as
    they like inside one range. Above the bound the reconciler refused to search -- and then,
    with a zero residual, the ambiguity did not close NAV while the classification fallback
    (tip past the sequence, entry still queued) wrote the transfer down anyway: a haircut with
    no settlement behind it. A zero residual needs no search at all -- nothing landed, so every
    processed sequence failed, which is a PROVEN loss. A non-zero residual above the bound is an
    ambiguity that closes NAV and writes nothing off."""

    def _st(self):
        st = _full_state(m=110, e=200)
        st["tipAt"] = 9
        st["qIn"].append({"net": 50 * USDC, "block": 1, "tx": "0xo", "seq": 10})
        st["inSent"] += 50 * USDC
        for i in range(recon.MAX_SETTLE_CANDIDATES):
            st["foreignIn"].append({"net": USDC, "block": 1, "tx": f"0xf{i}", "seq": 11 + i})
        return st

    def test_a_zero_residual_proves_every_processed_sequence_failed_without_a_search(self):
        st = self._st()
        tip_now = 11 + recon.MAX_SETTLE_CANDIDATES
        events = recon.settle_inbound(st, residual=0, tip_prev=9, tip_now=tip_now, tol=0, block=110)
        self.assertEqual([(e["seq"], e.get("lost"), e.get("reason")) for e in st["qIn"]], [(10, True, "processed-undelivered")])
        self.assertEqual(st["foreignIn"], [])
        self.assertIn("bridge-processed-undelivered", [e[0] for e in events])
        self.assertEqual(st["tipAt"], tip_now)

    def test_too_many_processed_sequences_with_a_residual_closes_nav_and_writes_nothing_off(self):
        st = self._st()
        un_out, un_in = recon.fold_tick(st, mezo={"lo": 101, "hi": 110, "departed": [], "minted": 50 * USDC,
                                                  "tipPrev": 9, "tip": 11 + recon.MAX_SETTLE_CANDIDATES}, eth=None)
        self.assertEqual([(e["seq"], e.get("lost")) for e in st["qIn"]], [(10, None)], "nothing written off")
        self.assertEqual(len(st["foreignIn"]), recon.MAX_SETTLE_CANDIDATES)
        inv = _inventory_of(st, un_out, un_in)
        self.assertFalse(inv["bridge"]["attributionCertain"])
        self.assertEqual([e["haircutBps"] for e in inv["bridge"]["inFlight"]], [0], "no haircut without a settlement")


class LogQuery(unittest.TestCase):
    """Topics are filtered by the NODE. `cast logs` takes topics positionally and cannot skip one,
    which is why incoming() used to fetch every USDC Transfer on Ethereum and filter in Python —
    and why a sender filter (topic 1, with the recipient in topic 2) was impossible. eth_getLogs
    takes null as a wildcard."""

    def test_topics_go_to_the_node_with_nulls_for_wildcards(self):
        seen = []

        def sh(*a, **k):
            seen.append(a)
            return "[]"

        with _patched(sh=sh, block_hash=lambda *a, **k: "0x" + "1" * 64):
            got = recon._try("http://rpc", "0xaddr", [recon.TRANSFER, None, "0x" + "a" * 64], 16, 32)
        self.assertEqual(got, [])
        argv = seen[0]
        self.assertIn("eth_getLogs", argv)
        self.assertEqual(json.loads(argv[-1]), [{"fromBlock": "0x10", "toBlock": "0x20", "address": "0xaddr",
                                                 "topics": [recon.TRANSFER, None, "0x" + "a" * 64]}])

    def test_an_answer_that_is_not_a_list_is_unreadable(self):
        with _patched(sh=lambda *a, **k: '{"error": "rate limited"}'):
            self.assertIsNone(recon._try("http://rpc", "0xaddr", [recon.TRANSFER], 1, 2))


class MalformedLogs(unittest.TestCase):
    """Operator H3. `cast logs` printed something that is not JSON — a provider's HTML error page,
    a truncated body — and `_try()` turned it into `[]`: "this endpoint answered, and there are
    no events". The rotation never tried the next endpoint, and every transfer in that range was
    scanned past for good. An answer that cannot be parsed is not an answer."""

    def test_unparseable_output_is_unreadable_not_empty(self):
        with _patched(sh=lambda *a, **k: "<html>502 Bad Gateway</html>"):
            self.assertIsNone(recon._try("http://rpc", "0xaddr", [recon.BRIDGE_SENT], 1, 2))

    def test_a_real_empty_answer_is_still_empty(self):
        with _patched(sh=lambda *a, **k: "[]", block_hash=lambda *a, **k: "0x" + "1" * 64):
            self.assertEqual(recon._try("http://rpc", "0xaddr", [recon.BRIDGE_SENT], 1, 2), [])

    def test_no_output_is_unreadable(self):
        with _patched(sh=lambda *a, **k: ""):
            self.assertIsNone(recon._try("http://rpc", "0xaddr", [recon.BRIDGE_SENT], 1, 2))


class FoldOrder(unittest.TestCase):
    """Operator H2. main() folded the Mezo range (where an eth->mezo transfer LANDS) before the
    Ethereum range (where it DEPARTS). Whenever both halves of a crossing fall inside one tick's
    ranges — a first run over history, a restart after any outage longer than a crossing — the
    arrival was folded against an empty queue and ignored as "not ours", then the departure
    was queued with nothing left to retire it. Departures on both legs fold first."""

    def test_a_completed_inbound_crossing_inside_one_tick_settles(self):
        st = _full_state(m=100, e=200)
        un_out, un_in = recon.fold_tick(
            st,
            mezo={"lo": 101, "hi": 110, "departed": [], "minted": 100 * USDC},
            eth={"lo": 201, "hi": 205, "departed": [_dep(100 * USDC, block=203, tx="0xa", seq=21475)], "arrived": []},
        )
        self.assertEqual(st["qIn"], [], "the departure read later in the tick retires the arrival read earlier")
        self.assertEqual((st["inSent"], st["inDelivered"]), (100 * USDC, 100 * USDC))
        self.assertEqual((un_out, un_in), (0, 0))
        self.assertEqual((st["m"], st["e"]), (110, 205))
        self.assertEqual(st["safeAfter"], {"mezo": 110, "eth": 205})

    def test_a_completed_outbound_crossing_inside_one_tick_settles(self):
        st = _full_state(m=100, e=200)
        recon.fold_tick(
            st,
            mezo={"lo": 101, "hi": 110, "departed": [_dep(1000 * USDC, block=105, tx="0xb")], "minted": 0},
            eth={"lo": 201, "hi": 205, "departed": [], "arrived": [997 * USDC]},
        )
        self.assertEqual(st["qOut"], [])
        self.assertEqual((st["outSent"], st["outDelivered"]), (1000 * USDC, 997 * USDC))

    def test_a_leg_with_nothing_to_scan_is_left_alone(self):
        st = _full_state(m=100, e=200)
        recon.fold_tick(st, mezo=None, eth={"lo": 201, "hi": 205, "departed": [], "arrived": []})
        self.assertEqual((st["m"], st["e"]), (100, 205))
        self.assertEqual(st["safeAfter"], {"mezo": 100, "eth": 200}, "no transition, no watermark move")

    def test_with_the_tip_known_the_inbound_leg_settles_by_sequence(self):
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21474
        recon.fold_tick(
            st,
            mezo={"lo": 101, "hi": 110, "departed": [], "minted": 100 * USDC, "tipPrev": 21474, "tip": 21476},
            eth={"lo": 201, "hi": 205, "departed": [_dep(100 * USDC, block=203, tx="0xa", seq=21475)],
                 "arrived": [], "foreign": [{"net": 30 * USDC, "block": 204, "tx": "0xz", "seq": 21476}]},
        )
        # 100 arrived; ours (21475) and theirs (21476) were both processed; the only subset that
        # adds to 100 is ours, so theirs failed and is dropped, ours is delivered.
        self.assertEqual((st["qIn"], st["foreignIn"]), ([], []))
        self.assertEqual(st["inDelivered"], 100 * USDC)
        self.assertEqual(st["tipAt"], 21476)

    def test_a_strangers_lock_is_remembered_until_the_tip_passes_it(self):
        st = _full_state(m=100, e=200)
        st["tipAt"] = 21474
        recon.fold_tick(st, mezo=None,
                        eth={"lo": 201, "hi": 205, "departed": [], "arrived": [],
                             "foreign": [{"net": 30 * USDC, "block": 204, "tx": "0xz", "seq": 21476}]})
        self.assertEqual([f["seq"] for f in st["foreignIn"]], [21476])
        self.assertEqual(recon.inflight_entries(st, st["tipAt"]), [], "not ours: never priced")


class OneTick(unittest.TestCase):
    """The poll loop's body, driven with synthetic chain answers. What these prove is the
    ordering the scan found wrong: every chain read completes before the state is touched
    (operator M8), the tip is read at the height the arrivals were folded through (M10), and
    the state is durable before the inventory that describes it is published (L11)."""

    MEZO_ADAPTER, ETH_ADAPTER = "0x" + "b" * 40, "0x" + "d" * 40

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.paths = _patched(STATE=os.path.join(self.dir, "state.json"),
                              INVENTORY=os.path.join(self.dir, "inv.json"),
                              MIRROR=os.path.join(self.dir, "mirror.json"))
        self.paths.__enter__()
        self.calls = []
        self.deps = {self.MEZO_ADAPTER: [], self.ETH_ADAPTER: []}
        self.locks = []        # L1 AssetsLocked for our inbound departures
        self.unlocks = []      # Mezo AssetsUnlocked for our outbound departures
        self.confirmations = []  # L1 AssetsUnlockConfirmed into our receiver
        self.transfers = []    # USDC Transfers from the L1 bridge into our receiver
        self.minted = 0
        self.tips = {"latest": 21480, "at_cursor": 21474}

        def departures(pool, adapter, dest, token, recipient, frm, to, step):
            self.calls.append(("departures", adapter, frm, to))
            return [dict(d, logIndex=d.get("logIndex", 9)) for d in self.deps[adapter] if frm <= d["block"] <= to]

        def locked_sequences(pool, bridge, recipient, token, frm, to, step):
            self.calls.append(("locked", frm, to))
            return [dict(l, logIndex=l.get("logIndex", 8), amount=l.get("amount", 100 * USDC)) for l in self.locks]

        def native_arrivals(pool, token, owner, frm, to, step):
            self.calls.append(("minted", frm, to))
            return self.minted

        def incoming(pool, token, sender, to_addr, frm, to, step):
            self.calls.append(("incoming", sender, to_addr))
            return [dict(t) for t in self.transfers]

        def unlock_events(pool, precompile, sender, recipient, token, frm, to, step):
            self.calls.append(("unlocks", sender, recipient, token))
            return [dict(u, logIndex=u.get("logIndex", 8), amount=u.get("amount", 1000 * USDC)) for u in self.unlocks]

        def unlock_confirmations(pool, bridge, recipient, token, frm, to, step):
            self.calls.append(("confirmations", bridge, recipient, token))
            return [dict(c, logIndex=c.get("logIndex", 426)) for c in self.confirmations]

        def uint_call(pool, target, sig, *args, block=None):
            self.calls.append(("call", sig, block))
            if sig.startswith("getCurrentSequenceTip"):
                if block is None:
                    return self.tips["latest"]
                return self.tips["at_cursor"] if block >= 110 else self.tips.get("before", 21474)
            return 21480  # source sequence()

        self.fakes = _patched(departures=departures, locked_sequences=locked_sequences,
                              native_arrivals=native_arrivals, incoming=incoming, uint_call=uint_call,
                              unlock_events=unlock_events, unlock_confirmations=unlock_confirmations)
        self.fakes.__enter__()

    def tearDown(self):
        self.fakes.__exit__(None, None, None)
        self.paths.__exit__(None, None, None)

    def _tick(self, st, mh=110, eh=210):
        return recon.tick(st, mh, eh, POLICY, _TEMPLATE, ["http://m"], ["http://e"])

    def _inventory(self):
        return json.load(open(recon.INVENTORY))

    def test_a_failed_read_leaves_the_state_untouched_and_a_retry_counts_once(self):
        # Operator M8, reproduced by the scan against the real main(): apply_tick had already
        # queued the departure when locked_sequences() raised, the cursor stayed put, and the
        # retry over the same range queued it again — inSent 200 for one transfer of 100, with
        # attributionCertain still true.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        boom = {"left": 1}

        def locked_sequences(pool, bridge, recipient, token, frm, to, step):
            if boom["left"]:
                boom["left"] -= 1
                raise RuntimeError("getLogs block 203 failed on all endpoints")
            return [{"seq": 21475, "tx": "0xa", "logIndex": 8, "amount": 100 * USDC}]

        st = _full_state(m=100, e=200)
        before = json.loads(json.dumps(st))
        with _patched(locked_sequences=locked_sequences):
            with self.assertRaises(RuntimeError):
                self._tick(st)
            self.assertEqual(st, before, "nothing folds until every read of the tick succeeded")
            self.assertFalse(os.path.exists(recon.STATE), "and nothing was persisted")
            self._tick(st)
        self.assertEqual(st["inSent"], 100 * USDC)
        self.assertEqual([e["net"] for e in st["qIn"]], [100 * USDC])
        self.assertEqual(st["qIn"][0]["seq"], 21475)

    def test_diagnostic_rpc_budget_failure_does_not_apply_a_departure_twice(self):
        # L21 adds an exception to the diagnostic sequence() read. It must happen
        # BEFORE fold, just like the accounting reads, even though its value is optional.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.locks = [{"seq": 21475, "tx": "0xa", "amount": 100 * USDC}]
        st = _full_state(m=100, e=200)
        before = json.loads(json.dumps(st))
        original_call = recon.uint_call

        def fail_diagnostic(pool, target, sig, *args, **kwargs):
            if sig == "sequence()(uint256)":
                raise recon.RpcBudgetExceeded("test deadline")
            return original_call(pool, target, sig, *args, **kwargs)

        with _patched(uint_call=fail_diagnostic):
            with self.assertRaises(recon.RpcBudgetExceeded):
                self._tick(st)
        self.assertEqual(st, before)
        self.assertFalse(os.path.exists(recon.STATE))
        self.assertFalse(os.path.exists(recon.INVENTORY))
        self._tick(st)
        self.assertEqual(st["inSent"], 100 * USDC)
        self.assertEqual(len(st["qIn"]), 1)

    def test_the_tip_is_read_at_the_folded_cursor_not_at_latest(self):
        # Operator M10. The tip was read at LATEST while arrivals were folded only through the
        # cursor: the destination had processed our sequence a few blocks ago, the mint sat in
        # blocks not yet scanned, and the live transfer was declared processed-undelivered and
        # haircut to zero — NAV understated by the whole transfer until the next tick caught up.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.locks = [{"seq": 21475, "tx": "0xa"}]
        st = _full_state(m=100, e=200)
        self._tick(st)
        tip_reads = [c for c in self.calls if c[0] == "call" and c[1].startswith("getCurrentSequenceTip")]
        # Once, at the range's upper bound, which is the cursor after the fold. Never at latest,
        # and NOT at the block before the range either: a first run starts from the deployment
        # blocks, so nothing of ours predates the range and no previous bound is needed -- and
        # that read needed archive state on mainnet and an unstubbed precompile on a fork.
        self.assertEqual(tip_reads, [("call", "getCurrentSequenceTip()(uint256)", st["m"])])
        self.assertEqual(st["tipAt"], 21474)
        entries = {e["id"]: e for e in self._inventory()["bridge"]["inFlight"]}
        self.assertEqual(entries[IN]["haircutBps"], 0, "at the cursor our sequence is not processed yet")
        self.assertNotIn(IN + ":processed-undelivered", entries)

    def test_arrivals_are_asked_for_from_the_bridge_to_the_receiver(self):
        st = _full_state(m=100, e=200)
        self._tick(st)
        self.assertEqual([c for c in self.calls if c[0] == "incoming"],
                         [("incoming", recon.ETH["mezoBridge"], recon.ETH["receiver"])])

    def test_a_loss_confirmed_at_the_cursor_survives_a_tick_that_cannot_read_the_tip(self):
        # Codex case 1 at the tick level: lost at tip 21480, then the tip is unreadable.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.locks = [{"seq": 21475, "tx": "0xa"}]
        self.tips["at_cursor"] = 21480
        st = _full_state(m=100, e=200)
        self._tick(st)
        self.assertEqual([e["haircutBps"] for e in self._inventory()["bridge"]["inFlight"]],
                         [recon.UNDELIVERED_HAIRCUT_BPS])
        self.assertTrue(json.load(open(recon.STATE))["qIn"][0]["lost"], "durable, not recomputed")

        def unreadable(pool, target, sig, *args, block=None):
            return None

        with _patched(uint_call=unreadable):
            self._tick(st, mh=120, eh=220)  # the next range; the tip read fails
        self.assertEqual([e["haircutBps"] for e in self._inventory()["bridge"]["inFlight"]],
                         [recon.UNDELIVERED_HAIRCUT_BPS], "missing data must not restore value")

    def test_an_unreadable_tip_holds_the_mezo_leg(self):
        # The tip at the range's bound decides which sequences the residual can belong to.
        # Without it the residual cannot be settled, so the tick is held like an unreadable
        # balance -- and a departure already read is not lost: nothing folded.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.locks = [{"seq": 21475, "tx": "0xa"}]
        st = _full_state(m=100, e=200)
        before = json.loads(json.dumps(st))
        with _patched(uint_call=lambda *a, **k: None):
            self.assertIsNone(self._tick(st))
        self.assertEqual(st, before)

    def test_the_state_is_durable_before_the_inventory_is_published(self):
        # Operator L11. The inventory went out first and the state file after; a crash between
        # the two published an inventory the next start could not account for, and the tick
        # that followed re-folded the range. With the state first, a failed publish is retried
        # from a cursor that has already moved and nothing is counted twice.
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.locks = [{"seq": 21475, "tx": "0xa"}]
        st = _full_state(m=100, e=200)

        def failing_publish(inv):
            raise OSError("disk full")

        with _patched(write_inventory=failing_publish):
            with self.assertRaises(OSError):
                self._tick(st)
        on_disk = json.load(open(recon.STATE))
        self.assertEqual((on_disk["m"], on_disk["e"]), (110, 205), "the fold was persisted first")
        self.assertFalse(os.path.exists(recon.INVENTORY))
        self._tick(on_disk)  # the retry, from the persisted state, with the publish working
        entries = {e["id"]: e for e in self._inventory()["bridge"]["inFlight"]}
        self.assertEqual(entries[IN]["expectedAmount"], str(100 * USDC), "once, not twice")
        self.assertEqual(on_disk["inSent"], 100 * USDC)

    def test_a_restart_from_the_persisted_state_changes_nothing(self):
        self.deps[self.MEZO_ADAPTER] = [_dep(1000 * USDC, block=105, tx="0xb")]
        self.unlocks = [{"seq": 9345, "tx": "0xb"}]
        self.confirmations = [{"seq": 9345, "tx": "0xe", "amount": 1000 * USDC, "block": 203}]
        self.transfers = [{"amount": 997 * USDC, "tx": "0xe", "block": 203, "logIndex": 429}]
        st = _full_state(m=100, e=200)
        self._tick(st)
        first = self._inventory()
        reloaded = json.load(open(recon.STATE))
        self.assertEqual(reloaded, st)
        self._tick(reloaded)
        self.assertEqual(self._inventory(), first)
        self.assertEqual((reloaded["outSent"], reloaded["outDelivered"]), (1000 * USDC, 997 * USDC))
        self.assertTrue(first["bridge"]["attributionCertain"])

    def test_an_unreadable_mezo_balance_holds_the_whole_tick(self):
        self.minted = None
        self.deps[self.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        st = _full_state(m=100, e=200)
        before = json.loads(json.dumps(st))
        self._tick(st)
        self.assertEqual(st, before, "no leg folds while the other is unreadable")
        self.assertFalse(os.path.exists(recon.STATE))


class DurableWrites(unittest.TestCase):
    def test_the_state_file_is_synced_before_it_is_renamed_into_place(self):
        # Operator L11: neither write was fsynced, so a power loss could leave a zero-length
        # state file behind a successful rename. Sync the temp file, then rename.
        order = []
        real_fsync, real_replace = os.fsync, os.replace

        def fsync(fd):
            order.append("fsync")
            real_fsync(fd)

        def replace(src, dst):
            order.append("replace")
            real_replace(src, dst)

        with tempfile.TemporaryDirectory() as d:
            with _patched(STATE=os.path.join(d, "s.json")):
                os.fsync, os.replace = fsync, replace
                try:
                    recon.persist_state(_full_state(m=1, e=2))
                finally:
                    os.fsync, os.replace = real_fsync, real_replace
                self.assertEqual(json.load(open(recon.STATE))["m"], 1)
        self.assertEqual(order, ["fsync", "replace"])


def _full_state(m, e):
    return {"version": recon.STATE_VERSION, "m": m, "e": e, "qOut": [], "qIn": [], "foreignIn": [],
            "pendingOut": [], "pendingIn": [],
            "tipAt": None, "outDelivered": 0, "inDelivered": 0, "outSent": 0, "inSent": 0,
            "safeAfter": {"mezo": m, "eth": e}, "ambiguous": {OUT: False, IN: False}}


class FirstRunStart(unittest.TestCase):
    """A seat that has never run must be able to start from the deployment blocks.

    The default lookback is for recovering a LOST state file. Applied to a brand-new external seat
    it silently skips anything that departed earlier, so that seat's canonical NAV omits in-flight
    capital, differs from the rest of the set, and it denies every price-setting task -- fails
    closed, but the seat never commissions and the cause is invisible from outside.
    """

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("RECON_START_MEZO", "RECON_START_ETH")}
        for k in self._saved:
            os.environ.pop(k, None)
        self._state = recon.STATE
        recon.STATE = os.path.join(tempfile.mkdtemp(), "absent.json")

    def tearDown(self):
        recon.STATE = self._state
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_defaults_to_the_lookback_when_unset(self):
        st = recon.load(1_000_000, 500_000)
        self.assertEqual(st["m"], 1_000_000 - 1500)
        self.assertEqual(st["e"], 500_000 - 400)

    def test_deployment_blocks_override_the_lookback(self):
        os.environ["RECON_START_MEZO"] = "11195721"
        os.environ["RECON_START_ETH"] = "25775990"
        st = recon.load(11_300_000, 25_900_000)
        self.assertEqual(st["m"], 11195721)
        self.assertEqual(st["e"], 25775990)
        self.assertEqual(st["qOut"], [])
        self.assertEqual(st["qIn"], [])

    def test_refuses_a_start_ahead_of_the_head(self):
        # Silently starting in the future would mark everything before it reconciled, which is the
        # same wrong answer as the lookback but with more confidence attached.
        os.environ["RECON_START_MEZO"] = "99999999"
        os.environ["RECON_START_ETH"] = "25775990"
        with self.assertRaises(SystemExit):
            recon.load(11_300_000, 25_900_000)


class FinalityPolicy(unittest.TestCase):
    """The two depths are different questions, and the margin between them is what keeps
    price-setting alive. Conflating them is the defect in the distribution's PR #2."""

    def _config(self, mezo_pin, eth_pin, mezo_lag, eth_lag):
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        json.dump({"navAccounting": {"policy": {
            "minConfirmations": {"mezo": mezo_pin, "eth": eth_pin},
            "maxHealthyLagBlocks": {"mezo": mezo_lag, "eth": eth_lag},
        }}}, open(path, "w"))
        self.addCleanup(os.unlink, path)
        return path

    def setUp(self):
        self._scan = dict(recon.SCAN_CONF)

    def tearDown(self):
        recon.SCAN_CONF.update(self._scan)

    def test_pilot_values_leave_a_margin(self):
        recon.SCAN_CONF.update({"mezo": 0, "eth": 5})
        p = recon.finality_policy(self._config(6, 12, 4, 6))
        self.assertEqual(p["mezo"], {"scan": 0, "pin": 6, "lag": 4})
        self.assertEqual(p["eth"], {"scan": 5, "pin": 12, "lag": 6})

    def test_equal_depths_are_refused(self):
        # PR #2 took the scan depth straight from minConfirmations. With no lag budget left, the
        # reconciler lands exactly on the pin and any polling drift puts it behind.
        recon.SCAN_CONF.update({"mezo": 2, "eth": 12})
        with self.assertRaises(SystemExit) as ctx:
            recon.finality_policy(self._config(2, 12, 4, 6))
        self.assertIn("no margin", str(ctx.exception))

    def test_the_error_says_which_knob_to_move(self):
        # The lag budget describes measured drift. Tuning it down to satisfy the check would make
        # the invariant self-confirming, so the message names the other knob.
        recon.SCAN_CONF.update({"mezo": 0, "eth": 9})
        with self.assertRaises(SystemExit) as ctx:
            recon.finality_policy(self._config(6, 12, 4, 6))
        self.assertIn("Raise minConfirmations", str(ctx.exception))

    def test_missing_or_malformed_policy_fails_closed(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        json.dump({"navAccounting": {"policy": {"minConfirmations": {"mezo": 6, "eth": 12}}}}, open(path, "w"))
        self.addCleanup(os.unlink, path)
        with self.assertRaises(SystemExit):
            recon.finality_policy(path)
        with self.assertRaises(SystemExit):
            recon.finality_policy(os.path.join(HERE, "does-not-exist.json"))


class SafeScanRange(unittest.TestCase):
    def test_stops_short_of_the_tip(self):
        safe, rng = recon.safe_scan_range(100, 120, 5)
        self.assertEqual(safe, 115)
        self.assertEqual(rng, (101, 115))

    def test_zero_depth_scans_to_the_tip(self):
        # Mezo: CometBFT commits are final under the consensus assumptions, so there is nothing
        # for a buffer to protect against and the margin is better spent on the NAV pin.
        _, rng = recon.safe_scan_range(100, 120, 0)
        self.assertEqual(rng, (101, 120))

    def test_a_cursor_above_the_safe_head_simply_waits(self):
        # This is EVERY existing seat on the tick after scanConfirmations is raised. It must be a
        # wait, not a fault: PR #2 raised SystemExit here, which under Restart=always is a crash
        # loop, and a stopped reconciler stops NAV.
        _, rng = recon.safe_scan_range(118, 120, 5)
        self.assertIsNone(rng)

    def test_never_scans_below_genesis(self):
        safe, rng = recon.safe_scan_range(0, 3, 5)
        self.assertEqual(safe, 0)
        self.assertIsNone(rng)


class CursorValidation(unittest.TestCase):
    def _state(self, m, e):
        return {"version": recon.STATE_VERSION, "m": m, "e": e, "safeAfter": {"mezo": m, "eth": e},
                "ambiguous": {recon.OUT: False, recon.IN: False}}

    def test_a_cursor_between_safe_head_and_latest_is_fine(self):
        recon._validate_cursors(self._state(120, 200), 120, 200)  # at the tip, pre-migration

    def test_a_cursor_above_latest_is_fatal(self):
        # Impossible on the chain it claims to describe: another deployment, or corruption.
        with self.assertRaises(SystemExit):
            recon._validate_cursors(self._state(121, 200), 120, 200)
        with self.assertRaises(SystemExit):
            recon._validate_cursors(self._state(120, 201), 120, 200)


class StateMigration(unittest.TestCase):
    def test_v1_seeds_the_watermarks_from_the_cursors(self):
        st, note = recon.migrate({"m": 500, "e": 900, "qOut": [], "qIn": []})
        self.assertEqual(st["version"], recon.STATE_VERSION)
        # Sound because we have reconciled through the cursor: anything ending later is still in
        # the queues, and a non-empty queue already halts NAV on its own.
        self.assertEqual(st["safeAfter"], {"mezo": 500, "eth": 900})
        self.assertIn("v1->", note)
        # v3 in the same hop: the ambiguity flags exist and start clear.
        self.assertEqual(st["ambiguous"], {recon.OUT: False, recon.IN: False})

    def test_v2_gains_only_the_ambiguity_flags(self):
        st, note = recon.migrate({"version": 2, "m": 1, "e": 2, "safeAfter": {"mezo": 1, "eth": 2}})
        self.assertEqual(st["version"], recon.STATE_VERSION)
        self.assertEqual(st["safeAfter"], {"mezo": 1, "eth": 2}, "an existing watermark must survive")
        self.assertEqual(st["ambiguous"], {recon.OUT: False, recon.IN: False})
        self.assertIn("v2->", note)

    def test_current_version_is_untouched(self):
        st, note = recon.migrate({"version": recon.STATE_VERSION, "m": 1, "e": 2,
                                  "safeAfter": {"mezo": 1, "eth": 2},
                                  "ambiguous": {recon.OUT: False, recon.IN: False}})
        self.assertIsNone(note)
        self.assertEqual(st["safeAfter"], {"mezo": 1, "eth": 2})

    def test_an_unknown_version_fails_closed(self):
        with self.assertRaises(SystemExit):
            recon.migrate({"version": 99, "m": 1, "e": 2})

    def test_v3_with_nothing_outstanding_upgrades_to_records(self):
        st, note = recon.migrate({"version": 3, "m": 1, "e": 2, "qOut": [], "qIn": [], "inSeqHigh": 0,
                                  "safeAfter": {"mezo": 1, "eth": 2},
                                  "ambiguous": {recon.OUT: True, recon.IN: False}})
        self.assertEqual(st["version"], recon.STATE_VERSION)
        self.assertEqual((st["qOut"], st["qIn"]), ([], []))
        self.assertEqual(st["ambiguous"], {recon.OUT: True, recon.IN: False}, "flags survive the hop")
        self.assertIn("v3->", note)

    def test_v3_with_transfers_outstanding_refuses_and_names_the_rebuild(self):
        # A bare amount cannot become a record: its block, tx and native sequence were never
        # stored. Inventing them (or dropping the entry) would be the silent-clean failure the
        # README's rebuild procedure exists to prevent, so the file is refused with the fix named.
        with self.assertRaises(SystemExit) as e:
            recon.migrate({"version": 3, "m": 1, "e": 2, "qOut": [997 * USDC], "qIn": [], "inSeqHigh": 0,
                           "safeAfter": {"mezo": 1, "eth": 2},
                           "ambiguous": {recon.OUT: False, recon.IN: False}})
        self.assertIn("rebuild", str(e.exception).lower())

    def test_a_file_missing_its_version_but_carrying_later_fields_is_refused(self):
        # Operator L10. A missing `version` was read as v1 and the v1 hop seeds the ambiguity
        # flags CLEAR — so a v3 file that lost its version key (a truncated or hand-edited write)
        # came back reading clean, with a durable ambiguity silently erased. v1 files have no
        # `ambiguous` and no `safeAfter`; a file that has them is not v1.
        with self.assertRaises(SystemExit):
            recon.migrate({"m": 1, "e": 2, "qOut": [], "qIn": [], "safeAfter": {"mezo": 1, "eth": 2},
                           "ambiguous": {recon.OUT: True, recon.IN: False}})


class BridgeWatermarkInInventory(unittest.TestCase):
    def test_the_inventory_carries_both_watermarks(self):
        inv = recon.build_inventory(_TEMPLATE, 10, 20, [], True, "n", {"mezo": 7, "eth": 15})
        self.assertEqual(inv["bridge"]["bridgeSafeAfter"], {"mezo": 7, "eth": 15})
        # And it stays alongside reconciledThrough, which bounds the pin from the other side:
        # bridgeSafeAfter <= pin <= reconciledThrough.
        self.assertEqual(inv["bridge"]["reconciledThrough"], {"mezo": 10, "eth": 20})


class StateValidation(unittest.TestCase):
    """Parseable JSON is not a valid state, and a malformed field does not announce itself: it is
    published as attributionCertain and signed by every seat that read the same file."""

    def _ok(self):
        return {"version": recon.STATE_VERSION, "m": 10, "e": 20,
                "qOut": [{"net": 1, "block": 3, "tx": "0x1", "seq": 9345, "gross": 4}],
                "qIn": [{"net": 5, "block": 4, "tx": "0x2", "seq": None}],
                "foreignIn": [{"net": 7, "block": 4, "tx": "0x3", "seq": 12}], "tipAt": 11,
                "pendingOut": [{"seq": 7777, "gross": 9, "net": 6, "block": 8, "tx": "0x4"}],
                "pendingIn": [{"tipPrev": 9, "tipNow": 11, "residual": 3, "block": 9}],
                "outDelivered": 1, "inDelivered": 0, "outSent": 4, "inSent": 5,
                "safeAfter": {"mezo": 10, "eth": 20},
                "ambiguous": {recon.OUT: False, recon.IN: False}}

    def test_the_pending_lists_are_checked(self):
        for field, bad in (("pendingOut", None), ("pendingOut", [{"seq": 1}]), ("pendingIn", [5]),
                           ("qOut", [{"net": 1, "block": 3, "tx": "0x1"}])):
            st = self._ok(); st[field] = bad
            with self.assertRaises(SystemExit, msg=f"{field}={bad!r} must be refused"):
                recon._validate_state(st)

    def test_the_settlement_fields_are_checked(self):
        for field, bad in (("tipAt", -1), ("tipAt", "11"), ("foreignIn", None), ("foreignIn", [5]),
                           ("foreignIn", [{"net": 7, "block": 4, "tx": "0x3", "seq": None}])):
            st = self._ok(); st[field] = bad
            with self.assertRaises(SystemExit, msg=f"{field}={bad!r} must be refused"):
                recon._validate_state(st)
        st = self._ok(); st["tipAt"] = None
        recon._validate_state(st)  # never read yet: allowed

    def test_a_well_formed_state_passes(self):
        recon._validate_state(self._ok())

    def test_negative_and_non_integer_fields_are_fatal(self):
        for field, bad in (("m", -1), ("outSent", "12"), ("inDelivered", None), ("inSent", True)):
            st = self._ok(); st[field] = bad
            with self.assertRaises(SystemExit, msg=f"{field}={bad!r} must be refused"):
                recon._validate_state(st)

    def test_a_negative_queue_entry_is_fatal(self):
        # It would make a total look reconciled that never was.
        st = self._ok(); st["qOut"] = [{"net": 5, "block": 3, "tx": "0x1"}, {"net": -3, "block": 3, "tx": "0x2"}]
        with self.assertRaises(SystemExit):
            recon._validate_state(st)

    def test_a_bare_amount_in_a_queue_is_refused(self):
        # The v3 shape. A number carries no block, no tx and no sequence, so nothing about it can
        # be classified or traced; it must not be accepted as a record by accident.
        st = self._ok(); st["qOut"] = [5]
        with self.assertRaises(SystemExit):
            recon._validate_state(st)

    def test_an_inbound_record_must_carry_its_sequence_field(self):
        st = self._ok(); st["qIn"] = [{"net": 5, "block": 4, "tx": "0x2"}]
        with self.assertRaises(SystemExit):
            recon._validate_state(st)
        st = self._ok(); st["qIn"] = [{"net": 5, "block": 4, "tx": "0x2", "seq": -1}]
        with self.assertRaises(SystemExit):
            recon._validate_state(st)

    def test_delivered_cannot_exceed_sent(self):
        # No sequence of ticks produces this, so the file did not come from this program.
        st = self._ok(); st["outDelivered"] = 99
        with self.assertRaises(SystemExit):
            recon._validate_state(st)

    def test_unknown_keys_are_left_alone(self):
        st = self._ok(); st["someFutureDiagnostic"] = {"a": 1}
        recon._validate_state(st)


class WatermarkValidation(unittest.TestCase):
    """nav-snapshot's guard is `bridgeSafeAfter <= pin`, so a NEGATIVE watermark passes it and the
    guard stops existing. Confirmed by execution before this check was added: -1 was accepted."""

    def _v3(self, **over):
        st = {"version": recon.STATE_VERSION, "m": 10, "e": 20, "qOut": [], "qIn": [],
              "outDelivered": 0, "inDelivered": 0, "outSent": 0, "inSent": 0, "inSeqHigh": 0,
              "safeAfter": {"mezo": 10, "eth": 20},
              "ambiguous": {recon.OUT: False, recon.IN: False}}
        st.update(over)
        return st

    def test_a_valid_state_passes(self):
        recon._validate_watermarks(self._v3())

    def test_a_negative_watermark_is_fatal(self):
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(safeAfter={"mezo": -1, "eth": 20}))

    def test_a_non_integer_watermark_is_fatal(self):
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(safeAfter={"mezo": "10", "eth": 20}))

    def test_a_watermark_ahead_of_its_cursor_is_fatal(self):
        # It names a transition at a block we have not scanned, which no tick can produce, and it
        # would hold NAV closed on evidence that does not exist.
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(safeAfter={"mezo": 11, "eth": 20}))

    def test_a_missing_watermark_is_fatal(self):
        st = self._v3()
        del st["safeAfter"]
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(st)

    def test_the_version_must_be_current_after_migration(self):
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(version=2))

    def test_ambiguity_flags_must_be_booleans(self):
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(ambiguous={recon.OUT: "no", recon.IN: False}))
        with self.assertRaises(SystemExit):
            recon._validate_watermarks(self._v3(ambiguous={}))


class AmbiguousArrivals(unittest.TestCase):
    """The module docstring has always said an unmatched arrival that WAS our delivery gets counted
    twice — once as the destination balance, once as a departure still in flight — and NAV is
    overstated. The code ignored it and set attributionCertain unconditionally anyway."""

    def _st(self, q_out=(), q_in=(), amb_out=False, amb_in=False):
        return {"qOut": [{"net": n} for n in q_out], "qIn": [{"net": n} for n in q_in], "pendingIn": [],
                "ambiguous": {recon.OUT: amb_out, recon.IN: amb_in}}

    def test_unmatched_with_an_empty_queue_is_ignored(self):
        # Nothing outstanding, so it cannot be a delivery of ours: a swap output, a venue
        # withdrawal, someone else's transfer. This is the case the file has always handled.
        st = self._st()
        certain, note, events = recon.update_ambiguity(st, un_out=3, un_in=2)
        self.assertTrue(certain)
        self.assertEqual(events, [])
        self.assertEqual(note, "reconciled (fifo)")

    def test_unmatched_with_transfers_outstanding_closes_nav(self):
        st = self._st(q_out=[997 * USDC])
        certain, note, events = recon.update_ambiguity(st, un_out=1, un_in=0)
        self.assertFalse(certain)
        self.assertTrue(st["ambiguous"][recon.OUT])
        self.assertFalse(st["ambiguous"][recon.IN], "the other direction is untouched")
        self.assertEqual(events[0][0], "bridge-ambiguous")
        self.assertIn("counted twice", events[0][1]["detail"])

    def test_the_flag_is_durable_across_ticks(self):
        # The arrival is seen once; the exposure lasts as long as the queue does.
        st = self._st(q_out=[997 * USDC])
        recon.update_ambiguity(st, un_out=1, un_in=0)
        certain, _, events = recon.update_ambiguity(st, un_out=0, un_in=0)  # a quiet tick
        self.assertFalse(certain, "a quiet tick must not clear it")
        self.assertEqual(events, [], "and must not re-log it")

    def test_draining_the_direction_clears_it(self):
        st = self._st(q_out=[997 * USDC])
        recon.update_ambiguity(st, un_out=1, un_in=0)
        st["qOut"] = []  # delivered and matched
        certain, note, events = recon.update_ambiguity(st, un_out=0, un_in=0)
        self.assertTrue(certain)
        self.assertEqual(events[0][0], "bridge-ambiguity-cleared")
        self.assertEqual(note, "reconciled (fifo)")

    def test_one_ambiguous_direction_closes_nav_for_both(self):
        # NAV is a single number over both legs; there is no half-priced round.
        st = self._st(q_in=[100 * USDC])
        certain, note, _ = recon.update_ambiguity(st, un_out=0, un_in=1)
        self.assertFalse(certain)
        self.assertIn(recon.IN, note)
        self.assertNotIn(recon.OUT, note.split("while")[0])

    def test_a_direction_still_ambiguous_keeps_nav_closed_while_the_other_drains(self):
        st = self._st(q_out=[997 * USDC], q_in=[100 * USDC])
        recon.update_ambiguity(st, un_out=1, un_in=1)
        st["qIn"] = []
        certain, note, _ = recon.update_ambiguity(st, un_out=0, un_in=0)
        self.assertFalse(certain)
        self.assertIn(recon.OUT, note)
        self.assertFalse(st["ambiguous"][recon.IN])


class RpcBudget(unittest.TestCase):
    def test_total_provider_outage_has_one_attempt_budget_across_bisection(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        with patch.object(recon, "RPC_MAX_ATTEMPTS", 7), patch.object(recon.subprocess, "run",
                return_value=SimpleNamespace(returncode=1, stdout="")) as run:
            with self.assertRaises(recon.RpcBudgetExceeded):
                recon.logs(["primary", "fallback"], "addr", [], 1, 1000000)
            self.assertEqual(run.call_count, 7)
            self.assertTrue(all(c.kwargs["timeout"] <= recon.RPC_TIMEOUT_SECS for c in run.call_args_list))
        self.assertIsNone(recon._rpc_budget.get())

    def test_deadline_caps_child_timeout_and_stops_before_another_attempt(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        clock = [0.0]
        timeouts = []
        def run(*args, **kwargs):
            timeouts.append(kwargs["timeout"])
            clock[0] += kwargs["timeout"]
            return SimpleNamespace(returncode=1, stdout="")
        with patch.object(recon, "RPC_BUDGET_SECS", 3), patch.object(recon.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(recon.subprocess, "run", side_effect=run):
            with self.assertRaises(recon.RpcBudgetExceeded):
                recon.logs(["primary", "fallback"], "addr", [], 1, 1000000)
        self.assertEqual(timeouts, [3])

    def test_successful_small_ranges_still_bisect_and_reset_the_budget(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        def run(args, **kwargs):
            q = json.loads(args[-1])[0]
            wide = int(q["toBlock"], 16) - int(q["fromBlock"], 16) > 1
            return SimpleNamespace(returncode=1 if wide else 0, stdout="[]")
        with patch.object(recon.subprocess, "run", side_effect=run), patch.object(recon, "block_hash", return_value="0x" + "1" * 64):
            for _ in range(3):
                self.assertEqual(recon.logs(["primary"], "addr", [], 1, 8), [])
        self.assertIsNone(recon._rpc_budget.get())

    def test_split_depth_is_bounded_even_with_fast_provider_failures(self):
        from unittest.mock import patch
        with patch.object(recon, "LOG_MAX_DEPTH", 2), patch.object(recon, "_try", return_value=None) as read:
            with self.assertRaises(recon.RpcBudgetExceeded):
                recon.logs(["primary"], "addr", [], 1, 1000000)
            self.assertEqual(read.call_count, 3)

class InboundRecovery(unittest.TestCase):
    """RC2-NEW-1 / B1 / B2: identical chain history, independently lagging source reads.

    These exercise the REAL tick, persistence and published inventory. Only chain reads are
    synthetic. An Ethereum source boundary is the sequence at its scanned block, not latest.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = _patched(STATE=os.path.join(self.tmp.name, "state.json"),
                              INVENTORY=os.path.join(self.tmp.name, "inventory.json"),
                              MIRROR=os.path.join(self.tmp.name, "mirror.json"))
        self.paths.__enter__()
        self.addCleanup(self.paths.__exit__, None, None, None)
        self.h = _History()
        self.h.N = 2
        self.h.eth_deps = [_dep(100 * USDC, block=201, tx="0xa", logIndex=9),
                           _dep(200 * USDC, block=202, tx="0xb", logIndex=9)]
        self.h.locks = [{"seq": 101 + i, "tx": d["tx"], "logIndex": 8,
                         "amount": d["amount"], "block": d["block"]}
                        for i, d in enumerate(self.h.eth_deps)]
        self.h.mints = [(301, 100 * USDC), (302, 200 * USDC)]
        self.h.mezo_deps, self.h.unlocks = [], []
        self.h.confirmations, self.h.transfers = [], []
        self.fakes = self.h.fakes()
        self.fakes.__enter__()
        self.addCleanup(self.fakes.__exit__, None, None, None)
        self.reads = []
        def uint_call(pool, target, sig, *args, block=None):
            self.reads.append((sig, block))
            if sig.startswith("getCurrentSequenceTip"):
                return 100 + sum(1 for b, _ in self.h.mints if b <= block)
            return max([100] + [l["seq"] for l in self.h.locks if block is None or l["block"] <= block])
        self.calls = _patched(uint_call=uint_call, log=lambda *a, **k: None)
        self.calls.__enter__()
        self.addCleanup(self.calls.__exit__, None, None, None)

    def tick(self, st, eh=240, mh=330, restart=False):
        self.assertIsNotNone(recon.tick(st, mh, eh, POLICY, _TEMPLATE, ["m"], ["e"]))
        if restart:
            restored, _ = recon.migrate(recon.load(mh, eh))
            recon._validate_state(restored)
            recon._validate_cursors(restored, mh, eh)
            recon._validate_watermarks(restored)
            self.assertEqual(restored, st)
            st = restored
        return st

    def ledger(self, st):
        with open(recon.INVENTORY) as f:
            inventory = json.load(f)
        inv = inventory["bridge"]
        # Range-end watermarks may be conservatively different with different range widths.
        # Compare the economic ledger and admission at the SAME final pins, not range sizes.
        if inv["attributionCertain"]:
            for leg in ("mezo", "eth"):
                self.assertTrue(_pin_admissible(inventory, leg, inv["reconciledThrough"][leg]))
                self.assertFalse(_pin_admissible(inventory, leg, inv["reconciledThrough"][leg] + 1))
        return {"sent": st["inSent"], "delivered": st["inDelivered"], "q": st["qIn"],
                "pending": st["pendingIn"], "foreign": st["foreignIn"],
                "certain": inv["attributionCertain"], "inFlight": inv["inFlight"],
                "through": inv["reconciledThrough"]}

    def test_same_history_whole_split_and_restarted_produces_the_same_inventory(self):
        expected = self.ledger(self.tick(_full_state(200, 200)))
        self.assertTrue(expected["certain"])
        self.assertEqual(expected["delivered"], 300 * USDC)
        for heads in ([205, 206, 207, 240, 240], [206, 207, 240], [205, 240]):
            for restart in (False, True):
                with self.subTest(heads=heads, restart=restart):
                    st = _full_state(200, 200)
                    for eh in heads:
                        st = self.tick(st, eh, restart=restart)
                    self.assertEqual(self.ledger(st), expected)

    def test_late_foreign_lock_explains_a_partly_known_mint_window(self):
        self.h.eth_deps.pop()
        self.h.locks[1]["amount"] = 30 * USDC
        self.h.mints[1] = (302, 30 * USDC)
        expected = self.ledger(self.tick(_full_state(200, 200)))
        st = self.tick(_full_state(200, 200), 206, restart=True)
        self.assertFalse(self.ledger(st)["certain"])
        self.assertTrue(st["pendingIn"], "the unexplained window must survive the cursor advancing")
        st = self.tick(st, 240, restart=True)
        self.assertEqual(self.ledger(st), expected)
        self.assertEqual(st["inDelivered"], 100 * USDC)

    def test_equal_amount_late_foreign_does_not_make_an_early_match_certain(self):
        self.h.eth_deps.pop()
        self.h.locks[1]["amount"] = 100 * USDC
        # One succeeded, one failed: both sequences processed, only one 100 mint.
        self.h.mints = [(301, 100 * USDC), (302, 0)]
        st = self.tick(_full_state(200, 200), 206)
        self.assertEqual(st["inDelivered"], 0, "source history is incomplete even though 100 fits")
        st = self.tick(st, 240)
        self.assertFalse(self.ledger(st)["certain"], "two subsets fit; neither may be guessed")
        self.assertFalse(any(e.get("lost") for e in st["qIn"]))

    def test_genuine_ambiguity_stays_closed_across_restart_and_quiet_ticks(self):
        self.h.eth_deps[1]["amount"] = 100 * USDC
        self.h.locks[1]["amount"] = 100 * USDC
        self.h.mints = [(301, 100 * USDC), (302, 0)]
        st = _full_state(200, 200)
        for _ in range(3):
            st = self.tick(st, restart=True)
            self.assertFalse(self.ledger(st)["certain"])
            self.assertEqual(st["inDelivered"], 0)
            self.assertFalse(any(e.get("lost") for e in st["qIn"]))

    def test_a_proved_loss_and_later_donation_do_not_latch_the_direction(self):
        self.h.eth_deps.pop()
        self.h.locks[1]["amount"] = 30 * USDC
        self.h.mints = [(301, 0), (302, 30 * USDC)]
        st = self.tick(_full_state(200, 200), 206, mh=301)
        self.assertTrue(st["qIn"][0]["lost"])
        st = self.tick(st, 206, restart=True)
        st = self.tick(st, 240, restart=True)
        self.assertTrue(self.ledger(st)["certain"])
        self.assertEqual(st["pendingIn"], [])
        self.assertEqual(self.ledger(st)["inFlight"][0]["haircutBps"], 10000)

    def test_source_sequence_is_read_at_processed_ethereum_block(self):
        self.tick(_full_state(200, 200), 206)
        self.assertIn(("sequence()(uint256)", 201), self.reads)
        self.assertNotIn(("sequence()(uint256)", None), self.reads)

    def test_all_source_destination_interleavings_settle_the_same_successful_history(self):
        import itertools
        expected = self.ledger(self.tick(_full_state(200, 200)))
        # All six orderings of two source steps and two destination steps, with a restart
        # after every step. The quiet final range must reconcile the SAME final price inputs.
        for source_positions in itertools.combinations(range(4), 2):
            with self.subTest(source_positions=source_positions):
                st, mh, eh, mi, ei = _full_state(200, 200), 200, 205, 0, 0
                for i in range(4):
                    if i in source_positions:
                        eh = [206, 240][ei]; ei += 1
                    else:
                        mh = [301, 330][mi]; mi += 1
                    st = self.tick(st, eh, mh, restart=True)
                self.assertEqual(self.ledger(st), expected)

    def test_more_than_search_limit_late_successes_settle_after_source_catches_up(self):
        n = recon.MAX_SETTLE_CANDIDATES + 1
        self.h.N = n
        self.h.eth_deps = [_dep((i + 1) * 100 * USDC, block=201 + i, tx=f"0xt{i}", logIndex=9) for i in range(n)]
        self.h.locks = [{"seq": 101 + i, "tx": d["tx"], "logIndex": 8,
                         "amount": d["amount"], "block": d["block"]} for i, d in enumerate(self.h.eth_deps)]
        self.h.mints = [(301 + i, (i + 1) * 100 * USDC) for i in range(n)]
        expected = self.ledger(self.tick(_full_state(200, 200)))
        st = self.tick(_full_state(200, 200), 205)
        for eh in range(206, 206 + n):
            st = self.tick(st, eh, restart=True)
        st = self.tick(st)
        self.assertEqual(self.ledger(st), expected)

    def test_resolving_a_window_does_not_latch_an_unrelated_future_backlog(self):
        self.h.eth_deps.append(_dep(70 * USDC, block=203, tx="0xfuture", logIndex=9))
        self.h.locks.append({"seq": 103, "tx": "0xfuture", "logIndex": 8, "amount": 70 * USDC, "block": 203})
        st = self.tick(_full_state(200, 200), 206)
        self.assertFalse(self.ledger(st)["certain"])
        st = self.tick(st)
        self.assertTrue(self.ledger(st)["certain"])
        self.assertEqual([e["seq"] for e in st["qIn"]], [103])
        self.assertEqual(st["inDelivered"], 300 * USDC)

    def test_late_departure_without_a_mint_remains_a_proved_loss(self):
        self.h.mints = [(301, 0), (302, 0)]
        st = self.tick(_full_state(200, 200), 205)
        st = self.tick(st)
        self.assertTrue(self.ledger(st)["certain"])
        self.assertTrue(all(e["lost"] for e in st["qIn"]))
        self.assertEqual(st["inDelivered"], 0)
        self.assertEqual(self.ledger(st)["inFlight"][0]["haircutBps"], 10000)

    def test_lost_rows_alone_cannot_keep_a_resolved_direction_ambiguous(self):
        st = _full_state(200, 200)
        st["qIn"] = [{"net": 100 * USDC, "block": 190, "tx": "0xlost", "seq": 99, "lost": True}]
        st["ambiguous"][IN] = True
        self.assertTrue(recon.update_ambiguity(st, 0, 0)[0])
        self.assertTrue(st["qIn"][0]["lost"], "clearing a flag must not erase loss evidence")

    def test_watermark_still_refuses_pins_before_the_late_mint_window(self):
        st = self.tick(_full_state(200, 200), 205)
        st = self.tick(st)
        with open(recon.INVENTORY) as f:
            inv = json.load(f)
        self.assertFalse(_pin_admissible(inv, "mezo", 329))
        self.assertTrue(_pin_admissible(inv, "mezo", 330))

    def test_unreadable_source_boundary_holds_before_fold_or_persist(self):
        st = _full_state(200, 200)
        before = json.loads(json.dumps(st))
        original = recon.uint_call
        def unreadable(pool, target, sig, *args, **kwargs):
            return None if sig.startswith("sequence()") else original(pool, target, sig, *args, **kwargs)
        with _patched(uint_call=unreadable):
            self.assertIsNone(recon.tick(st, 330, 240, POLICY, _TEMPLATE, ["m"], ["e"]))
        self.assertEqual(st, before)
        self.assertFalse(os.path.exists(recon.STATE))
        self.assertFalse(os.path.exists(recon.INVENTORY))


class UnreadableState(unittest.TestCase):
    def test_old_processed_row_without_its_window_requires_explicit_rebuild(self):
        st = _full_state(330, 235)
        st["tipAt"] = 102
        st["inSent"] = 100 * USDC
        st["qIn"] = [{"net": 100 * USDC, "block": 201, "tx": "0xa", "seq": 101}]
        with self.assertRaisesRegex(SystemExit, "rebuild from deployment blocks"):
            recon._validate_state(st)

    def test_existing_invalid_json_is_not_a_first_run(self):
        from unittest.mock import patch, mock_open
        for contents in ("", "{broken", '{"version":4,'):
            with self.subTest(contents=contents), patch.object(recon.os.path, "exists", return_value=True), \
                    patch("builtins.open", mock_open(read_data=contents)):
                with self.assertRaisesRegex(SystemExit, "FATAL.*state"):
                    recon.load(10000, 20000)

    def test_existing_unreadable_file_is_not_a_first_run(self):
        from unittest.mock import patch
        with patch.object(recon.os.path, "exists", return_value=True), \
                patch("builtins.open", side_effect=PermissionError("test denied")):
            with self.assertRaisesRegex(SystemExit, "FATAL.*state"):
                recon.load(10000, 20000)


class InboundReadConsistency(unittest.TestCase):
    """M1: contradictory reads must be retried, not persisted or called a donation."""

    def setUp(self):
        self.h = OneTick()
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.st = _full_state(100, 200)
        self.st["tipAt"] = 9
        self.h.tips.update(at_cursor=9, before=9)
        self.h._tick(self.st, mh=100, eh=205)  # known-good persisted baseline

    def assert_held(self):
        before = json.loads(json.dumps(self.st))
        paths = [recon.STATE, recon.INVENTORY, recon.MIRROR]
        def bytes_at(path):
            with open(path, "rb") as f:
                return f.read()
        files = [bytes_at(p) for p in paths]
        self.assertIsNone(self.h._tick(self.st))
        self.assertEqual(self.st, before, "an inconsistent read must not poison the live ledger")
        self.assertEqual([bytes_at(p) for p in paths], files, "no cursor, state or inventory publication")

    def test_positive_residual_without_tip_progress_holds_then_recovers(self):
        self.h.minted = 1  # smallest unit, not proof that a native transfer is reachable
        self.assert_held()
        self.h.minted = 0  # provider now returns a consistent balance/log snapshot
        self.assertTrue(self.h._tick(self.st)[0])
        self.assertEqual(self.st["pendingIn"], [])
        self.assertEqual(self.st["inDelivered"], 0)

    def test_unknown_residual_with_complete_source_is_not_accepted_as_cash(self):
        self.h.tips["at_cursor"] = 10
        self.h.minted = 100 * USDC
        self.assert_held()  # source counter says complete but its locks are missing
        # Retrying the SAME source/destination ranges with the missing logs restores evidence.
        self.h.deps[self.h.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
        self.h.locks = [{"seq": 10, "tx": "0xa", "amount": 100 * USDC}]
        self.assertTrue(self.h._tick(self.st)[0])
        self.assertEqual(self.st["inSent"], 100 * USDC)
        self.assertEqual(self.st["inDelivered"], 100 * USDC)
        self.h.minted = 0
        self.h.deps[self.h.ETH_ADAPTER], self.h.locks = [], []
        self.assertTrue(self.h._tick(self.st, mh=120, eh=220)[0])
        self.assertEqual(self.st["inDelivered"], 100 * USDC, "retry must not count twice")

    def test_persistent_contradiction_never_opens_nav_or_changes_state(self):
        self.h.minted = 30 * USDC
        for _ in range(3):
            self.assert_held()

    def test_regressing_tip_holds_even_without_a_balance_change(self):
        self.h.tips["at_cursor"] = 8
        self.assert_held()

    def test_real_foreign_lock_is_still_a_valid_arrival(self):
        self.h.tips["at_cursor"] = 10
        self.h.minted = 30 * USDC
        self.h.locks = [{"seq": 10, "tx": "0xforeign", "amount": 30 * USDC}]
        self.assertTrue(self.h._tick(self.st)[0])
        self.assertEqual(self.st["inSent"], 0)
        self.assertEqual(self.st["inDelivered"], 0)
        self.assertEqual(self.st["pendingIn"], [])

    def test_old_impossible_window_requires_rebuild_not_silent_clearing(self):
        self.st["pendingIn"] = [{"tipPrev": 9, "tipNow": 9, "residual": 1, "block": 100}]
        with self.assertRaisesRegex(SystemExit, "rebuild"):
            recon._validate_state(self.st)


class SecondScanIntegrity(unittest.TestCase):
    def test_actual_l1_lock_transfer_sent_order_requires_matching_token_movement(self):
        # Real pilot receipt 0x4e8d0b3a2e1773aed6841f520df1ed324a20ec2983f437a89366f52426717913,
        # Ethereum block 25791463, sequence 35338. Lock before the token transfer, not after.
        tx = "0x4e8d0b3a2e1773aed6841f520df1ed324a20ec2983f437a89366f52426717913"
        amount = int("6f65766", 16)
        dep = dict(_dep(amount, tx=tx), logIndex=172)
        lock = dict(tx=tx, seq=35338, logIndex=170, amount=amount)
        paid = dict(tx=tx, logIndex=171, amount=amount)
        self.assertEqual(recon.join_sequences([dep], [lock], [paid])[0]["seq"], 35338)
        for evidence in ([], [dict(paid, amount=amount-1)], [dict(paid, tx="foreign")], [dict(paid, logIndex=169)]):
            with self.assertRaisesRegex(ValueError, "adjacent"):
                recon.join_sequences([dep], [lock], evidence)

    def test_missing_own_lock_cannot_borrow_earlier_foreign_lock(self):
        with self.assertRaisesRegex(ValueError, "adjacent"):
            recon.join_sequences([dict(_dep(100, tx="tx"), logIndex=7)],
                                 [dict(tx="tx", seq=1, logIndex=1, amount=100)])

    def test_lagging_empty_provider_is_not_accepted(self):
        calls = []
        def sh(*args, **kwargs):
            rpc = args[args.index("--rpc-url") + 1]
            calls.append((rpc, args[-2]))
            if args[-2] == "eth_getBlockByNumber":
                return "null" if rpc == "lagging" else json.dumps({"number": "0x20", "hash": "0x" + "a" * 64})
            return "[]"
        with _patched(sh=sh):
            self.assertEqual(recon.logs(["lagging", "healthy"], "addr", [], 16, 32), [])
        self.assertNotIn(("lagging", "eth_getLogs"), calls)
        self.assertIn(("healthy", "eth_getLogs"), calls)

    def test_missing_confirmation_is_not_silently_discarded(self):
        with self.assertRaisesRegex(ValueError, "incomplete"):
            recon.join_arrivals([], [dict(tx="tx", logIndex=1, amount=10)])

    def test_foreign_lock_in_same_tx_is_retained_and_uses_net(self):
        h = OneTick(); h.setUp()
        try:
            h.deps[h.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
            h.locks = [dict(seq=21475, tx="0xa", logIndex=8, amount=100 * USDC),
                       dict(seq=21476, tx="0xa", logIndex=12, amount=20 * USDC)]
            fees = {**recon.FEES, IN: {"fee": 3 * USDC, "tol": 0}}
            with _patched(FEES=fees):
                _, eth = recon.read_tick(_full_state(100, 200), 110, 210, POLICY, ["m"], ["e"])
            self.assertEqual(eth["foreign"], [dict(net=17 * USDC, block=201, tx="0xa", seq=21476)])
        finally:
            h.tearDown()

    def test_one_provider_per_leg_and_failed_tick_rotates(self):
        recon._provider_offset.clear()
        @recon.consistent_tick
        def read(fail):
            a = recon.view_pool(["a", "b"])
            self.assertEqual(recon.view_pool(["a", "b"]), a)
            if fail: raise RuntimeError("missing evidence")
            return a
        with self.assertRaises(RuntimeError): read(True)
        self.assertEqual(read(False), ["b"])
        recon._provider_offset.clear()

    def test_eth_catchup_is_bounded(self):
        h = OneTick(); h.setUp()
        try:
            with _patched(ETH_RANGE_MAX=7):
                _, eth = recon.read_tick(_full_state(100, 200), 110, 10000, POLICY, ["m"], ["e"])
            self.assertEqual((eth["lo"], eth["hi"]), (201, 207))
        finally: h.tearDown()

    def test_fallback_does_not_rotate_healthy_leg_into_failure(self):
        recon._provider_offset.clear()
        @recon.identify_failed_pool
        def reader(pool):
            selected = recon.view_pool(pool)[0]
            return selected if selected.endswith("good") else None
        @recon.consistent_tick
        def read():
            mezo = reader(["m-good", "m-bad"])
            eth = reader(["e-bad", "e-good"])
            if mezo is None or eth is None:
                raise RuntimeError("incomplete snapshot")
            return mezo, eth
        try:
            with self.assertRaises(RuntimeError): read()
            self.assertEqual(read(), ("m-good", "e-good"))
        finally:
            recon._provider_offset.clear()

    def test_extra_locks_before_between_and_after_sends_are_foreign(self):
        deps = [dict(_dep(100, tx="tx", seq=None), logIndex=4),
                dict(_dep(200, tx="tx", seq=None), logIndex=10)]
        locks = [dict(tx="tx", seq=s, logIndex=i, amount=a)
                 for s, i, a in [(1, 1, 100), (2, 3, 100), (3, 6, 999), (4, 9, 200), (5, 12, 100)]]
        self.assertEqual([d["seq"] for d in recon.join_sequences(deps, locks)], [2, 4])

    def test_nearest_lock_must_match_amount_not_an_earlier_same_amount(self):
        deps = [dict(_dep(100, tx="tx"), logIndex=4)]
        locks = [dict(tx="tx", seq=1, logIndex=1, amount=100),
                 dict(tx="tx", seq=2, logIndex=3, amount=200)]
        with self.assertRaises(ValueError):
            recon.join_sequences(deps, locks)

    def test_duplicate_sequence_in_state_is_rejected(self):
        st = _full_state(100, 200)
        recon.apply_tick(st, "eth", [_dep(100, seq=50), _dep(100, seq=50)], [])
        with self.assertRaises(SystemExit):
            recon._validate_state(st)

    def test_invalid_candidate_rotates_provider_and_retries_without_mutating_committed_state(self):
        # A structurally invalid RPC-derived candidate is not corrupt DISK state.
        # SystemExit here used to bypass both main's tick-error and provider rotation.
        h = OneTick(); h.setUp()
        recon._provider_offset.clear()
        try:
            st = _full_state(100, 200)
            recon.apply_tick(st, "eth", [_dep(100 * USDC, block=198, tx="old", seq=21475)], [])
            recon.persist_state(st)
            recon.write_inventory({"previous": "committed inventory"})
            before = json.dumps(st, sort_keys=True)
            with open(recon.STATE, "rb") as f: disk_before = f.read()
            with open(recon.INVENTORY, "rb") as f: inv_before = f.read()
            pool = ["bad-provider", "healthy-fallback"]
            seen = []

            def departures(rpcs, adapter, *args):
                if adapter != h.ETH_ADAPTER:
                    return []
                provider = recon.view_pool(rpcs)[0]
                seen.append(provider)
                return [dict(_dep(100 * USDC, block=203, tx="new"), logIndex=9)]

            def locks(rpcs, *args):
                seq = 21475 if recon.view_pool(rpcs)[0] == pool[0] else 21476
                return [dict(seq=seq, tx="new", block=203, logIndex=8, amount=100 * USDC)]

            with _patched(departures=departures, locked_sequences=locks):
                with self.assertRaisesRegex(ValueError, "candidate.*duplicate sequence"):
                    recon.tick(st, 110, 210, POLICY, _TEMPLATE, ["m"], pool)
                self.assertEqual(json.dumps(st, sort_keys=True), before)
                with open(recon.STATE, "rb") as f: self.assertEqual(f.read(), disk_before)
                with open(recon.INVENTORY, "rb") as f: self.assertEqual(f.read(), inv_before)
                self.assertEqual(recon._provider_offset[tuple(pool)], 1)
                recon.tick(st, 110, 210, POLICY, _TEMPLATE, ["m"], pool)
                # The same range must not be folded twice after successful recovery.
                recon.tick(st, 110, 210, POLICY, _TEMPLATE, ["m"], pool)
            self.assertEqual(seen, pool)
            self.assertEqual(st["inSent"], 200 * USDC)
            self.assertEqual([e["seq"] for e in st["qIn"]], [21475, 21476])
            self.assertEqual(h._inventory()["bridge"]["reconciledThrough"]["eth"], 205)
        finally:
            recon._provider_offset.clear()
            h.tearDown()

    def test_invalid_candidate_watermark_is_retryable_but_stored_watermark_stays_fatal(self):
        h = OneTick(); h.setUp()
        recon._provider_offset.clear()
        original_fold = recon.fold_tick
        pool = ["bad-provider", "healthy-fallback"]
        try:
            st = _full_state(100, 200)
            before = json.dumps(st, sort_keys=True)

            def inconsistent_fold(candidate, *args, **kwargs):
                result = original_fold(candidate, *args, **kwargs)
                if recon.view_pool(pool)[0] == pool[0]:
                    candidate["safeAfter"]["mezo"] = candidate["m"] + 1
                return result

            with _patched(fold_tick=inconsistent_fold):
                with self.assertRaisesRegex(ValueError, "candidate.*ahead"):
                    h._tick(st)
                self.assertEqual(json.dumps(st, sort_keys=True), before)
                self.assertFalse(os.path.exists(recon.STATE))
                self.assertFalse(os.path.exists(recon.INVENTORY))
                self.assertEqual(recon._provider_offset[tuple(pool)], 1)
                h._tick(st)
            self.assertEqual(st["m"], 110)
            self.assertTrue(h._inventory()["bridge"]["attributionCertain"])
            # Persisted corruption is never a reason to rotate RPCs or reset accounting.
            st["safeAfter"]["mezo"] = st["m"] + 1
            recon.persist_state(st)
            with self.assertRaisesRegex(SystemExit, "FATAL.*ahead"):
                recon._validate_watermarks(recon.load(110, 210))
        finally:
            recon._provider_offset.clear()
            h.tearDown()

    def test_duplicate_arrival_cannot_apply_twice(self):
        st = _full_state(100, 200)
        recon.apply_tick(st, "mezo", [_dep(100 * USDC, seq=10)], [])
        a = dict(seq=10, gross=100 * USDC, net=97 * USDC, block=201, tx="arrival")
        recon.settle_outbound(st, [a, dict(a)], 0)
        self.assertEqual(st["outDelivered"], 97 * USDC)
        self.assertEqual(st["pendingOut"], [])

    def test_fold_and_persist_failures_do_not_mutate_live_state(self):
        h = OneTick(); h.setUp()
        try:
            h.deps[h.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
            h.locks = [dict(seq=21475, tx="0xa")]
            for point in ("update_ambiguity", "persist_state"):
                st = _full_state(100, 200)
                before = json.dumps(st, sort_keys=True)
                def fail(*a, **k): raise OSError("injected failure")
                with _patched(**{point: fail}), self.assertRaises(OSError):
                    h._tick(st)
                self.assertEqual(json.dumps(st, sort_keys=True), before, point)
                h._tick(st)
                self.assertEqual(st["inSent"], 100 * USDC)
        finally:
            h.tearDown()

    def test_publication_retries_without_rpc_after_commit(self):
        h = OneTick(); h.setUp()
        try:
            st = _full_state(100, 200)
            h.deps[h.ETH_ADAPTER] = [_dep(100 * USDC, block=203, tx="0xa")]
            h.locks = [dict(seq=21475, tx="0xa")]
            def fail(*a, **k): raise OSError("injected failure")
            with _patched(write_inventory=fail), self.assertRaises(OSError):
                h._tick(st)
            with _patched(read_tick=fail):
                h._tick(st)
            self.assertEqual(h._inventory()["bridge"]["reconciledThrough"]["eth"], 205)
            self.assertEqual(st["inSent"], 100 * USDC)
        finally:
            h.tearDown()

    def test_lost_records_are_not_outstanding_age(self):
        self.assertEqual(recon.oldest_block([dict(block=1, lost=True), dict(block=9)]), 9)
        self.assertIsNone(recon.oldest_block([dict(block=1, lost=True)]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
