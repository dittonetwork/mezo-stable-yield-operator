// SPDX-License-Identifier: BUSL-1.1
// SQLiteWALStore — durable persistence for the AggregatorWAL.
//
// Uses sql.js (pure JS/WASM SQLite, zero native deps) as an in-memory SQL engine.
// Durability is achieved via ATOMIC EXPORT + FSYNC, NOT via SQLite's WAL/journal:
// every put() serializes the ENTIRE database to a temp file, fsyncs it, then
// atomically renames over the target path. This satisfies the persist-before-sign
// contract (§04): the write is on durable storage before the caller proceeds with
// signature requests.
//
// PRAGMA journal_mode=WAL is set for internal WASM-memory read/write concurrency
// (sql.js benefits from WAL for interleaved reads/writes in the WASM heap), but
// it does NOT contribute to on-disk durability. Durability comes exclusively from
// the export+atomic-write+fsync barrier in _sync().
//
// Crash-safety model (POSIX):
//   _sync() writes to a temp file, fsyncs it, then atomically renames over the
//   target path. A crash during write leaves either the old file intact (rename
//   didn't happen) or the new file complete (rename is atomic). No partial or
//   corrupt state is possible. On restart, the store reads the single-file DB
//   snapshot and resumes exactly where it was.
//
// Trade-off: full-DB export per write is O(n) in DB size. Acceptable for the
// pilot's data volumes (hundreds of rounds + partial-sig entries). Upgrade path:
//   - better-sqlite3 (native Node addon) — true WAL with incremental fsync
//   - node:sqlite (Node.js 22+ built-in) — native SQLite with WAL support
// Both eliminate the full-DB-export overhead while preserving the same durability
// contract and store interface.
//
// Schema:
//   rounds(taskKey TEXT PRIMARY KEY, nonce TEXT NOT NULL, task TEXT NOT NULL,
//          state TEXT NOT NULL DEFAULT 'MINTED', sigs TEXT DEFAULT '[]', txHash TEXT)
//   partial_sigs(taskKey TEXT NOT NULL, nonce TEXT NOT NULL, payloadHash TEXT NOT NULL,
//                signedAt INTEGER NOT NULL, PRIMARY KEY (taskKey))

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let _SQL = null;

async function _initSqlJs() {
  if (!_SQL) {
    const initSqlJs = (await import("sql.js")).default;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

function _fsyncWrite(path, data) {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w");
  writeSync(fd, data);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
  // fsync the DIRECTORY too: fsync'ing the file makes its CONTENTS durable, but the rename
  // is a directory operation and can still be lost in a crash — leaving the old file, or
  // none. persist-before-sign is only as strong as this barrier, so it is not optional.
  const dfd = openSync(dirname(path), "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

/** JSON replacer: chain quantities arrive as BigInt, which JSON.stringify refuses. */
const _bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

export class SQLiteWALStore {
  constructor(dbPath) {
    this.path = dbPath;
    this._ready = false;
  }

  async _ensureReady() {
    if (this._ready) return;
    const SQL = await _initSqlJs();
    mkdirSync(dirname(this.path), { recursive: true });
    let buf = null;
    if (existsSync(this.path)) {
      buf = readFileSync(this.path);
    }
    this._db = new SQL.Database(buf);
    this._db.run("PRAGMA journal_mode=WAL");
    this._db.run(`
      CREATE TABLE IF NOT EXISTS rounds (
        taskKey TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        task TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'MINTED',
        sigs TEXT DEFAULT '[]',
        txHash TEXT,
        -- which seats signed. A resume after a post-submit crash must rebuild the
        -- IDENTICAL tx, and the bitmap cannot be recovered from the task alone.
        bitmap INTEGER
      )
    `);
    // Pre-existing DBs predate the bitmap column; add it rather than lose the round.
    try {
      this._db.run("ALTER TABLE rounds ADD COLUMN bitmap INTEGER");
    } catch {
      /* already there */
    }
    // Pre-existing DBs predate RETIRED/attempt tracking (external review, 2026-07-16): a
    // retired round's audit trail (which trigger it came from, which attempt number, why it
    // died) must survive a restart, or a restore reads a bare CONFIRMED-looking row and loses
    // the "this never executed" fact entirely.
    for (const col of ["triggerKey TEXT", "attempt INTEGER", "retiredReason TEXT"]) {
      try {
        this._db.run(`ALTER TABLE rounds ADD COLUMN ${col}`);
      } catch {
        /* already there */
      }
    }
    // Append-only evidence, keyed by (taskKey, NONCE). The operator's log is what a restored
    // aggregator queries to avoid minting a second nonce for a trigger that already has a
    // signed task in flight — so it must remember every (task, nonce) it was ever asked to
    // sign, and it must store the TASK, not just its hash: an adopting aggregator has to
    // rebuild the exact task, and a hash cannot be un-hashed.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS partial_sigs (
        taskKey TEXT NOT NULL,
        nonce TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        task TEXT,
        signedAt INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (taskKey, nonce)
      )
    `);
    // Migrate the original schema, which was PRIMARY KEY (taskKey) with no task column: a
    // second request for the same trigger silently REPLACED the row, destroying the record
    // of the first nonce — the exact evidence restore depends on.
    const info = this._db.exec("PRAGMA table_info(partial_sigs)");
    const cols = info.length ? info[0].values.map((r) => r[1]) : [];
    if (cols.length && !cols.includes("task")) {
      this._db.run("ALTER TABLE partial_sigs RENAME TO partial_sigs_legacy");
      this._db.run(`
        CREATE TABLE partial_sigs (
          taskKey TEXT NOT NULL, nonce TEXT NOT NULL, payloadHash TEXT NOT NULL,
          task TEXT, signedAt INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (taskKey, nonce)
        )`);
      this._db.run(`INSERT INTO partial_sigs (taskKey, nonce, payloadHash, signedAt)
                    SELECT taskKey, nonce, payloadHash, signedAt FROM partial_sigs_legacy`);
      this._db.run("DROP TABLE partial_sigs_legacy");
    }
    this._ready = true;
  }

  _sync() {
    const data = this._db.export();
    _fsyncWrite(this.path, Buffer.from(data));
  }

  async get(taskKey) {
    await this._ensureReady();
    const stmt = this._db.prepare(
      "SELECT taskKey, nonce, task, state, sigs, txHash, bitmap, triggerKey, attempt, retiredReason FROM rounds WHERE taskKey = ?"
    );
    stmt.bind([taskKey]);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = vals[i];
      }
      if (row.sigs) {
        try { row.sigs = JSON.parse(row.sigs); } catch { row.sigs = []; }
      }
      if (row.task) {
        try { row.task = JSON.parse(row.task); } catch { row.task = null; }
      }
      return row;
    }
    stmt.free();
    return null;
  }

  async put(taskKey, row) {
    await this._ensureReady();
    // Task fields are chain quantities and arrive as BigInt; plain JSON.stringify throws on
    // those, so persist them as decimal strings (every reader coerces through BigInt()).
    const taskJson = typeof row.task === "string" ? row.task : JSON.stringify(row.task, _bigintSafe);
    const sigsJson = Array.isArray(row.sigs) ? JSON.stringify(row.sigs, _bigintSafe) : (row.sigs || "[]");
    this._db.run(
      `INSERT OR REPLACE INTO rounds (taskKey, nonce, task, state, sigs, txHash, bitmap, triggerKey, attempt, retiredReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskKey, String(row.nonce), taskJson, row.state, sigsJson, row.txHash || null,
       row.bitmap === undefined ? null : Number(row.bitmap),
       row.triggerKey ?? null, row.attempt === undefined ? null : Number(row.attempt), row.retiredReason ?? null]
    );
    this._sync();
  }

  async all() {
    await this._ensureReady();
    const results = [];
    // bitmap MUST be selected: resumeUnfinished() rebuilds the identical tx from it, and
    // without it every unfinished row looks unsignable and is skipped forever.
    const stmt = this._db.prepare(
      "SELECT taskKey, nonce, task, state, sigs, txHash, bitmap, triggerKey, attempt, retiredReason FROM rounds"
    );
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = vals[i];
      }
      if (row.sigs) {
        try { row.sigs = JSON.parse(row.sigs); } catch { row.sigs = []; }
      }
      if (row.task) {
        try { row.task = JSON.parse(row.task); } catch { row.task = null; }
      }
      results.push(row);
    }
    stmt.free();
    return results;
  }

  /**
   * Record that this operator was asked to sign (taskKey, nonce, task). APPEND-ONLY: re-asking
   * for the same (taskKey, nonce) is an idempotent no-op, and a DIFFERENT nonce for the same
   * trigger is kept ALONGSIDE the first rather than replacing it — two rows for one trigger is
   * evidence of aggregator equivocation and must survive to be seen.
   *
   * Called BEFORE the signature is produced, deliberately: over-remembering is harmless (a
   * restore just resumes a nonce nobody signed), while under-remembering is what lets a
   * restored aggregator mint a second nonce for a trigger whose first task is already signed
   * and in flight.
   */
  async logPartialSig(taskKey, nonce, payloadHash, task) {
    await this._ensureReady();
    this._db.run(
      `INSERT OR IGNORE INTO partial_sigs (taskKey, nonce, payloadHash, task, signedAt)
       VALUES (?, ?, ?, ?, unixepoch())`,
      [taskKey, String(nonce), payloadHash, task == null ? null : (typeof task === "string" ? task : JSON.stringify(task, _bigintSafe))]
    );
    this._sync();
  }

  /** Every (task, nonce) this operator was ever asked to sign for `taskKey`, oldest first. */
  async getPartialSigs(taskKey) {
    await this._ensureReady();
    const stmt = this._db.prepare(
      "SELECT taskKey, nonce, payloadHash, task, signedAt FROM partial_sigs WHERE taskKey = ? ORDER BY signedAt ASC"
    );
    stmt.bind([taskKey]);
    const rows = [];
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row = {};
      for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
      if (row.task) {
        try {
          row.task = JSON.parse(row.task);
        } catch {
          row.task = null;
        }
      }
      rows.push(row);
    }
    stmt.free();
    return rows;
  }

  /**
   * The single record for a trigger, or an equivocation marker. A restore may only adopt a
   * nonce when the operator remembers exactly ONE for the trigger; more than one means the
   * aggregator proposed twice and no automatic choice is safe.
   */
  async getPartialSig(taskKey) {
    const rows = await this.getPartialSigs(taskKey);
    if (rows.length === 0) return null;
    if (rows.length > 1) return { taskKey, equivocated: true, entries: rows };
    return rows[0];
  }

  async close() {
    if (this._db) {
      this._sync();
      this._db.close();
      this._ready = false;
      this._db = null;
    }
  }
}

/**
 * The anti-equivocation predicate: a stored row conflicts if it carries a different nonce OR a
 * different payload for this one.
 *
 * The payload half was missing. Binding only the nonce left the property the comment above the call
 * site promises ("one trigger -> one task") unmet: a SECOND task under the same (taskKey, nonce)
 * passed the check and was signed — and because the row is keyed on (taskKey, nonce), the
 * INSERT OR IGNORE silently dropped it, so the evidence log recorded one signature where two had
 * been produced. Reproduced against the previous code, external review 2026-08-23.
 *
 * Exported and shared so the single-sign and batch paths cannot drift apart, which is exactly how
 * the first version of this check ended up enforced in one place and not the other.
 */
export function partialSigConflict(rows, nonce, payloadHash) {
  return rows.find((r) =>
    String(r.nonce) !== String(nonce) || String(r.payloadHash) !== String(payloadHash));
}
