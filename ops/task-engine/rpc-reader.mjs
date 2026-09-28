// SPDX-License-Identifier: BUSL-1.1
// Direct JSON-RPC reads, batched — the chain-read path for the canonical NAV snapshot.
//
// Every read used to be a `cast` subprocess: a process spawn plus a fresh TLS handshake per
// value. One canonical snapshot makes ~30 of them, so a NAV recompute took minutes against a
// public RPC and the aggregator's 60s poll could not keep up — rounds expired before their
// operators had even answered. None of those reads need a subprocess: they are all `eth_call`
// at a pinned block, plus `eth_getBlockByNumber`.
//
// Calls issued in the same tick are coalesced into ONE JSON-RPC array request, so the
// Promise.all fan-outs the snapshot already does collapse to a single round trip.
import { keccak256 } from "./keccak.mjs";

const HEX = "0123456789abcdef";

function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** 4-byte selector of a cast-style signature: `name(inputs)(outputs)` — outputs are not part
 * of the selector, so everything from the second '(' onward is dropped. */
export function selectorOf(sig) {
  const open = sig.indexOf("(");
  if (open < 0) throw new Error(`malformed signature: ${sig}`);
  let depth = 0;
  let end = -1;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced signature: ${sig}`);
  const canonical = sig.slice(0, end + 1).replace(/\s+/g, "");
  return "0x" + toHex(keccak256(new TextEncoder().encode(canonical))).slice(0, 8);
}

/** Static 32-byte word encoding — the only argument types these reads use are address/uint. */
function encodeWord(arg) {
  let v;
  if (typeof arg === "string" && arg.startsWith("0x")) v = BigInt(arg);
  else v = BigInt(arg);
  if (v < 0n || v >= 1n << 256n) throw new Error("argument outside uint256");
  return v.toString(16).padStart(64, "0");
}

export function encodeCall(sig, args = []) {
  return selectorOf(sig) + args.map(encodeWord).join("");
}

/** Split return data into 32-byte words as BigInts. */
export function decodeWords(data) {
  const hex = String(data ?? "0x").replace(/^0x/, "");
  if (hex.length === 0) return [];
  if (hex.length % 64 !== 0) throw new Error(`return data is not word-aligned: ${hex.length} nibbles`);
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push(BigInt("0x" + hex.slice(i, i + 64)));
  return out;
}

export const wordToAddress = (word) => "0x" + word.toString(16).padStart(64, "0").slice(24);

function rpcEndpointLabel(rpcUrl) {
  try {
    const url = new URL(rpcUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid-rpc-url>";
  }
}

/**
 * Scrub any URL-shaped substring down to scheme://host.
 *
 * Split out from sanitizedTransportError because the JSON-RPC error BODY needed it too and did not
 * have it: `row.error.message` is text the provider wrote, and providers do echo request URLs and
 * key-bearing paths in error strings ("invalid key for https://.../v1/<key>"). Sanitising only the
 * transport path left that one open — external review, 2026-08-23.
 */
function scrubUrls(text, rpcUrl) {
  const label = rpcEndpointLabel(rpcUrl);
  return String(text)
    .split(String(rpcUrl)).join(label)
    .replace(/https?:\/\/[^\s]+/gi, (value) => rpcEndpointLabel(value));
}

function sanitizedTransportError(error, rpcUrl) {
  const label = rpcEndpointLabel(rpcUrl);
  let message = String(error?.message ?? "transport failure");
  // Fetch/undici validation errors can echo the complete URL, including userinfo, provider path
  // and query tokens. Replace the exact configured value first, then scrub any other URL-shaped
  // substring before the error reaches /sign, REPORT_URL or logs.
  message = message.split(String(rpcUrl)).join(label);
  message = message.replace(/https?:\/\/[^\s]+/gi, (value) => rpcEndpointLabel(value));
  return new Error(`rpc transport failed at ${label}: ${message.slice(0, 160)}`);
}

/**
 * @param {string} rpcUrl
 * @param {{fetchImpl?: Function, maxBatch?: number, rpcFallbacks?: string[], maxAttempts?: number,
 *          retryDelayMs?: number, attemptTimeoutMs?: number, sleepImpl?: Function}} [opts]
 */
export function jsonRpc(rpcUrl, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  // A public endpoint will reject an unbounded array; chunk rather than discover the limit in
  // production. 50 keeps a whole snapshot inside one or two round trips.
  const maxBatch = opts.maxBatch ?? 50;
  // TRANSPORT retry, added 2026-08-12. Every read here is idempotent — eth_call, eth_blockNumber,
  // eth_getBlockByNumber and nothing else — so re-sending a chunk cannot have a side effect.
  //
  // Why it is load-bearing rather than a nicety: one dropped connection used to deny a whole task.
  // A single `fetch` reject ("terminated") rejects the entire chunk, which propagates out of
  // computePinnedCanonicalNav, and verify.mjs turns any throw there into
  // `deny("canonical NAV unreadable: …")`. So a transient blip is indistinguishable from a seat
  // that disagrees with the price. Seat 1 did exactly that on the first real mainnet round
  // (2026-08-12): it refused a fix-batch every other seat signed, purely because its connection
  // dropped mid-read. Quorum absorbed it at 4-of-5, which is the only reason it cost nothing.
  //
  // Endpoints rotate across attempts when fallbacks are configured. That is safe HERE specifically
  // because a canonical price is pinned by block NUMBER AND HASH and verified by exact match: an
  // endpoint on a different history fails the hash check and the operator denies, rather than
  // signing a number derived from the wrong chain.
  const urls = [rpcUrl, ...(opts.rpcFallbacks ?? [])].filter(Boolean);
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 150;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 15_000;
  const sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (const [name, value, min] of [
    ["maxBatch", maxBatch, 1], ["maxAttempts", maxAttempts, 1],
    ["attemptTimeoutMs", attemptTimeoutMs, 1], ["retryDelayMs", retryDelayMs, 0],
  ]) {
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`invalid RPC ${name}`);
  }
  if (!urls.length) throw new Error("RPC endpoint required");
  let queue = [];
  let scheduled = false;
  let nextId = 1;

  /**
   * POST one chunk, retrying only TRANSPORT failures. A per-call `row.error` is NOT retried: an
   * execution revert is a real answer, and re-asking cannot change it.
   */
  async function post(chunk) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const url = urls[attempt % urls.length];
      const controller = new AbortController();
      // AbortSignal.timeout() uses an unref'ed timer in Node. That is fine for native fetch, but a
      // custom transport can otherwise leave only a pending Promise and let the process exit before
      // the timeout fires. Keep this attempt alive explicitly, then always release the timer.
      const timeout = setTimeout(
        () => controller.abort(new Error(`rpc attempt timed out after ${attemptTimeoutMs}ms`)),
        attemptTimeoutMs,
      );
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk.map((c) => c.payload)),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`rpc ${res.status}`);
        // Inside the try on purpose: a truncated body throws here, and that is transport, not answer.
        const body = await res.json();
        const rows = Array.isArray(body) ? body : [body];
        const ids = new Set(chunk.map((c) => c.payload.id));
        const seen = new Set();
        if (rows.length !== chunk.length) throw new Error("RPC batch response arity mismatch");
        for (const row of rows) {
          if (!row || !ids.has(row.id) || seen.has(row.id)
              || (Object.hasOwn(row, "result") === Object.hasOwn(row, "error"))) {
            throw new Error("RPC batch response has duplicate/unknown id or invalid result");
          }
          seen.add(row.id);
        }
        return rows;
      } catch (e) {
        lastError = sanitizedTransportError(e, url);
        if (attempt < maxAttempts - 1 && retryDelayMs > 0) await sleep(retryDelayMs * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async function flush() {
    const batch = queue;
    queue = [];
    scheduled = false;
    for (let i = 0; i < batch.length; i += maxBatch) {
      const chunk = batch.slice(i, i + maxBatch);
      try {
        const body = await post(chunk);
        const rows = Array.isArray(body) ? body : [body];
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const c of chunk) {
          const row = byId.get(c.payload.id);
          if (!row) c.reject(new Error(`no response for ${c.payload.method}`));
          // Scrubbed: this is the PROVIDER'S text, and it can carry the request URL.
          else if (row.error) {
            c.reject(new Error(`${c.payload.method}: ${scrubUrls(row.error.message ?? "rpc error", rpcUrl).slice(0, 160)}`));
          }
          else c.resolve(row.result);
        }
      } catch (e) {
        for (const c of chunk) c.reject(e);
      }
    }
  }

  function send(method, params) {
    return new Promise((resolve, reject) => {
      queue.push({ payload: { jsonrpc: "2.0", id: nextId++, method, params }, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        // Coalesce everything enqueued in this tick, then go once.
        setTimeout(flush, 0);
      }
    });
  }

  const blockTag = (block) => {
    if (block && typeof block === "object") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(block.blockHash ?? "") || block.requireCanonical !== true) {
        throw new Error("pinned eth_call requires a canonical blockHash");
      }
      return { blockHash: block.blockHash, requireCanonical: true };
    }
    return block === undefined || block === null || block === "latest"
      ? "latest"
      : "0x" + BigInt(block).toString(16);
  };

  return {
    call: (to, sig, args, block) =>
      send("eth_call", [{ to, data: encodeCall(sig, args) }, blockTag(block)]),
    blockNumber: async () => BigInt(await send("eth_blockNumber", [])),
    getBlock: (block) => send("eth_getBlockByNumber", [blockTag(block), false]),
  };
}

/**
 * Drop-in replacement for castChainReader's read surface, over JSON-RPC instead of subprocesses.
 * Deliberately the same method names and return types so callers cannot tell them apart.
 */
export function rpcChainReader(rpcUrl, legCfg, opts = {}) {
  // A leg's own `rpcFallbacks` reach the transport without every call site having to thread them,
  // so adding redundancy to a deployment is a config edit rather than a code change.
  const rpc = jsonRpc(rpcUrl, { rpcFallbacks: legCfg?.rpcFallbacks, ...opts });
  const u = async (to, sig, args = [], block) => {
    const words = decodeWords(await rpc.call(to, sig, args, block));
    if (words.length === 0) throw new Error(`empty return from ${to} ${sig}`);
    return words[0];
  };

  return {
    pinnedBlockRef: (pin) => ({ blockHash: pin.hash, requireCanonical: true }),
    now: async () => BigInt((await rpc.getBlock("latest")).timestamp),
    blockNumber: () => rpc.blockNumber(),
    snapshotPin: async (number) => {
      const [block, head] = await Promise.all([rpc.getBlock(number), rpc.getBlock("latest")]);
      if (!block) throw new Error(`block ${number} not found`);
      return {
        number: BigInt(number),
        hash: block.hash,
        // Read once: a second identical read in the same batch proves nothing about a reorg, and
        // confirmSnapshotPin below is the check that actually re-reads later.
        confirmedHash: block.hash,
        timestamp: BigInt(block.timestamp),
        headNumber: BigInt(head.number),
        headTimestamp: BigInt(head.timestamp),
      };
    },
    confirmSnapshotPin: async (pin) => {
      const block = await rpc.getBlock(pin.number);
      if (String(block?.hash).toLowerCase() !== String(pin.hash).toLowerCase()) {
        throw new Error("snapshot block reorged during read");
      }
    },
    pinnedUintCall: (target, sig, args, block) => u(target, sig, args, block),
    pinnedAddressCall: async (target, sig, args, block) =>
      wordToAddress(await u(target, sig, args, block)),
    pinnedTokenDecimals: (token, block) => u(token, "decimals()(uint8)", [], block),
    pinnedTokenBalance: (token, owner, block) =>
      u(token, "balanceOf(address)(uint256)", [owner], block),
    pinnedUnbondState: async (adapter, block) => {
      const w = decodeWords(await rpc.call(adapter, "unbondState()((uint256,uint64,uint256))", [], block));
      if (w.length < 3) throw new Error(`invalid unbondState from ${adapter}`);
      return { requested: w[0], claimableAt: w[1], claimable: w[2] };
    },
    placeableSurplus: () => u(legCfg.vault, "placeableSurplus()(uint256)", [], "latest"),
  };
}
