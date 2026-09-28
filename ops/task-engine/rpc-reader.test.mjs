// SPDX-License-Identifier: BUSL-1.1
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectorOf, encodeCall, decodeWords, wordToAddress, jsonRpc, rpcChainReader } from "./rpc-reader.mjs";

// Selectors were cross-checked against `cast sig` on a live host; these lock the values in so a
// change to the signature parser cannot silently start calling a different function.
test("selectorOf ignores the return-type group", () => {
  assert.equal(selectorOf("balanceOf(address)(uint256)"), "0x70a08231");
  assert.equal(selectorOf("decimals()(uint8)"), "0x313ce567");
  assert.equal(selectorOf("totalSupply()(uint256)"), "0x18160ddd");
  assert.equal(selectorOf("adapterAt(uint256)(address)"), "0xd9903c08");
  // Nested parens in the RETURN group must not confuse the input-group scan.
  assert.equal(selectorOf("unbondState()((uint256,uint64,uint256))"), "0x5b763e47");
});

test("selectorOf rejects malformed signatures", () => {
  assert.throws(() => selectorOf("noParens"), /malformed/);
  assert.throws(() => selectorOf("f(uint256"), /unbalanced/);
});

test("encodeCall pads address and uint args to words", () => {
  assert.equal(
    encodeCall("balanceOf(address)(uint256)", ["0x00000000000000000000000000000000000000ff"]),
    "0x70a08231" + "ff".padStart(64, "0"),
  );
  assert.equal(encodeCall("adapterAt(uint256)(address)", [1]), "0xd9903c08" + "1".padStart(64, "0"));
});

test("decodeWords requires word alignment", () => {
  assert.deepEqual(decodeWords("0x"), []);
  assert.deepEqual(decodeWords("0x" + "2a".padStart(64, "0")), [42n]);
  assert.throws(() => decodeWords("0xabc"), /word-aligned/);
});

test("wordToAddress takes the low 20 bytes", () => {
  assert.equal(wordToAddress(0xffn), "0x00000000000000000000000000000000000000ff");
});

test("calls issued in one tick go out as a single batch", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const batch = JSON.parse(init.body);
    bodies.push(batch);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x2a" })) };
  };
  const rpc = jsonRpc("http://x", { fetchImpl });
  const out = await Promise.all([
    rpc.call("0x1", "decimals()(uint8)", [], 5),
    rpc.call("0x2", "decimals()(uint8)", [], 5),
    rpc.call("0x3", "decimals()(uint8)", [], 5),
  ]);
  assert.equal(bodies.length, 1, "three concurrent reads must be one HTTP request");
  assert.equal(bodies[0].length, 3);
  assert.deepEqual(out, ["0x2a", "0x2a", "0x2a"]);
});

test("a per-request rpc error rejects only that call", async () => {
  const fetchImpl = async (_url, init) => {
    const batch = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => batch.map((r, i) => (i === 0
        ? { jsonrpc: "2.0", id: r.id, error: { message: "execution reverted" } }
        : { jsonrpc: "2.0", id: r.id, result: "0x01" })),
    };
  };
  const rpc = jsonRpc("http://x", { fetchImpl });
  const results = await Promise.allSettled([
    rpc.call("0x1", "decimals()(uint8)", [], 5),
    rpc.call("0x2", "decimals()(uint8)", [], 5),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /execution reverted/);
  assert.equal(results[1].status, "fulfilled");
});

test("oversized fan-outs are chunked, not sent as one giant array", async () => {
  const sizes = [];
  const fetchImpl = async (_url, init) => {
    const batch = JSON.parse(init.body);
    sizes.push(batch.length);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x0" })) };
  };
  const rpc = jsonRpc("http://x", { fetchImpl, maxBatch: 4 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => rpc.call("0x" + i, "decimals()(uint8)", [], 1)));
  assert.deepEqual(sizes, [4, 4, 2]);
});

// --- transport retry (2026-08-12) ---------------------------------------------------------------
// The bug these lock down: one dropped connection made a healthy operator DENY a task the rest of
// the quorum signed, because a transport reject and a disagreement about the price were the same
// event upstream. Retries are safe only because every method here is a read.

const noSleep = () => Promise.resolve();

test("batch arity, duplicate IDs, missing results and unknown IDs fail the whole chunk", async () => {
  for (const corrupt of [
    (rows) => [rows[0], rows[0]],
    (rows) => rows.slice(0, 1),
    (rows) => [...rows, { id: 999, result: "0x0" }],
    (rows) => [rows[0], { id: 999, result: "0x0" }],
    (rows) => [rows[0], { id: rows[1].id }],
  ]) {
    const rpc = jsonRpc("http://x", { maxAttempts: 1, fetchImpl: async (_url, init) => {
      const rows = JSON.parse(init.body).map(({ id }) => ({ id, result: "0x0" }));
      return { ok: true, json: async () => corrupt(rows) };
    } });
    const results = await Promise.allSettled([rpc.blockNumber(), rpc.blockNumber()]);
    assert.ok(results.every((r) => r.status === "rejected"));
  }
});

test("RPC limits reject zero/invalid knobs before any I/O", () => {
  for (const key of ["maxAttempts", "maxBatch", "attemptTimeoutMs"]) {
    for (const value of [0, -1, Infinity, NaN, 0.5]) assert.throws(() => jsonRpc("http://x", { [key]: value }));
  }
});

test("pinned calls retain the signed block hash across provider fallback, without a number-only retry", async () => {
  const hash = "0x" + "ab".repeat(32), refs = [];
  const reader = rpcChainReader("http://primary", { rpcFallbacks: ["http://backup"] }, {
    retryDelayMs: 0, fetchImpl: async (url, init) => {
      const batch = JSON.parse(init.body);
      refs.push(batch[0].params[1]);
      if (url.endsWith("primary")) throw new Error("offline");
      return { ok: true, json: async () => batch.map(({ id }) => ({ id, result: "0x" + "1".padStart(64, "0") })) };
    },
  });
  assert.equal(await reader.pinnedUintCall("0x1", "totalSupply()(uint256)", [], reader.pinnedBlockRef({ hash })), 1n);
  assert.deepEqual(refs, Array(2).fill({ blockHash: hash, requireCanonical: true }));
});

test("a transient transport failure is retried, not surfaced as a refusal", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) throw new Error("terminated"); // exactly what undici throws on a dropped socket
    const batch = JSON.parse(init.body);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x2a" })) };
  };
  const rpc = jsonRpc("http://x", { fetchImpl, sleepImpl: noSleep });
  assert.equal(await rpc.call("0x1", "decimals()(uint8)", [], 5), "0x2a");
  assert.equal(calls, 2);
});

test("a non-ok status is retried too", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, json: async () => ({}) };
    const batch = JSON.parse(init.body);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x1" })) };
  };
  const rpc = jsonRpc("http://x", { fetchImpl, sleepImpl: noSleep });
  assert.equal(await rpc.call("0x1", "decimals()(uint8)", [], 5), "0x1");
  assert.equal(calls, 3);
});

test("a truncated body counts as transport, not as an answer", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => { throw new Error("Unexpected end of JSON input"); } };
    const batch = JSON.parse(init.body);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x7" })) };
  };
  const rpc = jsonRpc("http://x", { fetchImpl, sleepImpl: noSleep });
  assert.equal(await rpc.call("0x1", "decimals()(uint8)", [], 5), "0x7");
  assert.equal(calls, 2);
});

test("attempts rotate across rpcFallbacks", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (seen.length < 3) throw new Error("terminated");
    const batch = JSON.parse(init.body);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x1" })) };
  };
  const rpc = jsonRpc("http://primary", {
    fetchImpl, sleepImpl: noSleep, rpcFallbacks: ["http://backup"],
  });
  await rpc.call("0x1", "decimals()(uint8)", [], 5);
  assert.deepEqual(seen, ["http://primary", "http://backup", "http://primary"]);
});

test("a hung primary times out so the fallback can answer", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url === "http://primary") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const batch = JSON.parse(init.body);
    return { ok: true, json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x2a" })) };
  };
  const rpc = jsonRpc("http://primary", {
    fetchImpl,
    sleepImpl: noSleep,
    rpcFallbacks: ["http://backup"],
    maxAttempts: 2,
    attemptTimeoutMs: 20,
  });
  assert.equal(await rpc.call("0x1", "decimals()(uint8)", [], 5), "0x2a");
  assert.deepEqual(seen, ["http://primary", "http://backup"]);
});

test("an execution revert is NOT retried — re-asking cannot change the answer", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const batch = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { message: "execution reverted" } })),
    };
  };
  const rpc = jsonRpc("http://x", { fetchImpl, sleepImpl: noSleep });
  await assert.rejects(rpc.call("0x1", "decimals()(uint8)", [], 5), /execution reverted/);
  assert.equal(calls, 1);
});

test("the last transport error survives when every attempt fails", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("terminated"); };
  const rpc = jsonRpc("http://x", { fetchImpl, sleepImpl: noSleep, maxAttempts: 2 });
  await assert.rejects(rpc.call("0x1", "decimals()(uint8)", [], 5), /terminated/);
  assert.equal(calls, 2);
});

test("transport errors never expose RPC credentials, paths or query tokens", async () => {
  const rpcUrl = "http://rpc-user:rpc-password@127.0.0.1:1/private/path?apiKey=secret-value";
  const fetchImpl = async (url) => {
    throw new Error(`Request cannot be constructed from a URL that includes credentials: ${url}`);
  };
  const rpc = jsonRpc(rpcUrl, { fetchImpl, maxAttempts: 1 });
  await assert.rejects(
    rpc.call("0x1", "decimals()(uint8)", [], 5),
    (error) => {
      assert.match(error.message, /http:\/\/127\.0\.0\.1:1/);
      assert.doesNotMatch(error.message, /rpc-user|rpc-password|private\/path|secret-value/);
      return true;
    },
  );
});

test("a leg's rpcFallbacks reach the transport without call-site threading", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (seen.length === 1) throw new Error("terminated");
    const batch = JSON.parse(init.body);
    // A real eth_call returns whole 32-byte words; `placeableSurplus()` decodes one.
    return {
      ok: true,
      json: async () => batch.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x" + (42n).toString(16).padStart(64, "0") })),
    };
  };
  const reader = rpcChainReader("http://primary", { rpcFallbacks: ["http://backup"], vault: "0xv" },
    { fetchImpl, sleepImpl: noSleep });
  assert.equal(await reader.placeableSurplus(), 42n);
  assert.deepEqual(seen, ["http://primary", "http://backup"]);
});
