# 反射神経測定Webアプリ（研究用）

高校の研究・実験で、複数端末の反応時間を測定・保存・分析するWebアプリです。
Express + Socket.IO + SQLite（サーバー）/ HTML・CSS・JavaScript + IndexedDB（参加者端末）。

> **測定上の限界（必ずお読みください）**
> ブラウザのJavaScriptでは、ディスプレイが物理的に発光した正確な時刻を直接測定できません。
> 本アプリは `requestAnimationFrame()` で描画を指示した時刻を「画面切り替え時刻」として記録します。
> 実際の表示まではディスプレイの応答時間・コンポジタ・フレーム周期（60Hzなら最大約16.7ms）の遅れが加わり、
> 端末ごとに異なります。また入力デバイス（キーボード・タッチパネル）の遅延も含まれません。
> 端末間の比較では `device` / `browser` / `os` / `sync_quality` / `frame_delay` を併せて確認し、
> 絶対値より「同一端末内の比較」を重視してください。

## 参加上限

| 項目 | 値 |
|---|---|
| 初期値 | **100台** |
| 設定可能範囲 | 10〜300台（範囲外は自動補正し、起動ログに警告） |
| 変更方法 | 環境変数 `MAX_PARTICIPANTS`（Render の Environment で変更→再デプロイ） |
| 画面表示 | サーバーから取得した実際の値（`参加者数：N / 100 台`）。HTMLに固定値は書いていません |

300台は**設定上の最大値であり、安定動作を保証する台数ではありません**。推奨台数は `docs/TEST_REPORT.md` を参照してください。

## ローカル実行

```bash
# Node.js 22.23.5 以上（22系）が必要
npm ci
npm start          # http://localhost:3000  （ホスト: /host.html 参加者: /）
npm test           # 結合テスト＋参加者画面テスト（約1分）
npm run test:load  # 負荷試験（1/10/30/50/100台・ループバック）
```

## Render へのデプロイ

1. GitHub にこのフォルダの中身をそのままアップロードする。
2. Render で **New → Web Service**、リポジトリを選択。Runtime は **Node**。
3. 設定:
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. **Disks** で Persistent Disk を追加（**Mount Path: `/var/data`**）。
5. **Environment** に設定:
   - `DB_PATH=/var/data/reaction-test.sqlite`（Mount Path と必ず一致させる）
   - `MAX_PARTICIPANTS=100`
6. デプロイ後、`https://<サービス名>.onrender.com/health` を開き、`maxParticipants` と `version` を確認。

`render.yaml`（Blueprint）も同梱しています。

### Render の制約・注意

- **Persistent Disk を使うには、Render の有料インスタンスが必要です（最新の条件は Render 公式ドキュメントで確認してください）。** ディスクが無い構成ではファイルが再デプロイ/再起動で消えるため、研究データの保存には使わないでください。
- Disk を使うサービスは**1インスタンス**のみ。SQLite を複数インスタンスで共有する構成にはしないでください（スケールアウト不可）。
- Disk を使うサービスはデプロイ時に短い停止が起こり得ます（Render公式で確認してください）。**測定中のデプロイ・再起動は避けてください**（測定中だった部屋は安全のため「一時停止」で復元されます）。
- メモリ: 5万件のExcel出力時にサーバーのメモリが一時的に約120MB増えました（試験環境）。小さいプランでは測定終了後に出力してください。
- Node.js の版は `.node-version`（22.23.5）で固定しています。
- 公開URLのHTTPS/WSSはRenderが終端します。`TRUST_PROXY` は Render 上で自動的に有効になります。

### 環境変数

| 名前 | 既定値 | 説明 |
|---|---|---|
| `PORT` | 3000 | Render が自動設定 |
| `DB_PATH` | `./data/reaction-test.sqlite` | SQLite の保存先。Render では `/var/data/...` |
| `MAX_PARTICIPANTS` | 100 | 1部屋の参加上限（10〜300） |
| `MAX_ROOMS` | 100 | 同時に開ける部屋数（1〜1000） |
| `MAX_CONNECTIONS` | 1500 | サーバー全体の同時接続数 |
| `MAX_CONN_PER_IP` | 600 | 同一IPからの同時接続数（学校のNATを考慮して大きめ） |
| `MEM_WARN_MB` | 400 | RSSがこの値を超えるとログに警告 |
| `TRUST_PROXY` | Renderで自動 | `1`/`true` でプロキシ背後のIPを `X-Forwarded-For` の最後の要素から取得 |
| `ALLOWED_ORIGINS` | なし | 追加で許可するWebSocketのOrigin（カンマ区切り） |

## 使い方

1. ホストが `/host.html` で部屋を作成（6桁の部屋番号とホスト専用トークンを発行。トークンはブラウザに保存され、再接続に使用）。
2. 参加者は `/` から部屋番号と名前で参加。参加者IDは自動発行（名前と別管理）。同じ部屋で名前は重複不可。
3. ホストが回数（1〜500）と待機時間（0.5〜30秒、最短≦最長）を設定し、測定開始。
4. 参加者は右上の ✕ でオプションを閉じると測定入力が有効になる（オプション表示中は入力無効）。
5. 測定終了後、各端末が結果を一括送信し「送信完了」を表示。ホストは「集計を更新」→ CSV / Excel 出力。

### 測定の仕組み

- サーバーは試行ごとに**全端末共通の予定時刻（約2.5秒以上先）**だけを通知します。
- 端末は `clock:ping` を複数回行い、最小RTTの標本からサーバー時刻とのオフセットを求め、
  `performance.now()` 基準で切り替え時刻を計算し、直前に `requestAnimationFrame()` で赤に切り替えます。
- 反応時間は端末内（`performance.now()`）で計測し、**測定中はサーバーへ送信しません**。
- 早押し（切り替え前の入力）、タイムアウト（切り替え後3秒無入力）、タブ非表示、通信切断、一時停止、取り逃がしは
  いずれも**削除せず無効データとして保存**し、`invalid_reason` を記録します（`early` / `timeout` / `hidden` / `disconnected` / `paused` / `missed` / `late_schedule`）。
- 入力方式は `keyboard` / `touch` / `mouse` / `pen`（旧版の `pointer` から細分化）。キーのリピートと2回目以降の入力は無視。
- 途中参加者は進行中の試行には参加せず、次の試行から**設定回数ぶん**測定します。測定済みの参加者に追加試行は送りません。
- 測定の再開始（終了後に再度開始）は `run`（測定回）番号で区別して保存されます。

### 記録項目

`participant_name / participant_id / run / trial / reaction_time_ms / input_type / status / invalid_reason /
scheduled_time / local_change_time / input_time / clock_offset_ms / rtt_ms / sync_quality / frame_delay_ms /
visibility_state / browser / os / device / created_at`（時刻は端末のエポックms）。

`sync_quality`: `good`（RTT≦50ms かつ描画遅延≦20ms）/ `fair`（≦150ms・≦50ms）/ `poor` / `unknown`。
**この閾値は本アプリの暫定基準です。研究では実測分布を見て調整してください。**

### データ保存

- 参加者端末: 参加者ごとに別の IndexedDB（`reactionTestParticipant_<参加者ID>`）。送信完了後も端末内に残ります。共用端末では研究終了後にブラウザのサイトデータを削除してください。
- サーバー: SQLite（部屋・参加者・設定・結果）。部屋を終了しても結果は保持。サーバー再起動後に復元（測定中の部屋は自動再開せず一時停止）。
- 重複防止: サーバー側のキーは `参加者ID:run:試行番号`。再送しても二重登録されません。受信確認は `accepted + duplicates + rejected = 送信件数` で、拒否が1件でもあれば端末は「送信完了」とせず再試行します。
- 結果出力: CSV（UTF-8 BOM付き）/ Excel。サーバーから全件をストリーミングします。CSV/Excelの数式インジェクション（名前が `=` 等で始まる場合）は無害化します。標準偏差は**母集団標準偏差**（旧版仕様を維持）。

### 既知の制限

- ホストが部屋を終了した時点でオフライン/強制退出された参加者の未送信データは、その端末のIndexedDBに残りますが、サーバーには自動送信されません。
- 測定中・一時停止中は設定を変更できません（旧版は一時停止中のみ変更可能でした）。
- 放置された未終了の部屋は自動では閉じません。
- ホストトークンはブラウザの localStorage に保存されます。共用PCでは使用後に「部屋を終了」し、ブラウザのデータを削除してください。

詳細: `docs/CHANGES.md`（変更点）、`docs/SECURITY.md`（セキュリティ調査）、`docs/TEST_REPORT.md`（試験結果・未検証項目）。
