'use strict';
// ホスト画面の実コード(frontend/js/host.js)を jsdom で動かし、実サーバーと接続して表示を検証する（実ブラウザではない）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { io: ioClient } = require('socket.io-client');
const { startServer, newParticipant, row } = require('./helpers');
const FRONT = path.join(__dirname, '..', 'frontend');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(10); } throw new Error('timeout: ' + label); }

test('ホスト画面: 参加上限はサーバーの実際の値を表示 / 集計表示 / 参加者一覧', async () => {
  for (const limit of ['10', '37']) {
    const s = await startServer({ env: { MAX_PARTICIPANTS: limit } });
    const html = fs.readFileSync(path.join(FRONT, 'host.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
    assert.ok(!/\/\s*100\s*台/.test(html), 'HTMLに固定の「100台」が書かれていない');
    const dom = new JSDOM(html, { url: s.url + '/host', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; let sock;
    w.fetch = (u, o) => fetch(new URL(u, s.url), o);
    w.io = () => (sock = ioClient(s.url, { transports: ['websocket'], forceNew: true }));
    w.eval(fs.readFileSync(path.join(FRONT, 'js', 'host.js'), 'utf8'));
    const $ = id => w.document.getElementById(id);
    const clients = [];
    try {
      await until(() => sock && sock.connected, 5000, 'connect');
      $('createRoomBtn').click();
      await until(() => !$('roomPanel').classList.contains('hidden'), 5000, 'room shown');
      const code = $('roomCode').textContent; assert.match(code, /^\d{6}$/);
      assert.equal($('participantCount').textContent, `参加者数：0 / ${limit} 台`);
      const p = await newParticipant(s.url, code, '<b>x</b>'); clients.push(p);
      await until(() => $('participantCount').textContent === `参加者数：1 / ${limit} 台`, 4000, 'count updated');
      assert.ok(!$('participantsBody').innerHTML.includes('<b>'), '参加者名がHTMLとして解釈されない');
      assert.ok($('participantsBody').textContent.includes('<b>x</b>'));
      // 結果を送って集計を更新
      $('startBtn').click(); await until(() => /測定中/.test($('roomState').textContent), 4000, 'measuring');
      await until(() => p.events.some(e => e.name === 'trial:scheduled'), 6000, 'trial');
      await p.call('participant:submit-results', { rows: [row(p.p, 1, { reactionTimeMs: 300 })] });
      $('fetchResultsBtn').click();
      await until(() => $('validCount').textContent === '1', 4000, 'stats');
      assert.equal($('avgRt').textContent, '300.00 ms'); assert.equal($('medianRt').textContent, '300.00 ms');
      assert.equal($('minRt').textContent, '300.00 ms'); assert.equal($('maxRt').textContent, '300.00 ms'); assert.equal($('sdRt').textContent, '0.00 ms');
      assert.ok($('participantStatsBody').textContent.includes('<b>x</b>'));
      assert.ok($('inputStatsBody').textContent.includes('keyboard'));
      assert.ok($('resultsBody').textContent.includes('300.000'));
      // ホストのリロード相当: トークンで再接続できる
      assert.ok(w.localStorage.getItem('rt_host_token'));
    } finally { clients.forEach(c => c.close()); sock?.close(); w.close(); await s.stop(); }
  }
});
