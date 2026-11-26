'use strict';
// SQLite の初期化・スキーマ・移行。既存のDB（第5段階）を壊さずに列を追加する。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function addColumn(db, table, name, ddl) {
  if (!columnsOf(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try { fs.chmodSync(dbPath, 0o600); } catch (_) { /* Windows等では無視 */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      room_code TEXT PRIMARY KEY,
      host_token TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      trial_number INTEGER NOT NULL DEFAULT 0,
      participants_json TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS results (
      record_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
  `);

  // 第5段階のDBからの移行（列追加のみ。既存データは削除しない）
  addColumn(db, 'sessions', 'run_number', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'results', 'run_number', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'results', 'trial_number', 'INTEGER');
  addColumn(db, 'results', 'status', 'TEXT');
  addColumn(db, 'results', 'reaction_time_ms', 'REAL');
  addColumn(db, 'results', 'input_type', 'TEXT');
  addColumn(db, 'results', 'reason', 'TEXT');
  addColumn(db, 'results', 'participant_name', 'TEXT');
  addColumn(db, 'results', 'received_at', 'INTEGER');

  // 旧行の集計用列をdata_jsonから補完
  const legacy = db.prepare('SELECT record_id, data_json FROM results WHERE status IS NULL').all();
  if (legacy.length) {
    const upd = db.prepare(`UPDATE results SET trial_number=?, status=?, reaction_time_ms=?, input_type=?, reason=?, participant_name=?, received_at=COALESCE(received_at, 0) WHERE record_id=?`);
    db.transaction(() => {
      for (const r of legacy) {
        let d = {};
        try { d = JSON.parse(r.data_json) || {}; } catch (_) { /* 破損行はそのまま */ }
        upd.run(Number(d.trialNumber) || 0, d.status === 'recorded' ? 'recorded' : 'invalid',
          d.reactionTimeMs == null ? null : Number(d.reactionTimeMs),
          String(d.inputType || 'unknown'), String(d.reason || ''), String(d.participantName || ''), r.record_id);
      }
    })();
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_results_room_order ON results(room_code, created_at, record_id);
    CREATE INDEX IF NOT EXISTS idx_results_participant ON results(room_code, participant_id);
    CREATE INDEX IF NOT EXISTS idx_results_room_status ON results(room_code, status);
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
