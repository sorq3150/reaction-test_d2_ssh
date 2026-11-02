(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const saved = JSON.parse(localStorage.getItem("rt_participant_session") || "null");
  if (saved) {
    $("roomInput").value = saved.roomCode || "";
    $("nameInput").value = saved.name || "";
    $("reconnectNotice").classList.remove("hidden");
  }
  let activeSession = null;

  function joined(data) {
    activeSession = data;
    $("joinPanel").classList.add("hidden");
    $("participantPanel").classList.remove("hidden");
    $("joinedRoom").textContent = data.roomCode;
    $("joinedName").textContent = data.name;
    $("joinedId").textContent = data.participantId;
    $("connectionState").textContent = "接続中";
    $("connectionState").className = "status online";
    $("joinStatus").textContent = data.joinedDuringSession
      ? "測定が進行中のため、次の試行から参加する予定です。"
      : "ホストの操作を待っています。";
  }

  $("joinBtn").addEventListener("click", () => {
    const roomCode = $("roomInput").value.trim();
    const name = $("nameInput").value.trim();
    $("joinError").textContent = "";
    if (!/^\d{6}$/.test(roomCode)) { $("joinError").textContent = "部屋番号は6桁の数字で入力してください。"; return; }
    if (!name || name.length > 24) { $("joinError").textContent = "参加者名を1〜24文字で入力してください。"; return; }
    $("joinBtn").disabled = true;
    socket.emit("participant:join", { roomCode, name }, (res) => {
      $("joinBtn").disabled = false;
      if (!res?.ok) { $("joinError").textContent = res?.error || "接続できませんでした。"; return; }
      const session = { roomCode, name, participantId: res.participant.participantId, participantToken: res.participant.participantToken };
      localStorage.setItem("rt_participant_session", JSON.stringify(session));
      joined({ ...res.participant, roomCode });
    });
  });

  $("leaveBtn").addEventListener("click", () => {
    if (!confirm("この端末の参加情報を削除して退出しますか？")) return;
    socket.emit("participant:leave", {}, () => {
      localStorage.removeItem("rt_participant_session");
      location.reload();
    });
  });

  socket.on("connect", () => {
    const session = JSON.parse(localStorage.getItem("rt_participant_session") || "null");
    if (!session?.participantToken) return;
    socket.emit("participant:reconnect", { ...session }, (res) => {
      if (res?.ok) joined({ ...res.participant, roomCode: session.roomCode });
      else {
        $("reconnectNotice").textContent = "以前の参加情報では再接続できません。部屋が終了した可能性があります。";
        $("reconnectNotice").classList.remove("hidden");
      }
    });
  });
  socket.on("disconnect", () => {
    if (activeSession) {
      $("connectionState").textContent = "切断";
      $("connectionState").className = "status offline";
      $("joinStatus").textContent = "通信が切断されました。接続が戻ると再接続を試みます。";
    }
  });
  socket.on("room:closed", () => {
    $("joinStatus").textContent = "ホストが部屋を終了しました。";
    localStorage.removeItem("rt_participant_session");
  });
  socket.on("participant:removed", () => {
    localStorage.removeItem("rt_participant_session");
    $("joinStatus").textContent = "ホストによって部屋から退出されました。";
  });
})();
