(() => {
  'use strict';
  const socket = io();
  const $ = id => document.getElementById(id);
  const STATE_LABELS = { waiting: '待機中', measuring: '測定中', paused: '一時停止', finished: '測定終了', closed: '部屋終了' };
  const ROOMS_KEY = 'rt_host_rooms';

  let room = null;
  let hostToken = localStorage.getItem('rt_host_token');
  let reconnectTried = false;
  let maxParticipants = null;     // サーバーから受け取った実際の上限（画面に固定値は書かない）

  // ---------------------------------------------------------------- 過去の部屋（このブラウザに保存したホストトークン）
  function loadRooms() {
    try { const v = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function rememberRoom(roomCode, token) {
    const list = loadRooms().filter(r => r.roomCode !== roomCode);
    list.unshift({ roomCode, hostToken: token });
    localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, 10)));
  }
  function renderPastRooms() {
    const list = loadRooms();
    $('pastRooms').classList.toggle('hidden', !list.length);
    const box = $('pastRoomsList'); box.replaceChildren();
    list.forEach(r => {
      const b = document.createElement('button');
      b.className = 'secondary'; b.textContent = r.roomCode;
      b.onclick = () => openRoom(r.hostToken);
      box.append(b);
    });
  }
  function openRoom(token) {
    socket.emit('host:reconnect', { hostToken: token }, r => {
      if (!r?.ok) { $('createError').textContent = r?.error || '部屋を開けませんでした。'; return; }
      hostToken = token; localStorage.setItem('rt_host_token', token);
      if (r.maxParticipants) maxParticipants = r.maxParticipants;
      show(r.room); refreshStats();
    });
  }

  // ---------------------------------------------------------------- 表示
  function show(data) {
    room = data;
    if (data.maxParticipants) maxParticipants = data.maxParticipants;
    $('createPanel').classList.add('hidden'); $('roomPanel').classList.remove('hidden');
    $('roomCode').textContent = data.roomCode;
    $('roomState').textContent = STATE_LABELS[data.status] || data.status;
    $('participantCount').textContent = `参加者数：${data.participants.length} / ${maxParticipants ?? '—'} 台`;
    $('progress').textContent = data.trialNumber ? `${data.trialNumber} 回目${data.run > 1 ? `（${data.run}回目の測定）` : ''}` : '未開始';
    if (data.settings && document.activeElement?.tagName !== 'INPUT') {
      $('trials').value = data.settings.trials;
      $('minWait').value = data.settings.minWaitMs / 1000;
      $('maxWait').value = data.settings.maxWaitMs / 1000;
    }
    renderParticipants(data.participants);
    const closed = data.status === 'closed';
    ['startBtn', 'pauseBtn', 'resumeBtn', 'endBtn', 'saveSettingsBtn', 'closeRoomBtn'].forEach(id => { $(id).disabled = closed; });
    $('closeRoomBtn').textContent = closed ? '部屋終了済み' : '部屋を終了';
    $('newRoomBtn').classList.toggle('hidden', !closed);
    $('updatedAt').textContent = '更新：' + new Date().toLocaleTimeString('ja-JP');
  }

  function cell(tr, value) { const td = document.createElement('td'); td.textContent = String(value); tr.append(td); }

  function renderParticipants(list) {
    const body = $('participantsBody'); body.replaceChildren();
    if (!list.length) { body.innerHTML = '<tr><td colspan="6" class="empty">参加者はいません。</td></tr>'; return; }
    list.forEach(p => {
      const tr = document.createElement('tr');
      cell(tr, p.participantId.slice(0, 8)); cell(tr, p.name); cell(tr, p.connected ? '接続中' : '切断');
      cell(tr, p.joinedDuringSession ? '途中参加' : '参加済み'); cell(tr, p.uploadedCount ?? 0);
      const td = document.createElement('td'), b = document.createElement('button');
      b.className = 'mini-button'; b.textContent = '退出';
      b.onclick = () => {
        if (confirm(p.name + ' さんを退出させますか？')) socket.emit('host:remove-participant', { participantId: p.participantId }, r => { if (!r?.ok) $('hostMessage').textContent = r?.error || ''; });
      };
      td.append(b); tr.append(td); body.append(tr);
    });
  }

  const fmt = v => (v == null ? '—' : Number(v).toFixed(2));

  function renderStats(stats) {
    const o = stats.overall;
    $('validCount').textContent = o.valid;
    $('avgRt').textContent = o.valid ? fmt(o.mean) + ' ms' : '—';
    $('medianRt').textContent = o.valid ? fmt(o.median) + ' ms' : '—';
    $('sdRt').textContent = o.valid ? fmt(o.sd) + ' ms' : '—';
    $('minRt').textContent = o.valid ? fmt(o.min) + ' ms' : '—';
    $('maxRt').textContent = o.valid ? fmt(o.max) + ' ms' : '—';
    $('earlyCount').textContent = o.early; $('timeoutCount').textContent = o.timeout; $('invalidCount').textContent = o.invalid;

    const pBody = $('participantStatsBody'); pBody.replaceChildren();
    if (!stats.byParticipant.length) pBody.innerHTML = '<tr><td colspan="10" class="empty">データがありません。</td></tr>';
    stats.byParticipant.forEach(p => {
      const tr = document.createElement('tr');
      [p.name, p.valid, fmt(p.mean), fmt(p.median), fmt(p.min), fmt(p.max), fmt(p.sd), p.early, p.timeout, p.invalid].forEach(v => cell(tr, v));
      pBody.append(tr);
    });
    const iBody = $('inputStatsBody'); iBody.replaceChildren();
    if (!stats.byInput.length) iBody.innerHTML = '<tr><td colspan="7" class="empty">データがありません。</td></tr>';
    stats.byInput.forEach(i => {
      const tr = document.createElement('tr');
      [i.inputType, i.valid, fmt(i.mean), fmt(i.median), fmt(i.min), fmt(i.max), fmt(i.sd)].forEach(v => cell(tr, v));
      iBody.append(tr);
    });
  }

  function renderResults(rows, total) {
    const body = $('resultsBody'); body.replaceChildren();
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty">回収された結果はありません。</td></tr>'; return; }
    rows.forEach(x => {
      const tr = document.createElement('tr');
      [x.participantName, x.trialNumber, x.reactionTimeMs == null ? '—' : Number(x.reactionTimeMs).toFixed(3), x.inputType,
        x.status === 'recorded' ? '有効' : `無効 (${x.reason || x.status})`].forEach(v => cell(tr, v));
      body.append(tr);
    });
    if (total > rows.length) $('exportMessage').textContent = `全${total}件のうち先頭${rows.length}件を表示しています。集計とCSV/Excel出力は全件が対象です。`;
  }

  const emitAsync = (event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));

  async function refreshStats() {
    const btn = $('fetchResultsBtn'); btn.disabled = true;
    $('exportMessage').textContent = '集計しています…';
    try {
      const [s, r] = await Promise.all([emitAsync('host:get-stats', {}), emitAsync('host:get-results', { limit: 500 })]);
      if (!s?.ok) throw new Error(s?.error || '集計を取得できませんでした。');
      $('resultCount').textContent = `回収 ${s.count} 件`;
      renderStats(s.stats);
      renderResults(r?.rows || [], s.count);
      if (s.count <= 500) $('exportMessage').textContent = 'サーバーから集計を取得しました。';
    } catch (e) { $('exportMessage').textContent = e.message; }
    finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- ダウンロード（サーバー側でストリーミング生成）
  async function download(format) {
    if (!hostToken) return;
    const btn = $(format === 'csv' ? 'csvBtn' : 'xlsxBtn'); btn.disabled = true;
    $('exportMessage').textContent = '出力を作成しています…（件数が多い場合は時間がかかります）';
    try {
      const res = await fetch(`/api/export/${format}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostToken })
      });
      if (!res.ok) { let msg = '出力に失敗しました。'; try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ } throw new Error(msg); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `reaction-results-${room.roomCode}.${format}`; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      $('exportMessage').textContent = `${format.toUpperCase()}を出力しました。`;
    } catch (e) { $('exportMessage').textContent = e.message; }
    finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- 操作
  const say = (id, okText) => r => { $(id).textContent = r?.ok ? okText : (r?.error || '操作に失敗しました。'); };

  $('createRoomBtn').onclick = () => socket.emit('host:create-room', {}, r => {
    if (!r?.ok) { $('createError').textContent = r?.error || '部屋を作成できませんでした。'; return; }
    $('createError').textContent = '';
    hostToken = r.hostToken; localStorage.setItem('rt_host_token', hostToken); rememberRoom(r.room.roomCode, hostToken);
    if (r.maxParticipants) maxParticipants = r.maxParticipants;
    show(r.room); refreshStats();
  });
  $('saveSettingsBtn').onclick = () => socket.emit('host:update-settings',
    { trials: $('trials').value, minWaitSeconds: $('minWait').value, maxWaitSeconds: $('maxWait').value }, say('settingsMessage', '設定を保存しました。'));
  $('startBtn').onclick = () => socket.emit('host:start-measurement', {}, say('hostMessage', '測定を開始しました。'));
  $('pauseBtn').onclick = () => socket.emit('host:pause-measurement', {}, say('hostMessage', '一時停止しました。'));
  $('resumeBtn').onclick = () => socket.emit('host:resume-measurement', {}, say('hostMessage', '測定を再開しました。'));
  $('endBtn').onclick = () => { if (confirm('測定を終了しますか？')) socket.emit('host:end-measurement', {}, say('hostMessage', '測定を終了しました。')); };
  $('closeRoomBtn').onclick = () => {
    if (!confirm('部屋を終了しますか？参加者は結果を送信してホーム画面に戻ります。結果データは保存され、ここから出力できます。')) return;
    socket.emit('host:close-room', {}, r => {
      if (r?.ok) { $('hostMessage').textContent = '部屋を終了しました。結果データは保存されています。'; setTimeout(refreshStats, 2500); }
      else $('hostMessage').textContent = r?.error || '操作に失敗しました。';
    });
  };
  $('newRoomBtn').onclick = () => {
    room = null; hostToken = null; localStorage.removeItem('rt_host_token');
    $('roomPanel').classList.add('hidden'); $('createPanel').classList.remove('hidden'); renderPastRooms();
  };
  $('fetchResultsBtn').onclick = refreshStats;
  $('csvBtn').onclick = () => download('csv');
  $('xlsxBtn').onclick = () => download('xlsx');

  // ---------------------------------------------------------------- Socket.IO イベント
  socket.on('results:updated', d => { $('resultCount').textContent = `サーバー回収 ${d.count} 件（「集計を更新」で反映）`; });
  socket.on('room:update', show);
  socket.on('session:finished', () => { $('hostMessage').textContent = '全試行が終了しました。参加者の結果送信後に「集計を更新」を押してください。'; });
  socket.on('connect_error', () => { $('hostMessage').textContent = 'サーバーに接続できません。'; });
  socket.on('connect', () => {
    if (hostToken && !reconnectTried) {
      reconnectTried = true;
      socket.emit('host:reconnect', { hostToken }, r => {
        if (r?.ok) { if (r.maxParticipants) maxParticipants = r.maxParticipants; show(r.room); refreshStats(); }
        else { localStorage.removeItem('rt_host_token'); hostToken = null; }
      });
    } else if (hostToken && room) {   // 通信が途切れて戻った場合もホスト権限を取り直す
      socket.emit('host:reconnect', { hostToken }, r => { if (r?.ok) show(r.room); });
    }
  });
  fetch('/config').then(r => r.json()).then(c => {
    if (Number(c.maxParticipants)) { maxParticipants = Number(c.maxParticipants); if (room) show(room); }
  }).catch(() => {});
  renderPastRooms();
})();
