'use strict';
// 参加者画面の実コード(frontend/js/participant.js)を jsdom + fake-indexeddb 上で動かし、実サーバーに接続して検証する。
// 注意: 実ブラウザではない。描画・vsync・実機の入力遅延は検証できない。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const { io: ioClient } = require('socket.io-client');
const { startServer, newHost } = require('./helpers');

const FRONT = path.join(__dirname, '..', 'frontend');
const CODE = fs.readFileSync(path.join(FRONT, 'js', 'participant.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, label = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(5); }
  throw new Error('timeout: ' + label);
}

function makeDevice(serverUrl, { ua } = {}) {
  const html = fs.readFileSync(path.join(FRONT, 'participant.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: serverUrl + '/participant', runScripts: 'outside-only', pretendToBeVisual: true,
    userAgent: ua || 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'userAgent', { value: ua || 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  let socket = null;
  const log = [];
  w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange;
  w.confirm = () => true;
  w.io = () => { socket = ioClient(serverUrl, { transports: ['websocket'], forceNew: true }); socket.onAny((n, d) => log.push([Math.round(performance.now()), n, d && d.trialNumber])); return socket; };
  w.eval(CODE);
  const $ = id => w.document.getElementById(id);
  new w.MutationObserver(() => log.push([Math.round(performance.now()), 'class', $('stimulus').className])).observe($('stimulus'), { attributes: true });
  const press = (type = 'keyboard') => {
    log.push([Math.round(performance.now()), 'press', type, 'optsHidden=' + $('optionsPanel').classList.contains('hidden'), 'joinPanelHidden=' + $('joinPanel').classList.contains('hidden'), 'info=' + $('trialInfo').textContent]);
    if (type === 'keyboard') {
      const e = new w.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      w.document.dispatchEvent(e);
    } else {
      const e = new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'pointerType', { value: type });
      $('stimulus').dispatchEvent(e);
    }
  };
  return {
    w, $, press, log, get socket() { return socket; },
    join: async (code, name) => {
      $('roomInput').value = code; $('nameInput').value = name; $('joinBtn').click();
      await until(() => !$('participantPanel').classList.contains('hidden'), 8000, 'join ' + name);
    },
    closeOptions: () => $('optionsClose').click(),
    isGo: () => $('stimulus').classList.contains('go'),
    keyRepeat: () => { const e = new w.KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true, cancelable: true }); w.document.dispatchEvent(e); }
  };
}

test('参加者画面の実コード: 通常入力/早押し/タイムアウト/非表示/切断再接続/送信確認（実時間約20秒）', async () => {
  const s = await startServer();
  const devices = [];
  let host;
  try {
    host = await newHost(s.url);
    await host.call('host:update-settings', { trials: 2, minWaitSeconds: 0.5, maxWaitSeconds: 0.5 });
    const code = host.room.roomCode;
    const A = makeDevice(s.url), B = makeDevice(s.url), C = makeDevice(s.url), D = makeDevice(s.url);
    devices.push(A, B, C, D);
    await A.join(code, 'A-key'); await B.join(code, 'B-touch'); await C.join(code, 'C-hidden'); await D.join(code, 'D-reconnect');
    [A, B, C, D].forEach(d => d.closeOptions());   // オプションを閉じると測定入力が有効になる
    assert.ok(A.w.localStorage.getItem('rt_participant_session'));

    await host.call('host:start-measurement', {});

    // ---- 第1試行: A=キーボード正常 / B=タッチ正常 / C=待機中にタブ非表示 / D=待機中に切断→再接続
    await until(() => /切り替わりを待っています/.test(A.$('trialInfo').textContent), 8000, 'A waiting t1');
    await sleep(300);
    // C: 非表示化
    Object.defineProperty(C.w.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    C.w.document.dispatchEvent(new C.w.Event('visibilitychange'));
    // D: 切断
    D.socket.disconnect();
    await until(() => D.$('connectionState').textContent === '切断', 3000, 'D disconnected');
    D.socket.connect();
    await until(() => D.$('connectionState').textContent === '接続中', 5000, 'D reconnected');
    // 切り替わり(赤)を待って反応
    await until(() => A.isGo() && B.isGo(), 8000, 'A,B go');
    await sleep(40);
    A.press('keyboard'); A.keyRepeat(); A.keyRepeat();          // キーリピートは無視される
    await sleep(15);
    B.press('touch'); B.press('touch');                          // 二重入力は最初のみ
    await until(() => /記録しました/.test(A.$('trialInfo').textContent), 3000, 'A recorded');
    assert.match(A.$('lastResult').textContent, /ms/);
    // ---- 第2試行: A=早押し / B=無入力(タイムアウト) / C=復帰して通常入力 / D=通常入力
    Object.defineProperty(C.w.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await until(() => /第2回：切り替わりを待っています/.test(A.$('trialInfo').textContent), 12000, 'A waiting t2');
    A.press('keyboard');                                          // 赤になる前 → 早押し
    await until(() => /早押し/.test(A.$('trialInfo').textContent), 2000, 'A early');
    assert.ok(!A.$('stimulusMessage').classList.contains('hidden'), '早押しが一時表示される');
    await until(() => C.isGo() && D.isGo(), 8000, 'C,D go');
    await sleep(30); C.press('keyboard'); D.press('mouse');
    // B は何も入力しない → 3秒後にタイムアウトとして記録される（表示は直後の送信メッセージで上書きされるため、最終的なDB記録で検証する）

    // ---- 終了 → 自動送信 → 送信完了表示
    for (const d of [A, B, C, D]) await until(() => /送信完了/.test(d.$('uploadStatus').textContent), 25000, 'upload done');
    assert.equal(A.$('savedCount').textContent, '2');

    // ---- サーバー側の記録を検証
    const res = await host.call('host:get-results', { limit: 100 });
    const by = {}; for (const r of res.rows) (by[r.participantName] ||= {})[r.trialNumber] = r;
    assert.equal(res.count, 8, '4台×2試行 = 8件（欠落なし・重複なし）');
    const a1 = by['A-key'][1], a2 = by['A-key'][2];
    assert.equal(a1.status, 'recorded'); assert.equal(a1.inputType, 'keyboard');
    assert.ok(a1.reactionTimeMs >= 0 && a1.reactionTimeMs < 1000, 'RT=' + a1.reactionTimeMs);
    assert.equal(a2.status, 'invalid'); assert.equal(a2.reason, 'early'); assert.equal(a2.inputType, 'keyboard');
    assert.equal(by['B-touch'][1].inputType, 'touch'); assert.equal(by['B-touch'][1].status, 'recorded');
    assert.equal(by['B-touch'][2].reason, 'timeout');
    assert.equal(by['C-hidden'][1].reason, 'hidden');
    assert.equal(by['C-hidden'][2].status, 'recorded');
    assert.equal(by['D-reconnect'][1].reason, 'disconnected');
    const dump = JSON.stringify(Object.values(by['D-reconnect']).map(r => [r.trialNumber, r.status, r.reason, r.inputType, r.reactionTimeMs, r.frameDelayMs]));
    assert.equal(by['D-reconnect'][2].inputType, 'mouse', 'D rows=' + dump + ' events=' + JSON.stringify(D.log));
    // 研究用の付帯情報
    for (const k of ['scheduledTime', 'localChangeTime', 'inputTime', 'clockOffsetMs', 'rttMs', 'syncQuality', 'frameDelayMs']) assert.ok(a1[k] !== null && a1[k] !== undefined, k);
    assert.ok(a1.inputTime > a1.localChangeTime, '入力時刻は切替時刻より後');
    assert.ok(Math.abs((a1.inputTime - a1.localChangeTime) - a1.reactionTimeMs) < 2, '反応時間=入力時刻-切替時刻');
    assert.ok(Math.abs(a1.localChangeTime + a1.clockOffsetMs - a1.scheduledTime) < 100, `切替は予定時刻付近(±100ms): diff=${a1.localChangeTime + a1.clockOffsetMs - a1.scheduledTime}`);
    assert.equal(a1.os, 'ChromeOS'); assert.match(a1.browser, /^Chrome 130/); assert.match(a1.device, /^chromebook/);
    assert.equal(by['A-key'][1].visibilityState, 'visible');
    assert.ok(['good', 'fair', 'poor'].includes(a1.syncQuality));
  } finally {
    devices.forEach(d => { try { d.socket?.close(); d.w.close(); } catch (_) { /* ignore */ } });
    host?.close(); await s.stop();
  }
});

test('参加者ごとのIndexedDBが分離され、同じ端末内でも混ざらない', async () => {
  const s = await startServer();
  const devs = []; let host;
  try {
    host = await newHost(s.url);
    const listDbs = async () => (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('reactionTestParticipant_'));
    const before = new Set(await listDbs());
    const A = makeDevice(s.url), B = makeDevice(s.url); devs.push(A, B);
    await A.join(host.room.roomCode, 'iso-A'); await B.join(host.room.roomCode, 'iso-B');
    const added = (await listDbs()).filter(n => !before.has(n));
    assert.equal(added.length, 2, '参加者ごとに別々のIndexedDBが作られる');
    const idOf = d => JSON.parse(d.w.localStorage.getItem('rt_participant_session')).participantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    assert.deepEqual(new Set(added), new Set([`reactionTestParticipant_${idOf(A)}`, `reactionTestParticipant_${idOf(B)}`]));
  } finally { devs.forEach(d => { try { d.socket?.close(); d.w.close(); } catch (_) {} }); host?.close(); await s.stop(); }
});
