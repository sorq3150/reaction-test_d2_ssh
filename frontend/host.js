(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  let room = null;
  let hostToken = localStorage.getItem("rt_host_token");
  let reconnectAttempted = false;

  function showRoom(data) {
    room = data;
    $("createPanel").classList.add("hidden");
    $("roomPanel").classList.remove("hidden");
    $("roomCode").textContent = data.roomCode;
    $("roomState").textContent = data.status === "measuring" ? "測定中（次段階）" : "待機中";
    renderParticipants(data.participants || []);
  }
  function renderParticipants(list) {
    $("participantCount").textContent = `${list.length} / 10 台`;
    $("updatedAt").textContent = `更新：${new Date().toLocaleTimeString("ja-JP")}`;
    const body = $("participantsBody");
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">参加者はいません。</td></tr>';
      return;
    }
    body.replaceChildren();
    list.forEach(p => {
      const tr = document.createElement("tr");
      const cells = [p.participantId.slice(0, 8), p.name, p.connected ? "接続中" : "切断", p.joinedDuringSession ? "次の試行から参加予定" : "参加済み"];
      cells.forEach((value, i) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (i === 2) {
          const span = document.createElement("span");
          span.className = `status ${p.connected ? "online" : "offline"}`;
          span.textContent = value;
          td.replaceChildren(span);
        }
        tr.appendChild(td);
      });
      const action = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "mini-button";
      btn.textContent = "退出";
      btn.addEventListener("click", () => {
        if (confirm(`${p.name} さんを部屋から退出させますか？`)) {
          socket.emit("host:remove-participant", { participantId: p.participantId });
        }
      });
      action.appendChild(btn);
      tr.appendChild(action);
      body.appendChild(tr);
    });
  }

  $("createRoomBtn").addEventListener("click", () => {
    $("createRoomBtn").disabled = true;
    socket.emit("host:create-room", {}, (res) => {
      $("createRoomBtn").disabled = false;
      if (!res?.ok) { $("createError").textContent = res?.error || "部屋を作成できませんでした。"; return; }
      hostToken = res.hostToken;
      localStorage.setItem("rt_host_token", hostToken);
      showRoom(res.room);
    });
  });

  $("closeRoomBtn").addEventListener("click", () => {
    if (!confirm("部屋を終了しますか？参加者は切断されます。")) return;
    socket.emit("host:close-room", {}, (res) => {
      if (res?.ok) {
        localStorage.removeItem("rt_host_token");
        location.reload();
      } else $("hostMessage").textContent = res?.error || "終了できませんでした。";
    });
  });

  socket.on("connect", () => {
    if (hostToken && !reconnectAttempted) {
      reconnectAttempted = true;
      socket.emit("host:reconnect", { hostToken }, (res) => {
        if (res?.ok) showRoom(res.room);
        else {
          localStorage.removeItem("rt_host_token");
          hostToken = null;
        }
      });
    }
  });
  socket.on("room:update", (data) => { if (room) showRoom(data); });
  socket.on("room:closed", () => {
    $("hostMessage").textContent = "部屋が終了しました。";
    localStorage.removeItem("rt_host_token");
    setTimeout(() => location.reload(), 1600);
  });
  socket.on("connect_error", () => { $("hostMessage").textContent = "サーバーに接続できません。通信状態を確認してください。"; });
})();
