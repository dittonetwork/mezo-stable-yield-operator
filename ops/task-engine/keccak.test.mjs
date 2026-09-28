// SPDX-License-Identifier: BUSL-1.1
import test from "node:test";
import assert from "node:assert/strict";
import * as keccak from "./keccak.mjs";

test("64-bit rotation agrees with a BigInt oracle for all shifts, including 32", () => {
  const mask = (1n << 64n) - 1n;
  for (const value of [0n, 1n, mask, 0x123456789abcdef0n, 0x8000000000000001n]) {
    for (let n = 0; n < 64; n++) {
      const hi = Number(value >> 32n), lo = Number(value & 0xffffffffn);
      const expected = ((value << BigInt(n)) | (value >> BigInt(64 - n))) & mask;
      assert.deepEqual(keccak.rotl64(hi, lo, n),
        [Number(expected >> 32n), Number(expected & 0xffffffffn)], `value ${value}, rotation ${n}`);
    }
  }
});

test("Ethereum Keccak vectors remain unchanged (not SHA3 padding)", () => {
  assert.equal(keccak.keccak256Hex(new Uint8Array()),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak.keccak256Hex(new TextEncoder().encode("abc")),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});
