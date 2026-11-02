const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { randomInt, randomUUID, randomBytes } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/host", (_req, res) => res.sendFile(path.join(__dirname, "../frontend/host.html")));
app.get("/participant", (_req, res) => res.sendFile(path.join(__dirname, "../frontend/participant.html")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "reaction-test-stage2" }));

// 第2段階はメモリ内管理。永続DBは後続段階・本番化時に追加する。
const rooms = new Map();
const socketRoles = new Map();
const MAX_PARTICIPANTS = 10;

const token = () => randomBytes(32).toString("hex");
const cleanName = (v) => String(v || "").trim().normalize("NFKC");
const publicRoom = (room) => ({
  roomCode: room.code,
  status: room.status,
  participants: [...room.participants.values()].map(p => ({
    participantId: p.id,
    name: p.name,
    connected: Boolean(p.socketId),
    joinedDuringSession: p.joinedDuringSession
  }))
});
function emitRoom(room) { io.to(room.hostSocketId).emit("room:update", publicRoom(room)); }
function findRoomByHostToken(hostToken) {
  for (const room of rooms.values()) if (room.hostToken === hostToken) return room;
  return null;
}
function findRoomByParticipantToken(participantToken) {
  for (const room of rooms.values()) {
    for (const p of room.participants.values()) if (p.token === participantToken) return { room, participant: p };
  }
  return null;
}
function makeRoomCode() {
  for (let i = 0; i < 100; i++) {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    if (!rooms.has(code)) return code;
  }
  throw new Error("部屋番号を発行できません。時間をおいて再試行してください。");
}
function attachHost(socket, room) {
  room.hostSocketId = socket.id;
  socket.join(`room:${room.code}`);
  socketRoles.set(socket.id, { type: "host", roomCode: room.code });
}
function attachParticipant(socket, room, participant) {
  participant.socketId = socket.id;
  socket.join(`room:${room.code}`);
  socketRoles.set(socket.id, { type: "participant", roomCode: room.code, participantId: participant.id });
}

io.on("connection", (socket) => {
  socket.on("host:create-room", (_payload, ack = () => {}) => {
    try {
      const code = makeRoomCode();
      const room = {
        code, hostToken: token(), hostSocketId: socket.id,
        status: "waiting", createdAt: Date.now(), participants: new Map()
      };
      rooms.set(code, room);
      attachHost(socket, room);
      ack({ ok: true, hostToken: room.hostToken, room: publicRoom(room) });
    } catch (err) { ack({ ok: false, error: err.message }); }
  });

  socket.on("host:reconnect", ({ hostToken } = {}, ack = () => {}) => {
    const room = findRoomByHostToken(hostToken);
    if (!room) return ack({ ok: false, error: "ホスト情報が見つかりません。部屋が終了した可能性があります。" });
    if (room.hostSocketId && room.hostSocketId !== socket.id) {
      const old = io.sockets.sockets.get(room.hostSocketId);
      if (old?.connected) old.disconnect(true);
    }
    attachHost(socket, room);
    ack({ ok: true, room: publicRoom(room) });
  });

  socket.on("participant:join", ({ roomCode, name } = {}, ack = () => {}) => {
    const code = String(roomCode || "").trim();
    const normalizedName = cleanName(name);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: "部屋が見つかりません。番号を確認してください。" });
    if (!/^\d{6}$/.test(code)) return ack({ ok: false, error: "部屋番号が正しくありません。" });
    if (!normalizedName || normalizedName.length > 24) return ack({ ok: false, error: "参加者名は1〜24文字で入力してください。" });
    if (room.participants.size >= MAX_PARTICIPANTS) return ack({ ok: false, error: "この部屋は参加上限の10台に達しています。" });
    const duplicate = [...room.participants.values()].some(p => p.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
    if (duplicate) return ack({ ok: false, error: "同じ参加者名が既に登録されています。別の名前を入力してください。" });
    const participant = {
      id: randomUUID(), token: token(), name: normalizedName, socketId: socket.id,
      joinedAt: Date.now(), joinedDuringSession: room.status === "measuring"
    };
    room.participants.set(participant.id, participant);
    attachParticipant(socket, room, participant);
    ack({ ok: true, participant: {
      participantId: participant.id, participantToken: participant.token,
      name: participant.name, joinedDuringSession: participant.joinedDuringSession
    }});
    emitRoom(room);
  });

  socket.on("participant:reconnect", ({ roomCode, participantId, participantToken } = {}, ack = () => {}) => {
    const room = rooms.get(String(roomCode || ""));
    const participant = room?.participants.get(String(participantId || ""));
    if (!room || !participant || participant.token !== participantToken) {
      return ack({ ok: false, error: "参加情報を確認できません。ホストに部屋の状態を確認してください。" });
    }
    if (participant.socketId && participant.socketId !== socket.id) {
      const old = io.sockets.sockets.get(participant.socketId);
      if (old?.connected) old.disconnect(true);
    }
    attachParticipant(socket, room, participant);
    ack({ ok: true, participant: {
      participantId: participant.id, name: participant.name,
      joinedDuringSession: participant.joinedDuringSession
    }});
    emitRoom(room);
  });

  socket.on("participant:leave", (_payload, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    if (role?.type === "participant") {
      const room = rooms.get(role.roomCode);
      const p = room?.participants.get(role.participantId);
      if (p) {
        room.participants.delete(p.id);
        emitRoom(room);
      }
    }
    socketRoles.delete(socket.id);
    ack({ ok: true });
  });

  socket.on("host:remove-participant", ({ participantId } = {}, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    const room = role?.type === "host" ? rooms.get(role.roomCode) : null;
    if (!room) return ack?.({ ok: false, error: "ホスト権限がありません。" });
    const p = room.participants.get(String(participantId || ""));
    if (!p) return ack?.({ ok: false, error: "参加者が見つかりません。" });
    if (p.socketId) {
      io.to(p.socketId).emit("participant:removed");
      const participantSocket = io.sockets.sockets.get(p.socketId);
      participantSocket?.leave(`room:${room.code}`);
      socketRoles.delete(p.socketId);
    }
    room.participants.delete(p.id);
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on("host:close-room", (_payload, ack = () => {}) => {
    const role = socketRoles.get(socket.id);
    const room = role?.type === "host" ? rooms.get(role.roomCode) : null;
    if (!room) return ack({ ok: false, error: "ホスト権限がありません。" });
    io.to(`room:${room.code}`).emit("room:closed");
    for (const p of room.participants.values()) if (p.socketId) socketRoles.delete(p.socketId);
    rooms.delete(room.code);
    socketRoles.delete(socket.id);
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const role = socketRoles.get(socket.id);
    socketRoles.delete(socket.id);
    if (!role) return;
    const room = rooms.get(role.roomCode);
    if (!room) return;
    if (role.type === "host") {
      if (room.hostSocketId === socket.id) room.hostSocketId = null;
    } else if (role.type === "participant") {
      const p = room.participants.get(role.participantId);
      if (p?.socketId === socket.id) p.socketId = null;
    }
    if (room.hostSocketId) emitRoom(room);
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Reaction Test Stage 2 listening on http://localhost:${PORT}`);
});
