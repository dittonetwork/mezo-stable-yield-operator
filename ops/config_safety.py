# SPDX-License-Identifier: BUSL-1.1
"""Small shared checks for the internal and exported config generators."""
import json
import os
import re
import subprocess
from urllib.parse import urlsplit


def valid_address(value):
    return isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", value) is not None and int(value, 16) != 0


def same_address(got, want):
    return valid_address(got) and valid_address(want) and got.lower() == want.lower()


def safe_url(value):
    try:
        parsed = urlsplit(value)
        return "%s://%s" % (parsed.scheme, parsed.hostname or "<invalid-host>")
    except ValueError:
        return "<invalid-url>"


def cast_read(rpcs, to, sig, *args):
    for rpc in rpcs:
        try:
            result = subprocess.run(["cast", "call", to, sig, *args, "--rpc-url", rpc],
                                    capture_output=True, text=True, timeout=15)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0 and result.stdout.strip():
            word = result.stdout.strip().split()[0]
            if re.fullmatch(r"(?:0x[0-9a-fA-F]{40}|[0-9]+)", word):
                return word
    # Provider error bodies may echo credentials, paths or query strings. They are not an
    # address and no raw stderr is needed to diagnose this refusal.
    return "<rpc-error>"


def private_json(path, value):
    # Set permissions BEFORE emitting credential-bearing bytes, including when replacing
    # an existing world-readable file. Do not follow a symlink supplied as the destination.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        os.fchmod(out.fileno(), 0o600)
        json.dump(value, out, indent=1)
