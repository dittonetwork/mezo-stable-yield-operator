// SPDX-License-Identifier: BUSL-1.1
// Operator pull-sign service — the operator's entire runtime loop.
//
// Architecture: operators are PASSIVE. They do NOT watch the chain for triggers
// or race to propose. They wait for the single aggregator to push a proposed
// `(taskKey, task, nonce)`, re-derive the task locally to check the conditions,
// sign if it matches, and send the partial BLS signature back. No leader election,
// no gossip, no mempool watching.
//
// Endpoints:
//   POST /sign        — HMAC-auth: receive sign request, re-verify task, produce partial sig
//   GET  /sig-log/:key — HMAC-auth: return partial-sig log entry (DB-restore reconciliation)
//   GET  /health       — unauthenticated liveness check (no secrets exposed)
//
// Usage:
//   OPERATOR_SECRET=<hex> BLS_KEY_PATH=<path> PARTIAL_SIG_DB=<path> \
//     OPERATOR_CONFIG=<path with .legs.{mezo,eth}.rpcUrl> PORT=4000 node ops/operator/server.mjs
// Set OPERATOR_SHADOW_ONLY=1 during commissioning to run every independent verification and
// report the verdict without ever loading the BLS key or returning a partial signature.
//
// Multichain (2026-07-15): this ONE process verifies/signs against every leg in
// OPERATOR_CONFIG.legs — each leg carries its own rpcUrl, so a single operator handles both
// the Mezo executor and the Ethereum receiver without a second process or a second key.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRequest, sign as signHmac } from "./auth.mjs";
import { SQLiteWALStore } from "../aggregator/db.mjs";
import { verifyProposal, multiChainReader } from "./verify.mjs";
import { encodeTask, taskHash } from "../task-engine/engine.mjs";
import { resolveTrackedThresholds } from "../task-engine/threshold-config.mjs";
import { partialSigConflict } from "../aggregator/db.mjs";
import { inventoryPathFor } from "./inventory-path.mjs";
import { pinPolicy } from "../task-engine/nav-snapshot.mjs";
import { BoundedWork, WorkLimitExceeded } from "./bounded-work.mjs";

const signingWork = new BoundedWork();

const PORT = parseInt(process.env.PORT || "4000", 10);
const LISTEN_HOST = process.env.OPERATOR_LISTEN_HOST || "127.0.0.1";
// This operator's OWN secret — the set does not share one, so a host that falls does not
// hand the attacker the keys to the other four (see auth.mjs).
const OPERATOR_SECRET = process.env.OPERATOR_SECRET || "";
const HERE = dirname(fileURLToPath(import.meta.url));
const PARTIAL_SIG_DB_PATH = process.env.PARTIAL_SIG_DB || join(HERE, "partial-sigs.db");
const BLS_KEY_PATH = process.env.BLS_KEY_PATH || "";
const SHADOW_ONLY = /^(1|true)$/i.test(process.env.OPERATOR_SHADOW_ONLY || "");

if (!OPERATOR_SECRET) {
  console.error("FATAL: OPERATOR_SECRET env var is required");
  process.exit(1);
}

const sigStore = new SQLiteWALStore(PARTIAL_SIG_DB_PATH);

// The operator's OWN view of the deployment — pinned at setup, never taken from a request.
// Without it there is nothing to re-derive against, so refuse to start rather than run as
// a rubber stamp. Multichain (2026-07-15): OPERATOR_CONFIG.legs carries one entry per chain
// this operator verifies/signs against (Mezo + Ethereum) — a single process, multi-RPC.
const operatorConfigPath = process.env.OPERATOR_CONFIG || join(HERE, "..", "operator-config.json");
const OP_CFG = JSON.parse(readFileSync(operatorConfigPath, "utf8"));
if (OP_CFG.navAccounting?.policy) pinPolicy(OP_CFG.navAccounting.policy);
// Re-read on every use rather than cached at boot — same reason as the aggregator: the snapshot
// builder rejects a NAV pinned past `bridge.reconciledThrough`, so a boot-time copy goes stale as
// blocks advance and this seat would refuse every NAV for the rest of its uptime. This is THIS
// seat's own independently managed file; re-reading keeps that independence intact.
const inventoryPath = inventoryPathFor(operatorConfigPath, OP_CFG.navAccounting?.inventoryFile);
if (inventoryPath) {
  Object.defineProperty(OP_CFG.navAccounting, "inventory", {
    get: () => JSON.parse(readFileSync(inventoryPath, "utf8")),
    enumerable: true,
    configurable: true,
  });
}
if (!OP_CFG.legs || typeof OP_CFG.legs !== "object" || Object.keys(OP_CFG.legs).length === 0) {
  console.error("FATAL: OPERATOR_CONFIG.legs is missing or empty — nothing to verify proposals against");
  process.exit(1);
}
for (const [name, leg] of Object.entries(OP_CFG.legs)) {
  for (const k of ["chainId", "rpcUrl"]) {
    if (!leg[k]) {
      console.error(`FATAL: OPERATOR_CONFIG.legs.${name} is missing '${k}'`);
      process.exit(1);
    }
  }
}
// Ефим ratified 2026-07-28: clearing thresholds must live IN GIT, not OPERATOR_CONFIG (see
// threshold-config.mjs for the full rationale). Overlays the git-tracked example.json onto
// OP_CFG for JUST these two keys; every other OPERATOR_CONFIG key stays as before.
Object.assign(OP_CFG, resolveTrackedThresholds(readFileSync, join(HERE, "..", "operator-config.example.json")));

// Where to POST this seat's verdict. Set => ASYNCHRONOUS mode: /sign acknowledges receipt at
// once and the verdict is pushed back when it is ready. Unset => the original synchronous
// reply, kept so an existing deployment is unaffected until it is configured.
//
// Verification is not fast and must not be: this seat runs its OWN canonical NAV recompute
// before signing a price-setting task, which is the entire point of a 4-of-5 threshold. Holding
// the aggregator's request open for that made a round's latency the SLOWEST seat's latency, and
// a timeout killed the round instead of costing one seat.
const REPORT_URL = process.env.REPORT_URL || OP_CFG.reportUrl || "";
if (REPORT_URL) {
  const target = new URL(REPORT_URL);
  if (!["http:", "https:"].includes(target.protocol) || target.pathname !== "/report"
      || target.search || target.hash || target.username || target.password) {
    throw new Error("REPORT_URL must be an HTTP(S) /report endpoint without credentials, query or fragment");
  }
}
const reportRequest = REPORT_URL ? { method: "POST", path: new URL(REPORT_URL).pathname + new URL(REPORT_URL).search } : null;
if (SHADOW_ONLY && !REPORT_URL) {
  console.error("FATAL: OPERATOR_SHADOW_ONLY requires REPORT_URL so the verified verdict is observable");
  process.exit(1);
}

/**
 * Per-leg circuit breaker: after `failThreshold` consecutive RPC failures on ONE leg's URL,
 * fail fast (no exec, no 30s timeout wait) for `cooldownMs` instead of retrying it on every
 * request. `fn` is async (see castFactory below) — wrapping it here just means the returned
 * function is also async; the breaker awaits it and only trips on a rejection.
 */
function withCircuitBreaker(fn, legLabel, { failThreshold = 5, cooldownMs = 30_000 } = {}) {
  let consecutiveFailures = 0;
  let openUntil = 0;
  return async (...args) => {
    const now = Date.now();
    if (openUntil && now < openUntil) {
      throw new Error(`circuit_open:${legLabel} (${consecutiveFailures} consecutive failures, retry after ${new Date(openUntil).toISOString()})`);
    }
    try {
      const out = await fn(...args);
      consecutiveFailures = 0;
      openUntil = 0;
      return out;
    } catch (e) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failThreshold) openUntil = Date.now() + cooldownMs;
      throw e;
    }
  };
}

const execFileAsync = promisify(execFile);

function rpcLabel(rpcUrl) {
  try {
    const url = new URL(rpcUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid-rpc-url>";
  }
}

// ASYNC on purpose (external-review follow-up, 2026-07-16): the D-fix stopped a broken leg
// from crashing the process, but execFileSync still blocked Node's single event loop for the
// full RPC round-trip (up to the 30s timeout) on every chain read — a merely-SLOW (not dead)
// leg could still head-of-line-block a concurrent request for the OTHER, healthy leg, since
// both are served by one process (variant A). Swapping to non-blocking execFile lets the two
// legs' reads interleave on the event loop instead of queuing behind each other. Every
// castChainReader call site in verify.mjs already `await`s its `cast(...)` call, so this is a
// drop-in swap at the one place `cast` is actually constructed.
// Fallbacks cover the CAST path too, not only the batched JSON-RPC one. The addresses file has
// always carried `rpcFallbacks` per leg and the RPC reader used them, but the methods it does not
// implement fall through to cast — and those were single-endpoint. A throttled or dead primary
// therefore failed exactly the reads that are signing-critical while the seat looked otherwise
// healthy, which reads as a flaky operator rather than as one provider having a bad afternoon.
//
// Timeout per endpoint rather than in total: 30s against three endpoints is 90s of wall clock for
// a task whose expiry window is five minutes, so the budget is 15s each.
function castFactory(rpcUrl, rpcFallbacks = []) {
  const urls = [rpcUrl, ...rpcFallbacks].filter(Boolean);
  const label = urls.map(rpcLabel).join(" -> ");
  return withCircuitBreaker(
    async (...args) => {
      let lastCode = "";
      for (const url of urls) {
        try {
          return (await execFileAsync("cast", [...args, "--rpc-url", url], {
            encoding: "utf8", timeout: 15_000,
          })).stdout.trim();
        } catch (e) {
          // Node's execFile error includes the complete argv, which includes the RPC URL. Never let
          // credentials, provider paths or query tokens escape through /sign, REPORT_URL or logs —
          // and that holds while rotating, where the temptation is to say which endpoint failed.
          lastCode = e?.code ? ` code=${String(e.code).slice(0, 40)}` : "";
        }
      }
      throw new Error(`rpc command failed at ${label}${lastCode}`);
    },
    label
  );
}

const chains = multiChainReader(castFactory, OP_CFG);

async function blsSign(taskEncoded) {
  if (!BLS_KEY_PATH || !existsSync(BLS_KEY_PATH)) {
    throw new Error("BLS_KEY_PATH not set or key file not found (pilot: use signer.py or KMS)");
  }
  // PYTHON lets the host point at the interpreter that actually has py_ecc (e.g. a venv);
  // distros increasingly refuse a system-wide pip install (PEP 668).
  return (await execFileAsync(process.env.PYTHON || "python3", [
    join(HERE, "..", "drills", "signer.py"),
    "sign", taskEncoded, BLS_KEY_PATH,
  ], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, BLS_OPERATOR_VERIFIED: "1" },
  })).stdout.trim();
}

async function handleSign(req, res, body) {
  let reqData;
  try {
    reqData = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const { taskKey, task, nonce, payload } = reqData;
  if (!taskKey || !task || !nonce || !payload) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_fields", required: ["taskKey", "task", "nonce", "payload"] }));
    return;
  }

  // The request carries the nonce TWICE — once as the top-level `nonce` (what the
  // anti-equivocation check below logs and compares) and once embedded in `task.nonce` (what
  // actually gets signed via encodeTask(task)). Without this check they were never compared:
  // an aggregator could hold the outer `nonce` fixed across requests (so the equivocation
  // check always sees the "same" nonce and never 409s) while varying task.nonce, and walk
  // away with signatures over two different nonces for one taskKey (external review,
  // 2026-07-16). One taskKey must mean exactly one nonce, full stop.
  if (String(task.nonce) !== String(nonce)) {
    console.error(JSON.stringify({ event: "nonce-mismatch-refused", taskKey, outerNonce: nonce, taskNonce: task.nonce }));
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "nonce_mismatch", reason: `outer nonce ${nonce} does not match task.nonce ${task.nonce}` }));
    return;
  }

  try { encodeTask(task); } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "malformed_task", reason: error.message }));
    return;
  }

  if (REPORT_URL) {
    let pending;
    try { pending = signingWork.run(body, () => judgeAndReport(taskKey, task, nonce, payload)); }
    catch (error) {
      if (!(error instanceof WorkLimitExceeded)) throw error;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "operator_busy" }));
      return;
    }
    // Acknowledge, then judge. The verdict travels back on its own request.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, accepted: true, taskKey, nonce }));
    pending.catch((e) => {
        console.error(JSON.stringify({ event: "report-failed", taskKey, error: String(e.message).slice(0, 200) }));
    });
    return;
  }

  // Re-derive against MY OWN chain reads and MY OWN pinned config. The aggregator
  // sequences rounds; it does not get to dictate their content. Anything this operator
  // cannot independently justify is refused — that refusal IS the 4-of-5 guarantee.
  const verdict = await verifyProposal({ task, payload, cfg: OP_CFG, chains });
  if (!verdict.ok) {
    console.error(JSON.stringify({ event: "refused", taskKey, reason: verdict.reason }));
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "task_verification_failed", reason: verdict.reason }));
    return;
  }

  if (SHADOW_ONLY) {
    // Commissioning mode is deliberately enforced at the last possible point: the proposal has
    // passed the exact same independent chain/config/NAV checks as a live seat, but no durable
    // anti-equivocation entry and no signature are produced. This lets a new organisation compare
    // real verdicts before its key contributes to consensus.
    console.error(JSON.stringify({ event: "shadow-verified", taskKey, nonce, signed: false }));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, shadow: true, signed: false, taskKey, nonce }));
    return;
  }

  // Anti-equivocation: one trigger -> one exact task, enforced by the OPERATORS and not merely by
  // the aggregator's own WAL discipline. An honest aggregator never asks twice with a
  // different nonce for the same taskKey (persist-before-sign resumes the stored one), so a
  // second nonce means either a compromised aggregator or a restored one that lost its WAL —
  // both cases end in two signed tasks for one trigger if we sign. Refuse and keep the
  // evidence; a legitimate retry re-sends the SAME nonce and is idempotent.
  // RESERVE FIRST, THEN SIGN. The store compares and records without an await between the read
  // and write, so concurrent requests cannot reserve one (taskKey, nonce) for two task hashes.
  // Exact retries are idempotent. Different nonces remain durable evidence and poison the key.
  //
  // Limit worth naming: this binds a taskKey to one nonce. An aggregator that invents a
  // SECOND taskKey for the same trigger is invisible here — an operator cannot know two keys
  // mean one trigger. That is the aggregator's WAL discipline to keep; this only stops the
  // key it was told about from carrying two nonces.
  const payloadHash = taskHash(task);
  await sigStore.logPartialSig(taskKey, nonce, payloadHash, task);
  const seen = await sigStore.getPartialSigs(taskKey);
  // Compare the PAYLOAD as well as the nonce. Binding only the nonce left the documented property
  // ("one trigger -> one task") unmet: a second task under the SAME (taskKey, nonce) passed the
  // check and was signed, and because the row is keyed on (taskKey, nonce) the INSERT OR IGNORE
  // dropped it, so the evidence log recorded one signature where two had been produced.
  // Reproduced against this code, external review 2026-08-23. Write-first ordering is unchanged,
  // so concurrent requests still both observe the landed row and exactly one of them signs.
  const conflict = partialSigConflict(seen, nonce, payloadHash);
  if (conflict) {
    const kind = String(conflict.nonce) !== String(nonce) ? "nonce_conflict" : "content_conflict";
    console.error(JSON.stringify({ event: "equivocation-refused", kind, taskKey, held: conflict.nonce, asked: nonce }));
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: kind, reason: `already hold ${kind === "nonce_conflict" ? `nonce ${conflict.nonce}` : "different task content"} for ${taskKey}` }));
    return;
  }

  // Produce the BLS partial signature over encodeTask(task)
  let partialSig;
  try {
    const encoded = encodeTask(task);
    partialSig = await blsSign(encoded);
  } catch (e) {
    console.error("signing error for", taskKey);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "signing_failed" }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    taskKey,
    nonce,
    partialSig,
    payloadHash,
  }));
}

/**
 * Judge a proposal and PUSH the verdict back to the aggregator.
 *
 * Same checks, same order, same refusals as the synchronous path — only the delivery differs.
 * A refusal is reported too: silence would be indistinguishable from a slow seat, and the
 * aggregator would keep waiting on a decision that has already been made.
 */
async function judgeAndReport(taskKey, task, nonce, payload) {
  let result;
  try {
    const verdict = await verifyProposal({ task, payload, cfg: OP_CFG, chains });
    if (!verdict.ok) {
      console.error(JSON.stringify({ event: "refused", taskKey, reason: verdict.reason }));
      result = { taskKey, nonce, error: verdict.reason };
    } else if (SHADOW_ONLY) {
      console.error(JSON.stringify({ event: "shadow-verified", taskKey, nonce, signed: false }));
      result = {
        taskKey,
        nonce,
        shadow: true,
        error: "shadow_only: proposal verified independently; signing disabled",
      };
    } else {
      // Anti-equivocation stays before signing in asynchronous mode too.
      const payloadHash = taskHash(task);
      await sigStore.logPartialSig(taskKey, nonce, payloadHash, task);
      const held = await sigStore.getPartialSigs(taskKey);
      const clash = partialSigConflict(held, nonce, payloadHash);
      if (clash) {
        const kind = String(clash.nonce) !== String(nonce) ? "nonce_conflict" : "content_conflict";
        console.error(JSON.stringify({ event: "equivocation-refused", kind, taskKey, held: clash.nonce, asked: nonce }));
        result = { taskKey, nonce, error: `refused: ${kind} for ${taskKey}` };
      } else {
        result = { taskKey, nonce, partialSig: await blsSign(encodeTask(task)), payloadHash };
      }
    }
  } catch (e) {
    result = { taskKey, nonce, error: `operator error: ${String(e.message).slice(0, 160)}` };
  }

  const body = JSON.stringify(result);
  const { signature, timestamp } = signHmac(body, OPERATOR_SECRET, undefined, reportRequest);
  const res = await fetch(REPORT_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-mezo-signature": signature,
      "x-mezo-timestamp": String(timestamp),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`report rejected with ${res.status}`);
  // The outcome is in the log line, not only in the report: a shadow seat's operator reads THIS
  // to compare verdicts with the fleet (ONBOARD step 8), and "signed:false" alone reads the same
  // for a verified shadow verdict, a refusal and an exception — which hid an ENOENT on 2026-09-04.
  const outcome = result.partialSig ? "signed" : result.shadow ? "shadow-verified" : String(result.error).startsWith("operator error") ? "error" : "refused";
  console.error(JSON.stringify({ event: "reported", taskKey, signed: !!result.partialSig, outcome }));
}

async function handleSigLog(req, res, key) {
  const entry = await sigStore.getPartialSig(key);
  if (!entry) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", taskKey: key }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(entry));
}

function handleHealth(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", role: "operator", mode: SHADOW_ONLY ? "shadow" : "signing" }));
}

function parseURL(url) {
  const i = url.indexOf("?");
  const path = i >= 0 ? url.slice(0, i) : url;
  return path.split("/").filter(Boolean);
}

const MAX_BODY = 1_048_576; // 1 MiB

/**
 * Read the request body into a Promise instead of registering the rest of the handler as an
 * `req.on("end", async () => ...)` listener. That pattern is the crash-isolation defect
 * (external review, 2026-07-16, variant-A isolation claim): an EventEmitter does not await its
 * async listeners, so an exception thrown inside one — e.g. verifyProposal's RPC read for the
 * OTHER leg throwing because that chain's RPC is down — becomes an unhandled promise
 * rejection that never reaches handleRequest's own `.catch()` below. By default Node
 * terminates the process on an unhandled rejection, which would take down BOTH legs (this is
 * one process, legs={mezo,eth}) over one leg's RPC being unreachable. Returning a Promise here
 * means every downstream `await` — including the ones inside verifyProposal/handleSign — stays
 * inside the promise chain that IS awaited, and any rejection is caught, not orphaned.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (c) => {
      len += c.length;
      if (len > MAX_BODY) { req.destroy(); reject(new Error("body_too_large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  const parts = parseURL(req.url || "/");
  const method = req.method.toUpperCase();

  if (method === "GET" && parts.length === 1 && parts[0] === "health") {
    return handleHealth(res);
  }

  if (method === "GET" && parts.length >= 2 && parts[0] === "sig-log") {
    const body = await readBody(req);
    const authResult = verifyRequest(req, body, OPERATOR_SECRET);
    if (!authResult.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", reason: authResult.reason }));
      return;
    }
    return handleSigLog(req, res, decodeURIComponent(parts.slice(1).join("/")));
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "sign") {
    const body = await readBody(req);
    const authResult = verifyRequest(req, body, OPERATOR_SECRET);
    if (!authResult.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", reason: authResult.reason }));
      return;
    }
    if (REPORT_URL) return handleSign(req, res, body);
    try {
      const response = await signingWork.run(body, async () => {
        const value = {};
        const capture = {
          writeHead(status, headers) { Object.assign(value, { status, headers }); },
          end(text) { value.body = text; },
        };
        await handleSign(req, capture, body);
        return value;
      });
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      if (!(error instanceof WorkLimitExceeded)) throw error;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "operator_busy" }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    // Guaranteed 503, never a silent crash: anything that reaches here is an infrastructure
    // failure (RPC down on some leg, a body-read error), not a verdict on the task — a real
    // refusal is handleSign's own 422/409 path above, which never throws.
    console.error("request error:", e.message);
    if (!res.headersSent) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "leg_unavailable", reason: e.message }));
    }
  });
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`operator server ready http://${LISTEN_HOST}:${PORT}`);
  console.error(`mode: ${SHADOW_ONLY ? "SHADOW — verifies but never signs" : "SIGNING"}`);
  for (const [name, leg] of Object.entries(OP_CFG.legs)) {
    console.error(`leg ${name}: chainId=${leg.chainId} rpc=${rpcLabel(leg.rpcUrl)}`);
  }
  console.error(`sig-log db: ${PARTIAL_SIG_DB_PATH}`);
});
