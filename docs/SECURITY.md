# セキュリティ調査・対策記録

調査日: 2026-11-26（作業環境: Node.js v22.23.5, npm 10.9.9）
「脆弱性ゼロ」を保証するものではありません。下記は**調査した範囲と、その時点の結果**です。

## 1. 外部情報の確認

| 項目 | 確認元 | 確認結果 |
|---|---|---|
| Upload2Shell（CVE-2026-125396） | Render公式 `https://render.com/docs/advisory-upload2shell`（本日取得）、Sophos、pwn.ai の記事も検索結果に存在 | 研究者が2026-11-21に詳細を公開、Renderの勧告は2026-11-23付。GhostscriptのサンドボックスRCE。ImageMagick/Pillow経由でも影響。Native Runtime: 自前同梱のGhostscriptは10.08.0以上へ、Render提供版は**2026-11-20 20:00 UTC以降に正常デプロイが1回以上**あれば対応済み |
| Node.js | nodejs.org 2026-11-11 セキュリティリリース（検索結果） | 修正版: 22.23.5 / 24.22.3 / 26.13.1。本プロジェクトは **22.23.5 に固定**（`.node-version`, `engines`）。Node 18/20 は対象外のため `engines` から除外 |
| Render の Node 版 | Render docs "Setting Your Node.js Version" | 版は `.node-version` / `NODE_VERSION` で指定可能。**未指定の古いサービスは作成時点の既定版のまま**の可能性があるため、固定した |
| SheetJS `xlsx@0.18.5`（旧 host.html がCDNから読込） | GitHub Advisory/各種DB（検索） | prototype pollution（CVE-2023-30533）・ReDoS（CVE-2024-22363）が報告済みで、修正版はnpmには無くSheetJS自身のCDN配布。npm audit の対象外。→ **廃止し、サーバー側 ExcelJS 出力に置換**（外部CDN依存も消滅） |

## 2. Ghostscript（Upload2Shell）への該当性

- 依存関係のスキャン: `npm ls --all` に ghostscript / imagemagick / pillow / sharp / canvas / pdf 系なし（`@napi-rs/canvas` は jsdom の**任意**依存で、開発用のみ・本番には入らない）。
- ソース全体で `child_process` / `exec` / `spawn` の使用なし。Dockerfile なし。PDF・PostScript・EPS・画像のアップロード/変換機能なし。
- **結論: Ghostscript を使用する経路は存在しません。** 本アプリはGhostscriptを同梱・インストールしておらず、何もインストールしていません。
- Render Native Runtime でシステムのGhostscriptが入っていても、本アプリはそれを呼び出しません。ただし念のため、**Renderダッシュボードの Deploys で 2026-11-20 20:00 UTC 以降に成功したデプロイがあるか**を確認してください（無ければ Manual Deploy）。**この確認は私の環境からは行えず、未確認です。**
- 将来 PDF/画像変換機能を追加する場合は Ghostscript 10.08.0 以上を使用し、`-dSAFER` に依存しない隔離（別プロセス/コンテナ・入力形式の許可リスト）を行ってください。

## 3. npm 依存関係

| 確認 | 結果 |
|---|---|
| 元の package.json を新規解決して `npm audit` | 0件（ただし元リポジトリに lockfile が無く、デプロイごとに版がずれる状態だった） |
| `npm audit`（全依存・開発含む） | **0件**（最終版 lock で実行） |
| `npm audit --omit=dev` | **0件** |
| 初回の audit で出たもの | `uuid <11.1.1`（GHSA-w5hq-g745-h8pq、moderate）。exceljs 4.4.0 が `uuid@8` に依存。`npm audit fix --force` は exceljs 3.4.0 への**ダウングレード**を提案したため不採用。`package.json` の `overrides` で `uuid@^11.1.1` に固定し、ExcelJSの出力を実テストで確認 |
| `npm outdated` | express 4.22.3（最新は 5.3.0 のメジャー更新。4.x の最新に追随済みで、audit も 0 のため据え置き。Express 5 への移行は別途テストが必要） |
| 主な版 | express 4.22.3 / socket.io 4.8.4 / better-sqlite3 13.2.0 / exceljs 4.4.0 / helmet 8.3.0 / uuid 11.1.1 |
| lockfile | `package-lock.json` を生成。クリーン環境で `npm ci` → 起動 → テスト12件成功を確認 |
| 注意（ExcelJS） | exceljs 4.4.0 は最終更新が2024年12月で、古い推移的依存（archiver 5 / unzipper 等）を含み deprecation 警告が出ます。現時点で audit は 0 ですが、今後の新規勧告に注意してください |
| `.npmrc` | `ignore-scripts=true`。依存パッケージのインストールスクリプトを実行しない（サプライチェーン対策）。better-sqlite3 13 はビルド済みバイナリ同梱。※ `ignore-scripts` が無いと、lockfile からの `npm ci` で better-sqlite3 に対し暗黙の `node-gyp rebuild` が走ることを確認したため必須 |

## 4. コード上の脆弱性と修正

| # | 問題 | 深刻度 | 修正 |
|---|---|---|---|
| 1 | **Socket.IOのハンドラに `null` を1回送るだけでサーバープロセスが終了（未認証のDoS）**。旧サーバーで再現確認（exitCode 1） | 高 | 全イベントを共通ラッパーで処理（payload/ack の型検証、例外の捕捉）。ファジング試験で全イベント×不正payloadを送ってもプロセス生存 |
| 2 | ホスト/参加者トークンをDBに平文保存 | 中 | SHA-256ハッシュで保存し、タイミング安全に照合。旧DBの平文は起動時に自動移行（移行試験あり） |
| 3 | 部屋番号（6桁）の総当たり、トークン照合の無制限試行 | 中 | IP単位の失敗回数制限（学校NATを考慮し「失敗のみ」カウント）。再接続の失敗も制限 |
| 4 | 端末ごとのイベント頻度が無制限 | 中 | トークンバケット（20イベント/秒、バースト40）。過剰なら切断 |
| 5 | CSV/Excel 出力の数式インジェクション（名前に `=HYPERLINK(...)` 等） | 中 | `= + - @ \t \r` で始まる文字列に `'` を前置。試験あり |
| 6 | 外部CDNの脆弱なSheetJS（SRIなし） | 中 | 廃止。外部スクリプトはゼロに（CSPで強制） |
| 7 | `frontend/css/server.js`（古いサーバーのソース）が静的配信され公開されていた | 低 | 削除。`/css/server.js` は404（試験あり） |
| 8 | セキュリティヘッダ無し | 中 | helmet + CSP（`script-src 'self'` など）、HSTS、nosniff、frame-ancestors none、`x-powered-by` 無効 |
| 9 | 結果が受理されなかった場合も端末が成功扱い（データ消失） | 高 | 受信確認の件数照合。拒否1件でも再試行 |
| 10 | 他人の参加者ID・未来/範囲外の試行番号・異常値の結果を受理可能 | 中 | サーバーで全項目を検証・正規化（長さ・範囲・参加者IDの一致・試行範囲）。1回の送信は100件まで |
| 11 | 他サイトからのWebSocket接続 | 低 | `allowRequest` で Origin を同一ホストに限定（`ALLOWED_ORIGINS` で追加可） |
| 12 | 過大リクエスト | 低 | Socket.IO `maxHttpBufferSize` 256KB、JSONボディ 2KB、同時接続数/IP/部屋数の上限 |

### CSRF について
HTTPの状態変更は結果出力（読み取りのみ）の `POST /api/export/*` だけで、認証は **Cookieではなくリクエスト本文のホストトークン**です。Cookieを使わないためCSRFの対象になりません。トークンはURLに載せません（ログ・履歴対策）。

### SQLインジェクション
すべて `better-sqlite3` のプリペアドステートメント。動的SQLは `db.js` の列追加（固定の識別子のみ）だけです。

### XSS
ホスト画面は参加者名などを `textContent` で描画（`innerHTML` は固定文字列のみ）。さらにCSPでインラインスクリプトを禁止。

### 残る注意点（未対応・要運用）
- ホストトークンは localStorage に保存（XSSが無い前提）。共用PCでは使用後に削除。
- 部屋番号は6桁の数字で、知っていれば誰でも参加できます（参加の認証はありません）。外部公開URLでの運用時は、測定中以外は部屋を閉じてください。
- レート制限はメモリ上でインスタンス単位です（単一インスタンス運用が前提）。
- Render側の設定（デプロイ日時、プラン、ディスク）は**私の環境から確認できず、未確認**です。
