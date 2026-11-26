'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const { startServer, connect, newHost, newParticipant, row } = require('./helpers');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('設定・静的配信・ヘッダ', async () => {
  const s = await startServer({ env: { MAX_PARTICIPANTS: '10' } });
  try {
    const cfg = await (await fetch(s.url + '/config')).json();
    assert.equal(cfg.maxParticipants, 10);
    const health = await (await fetch(s.url + '/health')).json();
    assert.equal(health.maxParticipants, 10);
    assert.equal((await fetch(s.url + '/css/server.js')).status, 404, '古いserver.jsが公開されていない');
    const home = await fetch(s.url + '/host');
    const csp = home.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!(await home.text()).includes('cdn.jsdelivr'), 'CDNを参照していない');
  } finally { await s.stop(); }
});

test('MAX_PARTICIPANTS の範囲補正（10〜300）と既定値100', async () => {
  for (const [value, expected] of [[undefined, 100], ['5', 10], ['999', 300], ['abc', 100], ['150', 150]]) {
    const env = value === undefined ? { MAX_PARTICIPANTS: '' } : { MAX_PARTICIPANTS: value };
    const s = await startServer({ env });
    try { assert.equal((await (await fetch(s.url + '/config')).json()).maxParticipants, expected, `MAX_PARTICIPANTS=${value}`); }
    finally { await s.stop(); }
  }
});

test('部屋作成・参加・重複名・上限・不正入力', async () => {
  const s = await startServer({ env: { MAX_PARTICIPANTS: '10' } });
  const clients = [];
  try {
    const host = await newHost(s.url); clients.push(host);
    assert.match(host.room.roomCode, /^\d{6}$/);
    assert.equal(host.create.maxParticipants, 10);
    assert.equal(host.room.maxParticipants, 10);
    const a = await newParticipant(s.url, host.room.roomCode, 'たろう'); clients.push(a);
    assert.equal(a.join.ok, true);
    const dup = await newParticipant(s.url, host.room.roomCode, 'タロウ'.replace('タロウ', 'たろう')); clients.push(dup);
    assert.equal(dup.join.ok, false);
    assert.match(dup.join.error, /同じ参加者名/);
    for (let i = 2; i <= 10; i++) { const c = await newParticipant(s.url, host.room.roomCode, 'p' + i); clients.push(c); assert.equal(c.join.ok, true, 'p' + i); }
    const over = await newParticipant(s.url, host.room.roomCode, 'p11'); clients.push(over);
    assert.equal(over.join.ok, false); assert.match(over.join.error, /10台/);
    const bad = await newParticipant(s.url, '12', 'x'); clients.push(bad);
    assert.equal(bad.join.ok, false);
    const longName = await newParticipant(s.url, host.room.roomCode, 'x'.repeat(25)); clients.push(longName);
    assert.equal(longName.join.ok, false);
  } finally { clients.forEach(c => c.close()); await s.stop(); }
});

test('測定設定の検証', async () => {
  const s = await startServer();
  let host;
  try {
    host = await newHost(s.url);
    const ok = await host.call('host:update-settings', { trials: 500, minWaitSeconds: 0.5, maxWaitSeconds: 30 });
    assert.equal(ok.ok, true);
    for (const bad of [{ trials: 0 }, { trials: 501 }, { trials: 1.5 }, { trials: 5, minWaitSeconds: 0.4, maxWaitSeconds: 3 },
      { trials: 5, minWaitSeconds: 3, maxWaitSeconds: 2 }, { trials: 5, minWaitSeconds: 1, maxWaitSeconds: 31 }, { trials: 'a' }]) {
      const r = await host.call('host:update-settings', { minWaitSeconds: 1, maxWaitSeconds: 3, ...bad });
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    const p = await newParticipant(s.url, host.room.roomCode, 'a'); // 参加者はホスト権限を持たない
    assert.equal((await p.call('host:update-settings', { trials: 3, minWaitSeconds: 1, maxWaitSeconds: 2 })).ok, false);
    assert.equal((await p.call('host:start-measurement', {})).ok, false);
    p.close();
  } finally { host?.close(); await s.stop(); }
});

test('不正なペイロードでもサーバーが落ちない（ファジング）', async () => {
  const s = await startServer();
  const c = connect(s.url);
  try {
    await c.ready;
    const events = ['clock:ping', 'host:create-room', 'host:reconnect', 'participant:join', 'participant:reconnect', 'host:update-settings',
      'host:start-measurement', 'host:pause-measurement', 'host:resume-measurement', 'host:end-measurement', 'participant:submit-results',
      'host:get-results', 'host:get-stats', 'host:remove-participant', 'host:close-room', 'participant:leave', 'participant:trial-result'];
    const payloads = [null, undefined, 'str', 42, [], [1, 2], { rows: 'x' }, { rows: [null, 1, 'a', {}] }, { hostToken: {} }, { roomCode: {}, name: [] },
      { __proto__: { x: 1 } }, { participantId: {}, participantToken: [] }, { trials: {}, minWaitSeconds: [], maxWaitSeconds: null }];
    for (const e of events) for (const p of payloads) {
      c.socket.emit(e, p);                 // ack なし
      c.socket.emit(e, p, 'not-a-function'); // ack が関数でない
      c.socket.emit(e, p, () => {});
    }
    await sleep(500);
    const h = await (await fetch(s.url + '/health')).json();
    assert.equal(h.ok, true);
    assert.ok(!/TypeError|Unhandled|uncaught/i.test(s.getLog().replace(/handler error[^\n]*\n/g, '')), s.getLog().slice(0, 500));
    assert.equal(s.child.exitCode, null, 'プロセスが生存');
  } finally { c.close(); await s.stop(); }
});

test('結果送信: 受信確認・重複防止・拒否・範囲外', async () => {
  const s = await startServer();
  const clients = [];
  try {
    const host = await newHost(s.url); clients.push(host);
    const a = await newParticipant(s.url, host.room.roomCode, 'alice'); clients.push(a);
    const b = await newParticipant(s.url, host.room.roomCode, 'bob'); clients.push(b);
    await host.call('host:update-settings', { trials: 2, minWaitSeconds: 0.5, maxWaitSeconds: 0.5 });
    assert.equal((await host.call('host:start-measurement', {})).ok, true);
    await a.waitFor('trial:scheduled'); // trial 1 が配信された（trialNumber=1）
    const r1 = await a.call('participant:submit-results', { rows: [row(a.p, 1), row(a.p, 1)] }); // 同一試行を2件
    assert.deepEqual([r1.ok, r1.accepted, r1.duplicates, r1.rejected, r1.received], [true, 1, 1, 0, 2]);
    const again = await a.call('participant:submit-results', { rows: [row(a.p, 1)] });
    assert.deepEqual([again.accepted, again.duplicates], [0, 1], '再送しても二重登録されない');
    const wrongOwner = await a.call('participant:submit-results', { rows: [row(b.p, 1)] });
    assert.equal(wrongOwner.rejected, 1, '他人のIDの結果は拒否');
    const future = await a.call('participant:submit-results', { rows: [row(a.p, 2)] });
    assert.equal(future.rejected, 1, '未到来の試行は拒否');
    const outOfRange = await a.call('participant:submit-results', { rows: [row(a.p, 99)] });
    assert.equal(outOfRange.rejected, 1);
    const badRt = await a.call('participant:submit-results', { rows: [row(a.p, 1, { reactionTimeMs: -5 }), row(a.p, 1, { reactionTimeMs: 'x' })] });
    assert.equal(badRt.rejected, 2);
    const tooMany = await a.call('participant:submit-results', { rows: Array.from({ length: 101 }, () => row(a.p, 1)) });
    assert.equal(tooMany.ok, false);
    const invalid = await b.call('participant:submit-results', { rows: [row(b.p, 1, { status: 'invalid', reason: 'early', reactionTimeMs: null, inputType: 'touch' })] });
    assert.equal(invalid.accepted, 1, '無効データも保存される');
    await host.call('host:end-measurement', {});
    const res = await host.call('host:get-results', { limit: 10 });
    assert.equal(res.count, 2);
    const stats = await host.call('host:get-stats', {});
    assert.equal(stats.stats.overall.valid, 1); assert.equal(stats.stats.overall.early, 1);
    assert.equal(stats.stats.byInput.length, 1);
  } finally { clients.forEach(c => c.close()); await s.stop(); }
});

test('途中参加: 次の試行から設定回数を確保 / 完了者に追加試行を送らない（実時間約25秒）', async () => {
  const s = await startServer();
  const clients = [];
  try {
    const host = await newHost(s.url); clients.push(host);
    await host.call('host:update-settings', { trials: 2, minWaitSeconds: 0.5, maxWaitSeconds: 0.5 });
    const a = await newParticipant(s.url, host.room.roomCode, 'early'); clients.push(a);
    assert.equal(a.p.firstTrial, 1); assert.equal(a.p.lastTrial, 2);
    await host.call('host:start-measurement', {});
    const t1 = await a.waitFor('trial:scheduled');
    assert.equal(t1.trialNumber, 1);
    assert.ok(t1.scheduledAt > Date.now() + 2000, '将来時刻が共通予定時刻として通知される');
    const late = await newParticipant(s.url, host.room.roomCode, 'late'); clients.push(late);
    assert.equal(late.p.joinedDuringSession, true);
    assert.equal(late.p.firstTrial, 2, '進行中の試行1には参加しない'); assert.equal(late.p.lastTrial, 3);
    const finished = await host.waitFor('session:finished', 40000);
    assert.equal(finished.trialNumber, 3, '途中参加者の最終試行まで進む');
    const lateTrials = late.events.filter(e => e.name === 'trial:scheduled').map(e => e.data.trialNumber);
    const earlyTrials = a.events.filter(e => e.name === 'trial:scheduled').map(e => e.data.trialNumber);
    assert.deepEqual(earlyTrials, [1, 2], '完了済み参加者に追加試行を強制しない');
    assert.deepEqual(lateTrials, [2, 3]);
    // 3試行目の通知は途中参加者のみ
    assert.ok(!earlyTrials.includes(3));
  } finally { clients.forEach(c => c.close()); await s.stop(); }
});

test('再接続・一時停止・サーバー再起動後の復元（測定中は一時停止で復元）', async () => {
  let s = await startServer();
  const dbPath = s.db;
  let host, p;
  try {
    host = await newHost(s.url);
    p = await newParticipant(s.url, host.room.roomCode, 'carol');
    await host.call('host:start-measurement', {});
    await p.waitFor('trial:scheduled');
    assert.equal((await host.call('host:pause-measurement', {})).ok, true);
    assert.equal((await host.call('host:resume-measurement', {})).ok, true);
    await p.call('participant:submit-results', { rows: [row(p.p, 1, { clientRecordId: 'x' })] });
    const sess = { roomCode: host.room.roomCode, ...p.p }, hostToken = host.hostToken;
    host.close(); p.close();
    await s.kill();                       // 異常終了（SIGKILL）でも復元できること
    s = await startServer({ dbPath });
    const h2 = connect(s.url); await h2.ready;
    const hr = await h2.call('host:reconnect', { hostToken });
    assert.equal(hr.ok, true); assert.equal(hr.room.status, 'paused', '測定中だった部屋は自動再開せず一時停止');
    assert.equal(hr.room.participants.length, 1);
    const p2 = connect(s.url); await p2.ready;
    const pr = await p2.call('participant:reconnect', { roomCode: sess.roomCode, participantId: sess.participantId, participantToken: sess.participantToken });
    assert.equal(pr.ok, true);
    const bad = await p2.call('participant:reconnect', { roomCode: sess.roomCode, participantId: sess.participantId, participantToken: 'f'.repeat(64) });
    assert.equal(bad.ok, false);
    const dup = await p2.call('participant:submit-results', { rows: [row(sess, 1)] });
    assert.equal(dup.duplicates, 1, '再起動後の再送でも二重登録されない');
    const res = await h2.call('host:get-results', {});
    assert.equal(res.count, 1);
    h2.close(); p2.close();
  } finally { await s.stop(); }
});

test('強制退出・自主退出・部屋終了後も結果保持と送信可能', async () => {
  const s = await startServer();
  const clients = [];
  try {
    const host = await newHost(s.url); clients.push(host);
    const a = await newParticipant(s.url, host.room.roomCode, 'a'); clients.push(a);
    const b = await newParticipant(s.url, host.room.roomCode, 'b'); clients.push(b);
    const c = await newParticipant(s.url, host.room.roomCode, 'c'); clients.push(c);
    await host.call('host:start-measurement', {});
    await a.waitFor('trial:scheduled');
    assert.equal((await host.call('host:remove-participant', { participantId: a.p.participantId })).ok, true);
    await a.waitFor('participant:removed', 3000);
    assert.equal((await a.call('participant:submit-results', { rows: [row(a.p, 1)] })).ok, false);
    assert.equal((await c.call('participant:leave', {})).ok, true);
    assert.equal((await host.call('host:close-room', {})).ok, true);
    await b.waitFor('room:closed', 3000);
    const late = await b.call('participant:submit-results', { rows: [row(b.p, 1)] });
    assert.equal(late.accepted, 1, '部屋終了直後でも未送信分を送信できる');
    const closedJoin = await newParticipant(s.url, host.room.roomCode, 'd'); clients.push(closedJoin);
    assert.equal(closedJoin.join.ok, false);
    const res = await host.call('host:get-results', {}); assert.equal(res.count, 1);
  } finally { clients.forEach(c => c.close()); await s.stop(); }
});

test('CSV/Excel 出力: 認証・BOM/CRLF・数式インジェクション対策', async () => {
  const s = await startServer();
  const clients = [];
  try {
    const host = await newHost(s.url); clients.push(host);
    const evil = await newParticipant(s.url, host.room.roomCode, '=HYPERLINK("http://x")'); clients.push(evil);
    const ok = await newParticipant(s.url, host.room.roomCode, 'normal'); clients.push(ok);
    await host.call('host:start-measurement', {});
    await evil.waitFor('trial:scheduled');
    await evil.call('participant:submit-results', { rows: [row(evil.p, 1)] });
    await ok.call('participant:submit-results', { rows: [row(ok.p, 1), ] });
    const post = (fmt, body) => fetch(`${s.url}/api/export/${fmt}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('csv', { hostToken: 'a'.repeat(64) })).status, 403);
    assert.equal((await post('csv', {})).status, 403);
    assert.equal((await post('pdf', { hostToken: host.hostToken })).status, 404);
    const csvRes = await post('csv', { hostToken: host.hostToken });
    assert.equal(csvRes.status, 200);
    const bytes = Buffer.from(await csvRes.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM付き（Excelで文字化けしない）');
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    assert.ok(text.startsWith('"参加者名"'));
    const lines = text.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 3, 'ヘッダ+2行がCRLFで区切られる');
    assert.ok(lines.some(l => l.startsWith(`"'=HYPERLINK`)), '数式として解釈されない');
    assert.ok(!lines.some(l => l.startsWith('"=')));
    const xr = await post('xlsx', { hostToken: host.hostToken });
    assert.equal(xr.status, 200);
    const buf = Buffer.from(await xr.arrayBuffer());
    assert.equal(buf.slice(0, 2).toString(), 'PK');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.deepEqual(wb.worksheets.map(w => w.name), ['測定結果', '集計']);
    assert.equal(wb.getWorksheet('測定結果').rowCount, 3);
    assert.match(String(wb.getWorksheet('測定結果').getRow(2).getCell(1).value), /^'=HYPERLINK|^normal/);
    // 部屋終了後も出力可能
    await host.call('host:close-room', {});
    assert.equal((await post('csv', { hostToken: host.hostToken })).status, 200);
  } finally { clients.forEach(c => c.close()); await s.stop(); }
});

test('レート制限: 部屋番号の総当たりを遮断', async () => {
  const s = await startServer();
  const c = connect(s.url);
  try {
    await c.ready;
    let blocked = false;
    for (let i = 0; i < 60; i++) {
      const r = await c.call('participant:join', { roomCode: String(100000 + i), name: 'x' });
      if (/多すぎます/.test(r.error || '')) { blocked = true; break; }
    }
    assert.equal(blocked, true);
  } finally { c.close(); await s.stop(); }
});

test('トークンは平文でDBに保存されない / 旧DB(第5段階)からの移行', async () => {
  const s = await startServer();
  let host, p;
  try {
    host = await newHost(s.url); p = await newParticipant(s.url, host.room.roomCode, 'zed');
    await sleep(400);
    const raw = new Database(s.db, { readonly: true });
    const dump = JSON.stringify(raw.prepare('SELECT * FROM sessions').all());
    raw.close();
    assert.ok(!dump.includes(host.hostToken), 'ホストトークンが平文で保存されていない');
    assert.ok(!dump.includes(p.p.participantToken), '参加者トークンが平文で保存されていない');
  } finally { host?.close(); p?.close(); await s.stop(); }

  // 旧スキーマを手で作る（第5段階の構造・平文トークン）
  const fs2 = require('fs'), os = require('os'), path = require('path');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'rt-legacy-')), file = path.join(dir, 'legacy.sqlite');
  const old = new Database(file);
  old.exec(`CREATE TABLE sessions (room_code TEXT PRIMARY KEY, host_token TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, settings_json TEXT NOT NULL, trial_number INTEGER NOT NULL DEFAULT 0, participants_json TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE results (record_id TEXT PRIMARY KEY, room_code TEXT NOT NULL, participant_id TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL);`);
  const oldHost = 'h'.repeat(64), oldPart = 'p'.repeat(64);
  old.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('123456', oldHost, 'measuring', Date.now(), JSON.stringify({ trials: 3, minWaitMs: 1000, maxWaitMs: 2000 }), 2,
    JSON.stringify([{ id: 'pid-1', token: oldPart, name: '旧参加者', joinedDuringSession: false, completed: false, uploadedCount: 1 }]), 0);
  old.prepare('INSERT INTO results VALUES (?,?,?,?,?)').run('uuid-1', '123456', 'pid-1', '2026-01-01T00:00:00Z',
    JSON.stringify({ recordId: 'uuid-1', participantId: 'pid-1', participantName: '旧参加者', trialNumber: 1, reactionTimeMs: 300, inputType: 'pointer', status: 'recorded', reason: '' }));
  old.close();
  const s2 = await startServer({ dbPath: file });
  try {
    const h = connect(s2.url); await h.ready;
    const hr = await h.call('host:reconnect', { hostToken: oldHost });
    assert.equal(hr.ok, true, '旧版の平文トークンで引き続きホスト再接続できる');
    assert.equal(hr.room.status, 'paused');
    const pc = connect(s2.url); await pc.ready;
    assert.equal((await pc.call('participant:reconnect', { roomCode: '123456', participantId: 'pid-1', participantToken: oldPart })).ok, true);
    const st = await h.call('host:get-stats', {});
    assert.equal(st.stats.overall.valid, 1, '旧データが集計に含まれる');
    h.close(); pc.close();
    await sleep(400);
    const raw = new Database(file, { readonly: true });
    assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM sessions').all()).includes(oldHost), '移行後は平文トークンが残らない');
    raw.close();
  } finally { await s2.stop(); }
});
