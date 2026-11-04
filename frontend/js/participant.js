(() => {
  'use strict';

  const socket = io();
  const $ = id => document.getElementById(id);

  let session = null;
  let offset = 0;
  let active = false;
  let armed = false;
  let trialNo = 0;
  let scheduledTimer = null;
  let changePerf = 0;
  let optionsVisible = true;
  let saveQueue = Promise.resolve();

  const DB_NAME_PREFIX = 'reactionTestParticipant_';
  const STORE_NAME = 'trials';

  function openDB() {
    if (!session?.participantId) {
      return Promise.reject(new Error('参加者情報が確定していません。'));
    }
    const participantDBName = DB_NAME_PREFIX + String(session.participantId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(participantDBName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function save(row) {
    saveQueue = saveQueue.then(async () => {
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).add(row);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('保存処理が中断されました。'));
        });
        $('savedCount').textContent = String(Number($('savedCount').textContent) + 1);
      } catch (error) {
        $('trialInfo').textContent = '端末内保存に失敗しました：' + error.message;
      }
    });
    return saveQueue;
  }

  function emitWithAck(eventName, payload, timeoutMs = 2500) {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, timeoutMs);
      socket.emit(eventName, payload, result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result || null);
      });
    });
  }

  async function syncClock() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const local0 = Date.now();
      const data = await emitWithAck('clock:ping', {}, 2500);
      const t1 = performance.now();
      if (data && Number.isFinite(data.serverTime)) {
        samples.push({
          rtt: t1 - t0,
          offset: data.serverTime - (local0 + (t1 - t0) / 2)
        });
      }
    }
    if (samples.length === 0) return Infinity;
    samples.sort((a, b) => a.rtt - b.rtt);
    offset = samples[0].offset;
    return samples[0].rtt;
  }

  // 刺激領域は色だけで状態を示し、文字を表示しない。
  function paint(state) {
    const stimulus = $('stimulus');
    stimulus.className = 'stimulus ' + state;
    stimulus.textContent = '';
  }

  let messageTimer = null;
  function showStimulusMessage(message, duration = 1800) {
    const node = $('stimulusMessage');
    if (!node) return;
    clearTimeout(messageTimer);
    node.textContent = message;
    node.classList.remove('hidden');
    if (duration > 0) {
      messageTimer = setTimeout(() => {
        node.classList.add('hidden');
        node.textContent = '';
      }, duration);
    }
  }

  function clearStimulusMessage() {
    clearTimeout(messageTimer);
    const node = $('stimulusMessage');
    if (node) {
      node.classList.add('hidden');
      node.textContent = '';
    }
  }

  function returnHome() {
    active = false;
    armed = false;
    clearTimeout(scheduledTimer);
    clearStimulusMessage();
    localStorage.removeItem('rt_participant_session');
    window.location.replace('/');
  }

  function setOptionsVisible(visible) {
    optionsVisible = Boolean(visible);
    $('optionsPanel').classList.toggle('hidden', !optionsVisible);
    $('optionsToggle').setAttribute('aria-expanded', String(optionsVisible));
    $('optionsToggle').setAttribute(
      'aria-label',
      optionsVisible ? 'オプションを非表示' : 'オプションを表示'
    );
    $('optionsToggle').textContent = optionsVisible ? '×' : '⚙';
    document.body.classList.toggle('options-hidden', !optionsVisible);
  }

  function recordTrial(row) {
    save(row);
    // ホストには測定途中の反応時間を送らず、試行状態のみ通知する。
    socket.emit('participant:trial-result', {
      trialNumber: row.trialNumber,
      status: row.status === 'recorded' ? 'recorded' : 'early'
    });
  }

  function onInput(inputType) {
    if (!session || !active || optionsVisible) return;

    // 色が緑（待機）から赤（合図）へ変わる前の入力は早押し。
    if (!armed) {
      if ($('stimulus').classList.contains('waiting')) {
        active = false;
        armed = false;
        clearTimeout(scheduledTimer);
        paint('waiting');
        showStimulusMessage('早押し');
        $('trialInfo').textContent = '早押しとして記録しました。';
        recordTrial({
          recordId: crypto.randomUUID(),
          sessionRoom: session.roomCode,
          participantId: session.participantId,
          participantName: session.name,
          trialNumber: trialNo,
          reactionTimeMs: null,
          inputType,
          status: 'invalid',
          reason: 'early',
          visibilityState: document.visibilityState,
          createdAt: new Date().toISOString()
        });
      }
      return;
    }

    // 1試行につき最初の入力だけを採用する。
    armed = false;
    active = false;
    clearTimeout(scheduledTimer);
    clearStimulusMessage();
    const inputPerf = performance.now();
    const reactionTime = inputPerf - changePerf;

    paint('waiting');
    $('lastResult').textContent = reactionTime.toFixed(1) + ' ms';
    $('trialInfo').textContent = `第${trialNo}回：記録しました（${inputType}）`;

    recordTrial({
      recordId: crypto.randomUUID(),
      sessionRoom: session.roomCode,
      participantId: session.participantId,
      participantName: session.name,
      trialNumber: trialNo,
      reactionTimeMs: Number(reactionTime.toFixed(3)),
      inputType,
      localChangePerf: changePerf,
      inputPerf,
      clockOffsetMs: offset,
      status: 'recorded',
      visibilityState: document.visibilityState,
      createdAt: new Date().toISOString()
    });
  }

  function schedule(data) {
    clearTimeout(scheduledTimer);
    trialNo = Number(data.trialNumber) || 0;
    active = true;
    armed = false;
    paint('waiting');
    clearStimulusMessage();
    $('trialInfo').textContent = `第${trialNo}回：切り替わりを待っています`;

    // サーバーから受け取った共通予定時刻を端末の時計に換算する。
    const localTarget = Number(data.scheduledAt) - offset;
    const delay = Math.max(0, localTarget - Date.now());

    scheduledTimer = setTimeout(() => {
      if (!active || document.visibilityState !== 'visible') {
        active = false;
        $('trialInfo').textContent = '画面が表示されていないため、この試行は無効です。';
        return;
      }
      requestAnimationFrame(() => {
        if (!active) return;
        paint('go');
        changePerf = performance.now();
        armed = true;

        scheduledTimer = setTimeout(() => {
          if (!active || !armed) return;
          active = false;
          armed = false;
          paint('waiting');
          showStimulusMessage('タイムアウト');
          $('trialInfo').textContent = `第${trialNo}回：タイムアウト`;
          recordTrial({
            recordId: crypto.randomUUID(),
            sessionRoom: session.roomCode,
            participantId: session.participantId,
            participantName: session.name,
            trialNumber: trialNo,
            reactionTimeMs: null,
            inputType: 'none',
            status: 'invalid',
            reason: 'timeout',
            visibilityState: document.visibilityState,
            clockOffsetMs: offset,
            createdAt: new Date().toISOString()
          });
        }, 3000);
      });
    }, delay);
  }

  function joined() {
    $('joinPanel').classList.add('hidden');
    $('pageHeader').classList.add('hidden');
    $('pageFooter').classList.add('hidden');
    $('participantPanel').classList.remove('hidden');
    document.body.classList.add('participant-mode');

    $('joinedRoom').textContent = session.roomCode;
    $('joinedName').textContent = session.name || session.participantName || '';
    $('connectionState').textContent = '接続中';
    $('joinStatus').textContent = session.joinedDuringSession
      ? '途中参加しました。次の試行から測定します。'
      : 'ホストの開始を待っています。';

    setOptionsVisible(true);
    paint('waiting');
  }

  $('joinBtn').addEventListener('click', async () => {
    const roomCode = $('roomInput').value.trim();
    const name = $('nameInput').value.trim();
    $('joinError').textContent = '';

    socket.emit('participant:join', { roomCode, name }, async result => {
      if (!result || !result.ok) {
        $('joinError').textContent = result?.error || '接続できませんでした。';
        return;
      }
      session = {
        roomCode,
        name,
        ...result.participant
      };
      localStorage.setItem('rt_participant_session', JSON.stringify(session));
      await syncClock();
      joined();
    });
  });

  $('optionsToggle').addEventListener('click', () => {
    setOptionsVisible(!optionsVisible);
  });
  $('optionsClose').addEventListener('click', () => setOptionsVisible(false));

  // オプションパネル上の操作は刺激領域に伝播させず、測定入力にも使わない。
  $('optionsPanel').addEventListener('pointerdown', event => {
    event.stopPropagation();
  });

  // 画面の色領域をタップした場合のみ反応入力にする。
  $('stimulus').addEventListener('pointerdown', event => {
    if (optionsVisible) return;
    event.preventDefault();
    onInput('pointer');
  });

  // オプション表示中はキーボードを測定に使わない。
  // 非表示中かつ測定試行中は、修飾キーを含むすべてのキーを検出する。
  // キーの長押しによる連続入力はevent.repeatで除外する。
  document.addEventListener('keydown', event => {
    if (!session || optionsVisible || !active) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onInput('keyboard');
  }, true);

  $('leaveBtn').addEventListener('click', () => {
    if (!confirm('退出しますか？')) return;
    socket.emit('participant:leave', {}, () => {
      returnHome();
    });
  });

  socket.on('connect', async () => {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem('rt_participant_session') || 'null');
    } catch (_) {
      localStorage.removeItem('rt_participant_session');
    }
    if (!stored?.participantToken) return;

    session = stored;
    socket.emit('participant:reconnect', {
      roomCode: stored.roomCode,
      participantId: stored.participantId,
      participantToken: stored.participantToken
    }, async result => {
      if (result?.ok) {
        session = { ...stored, ...result.participant };
        await syncClock();
        joined();
      } else {
        $('reconnectNotice').textContent = '以前の参加情報で再接続できません。';
        $('reconnectNotice').classList.remove('hidden');
      }
    });
  });

  socket.on('disconnect', () => {
    if (!session) return;
    $('connectionState').textContent = '切断';
    $('joinStatus').textContent = '通信が切断されました。再接続を待っています。';
    active = false;
    armed = false;
    clearTimeout(scheduledTimer);
    paint('waiting');
  });

  socket.on('trial:scheduled', async data => {
    if (!session) return;
    await syncClock();
    schedule(data);
  });

  socket.on('session:started', () => {
    $('joinStatus').textContent = '測定中です。画面の色が変わったら入力してください。';
  });

  socket.on('session:paused', () => {
    active = false;
    armed = false;
    clearTimeout(scheduledTimer);
    paint('waiting');
    $('trialInfo').textContent = '一時停止中です。';
  });

  socket.on('session:resumed', () => {
    $('joinStatus').textContent = '測定再開。次の試行を待っています。';
  });

  async function getAllRows() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result.filter(row =>
        row.sessionRoom === session.roomCode &&
        row.participantId === session.participantId
      ));
      request.onerror = () => reject(request.error);
    });
  }

  async function uploadResults() {
    await saveQueue;
    try {
      const rows = await getAllRows();
      const result = await emitWithAck('participant:submit-results', { rows }, 10000);
      if (result?.ok) {
        $('trialInfo').textContent =
          `測定終了。${result.total}件をホストへ送信し、受信確認を受け取りました。端末内データも保持しています。`;
      } else {
        $('trialInfo').textContent =
          '結果は端末内に保存されています。ホストへの送信に失敗しました：' +
          (result?.error || '通信エラー');
      }
    } catch (error) {
      $('trialInfo').textContent =
        '結果は端末内に保存されています。送信エラー：' + error.message;
    }
  }

  socket.on('session:finished', () => {
    active = false;
    armed = false;
    clearTimeout(scheduledTimer);
    paint('waiting');
    $('trialInfo').textContent = '測定が終了しました。';
    uploadResults();
  });

  socket.on('room:closed', () => {
    returnHome();
  });

  socket.on('participant:removed', () => {
    returnHome();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && active) {
      active = false;
      armed = false;
      clearTimeout(scheduledTimer);
      paint('waiting');
      $('trialInfo').textContent = '画面が非表示になったため、現在の試行を中断しました。';
    }
  });
})();
