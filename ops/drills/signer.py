#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""BLS operator signer — drill fixtures AND the real per-operator runtime path.

Two worlds live here on purpose, because they must produce byte-identical wire formats:

- DRILL/FIXTURE mode (`aggregate`): one process holds all 5 DETERMINISTIC fixture keys
  (sha256("ditto-mezo-pilot-operator-i") — same derivation as ops/vectors/gen_vectors.py)
  and signs for every seat at once. TEST KEYS ONLY; used by ops/drills/ and
  ops/testnet/run-e2e.mjs.
- PRODUCTION mode (`keygen` / `sign` / `combine`): each operator holds ONE private key and
  produces a PARTIAL signature; the aggregator combines partials it never could have made
  itself. This is the split the live operator network runs on — no process ever holds more
  than its own key.

Wire formats (must match src/libraries/BLS.sol + the EIP-2537 precompiles):
- partial signature / PoP on the wire: COMPRESSED (G2 = 96 bytes, G1 pubkey = 48 bytes)
- anything handed to the chain: UNCOMPRESSED (G1 = 128 bytes, G2 = 256 bytes)

usage:
  signer.py keygen <keyfile>
      -> writes a fresh private key (0600) and prints JSON with the compressed pubkey (for
         the aggregator/operator config) plus the uncompressed pubkeyG1 + popG2 that
         OperatorWhitelist enrollment expects.
  signer.py sign <0x-msg> <keyfile>
      -> prints 0x<compressed G2 partial signature> for THIS operator's key only.
  signer.py combine <0x-msg> <partials-csv> <compressed-pubkeys-csv>
      -> aggregates partials, FastAggregateVerify's them against the pubkeys (so a bad
         partial is caught here, not by a reverted on-chain tx), prints the
         0x<uncompressed G2> aggregate the Executor verifies.
  signer.py aggregate <0x-msg> <indices-csv>            [FIXTURE KEYS — drills only]
      -> prints 0x<uncompressed G2> aggregate over the fixture seats.
"""
import json
import os
import secrets
import sys
from hashlib import sha256

from py_ecc.bls import G2ProofOfPossession as bls
from py_ecc.bls.g2_primitives import pubkey_to_G1, signature_to_G2
from py_ecc.optimized_bls12_381 import curve_order, normalize

SKS = [
    int.from_bytes(sha256(f"ditto-mezo-pilot-operator-{i}".encode()).digest(), "big") % curve_order
    for i in range(5)
]

# keccak256("dmusd.task.<NAME>") for the two tasks that may never be signed directly from a quorum
# key: post_nav sets the price everything else consumes, and fix_batch strikes an obligation and
# burns shares against it. Keep in lockstep with ops/task-engine/direct-signing-guard.mjs.
QUORUM_ONLY_TASK_TYPES = {
    bytes.fromhex("460f828c90ceab083552b7f4cd3dba7d642f67a888afa5d907a36c505e6881c1"),  # POST_NAV
    bytes.fromhex("ca5d16444fc0de91901415410e79b34c4ca75868d2e6b5441978b8c4558b38cb"),  # FIX_BATCH
}


def _fe(v) -> str:
    return int(v).to_bytes(64, "big").hex()


def g2_uncompressed(sig_compressed: bytes) -> str:
    x, y = normalize(signature_to_G2(sig_compressed))
    return _fe(x.coeffs[0]) + _fe(x.coeffs[1]) + _fe(y.coeffs[0]) + _fe(y.coeffs[1])


def g1_uncompressed(pk_compressed: bytes) -> str:
    x, y = normalize(pubkey_to_G1(pk_compressed))
    return _fe(x) + _fe(y)


def _msg(arg: str) -> bytes:
    m = bytes.fromhex(arg.removeprefix("0x"))
    if len(m) != 224:
        raise ValueError(f"task message must be 224 bytes, got {len(m)}")
    return m


def _assert_signing_context(msg: bytes, fixture: bool = False):
    # Production price signatures must follow operator verification. This marker prevents
    # accidental use of this CLI; it is not a boundary against a holder of raw quorum keys.
    if msg[96:128] in QUORUM_ONLY_TASK_TYPES and (fixture or os.getenv("BLS_OPERATOR_VERIFIED") != "1"):
        raise RuntimeError("direct BLS signing disabled for post_nav and fix_batch")


def _hexlist(arg: str) -> list:
    return [bytes.fromhex(x.strip().removeprefix("0x")) for x in arg.split(",") if x.strip()]


def _load_sk(path: str) -> int:
    with open(path) as f:
        sk = int(f.read().strip().removeprefix("0x"), 16)
    if not 0 < sk < curve_order:
        raise ValueError("private key out of range")
    return sk


def cmd_keygen(path: str):
    sk = secrets.randbelow(curve_order - 1) + 1
    # 0600 from creation — never widen; the key must not exist world-readable even briefly.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(hex(sk))
    pk, pop = bls.SkToPk(sk), bls.PopProve(sk)
    print(json.dumps({
        "keyFile": path,
        "pubkeyCompressed": "0x" + pk.hex(),          # aggregator/operator config
        "pubkeyG1": "0x" + g1_uncompressed(pk),       # OperatorWhitelist enrollment
        "popG2": "0x" + g2_uncompressed(pop),         # OperatorWhitelist enrollment
    }, indent=1))


def cmd_sign(msg_arg: str, keyfile: str):
    msg = _msg(msg_arg)
    _assert_signing_context(msg)
    print("0x" + bls.Sign(_load_sk(keyfile), msg).hex())


def cmd_combine(msg_arg: str, partials_arg: str, pubkeys_arg: str):
    msg, partials, pks = _msg(msg_arg), _hexlist(partials_arg), _hexlist(pubkeys_arg)
    assert len(partials) == len(pks), f"{len(partials)} partials vs {len(pks)} pubkeys"
    agg = bls.Aggregate(partials)
    # Catch a bad/foreign partial HERE — on-chain it would just burn gas on a revert.
    assert bls.FastAggregateVerify(pks, msg, agg), "aggregate does not verify against the given pubkeys"
    print("0x" + g2_uncompressed(agg))


def cmd_aggregate(msg_arg: str, indices_arg: str):
    msg = _msg(msg_arg)
    _assert_signing_context(msg, fixture=True)
    indices = [int(i) for i in indices_arg.split(",")]
    sigs = [bls.Sign(SKS[i], msg) for i in indices]
    agg = bls.Aggregate(sigs)
    assert bls.FastAggregateVerify([bls.SkToPk(SKS[i]) for i in indices], msg, agg)
    print("0x" + g2_uncompressed(agg))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "keygen":
        cmd_keygen(sys.argv[2])
    elif cmd == "sign":
        cmd_sign(sys.argv[2], sys.argv[3])
    elif cmd == "combine":
        cmd_combine(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "aggregate":
        cmd_aggregate(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
