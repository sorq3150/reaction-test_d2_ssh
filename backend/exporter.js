'use strict';
// 集計（平均・中央値・標準偏差など）と、CSV / Excel のストリーミング出力。
const ExcelJS = require('exceljs');

function summarize(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, median: null, min: null, max: null, sd: null };
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  // 標準偏差は母集団標準偏差（既存仕様を維持。n で割る）
  const sd = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean, median, min: sorted[0], max: sorted[n - 1], sd };
}

class Bucket {
  constructor() { this.total = 0; this.valid = []; this.early = 0; this.timeout = 0; this.otherInvalid = 0; }
  add(row) {
    this.total++;
    if (row.status === 'recorded' && Number.isFinite(row.reaction_time_ms)) this.valid.push(row.reaction_time_ms);
    else if (row.reason === 'early') this.early++;
    else if (row.reason === 'timeout') this.timeout++;
    else this.otherInvalid++;
  }
  result() {
    const s = summarize(this.valid);
    return {
      total: this.total, valid: s.n, early: this.early, timeout: this.timeout,
      otherInvalid: this.otherInvalid, invalid: this.total - s.n,
      mean: s.mean, median: s.median, min: s.min, max: s.max, sd: s.sd
    };
  }
}

function computeStats(db, roomCode) {
  const overall = new Bucket();
  const byParticipant = new Map();
  const byInput = new Map();
  const byReason = new Map();
  const it = db.prepare(`SELECT participant_id, participant_name, input_type, status, reason, reaction_time_ms
    FROM results WHERE room_code = ?`).iterate(roomCode);
  for (const row of it) {
    overall.add(row);
    if (!byParticipant.has(row.participant_id)) byParticipant.set(row.participant_id, { name: row.participant_name, b: new Bucket() });
    byParticipant.get(row.participant_id).b.add(row);
    if (row.status === 'recorded') {
      const k = row.input_type || 'unknown';
      if (!byInput.has(k)) byInput.set(k, new Bucket());
      byInput.get(k).add(row);
    }
    if (row.status !== 'recorded') byReason.set(row.reason || 'unknown', (byReason.get(row.reason || 'unknown') || 0) + 1);
  }
  return {
    overall: overall.result(),
    byParticipant: [...byParticipant.entries()]
      .map(([participantId, v]) => ({ participantId, name: v.name, ...v.b.result() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja')),
    byInput: [...byInput.entries()].map(([inputType, b]) => ({ inputType, ...b.result() }))
      .sort((a, b) => a.inputType.localeCompare(b.inputType)),
    byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count }))
  };
}

// CSV/Excel の数式インジェクション対策: 先頭が = + - @ タブ CR の文字列は ' を前置する。
function safeText(v) {
  if (v == null) return '';
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

const COLUMNS = [
  ['参加者名', d => safeText(d.participantName)],
  ['参加者ID', d => d.participantId],
  ['測定回(run)', d => d.run],
  ['試行番号', d => d.trialNumber],
  ['反応時間(ms)', d => d.reactionTimeMs],
  ['入力方式 (input_type)', d => safeText(d.inputType)],
  ['状態', d => d.status],
  ['無効理由 (invalid_reason)', d => safeText(d.reason)],
  ['予定時刻 (scheduled_time, epoch ms)', d => d.scheduledTime],
  ['画面切替時刻 (local_change_time, epoch ms)', d => d.localChangeTime],
  ['入力時刻 (input_time, epoch ms)', d => d.inputTime],
  ['時計オフセット (clock_offset, ms)', d => d.clockOffsetMs],
  ['RTT(ms)', d => d.rttMs],
  ['同期品質 (sync_quality)', d => safeText(d.syncQuality)],
  ['描画遅延(ms)', d => d.frameDelayMs],
  ['画面表示状態 (visibility_state)', d => safeText(d.visibilityState)],
  ['ブラウザ', d => safeText(d.browser)],
  ['OS', d => safeText(d.os)],
  ['デバイス', d => safeText(d.device)],
  ['記録日時', d => safeText(d.createdAt)]
];

function* iterateRows(db, roomCode) {
  const it = db.prepare(`SELECT data_json FROM results WHERE room_code = ?
    ORDER BY participant_name, run_number, trial_number, rowid`).iterate(roomCode);
  for (const r of it) {
    try { yield JSON.parse(r.data_json); } catch (_) { /* 破損行はスキップ */ }
  }
}

function streamCsv(db, roomCode, res) {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  res.write('\uFEFF' + COLUMNS.map(c => esc(c[0])).join(',') + '\r\n');
  let buffer = [];
  for (const d of iterateRows(db, roomCode)) {
    buffer.push(COLUMNS.map(c => esc(c[1](d))).join(','));
    if (buffer.length >= 500) { res.write(buffer.join('\r\n') + '\r\n'); buffer = []; }
  }
  if (buffer.length) res.write(buffer.join('\r\n') + '\r\n');
  res.end();
}

async function streamXlsx(db, roomCode, res) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet('測定結果');
  ws.addRow(COLUMNS.map(c => c[0])).commit();
  for (const d of iterateRows(db, roomCode)) ws.addRow(COLUMNS.map(c => c[1](d))).commit();
  ws.commit();

  const stats = computeStats(db, roomCode);
  const sm = wb.addWorksheet('集計');
  const head = ['区分', '名前/入力方式', '総試行', '有効', '早押し', 'タイムアウト', 'その他無効', '平均(ms)', '中央値(ms)', '最小(ms)', '最大(ms)', '標準偏差(ms,母集団)'];
  const line = (kind, label, s) => sm.addRow([kind, safeText(label), s.total, s.valid, s.early, s.timeout, s.otherInvalid,
    s.mean, s.median, s.min, s.max, s.sd]).commit();
  sm.addRow(head).commit();
  line('全体', '全参加者', stats.overall);
  stats.byParticipant.forEach(p => line('参加者', p.name, p));
  stats.byInput.forEach(i => line('入力方式', i.inputType, i));
  sm.commit();
  await wb.commit();
}

module.exports = { computeStats, summarize, streamCsv, streamXlsx, safeText, COLUMNS };
