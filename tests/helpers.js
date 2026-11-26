'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { io } = require('socket.io-client');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function startServer({ env = {}, dbPath } = {}) {
  const port = await freePort();
  const dir = dbPath ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
  const db = dbPath || path.join(dir, 'test.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: db, MAX_PARTICIPANTS: '10', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url + '/health'); if (r.ok) break; } catch (_) { /* wait */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    url, port, db, child, getLog: () => log,
    stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); }),
    kill: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); })
  };
}

function connect(url) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  const events = [];
  socket.onAny((name, data) => events.push({ name, data, at: Date.now() }));
  const ready = new Promise((resolve, reject) => { socket.on('connect', () => resolve()); socket.on('connect_error', reject); });
  const call = (event, payload) => new Promise(resolve => {
    const t = setTimeout(() => resolve({ timeout: true }), 5000);
    socket.emit(event, payload, r => { clearTimeout(t); resolve(r); });
  });
  const waitFor = (name, ms = 15000) => new Promise((resolve, reject) => {
    const hit = events.find(e => e.name === name && !e.used);
    if (hit) { hit.used = true; return resolve(hit.data); }
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + name)), ms);
    const h = data => { clearTimeout(t); const e = events.find(x => x.name === name && !x.used); if (e) e.used = true; resolve(data); };
    socket.once(name, h);
  });
  return { socket, events, ready, call, waitFor, close: () => socket.close() };
}

async function newHost(url) { const c = connect(url); await c.ready; const r = await c.call('host:create-room', {}); return { ...c, room: r.room, hostToken: r.hostToken, create: r }; }
async function newParticipant(url, roomCode, name) { const c = connect(url); await c.ready; const r = await c.call('participant:join', { roomCode, name }); return { ...c, join: r, p: r.participant }; }

function row(p, trial, extra = {}) {
  return { recordId: `${p.participantId}:1:${trial}`, participantId: p.participantId, run: 1, trialNumber: trial,
    status: 'recorded', reactionTimeMs: 250 + trial, inputType: 'keyboard', createdAt: new Date().toISOString(),
    visibilityState: 'visible', clockOffsetMs: 3.2, rttMs: 20, syncQuality: 'good', frameDelayMs: 4,
    scheduledTime: Date.now(), localChangeTime: Date.now(), inputTime: Date.now(), browser: 'Chrome 1', os: 'ChromeOS', device: 'chromebook', ...extra };
}
module.exports = { startServer, connect, newHost, newParticipant, row, freePort };
