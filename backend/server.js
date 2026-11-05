'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { randomInt, randomUUID, randomBytes } = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 256 * 1024,
  perMessageDeflate: false,
  httpCompression: false,
  transports: ['websocket', 'polling']
});

const requestedLimit = Number.parseInt(process.env.MAX_PARTICIPANTS || '100', 10);
const MAX_PARTICIPANTS = Number.isFinite(requestedLimit) ? Math.max(10, Math.min(300, requestedLimit)) : 100;
const MAX_UPLOAD_ROWS = 100;
const MAX_RESULT_PAGE = 5000;
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'reaction-test.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
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
CREATE INDEX IF NOT EXISTS idx_results_room_order ON results(room_code, created_at, record_id);
CREATE INDEX IF NOT EXISTS idx_results_participant ON results(room_code, participant_id);
`);

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, '../frontend/host.html')));
app.get('/participant', (_req, res) => res.sendFile(path.join(__dirname, '../frontend/participant.html')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'reaction-test-stage5', maxParticipants: MAX_PARTICIPANTS }));
app.get('/config', (_req, res) => res.json({ maxParticipants: MAX_PARTICIPANTS }));

const rooms = new Map();
const socketRoles = new Map();
const joinAttempts = new Map();
const token = () => randomBytes(32).toString('hex');
const cleanName = value => String(value || '').trim().normalize('NFKC');
const insertResult = db.prepare('INSERT OR IGNORE INTO results(record_id, room_code, participant_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)');
const countResults = db.prepare('SELECT COUNT(*) AS count FROM results WHERE room_code = ?');
const pageResults = db.prepare('SELECT data_json FROM results WHERE room_code = ? ORDER BY created_at, record_id LIMIT ? OFFSET ?');
const findRoom = db.prepare('SELECT room_code FROM sessions WHERE room_code = ?');
const saveSession = db.prepare(`INSERT INTO sessions(room_code,host_token,status,created_at,settings_json,trial_number,participants_json,closed)
VALUES (@code,@hostToken,@status,@createdAt,@settings,@trialNumber,@participants,@closed)
ON CONFLICT(room_code) DO UPDATE SET host_token=excluded.host_token,status=excluded.status,settings_json=excluded.settings_json,trial_number=excluded.trial_number,participants_json=excluded.participants_json,closed=excluded.closed`);

function persistRoom(room) {
  saveSession.run({
    code: room.code, hostToken: room.hostToken, status: room.status,
    createdAt: room.createdAt, settings: JSON.stringify(room.settings),
    trialNumber: room.trialNumber,
    participants: JSON.stringify([...room.participants.values()].map(p => ({
      id: p.id, token: p.token, name: p.name,
      joinedDuringSession: !!p.joinedDuringSession, completed: !!p.completed,
      uploadedCount: p.uploadedCount || 0
    }))),
    closed: room.closed ? 1 : 0
  });
}
function publicRoom(room) {
  return {
    roomCode: room.code, status: room.status, settings: room.settings,
    trialNumber: room.trialNumber,
    participants: [...room.participants.values()].map(p => ({
      participantId: p.id, name: p.name, connected: !!p.socketId,
      joinedDuringSession: !!p.joinedDuringSession,
      completed: !!p.completed, uploadedCount: p.uploadedCount || 0
    }))
  };
}
function emitRoom(room) { if (room.hostSocketId) io.to(room.hostSocketId).emit('room:update', publicRoom(room)); }
function roleRoom(socket, role) {
  const roleInfo = socketRoles.get(socket.id);
  return roleInfo?.type === role ? rooms.get(roleInfo.roomCode) : null;
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
function allowJoin(socket) {
  const now = Date.now();
  const attempts = (joinAttempts.get(socket.id) || []).filter(t => now - t < 60000);
  if (attempts.length >= 12) return false;
  attempts.push(now);
  joinAttempts.set(socket.id, attempts);
  return true;
}
function scheduleTrial(room) {
  if (room.status !== 'measuring') return;
  if (room.trialNumber >= room.settings.trials) {
    room.status = 'finished';
    persistRoom(room);
    io.to(`room:${room.code}`).emit('session:finished');
    emitRoom(room);
    return;
  }
  room.trialNumber += 1;
  const delay = randomInt(room.settings.minWaitMs, room.settings.maxWaitMs + 1);
  const scheduledAt = Date.now() + delay + 2500;
  room.currentTrial = { number: room.trialNumber, scheduledAt };
  io.to(`room:${room.code}`).emit('trial:scheduled', {
    trialNumber: room.trialNumber, scheduledAt, serverSentAt: Date.now()
  });
  persistRoom(room);
  emitRoom(room);
  clearTimeout(room.nextTimer);
  room.nextTimer = setTimeout(() => scheduleTrial(room), delay + 2500 + 3000);
}

// Restore active rooms after a process restart. An interrupted measurement is paused, never silently resumed.
for (const saved of db.prepare('SELECT * FROM sessions').all()) {
  try {
    const participants = JSON.parse(saved.participants_json || '[]');
    const room = {
      code: saved.room_code, hostToken: saved.host_token, hostSocketId: null,
      status: saved.closed ? 'closed' : (saved.status === 'measuring' ? 'paused' : saved.status),
      closed: !!saved.closed,
      createdAt: saved.created_at, participants: new Map(), results: new Map(),
      settings: JSON.parse(saved.settings_json), trialNumber: saved.trial_number,
      nextTimer: null, currentTrial: null
    };
    for (const p of participants) room.participants.set(p.id, { ...p, socketId: null, uploadedCount: p.uploadedCount || 0 });
    const totalRows = db.prepare('SELECT participant_id, COUNT(*) AS count FROM results WHERE room_code=? GROUP BY participant_id').all(room.code);
    for (const row of totalRows) { const p = room.participants.get(row.participant_id); if (p) p.uploadedCount = row.count; }
    rooms.set(room.code, room);
    persistRoom(room);
  } catch (error) {
    console.error('Could not restore room', saved.room_code, error.message);
  }
}

io.on('connection', socket => {
  socket.on('clock:ping', (_data, ack = () => {}) => ack({ serverTime: Date.now() }));

  socket.on('host:create-room', (_data, ack = () => {}) => {
    try {
      const code = makeCode();
      const room = {
        code, hostToken: token(), hostSocketId: null, status: 'waiting',
        createdAt: Date.now(), participants: new Map(), results: new Map(),
        settings: { trials: 10, minWaitMs: 1000, maxWaitMs: 3000 },
        trialNumber: 0, nextTimer: null, currentTrial: null
      };
      rooms.set(code, room); persistRoom(room); attach(socket, room, 'host');
      ack({ ok: true, hostToken: room.hostToken, room: publicRoom(room), maxParticipants: MAX_PARTICIPANTS });
    } catch (error) { ack({ ok: false, error: error.message }); }
  });

  socket.on('host:reconnect', ({ hostToken } = {}, ack = () => {}) => {
    const room = [...rooms.values()].find(r => r.hostToken === hostToken);
    if (!room) return ack({ ok: false, error: 'ホスト情報が見つかりません。' });
    if (room.hostSocketId && room.hostSocketId !== socket.id) io.sockets.sockets.get(room.hostSocketId)?.disconnect(true);
    attach(socket, room, 'host'); persistRoom(room);
    ack({ ok: true, room: publicRoom(room), maxParticipants: MAX_PARTICIPANTS });
  });

  socket.on('participant:join', ({ roomCode, name } = {}, ack = () => {}) => {
    if (!allowJoin(socket)) return ack({ ok: false, error: '接続要求が多すぎます。少し待ってから再試行してください。' });
    const code = String(roomCode || '').trim();
    const participantName = cleanName(name);
    const room = rooms.get(code);
    if (!/^\d{6}$/.test(code) || !room || room.closed) return ack({ ok: false, error: '部屋番号を確認してください。' });
    if (!participantName || participantName.length > 24) return ack({ ok: false, error: '参加者名は1〜24文字で入力してください。' });
    if (room.participants.size >= MAX_PARTICIPANTS) return ack({ ok: false, error: `参加上限の${MAX_PARTICIPANTS}台に達しています。` });
    if ([...room.participants.values()].some(p => p.name.toLocaleLowerCase() === participantName.toLocaleLowerCase())) return ack({ ok: false, error: '同じ参加者名が登録済みです。' });
    const p = { id: randomUUID(), token: token(), name: participantName, socketId: socket.id,
      joinedDuringSession: room.status === 'measuring', completed: false, uploadedCount: 0 };
    room.participants.set(p.id, p); attach(socket, room, 'participant', p.id); persistRoom(room);
    ack({ ok: true, participant: { participantId: p.id, participantToken: p.token, name: p.name, joinedDuringSession: p.joinedDuringSession } });
    emitRoom(room);
  });

  socket.on('participant:reconnect', ({ roomCode, participantId, participantToken } = {}, ack = () => {}) => {
    const room = rooms.get(String(roomCode || ''));
    const p = room?.participants.get(String(participantId || ''));
    if (!room || room.closed || !p || p.token !== participantToken) return ack({ ok: false, error: '参加情報を確認できません。' });
    if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.disconnect(true);
    p.socketId = socket.id; attach(socket, room, 'participant', p.id); persistRoom(room);
    ack({ ok: true, status: room.status, participant: { participantId: p.id, name: p.name, joinedDuringSession: p.joinedDuringSession } });
    emitRoom(room);
  });

  socket.on('host:update-settings', ({ trials, minWaitSeconds, maxWaitSeconds } = {}, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room) return ack({ ok: false, error: 'ホスト権限がありません。' });
    if (room.closed) return ack({ ok: false, error: '終了した部屋では設定を変更できません。' });
    if (room.status === 'measuring') return ack({ ok: false, error: '測定中は設定を変更できません。' });
    const t = Number(trials), min = Number(minWaitSeconds), max = Number(maxWaitSeconds);
    if (!Number.isInteger(t) || t < 1 || t > 500) return ack({ ok: false, error: '測定回数は1〜500の整数にしてください。' });
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0.5 || max < min || max > 30) return ack({ ok: false, error: '待機時間は0.5〜30秒、最短≦最長にしてください。' });
    room.settings = { trials: t, minWaitMs: Math.round(min * 1000), maxWaitMs: Math.round(max * 1000) };
    persistRoom(room); emitRoom(room); ack({ ok: true, settings: room.settings });
  });

  socket.on('host:start-measurement', (_data, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room) return ack({ ok: false, error: 'ホスト権限がありません。' });
    if (room.closed) return ack({ ok: false, error: '終了した部屋では測定できません。' });
    if (room.status === 'measuring') return ack({ ok: false, error: '既に測定中です。' });
    if (![...room.participants.values()].some(p => p.socketId)) return ack({ ok: false, error: '参加者がいません。' });
    room.status = 'measuring'; room.trialNumber = 0;
    for (const p of room.participants.values()) { p.completed = false; p.joinedDuringSession = false; }
    persistRoom(room); io.to(`room:${room.code}`).emit('session:started', { settings: room.settings });
    scheduleTrial(room); emitRoom(room); ack({ ok: true });
  });

  socket.on('host:pause-measurement', (_data, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room || room.status !== 'measuring') return ack({ ok: false, error: '測定中ではありません。' });
    clearTimeout(room.nextTimer); room.status = 'paused'; persistRoom(room);
    io.to(`room:${room.code}`).emit('session:paused'); emitRoom(room); ack({ ok: true });
  });
  socket.on('host:resume-measurement', (_data, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room || room.status !== 'paused') return ack({ ok: false, error: '一時停止中ではありません。' });
    room.status = 'measuring'; persistRoom(room); io.to(`room:${room.code}`).emit('session:resumed'); scheduleTrial(room); emitRoom(room); ack({ ok: true });
  });
  socket.on('host:end-measurement', (_data, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room) return ack({ ok: false, error: 'ホスト権限がありません。' });
    clearTimeout(room.nextTimer); room.status = 'finished'; persistRoom(room);
    io.to(`room:${room.code}`).emit('session:finished'); emitRoom(room); ack({ ok: true });
  });

  socket.on('participant:submit-results', ({ rows } = {}, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    const room = role?.type === 'participant' ? rooms.get(role.roomCode) : null;
    const participant = room?.participants.get(role.participantId);
    if (!room || !participant) return ack({ ok: false, error: '参加者を確認できません。' });
    if (!Array.isArray(rows) || rows.length > MAX_UPLOAD_ROWS) return ack({ ok: false, error: `一度に送信できる件数は${MAX_UPLOAD_ROWS}件までです。` });
    let accepted = 0;
    const transaction = db.transaction(() => {
      for (const raw of rows) {
        if (!raw || raw.participantId !== participant.id || typeof raw.recordId !== 'string' || raw.recordId.length > 100) continue;
        const reactionTime = raw.reactionTimeMs == null ? null : Number(raw.reactionTimeMs);
        if (reactionTime !== null && (!Number.isFinite(reactionTime) || reactionTime < 0 || reactionTime > 60000)) continue;
        const row = {
          recordId: raw.recordId, roomCode: room.code, participantId: participant.id,
          participantName: participant.name, trialNumber: Number(raw.trialNumber) || 0,
          reactionTimeMs: reactionTime, inputType: String(raw.inputType || 'unknown').slice(0, 24),
          status: String(raw.status || 'invalid').slice(0, 24), reason: String(raw.reason || '').slice(0, 48),
          createdAt: String(raw.createdAt || new Date().toISOString()).slice(0, 48),
          visibilityState: String(raw.visibilityState || 'unknown').slice(0, 24),
          clockOffsetMs: Number(raw.clockOffsetMs) || 0
        };
        const inserted = insertResult.run(row.recordId, room.code, participant.id, row.createdAt, JSON.stringify(row));
        if (inserted.changes) accepted++;
      }
    });
    transaction();
    participant.uploadedCount = db.prepare('SELECT COUNT(*) AS count FROM results WHERE room_code=? AND participant_id=?').get(room.code, participant.id).count;
    persistRoom(room); emitRoom(room);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('results:updated', { count: countResults.get(room.code).count });
    ack({ ok: true, accepted, total: participant.uploadedCount });
  });

  socket.on('host:get-results', ({ offset = 0, limit = MAX_RESULT_PAGE } = {}, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room) return ack({ ok: false, error: 'ホスト権限がありません。' });
    const safeOffset = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
    const safeLimit = Math.max(1, Math.min(MAX_RESULT_PAGE, Math.floor(Number(limit) || MAX_RESULT_PAGE)));
    const count = countResults.get(room.code).count;
    const rows = pageResults.all(room.code, safeLimit, safeOffset).map(row => JSON.parse(row.data_json));
    ack({ ok: true, rows, count, offset: safeOffset, hasMore: safeOffset + rows.length < count });
  });

  socket.on('participant:trial-result', ({ status } = {}, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    const room = role?.type === 'participant' ? rooms.get(role.roomCode) : null;
    const participant = room?.participants.get(role.participantId);
    if (!participant) return ack({ ok: false });
    participant.lastTrialStatus = String(status || 'recorded'); ack({ ok: true });
  });

  socket.on('host:remove-participant', ({ participantId } = {}, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    const participant = room?.participants.get(String(participantId || ''));
    if (!room || !participant) return ack({ ok: false, error: '参加者が見つかりません。' });
    if (participant.socketId) { io.to(participant.socketId).emit('participant:removed'); socketRoles.delete(participant.socketId); }
    room.participants.delete(participant.id); persistRoom(room); emitRoom(room); ack({ ok: true });
  });

  socket.on('host:close-room', (_data, ack = () => {}) => {
    const room = roleRoom(socket, 'host');
    if (!room) return ack({ ok: false, error: 'ホスト権限がありません。' });
    clearTimeout(room.nextTimer); room.closed = true; room.status = 'closed';
    io.to(`room:${room.code}`).emit('room:closed');
    for (const p of room.participants.values()) { if (p.socketId) socketRoles.delete(p.socketId); p.socketId = null; }
    persistRoom(room); emitRoom(room); ack({ ok: true });
  });

  socket.on('participant:leave', (_data, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    const room = role?.type === 'participant' ? rooms.get(role.roomCode) : null;
    const participant = room?.participants.get(role.participantId);
    if (participant) { room.participants.delete(participant.id); persistRoom(room); }
    socketRoles.delete(socket.id); if (room) emitRoom(room); ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const role = socketRoles.get(socket.id); socketRoles.delete(socket.id); joinAttempts.delete(socket.id);
    if (!role) return;
    const room = rooms.get(role.roomCode); if (!room) return;
    if (role.type === 'host') { if (room.hostSocketId === socket.id) room.hostSocketId = null; }
    else { const p = room.participants.get(role.participantId); if (p?.socketId === socket.id) p.socketId = null; }
    persistRoom(room); emitRoom(room);
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Reaction Test Stage 5 listening on ${PORT}; capacity=${MAX_PARTICIPANTS}; db=${dbPath}`));
