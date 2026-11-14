# 小幫手連企業私有雲（inkstone/arcrun-rag#335）

私有雲＝`inkstone/Arcrun#409` 的 docker 映像檔（網頁 :8080、API :8081）。小幫手端不用改設定檔格式：同一個「連線」流程，網址換成公司的位址就行。

## 配對
- 網址欄貼網頁網址（`http://主機:8080`）或 API 網址都可以。明確打 `http://` 就用 http；沒打協定一律補 https。
- 網頁網址打 `/portal/daemon/config` 不是 API 時，小幫手讀該網址的 `/config.js`（`apiBase`）換到 API 再打一次；帳密錯這類真的回應**不會**重打。
- 配對結果寫進 `~/.arcrun-rag/config.json` 的 `accounts[]`，與 Cloudflare 帳號並存；一個資料夾只掛在一個帳號底下（`watch_folders`），各帳號的資料、AI、憑證互不相通。

## 映像檔剛起好之後要補兩件事（雲端 2026-11-14 實測）
1. 部署 RAG 工作流：`install/push-workflow-update.sh`（`CYPHER` 填 API 位址、`KBDB`／`HTTPREQ`／`CODE` 填 `http://arcrun-kbdb.priv.local` 等引擎內部位址、`ARCRUN_BEARER` 填配對拿到的 `kbdb_key`）。
2. 在私有雲的金鑰保存處建 `kbdb_internal_token`（值＝容器 `/data/secrets/secrets.json` 的 `kbdb_token`）。少了它，卡片寫入回 500「內部金鑰沒有裝上去」。
這兩件理應由映像檔／精靈自己做，已回報 Arcrun#409。

## 無頭驗證（不需桌面 App）
`go test -run PrivateCloudLive ./cmd/arcrun-app`（環境變數見 `private_cloud_335_live_manual_test.go`）配對，再 `collector direct --config <config.json> --once`。
