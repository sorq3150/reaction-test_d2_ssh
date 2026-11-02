const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { randomInt, randomUUID, randomBytes } = require("crypto");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000, maxHttpBufferSize: 1e6 });
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/host", (_q, r) => r.sendFile(path.join(__dirname, "../frontend/host.html")));
app.get("/participant", (_q, r) => r.sendFile(path.join(__dirname, "../frontend/participant.html")));
app.get("/health", (_q, r) => r.json({ok:true, service:"reaction-test-stage4"}));
const rooms = new Map(), socketRoles = new Map();
const MAX_PARTICIPANTS=10, token=()=>randomBytes(32).toString("hex"), cleanName=v=>String(v||"").trim().normalize("NFKC");
const pub = room => ({roomCode:room.code,status:room.status,settings:room.settings,trialNumber:room.trialNumber,participants:[...room.participants.values()].map(p=>({participantId:p.id,name:p.name,connected:!!p.socketId,joinedDuringSession:p.joinedDuringSession,completed:p.completed,uploadedCount:p.uploadedCount||0}))});
function emitRoom(room){if(room.hostSocketId) io.to(room.hostSocketId).emit("room:update",pub(room));}
function roleRoom(socket,type){const x=socketRoles.get(socket.id);return x?.type===type?rooms.get(x.roomCode):null;}
function makeCode(){for(let i=0;i<100;i++){const c=String(randomInt(0,1e6)).padStart(6,"0");if(!rooms.has(c))return c;}throw Error("部屋番号を発行できません。");}
function attach(socket,room,role,participantId=null){socket.join(`room:${room.code}`);socketRoles.set(socket.id,{type:role,roomCode:room.code,participantId});if(role==='host')room.hostSocketId=socket.id;}
function scheduleTrial(room){
  if(room.status!=='measuring')return;
  if(room.trialNumber>=room.settings.trials){room.status='finished';io.to(`room:${room.code}`).emit('session:finished');emitRoom(room);return;}
  room.trialNumber++;
  const delay=randomInt(room.settings.minWaitMs,room.settings.maxWaitMs+1);
  const scheduledAt=Date.now()+delay+2500; // 2.5秒先の共通予定時刻
  room.currentTrial={number:room.trialNumber,scheduledAt};
  io.to(`room:${room.code}`).emit('trial:scheduled',{trialNumber:room.trialNumber,scheduledAt,serverSentAt:Date.now()});
  emitRoom(room);
  clearTimeout(room.nextTimer);
  room.nextTimer=setTimeout(()=>scheduleTrial(room),delay+2500+3000);
}
function hostRoom(socket){return roleRoom(socket,'host');}
io.on('connection',socket=>{
 socket.on('clock:ping',(_d,ack=()=>{})=>ack({serverTime:Date.now()}));
 socket.on('host:create-room',(_d,ack=()=>{})=>{try{const code=makeCode(),room={code,hostToken:token(),hostSocketId:null,status:'waiting',createdAt:Date.now(),participants:new Map(),results:new Map(),settings:{trials:10,minWaitMs:1000,maxWaitMs:3000},trialNumber:0,nextTimer:null};rooms.set(code,room);attach(socket,room,'host');ack({ok:true,hostToken:room.hostToken,room:pub(room)});}catch(e){ack({ok:false,error:e.message});}});
 socket.on('host:reconnect',({hostToken}={},ack=()=>{})=>{const room=[...rooms.values()].find(r=>r.hostToken===hostToken);if(!room)return ack({ok:false,error:'ホスト情報が見つかりません。'});if(room.hostSocketId&&room.hostSocketId!==socket.id)io.sockets.sockets.get(room.hostSocketId)?.disconnect(true);attach(socket,room,'host');ack({ok:true,room:pub(room)});});
 socket.on('participant:join',({roomCode,name}={},ack=()=>{})=>{const code=String(roomCode||'').trim(),n=cleanName(name),room=rooms.get(code);if(!/^\d{6}$/.test(code)||!room)return ack({ok:false,error:'部屋番号を確認してください。'});if(!n||n.length>24)return ack({ok:false,error:'参加者名は1〜24文字で入力してください。'});if(room.participants.size>=MAX_PARTICIPANTS)return ack({ok:false,error:'参加上限の10台に達しています。'});if([...room.participants.values()].some(p=>p.name.toLowerCase()===n.toLowerCase()))return ack({ok:false,error:'同じ参加者名が登録済みです。'});const p={id:randomUUID(),token:token(),name:n,socketId:null,joinedDuringSession:room.status==='measuring',completed:false};room.participants.set(p.id,p);attach(socket,room,'participant',p.id);p.socketId=socket.id;ack({ok:true,participant:{participantId:p.id,participantToken:p.token,name:p.name,joinedDuringSession:p.joinedDuringSession}});// 測定途中の新規参加者は、現在進行中の試行には参加させず次回通知から参加
emitRoom(room);});
 socket.on('participant:reconnect',({roomCode,participantId,participantToken}={},ack=()=>{})=>{const room=rooms.get(String(roomCode||'')),p=room?.participants.get(String(participantId||''));if(!room||!p||p.token!==participantToken)return ack({ok:false,error:'参加情報を確認できません。'});if(p.socketId&&p.socketId!==socket.id)io.sockets.sockets.get(p.socketId)?.disconnect(true);p.socketId=socket.id;attach(socket,room,'participant',p.id);ack({ok:true,participant:{participantId:p.id,name:p.name,joinedDuringSession:p.joinedDuringSession}});// 再接続端末も現在進行中の試行には遡って参加させない
emitRoom(room);});
 socket.on('host:update-settings',({trials,minWaitSeconds,maxWaitSeconds}={},ack=()=>{})=>{const r=hostRoom(socket);if(!r)return ack({ok:false,error:'ホスト権限がありません。'});if(r.status==='measuring')return ack({ok:false,error:'測定中は設定を変更できません。'});const t=Number(trials),a=Number(minWaitSeconds),b=Number(maxWaitSeconds);if(!Number.isInteger(t)||t<1||t>500)return ack({ok:false,error:'測定回数は1〜500の整数にしてください。'});if(!Number.isFinite(a)||!Number.isFinite(b)||a<0.5||b<a||b>30)return ack({ok:false,error:'待機時間は0.5〜30秒、最短≦最長にしてください。'});r.settings={trials:t,minWaitMs:Math.round(a*1000),maxWaitMs:Math.round(b*1000)};emitRoom(r);ack({ok:true,settings:r.settings});});
 socket.on('host:start-measurement',(_d,ack=()=>{})=>{const r=hostRoom(socket);if(!r)return ack({ok:false,error:'ホスト権限がありません。'});if(r.status==='measuring')return ack({ok:false,error:'既に測定中です。'});if(![...r.participants.values()].some(p=>p.socketId))return ack({ok:false,error:'参加者がいません。'});r.status='measuring';r.trialNumber=0;for(const p of r.participants.values()){p.completed=false;p.joinedDuringSession=false;}io.to(`room:${r.code}`).emit('session:started',{settings:r.settings});scheduleTrial(r);emitRoom(r);ack({ok:true});});
 socket.on('host:pause-measurement',(_d,ack=()=>{})=>{const r=hostRoom(socket);if(!r||r.status!=='measuring')return ack({ok:false,error:'測定中ではありません。'});clearTimeout(r.nextTimer);r.status='paused';io.to(`room:${r.code}`).emit('session:paused');emitRoom(r);ack({ok:true});});
 socket.on('host:resume-measurement',(_d,ack=()=>{})=>{const r=hostRoom(socket);if(!r||r.status!=='paused')return ack({ok:false,error:'一時停止中ではありません。'});r.status='measuring';io.to(`room:${r.code}`).emit('session:resumed');scheduleTrial(r);emitRoom(r);ack({ok:true});});
 socket.on('host:end-measurement',(_d,ack=()=>{})=>{const r=hostRoom(socket);if(!r)return ack({ok:false,error:'ホスト権限がありません。'});clearTimeout(r.nextTimer);r.status='finished';io.to(`room:${r.code}`).emit('session:finished');emitRoom(r);ack({ok:true});});
 socket.on('participant:submit-results',({rows}={},ack=()=>{})=>{
   const role=socketRoles.get(socket.id),r=role?.type==='participant'?rooms.get(role.roomCode):null,p=r?.participants.get(role.participantId);
   if(!r||!p)return ack({ok:false,error:'参加者を確認できません。'});
   if(!Array.isArray(rows)||rows.length>1000)return ack({ok:false,error:'送信件数が不正です。'});
   let accepted=0;
   for(const raw of rows){
     if(!raw||raw.participantId!==p.id||typeof raw.recordId!=='string')continue;
     const rt=raw.reactionTimeMs===null?null:Number(raw.reactionTimeMs);
     if(rt!==null&&(!Number.isFinite(rt)||rt<0||rt>60000))continue;
     const row={recordId:raw.recordId,roomCode:r.code,participantId:p.id,participantName:p.name,
       trialNumber:Number(raw.trialNumber)||0,reactionTimeMs:rt,inputType:String(raw.inputType||'unknown'),
       status:String(raw.status||'invalid'),reason:String(raw.reason||''),createdAt:String(raw.createdAt||new Date().toISOString()),
       visibilityState:String(raw.visibilityState||'unknown'),clockOffsetMs:Number(raw.clockOffsetMs)||0};
     if(!r.results.has(row.recordId)){r.results.set(row.recordId,row);accepted++;}
   }
   p.uploadedCount=[...r.results.values()].filter(x=>x.participantId===p.id).length;
   emitRoom(r);io.to(r.hostSocketId||'').emit('results:updated',{count:r.results.size});
   ack({ok:true,accepted,total:p.uploadedCount});
 });
 socket.on('host:get-results',(_d,ack=()=>{})=>{
   const r=hostRoom(socket);if(!r)return ack({ok:false,error:'ホスト権限がありません。'});
   ack({ok:true,rows:[...r.results.values()],count:r.results.size});
 });
 socket.on('participant:trial-result',({trialNumber,status}={},ack=()=>{})=>{const role=socketRoles.get(socket.id),r=role?.type==='participant'?rooms.get(role.roomCode):null,p=r?.participants.get(role.participantId);if(!p)return ack({ok:false});p.lastTrialStatus=String(status||'recorded');ack({ok:true});});
 socket.on('host:remove-participant',({participantId}={},ack=()=>{})=>{const r=hostRoom(socket),p=r?.participants.get(String(participantId||''));if(!r||!p)return ack({ok:false,error:'参加者が見つかりません。'});if(p.socketId){io.to(p.socketId).emit('participant:removed');socketRoles.delete(p.socketId);}r.participants.delete(p.id);emitRoom(r);ack({ok:true});});
 socket.on('host:close-room',(_d,ack=()=>{})=>{const r=hostRoom(socket);if(!r)return ack({ok:false,error:'ホスト権限がありません。'});clearTimeout(r.nextTimer);io.to(`room:${r.code}`).emit('room:closed');for(const p of r.participants.values())if(p.socketId)socketRoles.delete(p.socketId);rooms.delete(r.code);socketRoles.delete(socket.id);ack({ok:true});});
 socket.on('participant:leave',(_d,ack=()=>{})=>{const role=socketRoles.get(socket.id),r=role?.type==='participant'?rooms.get(role.roomCode):null,p=r?.participants.get(role.participantId);if(p)r.participants.delete(p.id);socketRoles.delete(socket.id);if(r)emitRoom(r);ack({ok:true});});
 socket.on('disconnect',()=>{const role=socketRoles.get(socket.id);socketRoles.delete(socket.id);if(!role)return;const r=rooms.get(role.roomCode);if(!r)return;if(role.type==='host'){if(r.hostSocketId===socket.id)r.hostSocketId=null;}else{const p=r.participants.get(role.participantId);if(p?.socketId===socket.id)p.socketId=null;}emitRoom(r);});
});
const PORT=Number(process.env.PORT)||3000;server.listen(PORT,'0.0.0.0',()=>console.log(`Reaction Test Stage 4 listening on ${PORT}`));
