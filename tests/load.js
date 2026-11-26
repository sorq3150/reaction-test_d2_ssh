'use strict';
// 負荷試験: node tests/load.js 10 30 50 100
// 実サーバーを子プロセスで起動し、N台の疑似参加者(socket.io-client)が参加→測定(各端末内で記録)→結果一括送信を行う。
// 注意: 同一マシンのループバック通信であり、Renderの実環境・実際の端末性能・Wi-Fi品質は反映しない。
const fs = require('fs');
const { startServer, connect, row } = require('./helpers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRIALS = Number(process.env.LOAD_TRIALS || 3);

function cpuSeconds(pid) {
  const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return (Number(f[11]) + Number(f[12])) / 100;
}
const rssMB = pid => Number((fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [0, 0])[1]) / 1024;

async function runOnce(n) {
  const s = await startServer({ env: { MAX_PARTICIPANTS: '300', MAX_CONN_PER_IP: '1000' } });
  const cpu0 = cpuSeconds(s.child.pid), rss0 = rssMB(s.child.pid);
  const out = { participants: n, trials: TRIALS };
  const host = connect(s.url); await host.ready;
  const created = await host.call('host:create-room', {});
  const code = created.room.roomCode;
  await host.call('host:update-settings', { trials: TRIALS, minWaitSeconds: 0.5, maxWaitSeconds: 0.5 });
  let roomUpdates = 0; host.socket.on('room:update', () => roomUpdates++);

  // 参加（一斉）
  const t0 = Date.now();
  const clients = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const c = connect(s.url); await c.ready;
    const r = await c.call('participant:join', { roomCode: code, name: 'P' + String(i).padStart(3, '0') });
    if (!r.ok) throw new Error('join failed: ' + JSON.stringify(r));
    c.p = r.participant; c.rows = []; c.scheduledEvents = 0;
    c.socket.on('trial:scheduled', d => {            // 端末内で記録（測定中はサーバーへ送信しない）
      c.scheduledEvents++;
      setTimeout(() => c.rows.push(row(c.p, d.trialNumber, { reactionTimeMs: 200 + Math.random() * 100 })), 0);
    });
    return c;
  }));
  out.joinAllMs = Date.now() - t0;
  const joinedOk = (await host.call('host:get-stats', {})).ok;

  const peakRss = { v: rss0 }; const iv = setInterval(() => { peakRss.v = Math.max(peakRss.v, rssMB(s.child.pid)); }, 100);
  const eventsBefore = clients.reduce((a, c) => a + c.events.length, 0);
  const tm = Date.now();
  await host.call('host:start-measurement', {});
  const finished = host.waitFor('session:finished', 60000);
  await finished;
  out.measureMs = Date.now() - tm;
  await sleep(200);
  out.msgsPerParticipantDuringMeasurement = Number(((clients.reduce((a, c) => a + c.events.length, 0) - eventsBefore) / n).toFixed(1));
  out.resultSubmitsDuringMeasurement = 0; // 測定中に結果送信イベントを使っていない（下の一括送信は終了後）

  // 終了後に一括送信（全員同時）
  const tu = Date.now(); const lat = [];
  await Promise.all(clients.map(async c => {
    for (let i = 0; i < c.rows.length; i += 100) {
      const a = Date.now(); const r = await c.call('participant:submit-results', { rows: c.rows.slice(i, i + 100) }); lat.push(Date.now() - a);
      if (!r.ok || r.rejected) throw new Error('submit failed ' + JSON.stringify(r));
    }
  }));
  out.uploadAllMs = Date.now() - tu;
  lat.sort((a, b) => a - b);
  out.ackLatencyMs = { p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)], max: lat[lat.length - 1] };
  // 再送しても二重登録されない
  const dup = await clients[0].call('participant:submit-results', { rows: clients[0].rows });
  out.resendDuplicates = dup.duplicates;
  await sleep(700);
  const res = await host.call('host:get-results', { limit: 2000 });
  out.storedRows = res.count; out.expectedRows = n * TRIALS;
  const st = await host.call('host:get-stats', {}); out.statsValid = st.stats.overall.valid;
  const tx = Date.now(); const csv = await fetch(`${s.url}/api/export/csv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: created.hostToken }) });
  const csvBytes = (await csv.arrayBuffer()).byteLength; out.csvMs = Date.now() - tx; out.csvKB = Math.round(csvBytes / 1024);
  const tw = Date.now(); const xl = await fetch(`${s.url}/api/export/xlsx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: created.hostToken }) });
  const xlBytes = (await xl.arrayBuffer()).byteLength; out.xlsxMs = Date.now() - tw; out.xlsxKB = Math.round(xlBytes / 1024);
  clearInterval(iv);
  out.hostRoomUpdates = roomUpdates;
  out.cpuSec = Number((cpuSeconds(s.child.pid) - cpu0).toFixed(2));
  out.rssMB = { start: Math.round(rss0), peak: Math.round(peakRss.v), end: Math.round(rssMB(s.child.pid)) };
  const lg = s.getLog();
  out.serverErrors = (lg.match(/error|Error/g) || []).length;
  out.ok = joinedOk && out.storedRows === out.expectedRows && out.resendDuplicates === clients[0].rows.length;
  clients.forEach(c => c.close()); host.close(); await s.stop();
  return out;
}

(async () => {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const all = [];
  for (const n of (sizes.length ? sizes : [1, 10, 30, 50, 100])) {
    try { const r = await runOnce(n); all.push(r); console.log(JSON.stringify(r)); }
    catch (e) { console.log(JSON.stringify({ participants: n, ok: false, error: e.message })); }
  }
  const bad = all.filter(r => !r.ok).length;
  process.exit(bad ? 1 : 0);
})();
