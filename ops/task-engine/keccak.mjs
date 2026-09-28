// SPDX-License-Identifier: BUSL-1.1
// Compact Keccak-256 (Ethereum's keccak, NOT SHA3-256 — different padding). Vendored so the
// off-chain task engine reproduces on-chain keccak256(abi.encode(Task)) byte-for-byte with
// zero external dependencies. Verified against RFC/known vectors in engine.test.mjs.
//
// This is a pure, standard Keccak-f[1600] sponge with rate 1088 bits (136 bytes) and the
// 0x01 keccak domain-suffix. Operates on Uint8Array; returns a 32-byte Uint8Array.

const RC = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
];
const R = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

export function rotl64(hi, lo, n) {
  if (n === 0) return [hi, lo];
  // JS shifts mask their count to five bits: >>> 32 would mean >>> 0, not zero.
  if (n === 32) return [lo >>> 0, hi >>> 0];
  if (n < 32) {
    return [((hi << n) | (lo >>> (32 - n))) >>> 0, ((lo << n) | (hi >>> (32 - n))) >>> 0];
  }
  n -= 32;
  return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
}

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(10);
    for (let x = 0; x < 5; x++) {
      C[x * 2] = s[x * 2] ^ s[(x + 5) * 2] ^ s[(x + 10) * 2] ^ s[(x + 15) * 2] ^ s[(x + 20) * 2];
      C[x * 2 + 1] =
        s[x * 2 + 1] ^ s[(x + 5) * 2 + 1] ^ s[(x + 10) * 2 + 1] ^ s[(x + 15) * 2 + 1] ^ s[(x + 20) * 2 + 1];
    }
    for (let x = 0; x < 5; x++) {
      const [dhi, dlo] = rotl64(C[((x + 1) % 5) * 2], C[((x + 1) % 5) * 2 + 1], 1);
      const thi = C[((x + 4) % 5) * 2] ^ dhi;
      const tlo = C[((x + 4) % 5) * 2 + 1] ^ dlo;
      for (let y = 0; y < 5; y++) {
        s[(x + y * 5) * 2] ^= thi;
        s[(x + y * 5) * 2 + 1] ^= tlo;
      }
    }
    const B = new Array(50);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + y * 5;
        const [hi, lo] = rotl64(s[idx * 2], s[idx * 2 + 1], R[idx]);
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        B[(nx + ny * 5) * 2] = hi;
        B[(nx + ny * 5) * 2 + 1] = lo;
      }
    }
    for (let i = 0; i < 25; i++) {
      s[i * 2] = B[i * 2] ^ ((~B[((i + 1) % 5 + Math.floor(i / 5) * 5) * 2]) & B[((i + 2) % 5 + Math.floor(i / 5) * 5) * 2]);
      s[i * 2 + 1] =
        B[i * 2 + 1] ^ ((~B[((i + 1) % 5 + Math.floor(i / 5) * 5) * 2 + 1]) & B[((i + 2) % 5 + Math.floor(i / 5) * 5) * 2 + 1]);
    }
    s[0] ^= RC[round][0];
    s[1] ^= RC[round][1];
  }
}

/** keccak256(Uint8Array) -> 32-byte Uint8Array */
export function keccak256(input) {
  const rate = 136; // bytes
  const s = new Array(50).fill(0); // 25 lanes as [hi,lo] pairs
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] ^= 0x01; // keccak domain suffix
  padded[padded.length - 1] ^= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      const b = off + i * 8;
      const lo = padded[b] | (padded[b + 1] << 8) | (padded[b + 2] << 16) | (padded[b + 3] << 24);
      const hi = padded[b + 4] | (padded[b + 5] << 8) | (padded[b + 6] << 16) | (padded[b + 7] << 24);
      s[i * 2] ^= hi >>> 0;
      s[i * 2 + 1] ^= lo >>> 0;
    }
    keccakF(s);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const hi = s[i * 2] >>> 0;
    const lo = s[i * 2 + 1] >>> 0;
    out[i * 8] = lo & 0xff;
    out[i * 8 + 1] = (lo >>> 8) & 0xff;
    out[i * 8 + 2] = (lo >>> 16) & 0xff;
    out[i * 8 + 3] = (lo >>> 24) & 0xff;
    out[i * 8 + 4] = hi & 0xff;
    out[i * 8 + 5] = (hi >>> 8) & 0xff;
    out[i * 8 + 6] = (hi >>> 16) & 0xff;
    out[i * 8 + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

export function keccak256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return "0x" + Buffer.from(keccak256(bytes)).toString("hex");
}
