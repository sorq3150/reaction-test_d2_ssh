(() => {
  'use strict';

  const socket = io();
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- 状態
  let session = null;            // {roomCode, name, participantId, participantToken, firstTrial, lastTrial, ...}
  let run = 0;
  let offset = 0;                // サーバー時刻 - 端末時刻(ms)。performance.timeOrigin + performance.now() を端末時刻とする
  let rtt = Infinity;            // 直近の同期での最小RTT
  let lastClockSyncAt = 0;
  let active = false;            // 試行が進行中（早押し判定の対象）
  let armed = false;             // 赤に切り替わった後（反応入力を受け付ける）
  let trialNo = 0;
  let scheduledAt = 0;
  let perfTarget = 0;            // 切り替え予定の performance.now() 値
  let changePerf = 0;
  let frameDelayMs = 0;
  let timers = [];
  let rafId = 0;
  let optionsVisible = true;
  let joinedOnce = false;
  let sessionFinished = false;
  let finalTrial = 0;
  let saveQueue = Promise.resolve();
  let uploadPromise = null;
  let retryTimer = null;
  let retryCount = 0;
  let recorded = new Set();      // この run で記録済みの試行番号
  let joining = false;
  let clockReady = false;        // 時計同期が完了するまで試行の通知は保留する
  let pendingTrial = null;

  const DB_NAME_PREFIX = 'reactionTestParticipant_';
  const STORE_NAME = 'trials';
  const TIMEOUT_MS = 3000;
  const pendingKey = () => 'rt_upload_pending:' + (session?.participantId || '');

  // ---------------------------------------------------------------- 端末情報
  const deviceInfo = (() => {
    const ua = navigator.userAgent || '';
    const uad = navigator.userAgentData;
    const m = re => (ua.match(re) || [])[1];
    let browser = 'unknown';
    if (/Edg\//.test(ua)) browser = 'Edge ' + m(/Edg\/([\d.]+)/);
    else if (/Firefox\//.test(ua)) browser = 'Firefox ' + m(/Firefox\/([\d.]+)/);
    else if (/Chrome\//.test(ua)) browser = 'Chrome ' + m(/Chrome\/([\d.]+)/);
    else if (/Safari\//.test(ua)) browser = 'Safari ' + m(/Version\/([\d.]+)/);
    let os = uad?.platform || 'unknown';
    if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Windows NT/.test(ua)) os = 'Windows ' + m(/Windows NT ([\d.]+)/);
    else if (/Android/.test(ua)) os = 'Android ' + m(/Android ([\d.]+)/);
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    const mobile = uad?.mobile ?? /Mobi|Android|iPhone/.test(ua);
    const touch = (navigator.maxTouchPoints || 0) > 0;
    const kind = /CrOS/.test(ua) ? 'chromebook' : (mobile ? 'mobile' : 'desktop');
    const device = `${kind}${touch ? '+touch' : ''} ${screen.width}x${screen.height}@${(window.devicePixelRatio || 1).toFixed(2)}`;
    return { browser: browser.slice(0, 64), os: String(os).slice(0, 64), device: device.slice(0, 64) };
  })();

  // ---------------------------------------------------------------- 時刻
  const epochNow = () => performance.timeOrigin + performance.now();
  const serverNow = () => epochNow() + offset;
  const toEpoch = perf => performance.timeOrigin + perf;
  function syncQuality() {
    if (!Number.isFinite(rtt)) return 'unknown';
    if (rtt <= 50 && frameDelayMs <= 20) return 'good';
    if (rtt <= 150 && frameDelayMs <= 50) return 'fair';
    return 'poor';
  }

  // ---------------------------------------------------------------- IndexedDB（参加者ごとに別DB）
  function openDB() {
    if (!session?.participantId) return Promise.reject(new Error('参加者情報が確定していません。'));
    const name = DB_NAME_PREFIX + String(session.participantId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        if (!store.indexNames.contains('recordId')) {
          try { store.createIndex('recordId', 'recordId', { unique: true }); } catch (_) { /* 旧データに重複がある場合は索引なし */ }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function save(row) {
    saveQueue = saveQueue.then(async () => {
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).add(row);
          tx.oncomplete = resolve;
          tx.onerror = () => { tx.error?.name === 'ConstraintError' ? resolve() : reject(tx.error); }; // 同じrecordIdは二重保存しない
          tx.onabort = () => (tx.error?.name === 'ConstraintError' ? resolve() : reject(tx.error || new Error('保存処理が中断されました。')));
        });
        db.close();
        $('savedCount').textContent = String(recorded.size);
      } catch (error) {
        $('trialInfo').textContent = '端末内保存に失敗しました：' + error.message;
      }
    });
    return saveQueue;
  }

  async function getAllRows() {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.filter(r => r.sessionRoom === session.roomCode && r.participantId === session.participantId);
  }

  // ---------------------------------------------------------------- 通信ヘルパー
  function emitWithAck(eventName, payload, timeoutMs = 2500) {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
      socket.emit(eventName, payload, result => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result || null);
      });
    });
  }

  async function syncClock(samplesWanted = 5) {
    const samples = [];
    for (let i = 0; i < samplesWanted; i++) {
      const t0 = performance.now();
      const data = await emitWithAck('clock:ping', {}, 2500);
      const t1 = performance.now();
      if (data && Number.isFinite(data.serverTime)) {
        samples.push({ rtt: t1 - t0, offset: data.serverTime - (toEpoch(t0) + (t1 - t0) / 2) });
      }
    }
    if (!samples.length) return false;
    samples.sort((a, b) => a.rtt - b.rtt);   // 最小RTTの標本を採用
    offset = samples[0].offset; rtt = samples[0].rtt; lastClockSyncAt = Date.now();
    clockReady = true;
    return true;
  }

  // ---------------------------------------------------------------- 画面
  function paint(state) {
    const stimulus = $('stimulus');
    stimulus.className = 'stimulus ' + state;
    stimulus.textContent = '';
  }

  let messageTimer = null;
  function showStimulusMessage(message, duration = 1800) {
    const node = $('stimulusMessage');
    clearTimeout(messageTimer);
    node.textContent = message;
    node.classList.remove('hidden');
    if (duration > 0) messageTimer = setTimeout(clearStimulusMessage, duration);
  }
  function clearStimulusMessage() {
    clearTimeout(messageTimer);
    const node = $('stimulusMessage');
    node.classList.add('hidden'); node.textContent = '';
  }

  function setOptionsVisible(visible) {
    optionsVisible = Boolean(visible);
    $('optionsPanel').classList.toggle('hidden', !optionsVisible);
    $('optionsToggle').setAttribute('aria-expanded', String(optionsVisible));
    $('optionsToggle').setAttribute('aria-label', optionsVisible ? 'オプションを非表示' : 'オプションを表示');
    $('optionsToggle').textContent = optionsVisible ? '×' : '⚙';
    document.body.classList.toggle('options-hidden', !optionsVisible);
  }

  function setUploadStatus(text) { $('uploadStatus').textContent = text; }

  function returnHome() {
    stopTrial();
    clearTimeout(retryTimer);
    clearStimulusMessage();
    localStorage.removeItem('rt_participant_session');
    if (session?.participantId) localStorage.removeItem(pendingKey());
    window.location.replace('/');
  }

  // ---------------------------------------------------------------- 記録
  function stopTrial() {
    active = false; armed = false;
    timers.forEach(clearTimeout); timers = [];
    cancelAnimationFrame(rafId);
  }

  // 試行番号ごとに1件だけ記録する（再接続・再読み込みでも重複しない）。recordId は決定的。
  function recordTrial(row) {
    if (!session || !run || recorded.has(row.trialNumber)) return false;
    recorded.add(row.trialNumber);
    save({
      recordId: `${session.participantId}:${run}:${row.trialNumber}`,
      sessionRoom: session.roomCode, participantId: session.participantId, participantName: session.name,
      run, personalTrial: row.trialNumber - session.firstTrial + 1,
      reactionTimeMs: null, inputType: 'none', status: 'invalid',
      visibilityState: document.visibilityState, createdAt: new Date().toISOString(),
      scheduledTime: scheduledAt || null, clockOffsetMs: offset, rttMs: Number.isFinite(rtt) ? rtt : null,
      syncQuality: syncQuality(), ...deviceInfo, ...row
    });
    return true;
  }
  const recordInvalid = (trial, reason, extra = {}) => recordTrial({ trialNumber: trial, reason, ...extra });

  // 未記録の試行（切断・再読み込み・通信遅延などで取り逃がしたもの）を無効データとして補完する
  function backfill(upToTrial) {
    if (!session) return;
    for (let t = session.firstTrial; t <= Math.min(upToTrial, session.lastTrial); t++) recordInvalid(t, 'missed');
  }

  function inMyRange(n) { return session && n >= session.firstTrial && n <= session.lastTrial; }

  function checkOwnCompletion() {
    if (!session || recorded.size < session.lastTrial - session.firstTrial + 1) return;
    // 自分の測定回数が完了。他の参加者の測定が続いていても追加試行は受けない。
    for (let t = session.firstTrial; t <= session.lastTrial; t++) if (!recorded.has(t)) return;
    $('joinStatus').textContent = '設定された測定回数が終わりました。結果を送信します。';
    setOptionsVisible(true);
    markPending(); uploadResults();
  }

  function markPending() { try { localStorage.setItem(pendingKey(), '1'); } catch (_) { /* ignore */ } }

  // ---------------------------------------------------------------- 入力
  function onInput(inputType) {
    if (!session || !active || optionsVisible) return;
    const n = trialNo;

    if (!armed) {                       // 色が切り替わる前の入力は早押し
      stopTrial();
      paint('waiting');
      showStimulusMessage('早押し');
      $('trialInfo').textContent = `第${n}回：早押しとして記録しました。`;
      recordTrial({ trialNumber: n, inputType, reason: 'early' });
      checkOwnCompletion();
      return;
    }

    const inputPerf = performance.now(); // 1試行につき最初の入力だけを採用
    const reactionTime = inputPerf - changePerf;
    stopTrial();
    clearStimulusMessage();
    paint('waiting');
    $('lastResult').textContent = reactionTime.toFixed(1) + ' ms';
    $('trialInfo').textContent = `第${n}回：記録しました（${inputType}）`;
    recordTrial({
      trialNumber: n, inputType, status: 'recorded', reason: '',
      reactionTimeMs: Number(reactionTime.toFixed(3)),
      localChangeTime: toEpoch(changePerf), inputTime: toEpoch(inputPerf), frameDelayMs: Number(frameDelayMs.toFixed(3)),
      syncQuality: syncQuality()
    });
    checkOwnCompletion();
  }

  // ---------------------------------------------------------------- 試行の進行
  function schedule(data) {
    stopTrial();
    trialNo = Number(data.trialNumber) || 0;
    scheduledAt = Number(data.scheduledAt);
    if (data.run) run = Number(data.run);
    // 前の試行で取り逃がしたものを補完（この試行より前）
    backfill(trialNo - 1);
    paint('waiting');
    clearStimulusMessage();
    active = true; armed = false;
    $('trialInfo').textContent = `第${trialNo}回：切り替わりを待っています`;

    // サーバーの予定時刻を端末の performance.now() 基準に換算する
    perfTarget = scheduledAt - offset - performance.timeOrigin;
    const waitMs = perfTarget - performance.now();
    if (waitMs < -50) {                 // 予定時刻を過ぎてから届いた
      stopTrial();
      $('trialInfo').textContent = `第${trialNo}回：通知が遅れたため無効です。`;
      recordInvalid(trialNo, 'late_schedule');
      checkOwnCompletion();
      return;
    }

    // 予定の約120ms前までは setTimeout、その後は requestAnimationFrame で切り替えフレームを選ぶ
    timers.push(setTimeout(() => {
      if (!active) return;
      if (document.visibilityState !== 'visible') return abortTrial('hidden', '画面が表示されていないため、この試行は無効です。');
      const frame = ts => {
        if (!active) return;
        if (ts < perfTarget - 8) { rafId = requestAnimationFrame(frame); return; }   // 半フレーム手前で切り替える
        paint('go');
        changePerf = performance.now();
        frameDelayMs = changePerf - perfTarget;
        armed = true;
        timers.push(setTimeout(() => {
          if (!active || !armed) return;
          stopTrial(); paint('waiting');
          showStimulusMessage('タイムアウト');
          $('trialInfo').textContent = `第${trialNo}回：タイムアウト`;
          recordTrial({ trialNumber: trialNo, inputType: 'none', reason: 'timeout', localChangeTime: toEpoch(changePerf), frameDelayMs: Number(frameDelayMs.toFixed(3)) });
          checkOwnCompletion();
        }, TIMEOUT_MS));
      };
      rafId = requestAnimationFrame(frame);
    }, Math.max(0, waitMs - 120)));

    // 時計補正は次の試行のために裏で行う（この試行の待機時間を邪魔しない）
    if (Date.now() - lastClockSyncAt > 60000) syncClock(3);
  }

  function abortTrial(reason, message) {
    const n = trialNo;
    const was = active;
    stopTrial(); paint('waiting');
    if (was && n) { recordInvalid(n, reason); $('trialInfo').textContent = message; checkOwnCompletion(); }
  }

  // ---------------------------------------------------------------- 結果送信（受信確認つき・再送あり）
  async function uploadResults() {
    if (uploadPromise) return uploadPromise;
    uploadPromise = (async () => {
      await saveQueue;
      try {
        setUploadStatus('送信中…');
        const rows = await getAllRows();
        let accepted = 0, duplicates = 0;
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          let result = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            result = await emitWithAck('participant:submit-results', { rows: batch }, 12000);
            if (result?.ok) break;
            await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
          }
          if (!result?.ok) throw new Error(result?.error || '通信エラー');
          if (result.accepted + result.duplicates + result.rejected !== batch.length) throw new Error('受信確認の件数が一致しません');
          if (result.rejected > 0) throw new Error(`${result.rejected}件がサーバーに受理されませんでした`);
          accepted += result.accepted; duplicates += result.duplicates;
        }
        retryCount = 0;
        localStorage.removeItem(pendingKey());
        setUploadStatus(`送信完了（${rows.length}件）`);
        $('trialInfo').textContent = `端末内${rows.length}件を送信し、サーバーの受信確認を受け取りました（新規${accepted}件・登録済み${duplicates}件）。`;
        return true;
      } catch (error) {
        setUploadStatus('未送信（再試行します）');
        $('trialInfo').textContent = '結果は端末内に保持されています。送信に失敗しました：' + error.message;
        scheduleUploadRetry();
        return false;
      } finally { uploadPromise = null; }
    })();
    return uploadPromise;
  }

  function scheduleUploadRetry() {
    clearTimeout(retryTimer);
    if (retryCount >= 30) return;     // 以降は再接続時・手動操作時に再試行
    retryCount++;
    retryTimer = setTimeout(() => { if (socket.connected) uploadResults(); else scheduleUploadRetry(); }, Math.min(30000, 3000 * retryCount));
  }

  // ---------------------------------------------------------------- 参加・再接続
  async function loadRecorded() {
    recorded = new Set();
    try { (await getAllRows()).filter(r => r.run === run).forEach(r => recorded.add(Number(r.trialNumber))); } catch (_) { /* ignore */ }
    $('savedCount').textContent = String(recorded.size);
  }

  async function joined() {
    $('joinPanel').classList.add('hidden');
    $('pageHeader').classList.add('hidden');
    $('pageFooter').classList.add('hidden');
    $('participantPanel').classList.remove('hidden');
    document.body.classList.add('participant-mode');
    $('joinedRoom').textContent = session.roomCode;
    $('joinedName').textContent = session.name || '';
    $('connectionState').textContent = '接続中';
    $('joinStatus').textContent = session.joinedDuringSession
      ? '途中参加しました。次の試行から測定します。' : 'ホストの開始を待っています。';
    // 初回のみオプションを開く。非同期読み込みより前に確定させ、利用者が先に閉じた操作を後から上書きしない。
    if (!joinedOnce) { joinedOnce = true; setOptionsVisible(true); paint('waiting'); }  // 再接続時は表示状態を変えない
    await loadRecorded();
    if (pendingTrial) { const t = pendingTrial; pendingTrial = null; if (inMyRange(Number(t.trialNumber))) schedule(t); }
  }

  $('joinBtn').addEventListener('click', () => {
    if (joining) return;
    const roomCode = $('roomInput').value.trim();
    const name = $('nameInput').value.trim();
    $('joinError').textContent = '';
    joining = true; $('joinBtn').disabled = true;
    socket.emit('participant:join', { roomCode, name }, async result => {
      try {
        if (!result || !result.ok) { $('joinError').textContent = result?.error || '接続できませんでした。'; return; }
        run = Number(result.participant.run) || 0;
        session = { roomCode, name, ...result.participant };
        localStorage.setItem('rt_participant_session', JSON.stringify(session));
        await syncClock();
        await joined();
      } finally { joining = false; $('joinBtn').disabled = false; }
    });
  });

  $('optionsToggle').addEventListener('click', () => setOptionsVisible(!optionsVisible));
  $('optionsClose').addEventListener('click', () => setOptionsVisible(false));
  $('optionsPanel').addEventListener('pointerdown', event => event.stopPropagation());

  // 色の領域のタップ/クリックのみ反応入力にする。入力方式（touch/mouse/pen）を記録。
  $('stimulus').addEventListener('pointerdown', event => {
    if (optionsVisible) return;
    event.preventDefault();
    onInput(['touch', 'mouse', 'pen'].includes(event.pointerType) ? event.pointerType : 'pointer');
  });

  // 測定中（オプション非表示かつ試行中）は、どのキーでも反応とみなす。長押しのリピートは無視。
  document.addEventListener('keydown', event => {
    if (!session || optionsVisible || !active) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) onInput('keyboard');
  }, true);

  $('leaveBtn').addEventListener('click', async () => {
    if (!confirm('退出しますか？')) return;
    $('leaveBtn').disabled = true;
    stopTrial();
    if (recorded.size) await uploadResults();   // 退出前に端末内の結果を送信しておく
    socket.emit('participant:leave', {}, () => returnHome());
    setTimeout(returnHome, 2500);
  });

  socket.on('connect', async () => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('rt_participant_session') || 'null'); }
    catch (_) { localStorage.removeItem('rt_participant_session'); }
    if (!stored?.participantToken) return;
    session = stored;
    socket.emit('participant:reconnect', {
      roomCode: stored.roomCode, participantId: stored.participantId, participantToken: stored.participantToken
    }, async result => {
      if (!result?.ok) {
        session = null;
        $('reconnectNotice').textContent = '以前の参加情報で再接続できません。';
        $('reconnectNotice').classList.remove('hidden');
        return;
      }
      session = { ...stored, ...result.participant };
      run = Number(result.run) || run;
      clockReady = false;
      await syncClock();
      await joined();
      if (result.status === 'closed') { await uploadResults(); returnHome(); return; }
      if (result.status === 'finished') { sessionFinished = true; backfill(result.trialNumber); markPending(); uploadResults(); }
      else if (localStorage.getItem(pendingKey())) uploadResults();   // 未送信が残っていれば再送
    });
  });

  socket.on('disconnect', () => {
    if (!session) return;
    clockReady = false;
    $('connectionState').textContent = '切断';
    $('joinStatus').textContent = '通信が切断されました。再接続を待っています。';
    abortTrial('disconnected', '通信が切断されたため、この試行は無効です。');
  });

  socket.on('trial:scheduled', data => {
    if (!session || !data || !inMyRange(Number(data.trialNumber))) return;
    if (!clockReady) { pendingTrial = data; return; }
    schedule(data);
  });

  socket.on('session:started', data => {
    run = Number(data?.run) || run;
    recorded = new Set(); $('savedCount').textContent = '0';
    sessionFinished = false; retryCount = 0;
    $('joinStatus').textContent = '測定中です。画面の色が変わったら入力してください。';
    setUploadStatus('測定後に送信');
    if (session) { session.firstTrial = 1; session.lastTrial = Number(data?.settings?.trials) || session.lastTrial; }
  });

  socket.on('session:paused', () => abortTrial('paused', '一時停止中です。'));
  socket.on('session:resumed', () => { $('joinStatus').textContent = '測定再開。次の試行を待っています。'; });

  socket.on('session:finished', data => {
    sessionFinished = true;
    stopTrial(); paint('waiting');
    backfill(Number(data?.trialNumber) || 0);   // ホストが途中で終了した場合は、ここまでの未記録分のみ補完
    $('joinStatus').textContent = '測定が終了しました。結果を送信します。';
    $('trialInfo').textContent = '測定が終了しました。';
    setOptionsVisible(true);
    markPending();
    uploadResults();
  });

  socket.on('room:closed', async () => {
    stopTrial();
    $('joinStatus').textContent = '部屋が終了しました。結果を送信しています…';
    if (session && recorded.size) await uploadResults();
    returnHome();
  });

  socket.on('participant:removed', () => returnHome());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && active) abortTrial('hidden', '画面が非表示になったため、この試行は無効です。');
  });
})();
