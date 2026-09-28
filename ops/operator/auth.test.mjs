// SPDX-License-Identifier: BUSL-1.1
// Run: node --test ops/operator/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecret, sign, verify, verifyRequest, DEFAULT_CLOCK_SKEW_SECS } from "./auth.mjs";

test("generateSecret produces 64-char hex", () => {
  const s = generateSecret();
  assert.equal(s.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(s));
});

test("sign + verify round-trip succeeds", () => {
  const secret = generateSecret();
  const body = JSON.stringify({ taskKey: "PLACEMENT:cycle-1", nonce: "0xabc" });
  const { signature, timestamp } = sign(body, secret);
  const result = verify(body, secret, signature, timestamp);
  assert.equal(result.ok, true);
});

test("verification fails with wrong secret", () => {
  const goodSecret = generateSecret();
  const badSecret = generateSecret();
  const body = "test";
  const { signature, timestamp } = sign(body, goodSecret);
  const result = verify(body, badSecret, signature, timestamp);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verification fails with tampered body", () => {
  const secret = generateSecret();
  const { signature, timestamp } = sign("original body", secret);
  const result = verify("tampered body", secret, signature, timestamp);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verification fails with expired timestamp", () => {
  const secret = generateSecret();
  const body = "test";
  const past = Math.floor(Date.now() / 1000) - DEFAULT_CLOCK_SKEW_SECS - 10;
  const { signature } = sign(body, secret, past);
  const result = verify(body, secret, signature, past, DEFAULT_CLOCK_SKEW_SECS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timestamp_too_old");
});

test("verification fails with missing headers", () => {
  const secret = generateSecret();
  const req = { headers: {} };
  const result = verifyRequest(req, "body", secret);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_headers");
});

test("verifyRequest succeeds with valid headers", () => {
  const secret = generateSecret();
  const body = JSON.stringify({ taskKey: "ABC" });
  const { signature, timestamp } = sign(body, secret);
  const req = {
    method: "POST", url: "/sign",
    headers: {
      "x-mezo-signature": signature,
      "x-mezo-timestamp": String(timestamp),
    },
  };
  const result = verifyRequest(req, body, secret);
  assert.equal(result.ok, true);
});

test("verifyRequest handles lowercase headers", () => {
  const secret = generateSecret();
  const body = "data";
  const { signature, timestamp } = sign(body, secret);
  const req = {
    method: "POST", url: "/sign",
    headers: {
      "x-mezo-signature": signature,
      "x-mezo-timestamp": String(timestamp),
    },
  };
  const result = verifyRequest(req, body, secret);
  assert.equal(result.ok, true);
});

test("HMAC binds method, path, query and the sig-log key", () => {
  const secret = generateSecret(), body = "";
  const ctx = { method: "GET", path: "/sig-log/task%3A1" };
  const { signature, timestamp } = sign(body, secret, undefined, ctx);
  assert.equal(verify(body, secret, signature, timestamp, undefined, ctx).ok, true);
  for (const request of [{ method: "POST", path: ctx.path }, { ...ctx, path: "/report" },
    { ...ctx, path: "/sig-log/task%3A2" }, { ...ctx, path: ctx.path + "?other=1" }]) {
    assert.equal(verify(body, secret, signature, timestamp, undefined, request).ok, false);
  }
});

test("legacy body-only MACs and malformed timestamps are not accepted", async () => {
  const { createHmac } = await import("node:crypto");
  const secret = generateSecret(), timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}:body`).digest("hex");
  assert.equal(verify("body", secret, signature, timestamp).ok, false);
  for (const bad of [NaN, Infinity, timestamp + 0.5]) {
    assert.equal(verify("body", secret, signature, bad).ok, false);
  }
});
