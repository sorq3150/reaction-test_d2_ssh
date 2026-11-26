'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { randomInt, randomUUID, randomBytes, createHash, timingSafeEqual } = require('crypto');
const { openDatabase } = require('./db');
const { computeStats, streamCsv, streamXlsx } = require('./exporter');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- 設定
function intEnv(name, def, min, max) {
  const n = Number.parseInt(process.env[name] || String(def), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
const requestedLimit = Number.parseInt(process.env.MAX_PARTICIPANTS || '100', 10);
const MAX_PARTICIPANTS = Number.isFinite(requestedLimit) ? Math.max(10, Math.min(300, requestedLimit)) : 100;
if (process.env.MAX_PARTICIPANTS && String(requestedLimit) !== String(MAX_PARTICIPANTS)) {
  console.warn(`MAX_PARTICIPANTS=${process.env.MAX_PARTICIPANTS} は範囲外/不正のため ${MAX_PARTICIPANTS} に補正しました（有効範囲 10〜300）。`);
}
const MAX_ACTIVE_ROOMS = intEnv('MAX_ROOMS', 100, 1, 1000);
const MAX_CONNECTIONS = intEnv('MAX_CONNECTIONS', 1500, 10, 10000);
const MAX_CONN_PER_IP = intEnv('MAX_CONN_PER_IP', 600, 10, 10000); // 学校のNATで多数端末が同一IPになるため大きめ
const MEM_WARN_MB = intEnv('MEM_WARN_MB', 400, 64, 65536);
const MAX_UPLOAD_ROWS = 100;
const MAX_RESULT_PAGE = 2000;
const BEHIND_PROXY = process.env.TRUST_PROXY ? ['1', 'true'].includes(process.env.TRUST_PROXY) : Boolean(process.env.RENDER);
const EXTRA_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'reaction-test.sqlite');
const db = openDatabase(dbPath);

// ---------------------------------------------------------------- ユーティリティ
const hashToken = v => 'h1:' + createHash('sha256').update(String(v)).digest('hex');
const newToken = () => randomBytes(32).toString('hex');
const cleanName = value => String(value || '').trim().normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
function tokenMatches(plain, storedHash) {
  if (typeof plain !== 'string' || plain.length < 16 || plain.length > 200 || !storedHash) return false;
  const a = Buffer.from(hashToken(plain)), b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
function num(v, min, max, dp = 3) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  const f = 10 ** dp; return Math.round(n * f) / f;
}
function clientIp(req) {
  if (BEHIND_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    // Render のプロキシが付与する最後の要素のみ信頼する（クライアントが前に偽装値を足せるため）
    if (xff) { const parts = String(xff).split(','); return parts[parts.length - 1].trim(); }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// 固定窓カウンタ（メモリ上）。check() は数えず、hit() で数える。
class WindowLimiter {
  constructor(windowMs, max) { this.windowMs = windowMs; this.max = max; this.map = new Map(); }
  entry(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.map.set(key, e); }
    return e;
  }
  blocked(key) { return this.entry(key).count >= this.max; }
  hit(key) { const e = this.entry(key); e.count++; return e.count <= this.max; }
  prune() { const now = Date.now(); for (const [k, e] of this.map) if (now - e.start >= this.windowMs) this.map.delete(k); }
}
const failedJoinLimiter = new WindowLimiter(60000, 40);  // 部屋番号の総当たり対策（失敗のみカウント）
const authFailLimiter = new WindowLimiter(60000, 30);    // トークン照合の失敗
const createRoomLimiter = new WindowLimiter(60000, 20);
const exportLimiter = new WindowLimiter(60000, 12);
setInterval(() => [failedJoinLimiter, authFailLimiter, createRoomLimiter, exportLimiter].forEach(l => l.prune()), 60000).unref();

// ---------------------------------------------------------------- 状態
const rooms = new Map();         // roomCode -> room
const hostIndex = new Map();     // hostTokenHash -> room
const socketRoles = new Map();   // socket.id -> {type, roomCode, participantId}
const ipConnections = new Map();
const resultsTimers = new Map();
const activeRoomCount = () => { let n = 0; for (const r of rooms.values()) if (!r.closed) n++; return n; };
function roomByHostToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
  return hostIndex.get(hashToken(token)) || null;
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
if (BEHIND_PROXY) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'], objectSrc: ["'none'"], baseUri: ["'self'"],
      frameAncestors: ["'none'"], formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
const FRONTEND = path.join(__dirname, '../frontend');
app.use(express.static(FRONTEND, { index: 'index.html', dotfiles: 'ignore' }));
app.get('/host', (_req, res) => res.sendFile(path.join(FRONTEND, 'host.html')));
app.get('/participant', (_req, res) => res.sendFile(path.join(FRONTEND, 'participant.html')));

const mb = n => Math.round(n / 1048576);
app.get('/health', (_req, res) => {
  const m = process.memoryUsage();
  res.json({
    ok: true, service: 'reaction-test', version: VERSION, maxParticipants: MAX_PARTICIPANTS,
    uptimeSec: Math.round(process.uptime()), activeRooms: activeRoomCount(),
    connections: io.engine.clientsCount, memory: { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed) }
  });
});
app.get('/config', (_req, res) => res.json({ maxParticipants: MAX_PARTICIPANTS }));

// 結果出力: ホストトークンは Cookie ではなく本文で送る（CSRF の対象にならない）。URLにも含めない。
app.post('/api/export/:format', express.json({ limit: '2kb' }), async (req, res) => {
  const ip = clientIp(req);
  res.set('Cache-Control', 'no-store');
  if (!exportLimiter.hit(ip) || authFailLimiter.blocked(ip)) return res.status(429).json({ ok: false, error: '出力要求が多すぎます。少し待ってください。' });
  const format = req.params.format;
  if (format !== 'csv' && format !== 'xlsx') return res.status(404).json({ ok: false, error: '不明な形式です。' });
  const room = roomByHostToken(req.body && req.body.hostToken);
  if (!room) { authFailLimiter.hit(ip); return res.status(403).json({ ok: false, error: 'ホスト権限がありません。' }); }
  try {
    const name = `reaction-results-${room.code}`;
    if (format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
      streamCsv(db, room.code, res);
    } else {
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"` });
      await streamXlsx(db, room.code, res);
    }
  } catch (error) {
    console.error('export failed', error.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: '出力に失敗しました。' }); else res.destroy();
  }
});
app.use((err, _req, res, next) => { // 不正なJSONなど
  if (res.headersSent) return next(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: '不正なリクエストです。' });
});

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000, pingTimeout: 20000,
  maxHttpBufferSize: 256 * 1024, perMessageDeflate: false, httpCompression: false,
  transports: ['websocket', 'polling'],
  // 他サイトのページからの接続を拒否（Origin ヘッダが無い非ブラウザは許可）
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true);
    try {
      const host = new URL(origin).host;
      return cb(null, host === req.headers.host || host === req.headers['x-forwarded-host'] || EXTRA_ORIGINS.includes(origin));
    } catch (_) { return cb(null, false); }
  }
});

// ---------------------------------------------------------------- DB 文
const insertResult = db.prepare(`INSERT OR IGNORE INTO results
  (record_id, room_code, participant_id, created_at, data_json, trial_number, run_number, status, reaction_time_ms, input_type, reason, participant_name, received_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const countResults = db.prepare('SELECT COUNT(*) AS count FROM results WHERE room_code = ?');
const countParticipantResults = db.prepare('SELECT COUNT(*) AS count FROM results WHERE room_code = ? AND participant_id = ?');
const countParticipantRun = db.prepare('SELECT COUNT(*) AS count FROM results WHERE room_code = ? AND participant_id = ? AND run_number = ?');
const pageResults = db.prepare('SELECT rowid AS rid, data_json FROM results WHERE room_code = ? AND rowid > ? ORDER BY rowid LIMIT ?');
const findRoom = db.prepare('SELECT room_code FROM sessions WHERE room_code = ?');
const saveSession = db.prepare(`INSERT INTO sessions(room_code,host_token,status,created_at,settings_json,trial_number,participants_json,closed,run_number)
VALUES (@code,@hostToken,@status,@createdAt,@settings,@trialNumber,@participants,@closed,@run)
ON CONFLICT(room_code) DO UPDATE SET host_token=excluded.host_token,status=excluded.status,settings_json=excluded.settings_json,trial_number=excluded.trial_number,participants_json=excluded.participants_json,closed=excluded.closed,run_number=excluded.run_number`);

// ---------------------------------------------------------------- 永続化（頻繁な書き込みはまとめる）
function saveRoomNow(room) {
  saveSession.run({
    code: room.code, hostToken: room.hostTokenHash, status: room.status,
    createdAt: room.createdAt, settings: JSON.stringify(room.settings),
    trialNumber: room.trialNumber, run: room.run,
    participants: JSON.stringify([...room.participants.values()].map(p => ({
      id: p.id, tokenHash: p.tokenHash, name: p.name,
      joinedDuringSession: !!p.joinedDuringSession, completed: !!p.completed,
      uploadedCount: p.uploadedCount || 0, firstTrial: p.firstTrial || 1, lastTrial: p.lastTrial || room.settings.trials
    }))),
    closed: room.closed ? 1 : 0
  });
}
const dirtyRooms = new Set();
let persistTimer = null;
function flushPersist() {
  persistTimer = null;
  for (const r of dirtyRooms) { try { saveRoomNow(r); } catch (e) { console.error('persist failed', r.code, e.message); } }
  dirtyRooms.clear();
}
function persistRoom(room, immediate = false) {
  if (immediate) { dirtyRooms.delete(room); saveRoomNow(room); return; }
  dirtyRooms.add(room);
  if (!persistTimer) persistTimer = setTimeout(flushPersist, 250);
}

function publicRoom(room) {
  return {
    roomCode: room.code, status: room.status, settings: room.settings, run: room.run,
    trialNumber: room.trialNumber, maxParticipants: MAX_PARTICIPANTS,
    participants: [...room.participants.values()].map(p => ({
      participantId: p.id, name: p.name, connected: !!p.socketId,
      joinedDuringSession: !!p.joinedDuringSession, completed: !!p.completed,
      uploadedCount: p.uploadedCount || 0, firstTrial: p.firstTrial, lastTrial: p.lastTrial
    }))
  };
}
// ホストへの更新通知は 250ms ごとにまとめる（大量参加時の通信量を抑える）
function emitRoom(room) {
  if (!room.hostSocketId || room.emitTimer) return;
  room.emitTimer = setTimeout(() => {
    room.emitTimer = null;
    if (room.hostSocketId) io.to(room.hostSocketId).emit('room:update', publicRoom(room));
  }, 250);
}
function emitRoomNow(room) {
  clearTimeout(room.emitTimer); room.emitTimer = null;
  if (room.hostSocketId) io.to(room.hostSocketId).emit('room:update', publicRoom(room));
}
function notifyResults(room) {
  if (!room.hostSocketId || resultsTimers.has(room.code)) return;
  resultsTimers.set(room.code, setTimeout(() => {
    resultsTimers.delete(room.code);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('results:updated', { count: countResults.get(room.code).count });
  }, 500));
}

function roleRoom(socket, role) {
  const info = socketRoles.get(socket.id);
  return info?.type === role ? rooms.get(info.roomCode) : null;
}
function participantOf(socket) {
  const info = socketRoles.get(socket.id);
  const room = info?.type === 'participant' ? rooms.get(info.roomCode) : null;
  return { room, participant: room?.participants.get(info?.participantId) };
}
function makeCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    if (!rooms.has(code) && !findRoom.get(code)) return code;
  }
  throw new Error('部屋番号を発行できません。');
}
function attach(socket, room, role, participantId = null) {
  socket.join(`room:${room.code}`);
  socketRoles.set(socket.id, { type: role, roomCode: room.code, participantId });
  if (role === 'host') room.hostSocketId = socket.id;
}

// ---------------------------------------------------------------- 測定進行
function maxLastTrial(room) {
  let max = room.settings.trials;
  for (const p of room.participants.values()) if (p.lastTrial > max) max = p.lastTrial;
  return max;
}
function finishRoom(room) {
  clearTimeout(room.nextTimer);
  room.status = 'finished'; room.currentTrial = null;
  persistRoom(room, true);
  io.to(`room:${room.code}`).emit('session:finished', { run: room.run, trialNumber: room.trialNumber });
  emitRoomNow(room);
}
function scheduleTrial(room) {
  if (room.status !== 'measuring') return;
  // 途中参加者の最終試行まで進める（途中参加者にも設定回数を確保）。測定を終えた参加者には追加試行を送らない。
  if (room.trialNumber >= maxLastTrial(room)) return finishRoom(room);
  room.trialNumber += 1;
  const n = room.trialNumber;
  const delay = randomInt(room.settings.minWaitMs, room.settings.maxWaitMs + 1);
  const scheduledAt = Date.now() + delay + 2500; // 全端末共通の予定時刻
  room.currentTrial = { number: n, scheduledAt };
  const ids = [];
  for (const p of room.participants.values()) if (p.socketId && n >= p.firstTrial && n <= p.lastTrial) ids.push(p.socketId);
  if (ids.length) io.to(ids).emit('trial:scheduled', { run: room.run, trialNumber: n, scheduledAt, serverSentAt: Date.now() });
  persistRoom(room); emitRoom(room);
  clearTimeout(room.nextTimer);
  // 予定時刻 + 3秒(タイムアウト) + 1.5秒(端末側の記録のための余裕)
  room.nextTimer = setTimeout(() => scheduleTrial(room), delay + 2500 + 3000 + 1500);
}

function normalizeRow(raw, room, p) {
  if (!isObj(raw) || raw.participantId !== p.id) return null;
  const run = raw.run == null ? room.run : Number(raw.run);
  const trial = Number(raw.trialNumber);
  if (!Number.isInteger(run) || run < 1 || run > room.run) return null;
  if (!Number.isInteger(trial) || trial < 1 || trial > 100000) return null;
  if (run === room.run && (trial > room.trialNumber || trial < p.firstTrial || trial > p.lastTrial)) return null;
  const status = raw.status === 'recorded' ? 'recorded' : 'invalid';
  const rt = num(raw.reactionTimeMs, 0, 60000, 3);
  if (status === 'recorded' && rt === null) return null;
  const epoch = v => num(v, 0, 4102444800000, 1);
  return {
    recordId: `${p.id}:${run}:${trial}`, clientRecordId: str(raw.recordId, 100),
    roomCode: room.code, participantId: p.id, participantName: p.name, run, trialNumber: trial,
    reactionTimeMs: status === 'recorded' ? rt : null,
    inputType: str(raw.inputType || 'unknown', 24), status,
    reason: status === 'recorded' ? '' : str(raw.reason || 'unknown', 48),
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? str(raw.createdAt, 40) : new Date().toISOString(),
    visibilityState: str(raw.visibilityState || 'unknown', 24),
    scheduledTime: epoch(raw.scheduledTime), localChangeTime: epoch(raw.localChangeTime), inputTime: epoch(raw.inputTime),
    clockOffsetMs: num(raw.clockOffsetMs, -1e9, 1e9, 3), rttMs: num(raw.rttMs, 0, 1e6, 3),
    syncQuality: str(raw.syncQuality || '', 12), frameDelayMs: num(raw.frameDelayMs, -1e5, 1e6, 3),
    browser: str(raw.browser, 64), os: str(raw.os, 64), device: str(raw.device, 64)
  };
}

// ---------------------------------------------------------------- 起動時の復元
// 測定中だった部屋は安全のため自動再開せず「一時停止」で復元する。
for (const saved of db.prepare('SELECT * FROM sessions').all()) {
  try {
    const settings = JSON.parse(saved.settings_json);
    const room = {
      code: saved.room_code, hostSocketId: null, emitTimer: null, nextTimer: null, currentTrial: null,
      hostTokenHash: saved.host_token.startsWith('h1:') ? saved.host_token : hashToken(saved.host_token), // 旧版の平文トークンはここでハッシュ化
      status: saved.closed ? 'closed' : (saved.status === 'measuring' ? 'paused' : saved.status),
      closed: !!saved.closed, createdAt: saved.created_at, participants: new Map(),
      settings, trialNumber: saved.trial_number, run: saved.run_number || (saved.trial_number > 0 ? 1 : 0)
    };
    for (const p of JSON.parse(saved.participants_json || '[]')) {
      room.participants.set(p.id, {
        id: p.id, name: p.name, socketId: null,
        tokenHash: p.tokenHash || hashToken(p.token || ''),
        joinedDuringSession: !!p.joinedDuringSession, completed: !!p.completed, uploadedCount: p.uploadedCount || 0,
        firstTrial: p.firstTrial || 1, lastTrial: p.lastTrial || settings.trials
      });
    }
    for (const row of db.prepare('SELECT participant_id, COUNT(*) AS count FROM results WHERE room_code=? GROUP BY participant_id').all(room.code)) {
      const p = room.participants.get(row.participant_id); if (p) p.uploadedCount = row.count;
    }
    rooms.set(room.code, room); hostIndex.set(room.hostTokenHash, room);
    saveRoomNow(room);
  } catch (error) { console.error('Could not restore room', saved.room_code, error.message); }
}

// ---------------------------------------------------------------- Socket.IO
io.use((socket, next) => {
  const ip = clientIp(socket.request);
  socket.data.ip = ip;
  if (io.engine.clientsCount > MAX_CONNECTIONS) return next(new Error('server busy'));
  if ((ipConnections.get(ip) || 0) >= MAX_CONN_PER_IP) return next(new Error('too many connections'));
  ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
  next();
});

// すべてのイベントを同じ安全な枠で処理する。不正な payload / ack があってもプロセスを落とさず、
// 端末ごとのイベント頻度（トークンバケット）も制限する。
function on(socket, event, handler) {
  socket.on(event, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const reply = result => { if (ack) { try { ack(result); } catch (_) { /* ignore */ } } };
    const b = socket.data.bucket, now = Date.now();
    b.tokens = Math.min(40, b.tokens + (now - b.at) / 1000 * 20); b.at = now;
    if (b.tokens < 1) {
      if (++b.violations > 300) socket.disconnect(true);
      return reply({ ok: false, error: '操作が多すぎます。少し待ってから再試行してください。' });
    }
    b.tokens -= 1;
    try { handler(isObj(args[0]) ? args[0] : {}, reply); }
    catch (error) { console.error(`handler error [${event}]`, error); reply({ ok: false, error: 'サーバーエラーが発生しました。' }); }
  });
}

io.on('connection', socket => {
  socket.data.bucket = { tokens: 40, at: Date.now(), violations: 0 };

  on(socket, 'clock:ping', (_d, reply) => reply({ serverTime: Date.now() }));

  on(socket, 'host:create-room', (_d, reply) => {
    if (!createRoomLimiter.hit(socket.data.ip)) return reply({ ok: false, error: '部屋の作成が多すぎます。少し待ってください。' });
    if (activeRoomCount() >= MAX_ACTIVE_ROOMS) return reply({ ok: false, error: `同時に開ける部屋は${MAX_ACTIVE_ROOMS}までです。` });
    const code = makeCode();
    const hostToken = newToken();
    const room = {
      code, hostTokenHash: hashToken(hostToken), hostSocketId: null, emitTimer: null, status: 'waiting', closed: false,
      createdAt: Date.now(), participants: new Map(), settings: { trials: 10, minWaitMs: 1000, maxWaitMs: 3000 },
      trialNumber: 0, run: 0, nextTimer: null, currentTrial: null
    };
    rooms.set(code, room); hostIndex.set(room.hostTokenHash, room);
    persistRoom(room, true); attach(socket, room, 'host');
    reply({ ok: true, hostToken, room: publicRoom(room), maxParticipants: MAX_PARTICIPANTS });
  });

  on(socket, 'host:reconnect', ({ hostToken }, reply) => {
    if (authFailLimiter.blocked(socket.data.ip)) return reply({ ok: false, error: '試行回数が多すぎます。少し待ってください。' });
    const room = roomByHostToken(hostToken);
    if (!room) { authFailLimiter.hit(socket.data.ip); return reply({ ok: false, error: 'ホスト情報が見つかりません。' }); }
    if (room.hostSocketId && room.hostSocketId !== socket.id) io.sockets.sockets.get(room.hostSocketId)?.disconnect(true);
    attach(socket, room, 'host');
    reply({ ok: true, room: publicRoom(room), maxParticipants: MAX_PARTICIPANTS });
  });

  on(socket, 'participant:join', ({ roomCode, name }, reply) => {
    const ip = socket.data.ip;
    if (failedJoinLimiter.blocked(ip)) return reply({ ok: false, error: '接続要求が多すぎます。少し待ってから再試行してください。' });
    const fail = error => { failedJoinLimiter.hit(ip); return reply({ ok: false, error }); };
    const code = String(roomCode == null ? '' : roomCode).trim();
    const participantName = cleanName(name);
    const room = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !room || room.closed) return fail('部屋番号を確認してください。');
    if (!participantName || participantName.length > 24) return reply({ ok: false, error: '参加者名は1〜24文字で入力してください。' });
    if (room.participants.size >= MAX_PARTICIPANTS) return reply({ ok: false, error: `参加上限の${MAX_PARTICIPANTS}台に達しています。` });
    const lower = participantName.toLocaleLowerCase();
    for (const q of room.participants.values()) if (q.name.toLocaleLowerCase() === lower) return reply({ ok: false, error: '同じ参加者名が登録済みです。' });
    // 途中参加: 進行中の試行には参加せず、次の試行から設定回数ぶん測定する
    const inProgress = (room.status === 'measuring' || room.status === 'paused') && room.trialNumber > 0;
    const first = inProgress ? room.trialNumber + 1 : 1;
    const token = newToken();
    const p = {
      id: randomUUID(), tokenHash: hashToken(token), name: participantName, socketId: socket.id,
      joinedDuringSession: room.status === 'measuring' || room.status === 'paused', completed: false, uploadedCount: 0,
      firstTrial: first, lastTrial: first + room.settings.trials - 1
    };
    room.participants.set(p.id, p); attach(socket, room, 'participant', p.id); persistRoom(room, true);
    reply({ ok: true, participant: {
      participantId: p.id, participantToken: token, name: p.name, joinedDuringSession: p.joinedDuringSession,
      firstTrial: p.firstTrial, lastTrial: p.lastTrial, run: room.run
    } });
    emitRoom(room);
  });

  on(socket, 'participant:reconnect', ({ roomCode, participantId, participantToken }, reply) => {
    const ip = socket.data.ip;
    if (authFailLimiter.blocked(ip)) return reply({ ok: false, error: '試行回数が多すぎます。少し待ってください。' });
    const room = rooms.get(String(roomCode || ''));
    const p = room?.participants.get(String(participantId || ''));
    if (!room || !p || !tokenMatches(participantToken, p.tokenHash)) {
      authFailLimiter.hit(ip);
      return reply({ ok: false, error: '参加情報を確認できません。' });
    }
    if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.disconnect(true);
    p.socketId = socket.id; attach(socket, room, 'participant', p.id);
    persistRoom(room);
    // 終了済みの部屋でも本人確認できれば「結果送信のみ」のために再接続を許可する
    reply({ ok: true, status: room.status, run: room.run, trialNumber: room.trialNumber, settings: room.settings,
      participant: { participantId: p.id, name: p.name, joinedDuringSession: p.joinedDuringSession, firstTrial: p.firstTrial, lastTrial: p.lastTrial } });
    // 予定時刻まで十分な時間があれば、進行中の試行を再通知する
    const t = room.currentTrial;
    if (room.status === 'measuring' && t && t.scheduledAt - Date.now() > 800 && t.number >= p.firstTrial && t.number <= p.lastTrial) {
      socket.emit('trial:scheduled', { run: room.run, trialNumber: t.number, scheduledAt: t.scheduledAt, serverSentAt: Date.now() });
    }
    emitRoom(room);
  });

  on(socket, 'host:update-settings', ({ trials, minWaitSeconds, maxWaitSeconds }, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    if (room.closed) return reply({ ok: false, error: '終了した部屋では設定を変更できません。' });
    if (room.status === 'measuring' || room.status === 'paused') return reply({ ok: false, error: '測定中・一時停止中は設定を変更できません。' });
    const t = Number(trials), min = Number(minWaitSeconds), max = Number(maxWaitSeconds);
    if (!Number.isInteger(t) || t < 1 || t > 500) return reply({ ok: false, error: '測定回数は1〜500の整数にしてください。' });
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0.5 || max < min || max > 30) return reply({ ok: false, error: '待機時間は0.5〜30秒、最短≦最長にしてください。' });
    room.settings = { trials: t, minWaitMs: Math.round(min * 1000), maxWaitMs: Math.round(max * 1000) };
    persistRoom(room, true); emitRoomNow(room); reply({ ok: true, settings: room.settings });
  });

  on(socket, 'host:start-measurement', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    if (room.closed) return reply({ ok: false, error: '終了した部屋では測定できません。' });
    if (room.status === 'measuring') return reply({ ok: false, error: '既に測定中です。' });
    if (![...room.participants.values()].some(p => p.socketId)) return reply({ ok: false, error: '参加者がいません。' });
    room.status = 'measuring'; room.trialNumber = 0; room.run += 1; room.currentTrial = null;
    for (const p of room.participants.values()) {
      p.completed = false; p.joinedDuringSession = false; p.firstTrial = 1; p.lastTrial = room.settings.trials;
    }
    persistRoom(room, true);
    io.to(`room:${room.code}`).emit('session:started', { settings: room.settings, run: room.run });
    scheduleTrial(room); emitRoomNow(room); reply({ ok: true });
  });

  on(socket, 'host:pause-measurement', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room || room.status !== 'measuring') return reply({ ok: false, error: '測定中ではありません。' });
    clearTimeout(room.nextTimer); room.status = 'paused'; room.currentTrial = null; persistRoom(room, true);
    io.to(`room:${room.code}`).emit('session:paused'); emitRoomNow(room); reply({ ok: true });
  });
  on(socket, 'host:resume-measurement', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room || room.status !== 'paused') return reply({ ok: false, error: '一時停止中ではありません。' });
    room.status = 'measuring'; persistRoom(room, true);
    io.to(`room:${room.code}`).emit('session:resumed', { run: room.run });
    scheduleTrial(room); emitRoomNow(room); reply({ ok: true });
  });
  on(socket, 'host:end-measurement', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    if (room.closed) return reply({ ok: false, error: '部屋は終了済みです。' });
    finishRoom(room); reply({ ok: true });
  });

  on(socket, 'participant:submit-results', ({ rows }, reply) => {
    const { room, participant } = participantOf(socket);
    if (!room || !participant) return reply({ ok: false, error: '参加者を確認できません。' });
    if (!Array.isArray(rows) || rows.length > MAX_UPLOAD_ROWS) return reply({ ok: false, error: `一度に送信できる件数は${MAX_UPLOAD_ROWS}件までです。` });
    let accepted = 0, rejected = 0;
    const receivedAt = Date.now();
    db.transaction(() => {
      for (const raw of rows) {
        const row = normalizeRow(raw, room, participant);
        if (!row) { rejected++; continue; }
        const info = insertResult.run(row.recordId, room.code, participant.id, row.createdAt, JSON.stringify(row),
          row.trialNumber, row.run, row.status, row.reactionTimeMs, row.inputType, row.reason, row.participantName, receivedAt);
        if (info.changes) accepted++;
      }
    })();
    const duplicates = rows.length - accepted - rejected;
    participant.uploadedCount = countParticipantResults.get(room.code, participant.id).count;
    participant.completed = countParticipantRun.get(room.code, participant.id, room.run).count >= participant.lastTrial - participant.firstTrial + 1;
    persistRoom(room); emitRoom(room); notifyResults(room);
    // 受信確認: accepted + duplicates + rejected = received。クライアントは rejected=0 のときのみ送信完了とみなす。
    reply({ ok: true, accepted, duplicates, rejected, received: rows.length, total: participant.uploadedCount });
  });

  on(socket, 'host:get-results', ({ cursor, limit }, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    const after = Math.max(0, Math.floor(Number(cursor) || 0));
    const size = Math.max(1, Math.min(MAX_RESULT_PAGE, Math.floor(Number(limit) || 500)));
    const found = pageResults.all(room.code, after, size + 1);
    const hasMore = found.length > size;
    const page = hasMore ? found.slice(0, size) : found;
    const rows = [];
    for (const r of page) { try { rows.push(JSON.parse(r.data_json)); } catch (_) { /* skip */ } }
    reply({ ok: true, rows, count: countResults.get(room.code).count, hasMore, nextCursor: page.length ? page[page.length - 1].rid : after });
  });

  on(socket, 'host:get-stats', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    reply({ ok: true, count: countResults.get(room.code).count, stats: computeStats(db, room.code) });
  });

  on(socket, 'host:remove-participant', ({ participantId }, reply) => {
    const room = roleRoom(socket, 'host');
    const participant = room?.participants.get(String(participantId || ''));
    if (!room || !participant) return reply({ ok: false, error: '参加者が見つかりません。' });
    if (participant.socketId) {
      io.to(participant.socketId).emit('participant:removed');
      socketRoles.delete(participant.socketId);
      io.sockets.sockets.get(participant.socketId)?.leave(`room:${room.code}`);
    }
    room.participants.delete(participant.id); persistRoom(room); emitRoom(room); reply({ ok: true });
  });

  on(socket, 'host:close-room', (_d, reply) => {
    const room = roleRoom(socket, 'host');
    if (!room) return reply({ ok: false, error: 'ホスト権限がありません。' });
    clearTimeout(room.nextTimer); room.closed = true; room.status = 'closed'; room.currentTrial = null;
    persistRoom(room, true);
    // 参加者は未送信の結果を送ってからホームへ戻る。送信用に参加者のソケット紐付けは残す。
    io.to(`room:${room.code}`).emit('room:closed');
    emitRoomNow(room); reply({ ok: true });
  });

  on(socket, 'participant:leave', (_d, reply) => {
    const { room, participant } = participantOf(socket);
    if (participant) { room.participants.delete(participant.id); persistRoom(room); }
    socketRoles.delete(socket.id); if (room) emitRoom(room); reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const ip = socket.data.ip;
    const n = (ipConnections.get(ip) || 1) - 1;
    if (n <= 0) ipConnections.delete(ip); else ipConnections.set(ip, n);
    const role = socketRoles.get(socket.id); socketRoles.delete(socket.id);
    if (!role) return;
    const room = rooms.get(role.roomCode); if (!room) return;
    if (role.type === 'host') { if (room.hostSocketId === socket.id) room.hostSocketId = null; }
    else { const p = room.participants.get(role.participantId); if (p?.socketId === socket.id) p.socketId = null; }
    persistRoom(room); emitRoom(room);
  });
});

// ---------------------------------------------------------------- 監視・終了処理
setInterval(() => {
  const rss = mb(process.memoryUsage().rss);
  const line = `[monitor] rss=${rss}MB heap=${mb(process.memoryUsage().heapUsed)}MB connections=${io.engine.clientsCount} activeRooms=${activeRoomCount()}`;
  if (rss >= MEM_WARN_MB) console.warn(line + ` ※メモリ使用量が${MEM_WARN_MB}MBを超えています`);
  else if (io.engine.clientsCount > 0) console.log(line);
}, 60000).unref();

process.on('unhandledRejection', reason => console.error('unhandledRejection', reason));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${signal} received: flushing state`);
  try { clearTimeout(persistTimer); for (const r of rooms.values()) saveRoomNow(r); db.close(); } catch (e) { console.error(e.message); }
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Reaction Test v${VERSION} listening on ${PORT}; maxParticipants=${MAX_PARTICIPANTS}; db=${dbPath}; node=${process.version}`);
});
