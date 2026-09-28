// SPDX-License-Identifier: BUSL-1.1
// Operator ↔ Aggregator authentication — shared-secret HMAC-SHA256.
// Both the operator pull-sign server and the aggregator client use the same
// secret to sign and verify requests. Replay protection is enforced via a
// timestamp window (±30s default); clock skew tolerance is configurable.
//
// The auth model is symmetric (pre-shared secret), not PKI — operators are a
// small, known set and the aggregator is exactly one.
//
// PER-OPERATOR secrets, not one shared across the set (external review, 2026-07-15): the
// aggregator holds a distinct secret for each operator, and each operator holds only its
// own. With a single set-wide secret, compromising ANY one operator host yields the key to
// impersonate the aggregator to the other four — collecting a real quorum from honest
// operators. Per-operator secrets contain that blast radius to the host that fell.
//
// It still authenticates only the CHANNEL, never the content: an authenticated proposal is
// not a trusted one, which is why ops/operator/verify.mjs re-derives independently.
//
// P2 upgrade path: mTLS, or signing requests with the aggregator's own key so operators
// verify a signature rather than a symmetric secret.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SIG_HEADER = "x-mezo-signature";
const TS_HEADER = "x-mezo-timestamp";
const ALGO = "sha256";

export const DEFAULT_CLOCK_SKEW_SECS = 30;

export function generateSecret() {
  return randomBytes(32).toString("hex");
}

/**
 * Sign HMAC(sha256, secret, JSON.stringify([2, method, path, timestamp, body])).
 * Returns { signature, timestamp } for headers.
 * @param {string} body
 * @param {string} secret
 * @param {number} [timestamp]
 */
const SIGN_REQUEST = { method: "POST", path: "/sign" };
function authPayload(body, timestamp, request) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("invalid timestamp");
  if (!request || !/^[A-Z]+$/.test(request.method ?? "")
      || typeof request.path !== "string" || !request.path.startsWith("/") || /[\r\n]/.test(request.path)) {
    throw new Error("missing or invalid request method/path");
  }
  // Versioned, unambiguous framing; no legacy body-only verification fallback.
  return JSON.stringify([2, request.method, request.path, timestamp, body]);
}

export function sign(body, secret, timestamp, request = SIGN_REQUEST) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const payload = authPayload(body, ts, request);
  const sig = createHmac(ALGO, secret).update(payload).digest("hex");
  return { signature: sig, timestamp: ts };
}

/**
 * Verify a signed request. Returns { ok, reason }.
 * @param {string} body
 * @param {string} secret
 * @param {string} signature - expected signature
 * @param {number} timestamp - unix seconds
 * @param {number} [maxSkewSecs]
 */
export function verify(body, secret, signature, timestamp, maxSkewSecs, request = SIGN_REQUEST) {
  const skew = maxSkewSecs ?? DEFAULT_CLOCK_SKEW_SECS;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > skew) {
    return { ok: false, reason: "timestamp_too_old", skew: Math.abs(now - timestamp) };
  }
  let payload;
  try { payload = authPayload(body, timestamp, request); }
  catch { return { ok: false, reason: "invalid_request_context" }; }
  if (typeof signature !== "string" || !/^[0-9a-fA-F]{64}$/.test(signature)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const expected = createHmac(ALGO, secret).update(payload).digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const sigBytes = Buffer.from(signature, "hex");
  if (expectedBytes.length !== sigBytes.length) {
    return { ok: false, reason: "signature_mismatch" };
  }
  if (!timingSafeEqual(expectedBytes, sigBytes)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

/**
 * Express-style middleware compatible helper: extracts and verifies auth headers
 * from a raw request object. Returns { ok, reason }.
 * @param {{headers: Record<string,string>, method?: string}} req
 * @param {string} body
 * @param {string} secret
 * @param {number} [maxSkewSecs]
 */
export function verifyRequest(req, body, secret, maxSkewSecs) {
  const sig = req.headers[SIG_HEADER] ?? req.headers[SIG_HEADER.toLowerCase()] ?? "";
  const rawTs = req.headers[TS_HEADER] ?? req.headers[TS_HEADER.toLowerCase()] ?? "";
  const ts = typeof rawTs === "string" && /^[0-9]+$/.test(rawTs) ? Number(rawTs) : 0;
  if (!sig || !ts) {
    return { ok: false, reason: "missing_headers" };
  }
  return verify(body, secret, sig, ts, maxSkewSecs, { method: req.method, path: req.url });
}
