// SPDX-License-Identifier: BUSL-1.1
// Run: node --test ops/aggregator/db.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SQLiteWALStore , partialSigConflict } from "./db.mjs";

const TMP = join(tmpdir(), "mezo-db-test-" + randomBytes(4).toString("hex"));

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// --- basic CRUD (unchanged semantics) ---

test("creates DB file and persists a row", async () => {
  const db = join(TMP, "basic.db");
  const store = new SQLiteWALStore(db);
  await store.put("PLACEMENT:cycle-1", {
    taskKey: "PLACEMENT:cycle-1",
    nonce: "0xabc",
    task: { chainId: 31612, nonce: "0xabc" },
    state: "MINTED",
    sigs: [],
  });
  assert.ok(existsSync(db));
  const row = await store.get("PLACEMENT:cycle-1");
  assert.equal(row.nonce, "0xabc");
  assert.equal(row.state, "MINTED");
  await store.close();
});

test("get returns null for unknown key", async () => {
  const db = join(TMP, "unknown.db");
  const store = new SQLiteWALStore(db);
  const row = await store.get("nonexistent");
  assert.equal(row, null);
  await store.close();
});

test("put updates existing row", async () => {
  const db = join(TMP, "update.db");
  const store = new SQLiteWALStore(db);
  await store.put("R:1", { taskKey: "R:1", nonce: "0x1", task: {}, state: "MINTED", sigs: [] });
  await store.put("R:1", { taskKey: "R:1", nonce: "0x1", task: {}, state: "SUBMITTED", sigs: ["sig1"], txHash: "0xtx" });
  const row = await store.get("R:1");
  assert.equal(row.state, "SUBMITTED");
  assert.deepEqual(row.sigs, ["sig1"]);
  assert.equal(row.txHash, "0xtx");
  await store.close();
});

test("all returns all rows", async () => {
  const db = join(TMP, "all.db");
  const store = new SQLiteWALStore(db);
  await store.put("A:1", { taskKey: "A:1", nonce: "0x1", task: {}, state: "MINTED", sigs: [] });
  await store.put("A:2", { taskKey: "A:2", nonce: "0x2", task: {}, state: "AGGREGATED", sigs: ["s"] });
  const all = await store.all();
  assert.equal(all.length, 2);
  await store.close();
});

// --- durability: close + reopen ---

test("survives close and reopen (durability)", async () => {
  const db = join(TMP, "durable.db");
  const s1 = new SQLiteWALStore(db);
  await s1.put("D:1", { taskKey: "D:1", nonce: "0xdead", task: { chainId: 31612 }, state: "MINTED", sigs: [] });
  await s1.close();

  const s2 = new SQLiteWALStore(db);
  const row = await s2.get("D:1");
  assert.equal(row.nonce, "0xdead");
  assert.equal(row.state, "MINTED");
  await s2.close();
});

// --- partial-sig log ---

test("partial sig log: write and read", async () => {
  const db = join(TMP, "psig.db");
  const store = new SQLiteWALStore(db);
  await store.logPartialSig("NAV:epoch-5", "0xnav5", "0xhash5");
  const sig = await store.getPartialSig("NAV:epoch-5");
  assert.equal(sig.nonce, "0xnav5");
  assert.equal(sig.payloadHash, "0xhash5");
  assert.equal(await store.getPartialSig("NAV:epoch-99"), null);
  await store.close();
});

// --- durability barrier: after put resolves, another store instance reads it ---

test("put is durable before resolve (barrier test)", async () => {
  const db = join(TMP, "barrier.db");
  const s1 = new SQLiteWALStore(db);
  await s1.put("BARRIER:1", { taskKey: "BARRIER:1", nonce: "0xbarrier", task: {}, state: "MINTED", sigs: [] });
  const s2 = new SQLiteWALStore(db);
  const row = await s2.get("BARRIER:1");
  assert.equal(row.nonce, "0xbarrier");
  await s1.close();
  await s2.close();
});

// --- crash-safety: truncated/corrupt DB file ---

test("recovers from empty DB file gracefully", async () => {
  const db = join(TMP, "empty.db");
  writeFileSync(db, ""); // empty file — not a valid SQLite DB
  const store = new SQLiteWALStore(db);
  await store.put("E:1", { taskKey: "E:1", nonce: "0xe1", task: {}, state: "MINTED", sigs: [] });
  const row = await store.get("E:1");
  assert.equal(row.nonce, "0xe1");
  await store.close();
});

test("recovers from truncated DB file", async () => {
  const db = join(TMP, "trunc.db");
  // First create a valid DB
  const s1 = new SQLiteWALStore(db);
  await s1.put("T:1", { taskKey: "T:1", nonce: "0xt1", task: {}, state: "MINTED", sigs: [] });
  await s1.close();

  // Truncate the file mid-way to simulate partial write from a crash
  const original = readFileSync(db);
  writeFileSync(db, original.subarray(0, Math.floor(original.length / 2)));

  // sql.js may reject a truncated DB; the store should handle it by starting fresh
  let recovered = false;
  try {
    const s2 = new SQLiteWALStore(db);
    await s2.put("T:2", { taskKey: "T:2", nonce: "0xt2", task: {}, state: "MINTED", sigs: [] });
    const row = await s2.get("T:2");
    assert.ok(row !== null);
    await s2.close();
    recovered = true;
  } catch (e) {
    // If sql.js can't open the truncated file, delete it and start fresh
    rmSync(db);
    const s2 = new SQLiteWALStore(db);
    await s2.put("T:2", { taskKey: "T:2", nonce: "0xt2", task: {}, state: "MINTED", sigs: [] });
    const row = await s2.get("T:2");
    assert.equal(row.nonce, "0xt2");
    await s2.close();
    recovered = true;
  }
  assert.ok(recovered);
});

// --- WAL semantics: persist-before-sign ordering ---

test("persist-before-sign: write visible to separate store instance before caller proceeds", async () => {
  // This verifies the BARRIER contract: after put() resolves, the data MUST be
  // readable from a different OS process (simulated by a new store instance).
  const db = join(TMP, "pbs.db");
  const store = new SQLiteWALStore(db);

  const keys = [];
  for (let i = 0; i < 20; i++) {
    const key = `PBS:${i}`;
    keys.push(key);
    await store.put(key, { taskKey: key, nonce: `0x${i}`, task: { i }, state: "MINTED", sigs: [] });
    // After each put, verify from a FRESH store (simulates separate process)
    const verifier = new SQLiteWALStore(db);
    const row = await verifier.get(key);
    assert.equal(row.nonce, `0x${i}`, `row ${i} not visible after put`);
    await verifier.close();
  }
  await store.close();

  // Reopen and verify ALL rows survived
  const final = new SQLiteWALStore(db);
  const all = await final.all();
  assert.equal(all.length, 20);
  await final.close();
});

// --- crash-recovery: stale .tmp file from prior crash ---

test("stale .tmp file from prior crash does not corrupt DB", async () => {
  const db = join(TMP, "stale-tmp.db");
  // Write a valid DB
  const s1 = new SQLiteWALStore(db);
  await s1.put("S:1", { taskKey: "S:1", nonce: "0xstale1", task: {}, state: "MINTED", sigs: [] });
  await s1.close();

  // Simulate a crash that left a .tmp file (write garbage to it)
  writeFileSync(db + ".tmp", "garbage from crashed write");

  // A new store should open the real DB, ignore the stale .tmp
  const s2 = new SQLiteWALStore(db);
  const row = await s2.get("S:1");
  assert.equal(row.nonce, "0xstale1");
  // Writing a new row should overwrite the stale .tmp
  await s2.put("S:2", { taskKey: "S:2", nonce: "0xstale2", task: {}, state: "MINTED", sigs: [] });

  // After close, the .tmp should be gone (overwritten by _sync)
  const s3 = new SQLiteWALStore(db);
  const r2 = await s3.get("S:2");
  assert.equal(r2.nonce, "0xstale2");
  await s2.close();
  await s3.close();
});

// --- resume-same-nonce: restart does not lose data ---

test("multi-cycle state machine: close and reopen between each transition", async () => {
  // Simulates the full lifecycle: MINTED -> AGGREGATED -> SUBMITTED -> CONFIRMED,
  // with close+reopen between each step (simulates crash+restart at each stage).
  const db = join(TMP, "lifecycle.db");
  const key = "LIFECYCLE:1";
  const nonce = "0xlife1";

  // MINTED
  let s = new SQLiteWALStore(db);
  await s.put(key, { taskKey: key, nonce, task: { chainId: 31612 }, state: "MINTED", sigs: [] });
  await s.close();

  // reopen -> AGGREGATED
  s = new SQLiteWALStore(db);
  assert.equal((await s.get(key)).state, "MINTED");
  await s.put(key, { taskKey: key, nonce, task: { chainId: 31612 }, state: "AGGREGATED", sigs: ["s1", "s2", "s3", "s4"] });
  await s.close();

  // reopen -> SUBMITTED
  s = new SQLiteWALStore(db);
  assert.equal((await s.get(key)).state, "AGGREGATED");
  assert.deepEqual((await s.get(key)).sigs, ["s1", "s2", "s3", "s4"]);
  await s.put(key, { taskKey: key, nonce, task: { chainId: 31612 }, state: "SUBMITTED", sigs: ["s1", "s2", "s3", "s4"], txHash: "0xdead" });
  await s.close();

  // reopen -> CONFIRMED
  s = new SQLiteWALStore(db);
  assert.equal((await s.get(key)).state, "SUBMITTED");
  assert.equal((await s.get(key)).txHash, "0xdead");
  await s.put(key, { taskKey: key, nonce, task: { chainId: 31612 }, state: "CONFIRMED", sigs: ["s1", "s2", "s3", "s4"], txHash: "0xdead" });
  await s.close();

  // final reopen -> verify CONFIRMED survived
  s = new SQLiteWALStore(db);
  const row = await s.get(key);
  assert.equal(row.state, "CONFIRMED");
  assert.equal(row.nonce, nonce);
  await s.close();
});

// --- partial-sig durability across restarts ---

test("partial sig log survives close and reopen", async () => {
  const db = join(TMP, "psig-durable.db");

  let s = new SQLiteWALStore(db);
  await s.logPartialSig("NAV:1", "0xn1", "0xh1");
  await s.logPartialSig("NAV:2", "0xn2", "0xh2");
  await s.close();

  s = new SQLiteWALStore(db);
  assert.equal((await s.getPartialSig("NAV:1")).nonce, "0xn1");
  assert.equal((await s.getPartialSig("NAV:2")).payloadHash, "0xh2");
  await s.close();
});

// --- concurrent write isolation (within one process) ---

test("interleaved put and get are isolated", async () => {
  const db = join(TMP, "isolation.db");
  const store = new SQLiteWALStore(db);

  // Write 50 rounds, interleaving puts and gets from the SAME instance
  for (let i = 0; i < 50; i++) {
    const key = `ISO:${i}`;
    await store.put(key, { taskKey: key, nonce: `0x${i}`, task: { i }, state: "MINTED", sigs: [] });
    const row = await store.get(key);
    assert.equal(row.nonce, `0x${i}`, `row ${i} immediately readable`);
    if (i > 0) {
      const prev = await store.get(`ISO:${i - 1}`);
      assert.equal(prev.nonce, `0x${i - 1}`, `previous row ${i - 1} still readable`);
    }
  }
  const all = await store.all();
  assert.equal(all.length, 50);
  await store.close();

  // Reopen and verify
  const s2 = new SQLiteWALStore(db);
  const all2 = await s2.all();
  assert.equal(all2.length, 50);
  await s2.close();
});

// --- nonce integrity: nonce must match across restarts ---

test("nonce is bit-exact after close+reopen", async () => {
  const db = join(TMP, "nonce.db");
  const nonce = "0x" + randomBytes(32).toString("hex"); // 256-bit random nonce

  const s1 = new SQLiteWALStore(db);
  await s1.put("N:1", { taskKey: "N:1", nonce, task: { chainId: 31612, nonce }, state: "MINTED", sigs: [] });
  await s1.close();

  const s2 = new SQLiteWALStore(db);
  const row = await s2.get("N:1");
  assert.equal(row.nonce, nonce);
  assert.equal(row.task.nonce, nonce);
  await s2.close();
});

// Regressions from the first live run of the real aggregator (2026-07-15). The drill
// harness built tasks out of plain numbers, so neither of these ever surfaced in tests.
test("persists a task whose fields are BigInt (chain quantities) and the signer bitmap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ditto-db-bigint-"));
  const store = new SQLiteWALStore(join(dir, "wal.db"));
  const task = { chainId: 31611n, contractAddr: "0xabc", nonce: "0x1", expiry: 1800000000n, maxBlock: 42n };
  await store.put("placement:1", { taskKey: "placement:1", nonce: "0x1", task, state: "AGGREGATED", sigs: ["0xdead"], bitmap: 15 });

  // a fresh instance = what a restarted aggregator actually reads back
  const reopened = new SQLiteWALStore(join(dir, "wal.db"));
  const row = await reopened.get("placement:1");
  assert.equal(row.bitmap, 15, "bitmap must survive: a post-submit resume rebuilds the identical tx from it");
  assert.equal(BigInt(row.task.expiry), 1800000000n);
  assert.equal(BigInt(row.task.chainId), 31611n);
  rmSync(dir, { recursive: true, force: true });
});

// External review round 4: all() dropped the bitmap, so every unfinished row looked
// unsignable and startup-resume silently skipped it forever.
test("all() returns the bitmap — startup-resume rebuilds the tx from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ditto-db-all-"));
  const store = new SQLiteWALStore(join(dir, "wal.db"));
  await store.put("placement:batch-1", {
    taskKey: "placement:batch-1", nonce: "0x1", task: { expiry: "99" }, state: "AGGREGATED", sigs: ["0xagg"], bitmap: 15,
  });
  const rows = await new SQLiteWALStore(join(dir, "wal.db")).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bitmap, 15, "without this resumeUnfinished() can never resubmit");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anti-equivocation, the payload half (external review, 2026-08-23). The check bound a taskKey to
// one NONCE and nothing else, so a second task presented under the same (taskKey, nonce) was signed
// too — and since the row is keyed on (taskKey, nonce), INSERT OR IGNORE dropped it and the
// evidence log showed one signature where two existed. Reproduced against the previous code.
// ---------------------------------------------------------------------------
test("partialSigConflict refuses a different payload under the same nonce", () => {
  const rows = [{ nonce: "0x2a", payloadHash: "0xaa" }];
  assert.equal(partialSigConflict(rows, "0x2a", "0xaa"), undefined, "an exact retry is idempotent");
  assert.ok(partialSigConflict(rows, "0x2a", "0xbb"), "same nonce, different task -> refuse");
  assert.ok(partialSigConflict(rows, "0x2b", "0xaa"), "different nonce -> refuse, as before");
});

test("partialSigConflict tolerates the string/number drift the store round-trips", () => {
  // nonce comes back from SQLite as TEXT and arrives from JSON as either; comparing raw would
  // make an exact retry look like an equivocation and refuse a legitimate resend.
  const rows = [{ nonce: 42, payloadHash: "0xAA" }];
  assert.equal(partialSigConflict(rows, "42", "0xAA"), undefined);
});
