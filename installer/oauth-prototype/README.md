# Arcrun RAG 一鍵安裝器（原型）

單一 JS module worker，零框架零 npm 依賴。讓使用者用自己的 Cloudflare 帳號，
一鍵在**他們自己的**帳號底下建立一整套 Arcrun RAG 執行環境。

## 它做了什麼

使用者按下「連結我的 Cloudflare 帳號」後，安裝器會依序：

1. 取得使用者的 Cloudflare 帳號清單（多帳號時原型先取第一個）
2. 建立一個 KV namespace（文案上叫「快取空間」）
3. 建立一個 D1 database（文案上叫「知識庫資料庫」）
4. 對 D1 送一批 migration SQL（`entries` + `meta` 兩張表 + 一筆範例資料）
5. 部署一顆示範 Worker，綁上剛建立的 KV 與 D1
6. 打新 Worker 的 `/health` 做端到端自檢，確認 binding 真的通了

全部資源都用 `arcrun-rag-<email 推導 8 碼>` 命名（可重現）：同一用戶重裝取用同一組，
不重建、不撞名——這是斷點續傳（P0-2）的基礎。

## 檔案

| 檔案 | 說明 |
|------|------|
| `worker.js` | 全部程式（路由 / OAuth / 安裝流程 / 內嵌 HTML） |
| `wrangler.toml` | 部署設定，KV id 是佔位符**必須先填** |
| `README.md` | 本檔 |

## 路由

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/` | 安裝首頁（含邀請碼輸入框） |
| GET | `/auth/start` | 產生 PKCE verifier/challenge + state 存 KV（TTL 10 分），302 導去 CF 授權頁 |
| GET | `/auth/callback` | 比對 state（不符擋下）、換 token、存 KV、導到 `/install` |
| GET | `/install` | 安裝進度頁 |
| GET | `/install.js` | 進度頁前端腳本 |
| POST | `/api/install/start` | 觸發安裝（`ctx.waitUntil` 背景跑，立即回應） |
| GET | `/api/install/status` | 回目前進度 JSON |
| POST | `/api/setup-account` | 帳密精靈：代理實例 `console/setup`→（409 則 `console/login`）→`portal/admin/bootstrap`；帳密只過境不落地（t20④d-3） |
| GET | `/healthz` | 安裝器自己的存活檢查 |

進度回報選了**輪詢**（1.5 秒一次）而不是 SSE：安裝步驟只有 6 步、
背景任務跑在 `waitUntil` 裡而不是同一個請求裡，輪詢可以跨頁面重整存活，
比 SSE 長連線可靠得多。

## 部署步驟

```bash
cd installer

# 1. 建 KV namespace（正式 + preview 各一個）
wrangler kv namespace create INSTALLER_KV
wrangler kv namespace create INSTALLER_KV --preview

# 2. 把上面印出的 id 貼進 wrangler.toml 的 id / preview_id

# 3. 部署
wrangler deploy
```

部署後會拿到一個 `https://arcrun-installer.<你的子網域>.workers.dev` 網址。

### ⚠️ OAuth redirect_uri 必須先註冊

`redirect_uri` 是用 `url.origin + /auth/callback` 動態組出來的。
Cloudflare 的 OAuth app 會嚴格比對 redirect_uri，所以**部署後的實際網址
必須已經登記在該 OAuth client 的允許清單裡**，否則授權頁會直接報錯。

換網域（例如從 workers.dev 換到自訂網域）時，要同步更新註冊，不然會壞掉。

## 怎麼測

### 本地

```bash
wrangler dev
```

本地 `http://localhost:8787` 走 OAuth 會失敗，因為 `localhost` 幾乎確定
不在 redirect_uri 白名單裡。**首頁 UI、404 頁、`/healthz` 可以在本地看**，
但完整流程需要部署到真實網址測。

### 端到端

1. 開部署後的網址
2. 邀請碼隨便填或留空（原型只存不驗證）
3. 按「連結我的 Cloudflare 帳號」→ 在 CF 頁面確認授權
4. 自動跳回 `/install`，看六個步驟逐一亮起
5. 完成後畫面會醒目顯示 instance 網址，點進去應該看到：

```json
{
  "service": "arcrun-rag",
  "ok": true,
  "checks": {
    "cache": { "ok": true },
    "database": { "ok": true, "entries": 1 }
  }
}
```

`ok: true` 就代表 KV 與 D1 binding 都真的接上了。

### 錯誤路徑測試

- **state 不符**：手動改 callback 網址的 `state` 參數 → 應該被導回首頁並顯示「這個連結已經失效了」
- **取消授權**：在 CF 授權頁按拒絕 → 導回首頁顯示「你在 Cloudflare 頁面上取消了授權」
- **重複安裝**：完成後在進度頁按「重新安裝」→ 用同一組 email 推導的可重現名稱，**取用上次那組**（不重建、不撞名）

## 設計要點

**PKCE / 無 secret** — client 是 public client，`client_id` 直接寫在程式碼常數區，
不存在 `client_secret`，所以這份程式碼裡沒有任何 secret 需要保護。

**refresh token rotation** — Cloudflare 的 refresh token 用過即失效、回應會給新的一把。
`getAccessToken()` 在 refresh 之後**一定會把新的 refresh_token 寫回 KV**
（`fresh.refresh_token || raw.refresh_token`，對方沒給才沿用舊的）。
access token 過期判斷留了 5 分鐘安全邊際。

**CSRF 防護是雙重的** — 不只比對 KV 裡的 state，還要求 cookie 裡的 session id
必須等於當初發出該 state 時綁定的 sid。state 一經使用立刻從 KV 刪除，確保一次性。

**錯誤處理** — 所有 CF API 錯誤都經過 `cfFetch` 翻譯成 `InstallError`，帶三個欄位：
`message`（發生什麼，人話）、`hint`（可以怎麼辦）、`detail`（技術細節，收在摺疊區）。
任何一步失敗，進度頁會明確標出**卡在哪一步**、給可行動的建議，並提供「重新安裝」按鈕。
最外層還有一層 try/catch 兜底，不會出現裸 500。

**自檢步驟是 warn 不是 error** — 新部署的 Worker 有傳播延遲，健檢重試 5 次仍不過
只標黃色警告，不把整個安裝判定為失敗（資源其實都建好了）。

**文案** — 面向使用者的文字完全不出現 KV、D1、binding、namespace 這些詞，
一律說「快取空間」「知識庫資料庫」「專屬服務」。技術細節放在 `<details>` 摺疊區。

---

## 還沒處理的邊界情況（誠實清單）

以下是原型刻意或非刻意留下的缺口，上線前需要處理：

### 辨識碼（P0-1 ✅ 已修，[cloud-worker] 2026-07-21）
- 首頁表單改必填 **Email + 辨識碼**；`/auth/start` 先打 landing `/api/verify-code`
  驗 `{email, code}`，**驗不過就不進 OAuth**（302 回首頁 error）；`/api/install/start`
  另有防禦縱深（session 未驗證回 403）。fail-closed（連不上中央服務也拒）。
  → 「任何人拿到網址就能裝」的開放缺口已關閉。（landing 端 normalize 亦小寫，無大小寫誤拒）

### 多帳號
- **只取第一個帳號**，沒有做選擇 UI。使用者若有多個 Cloudflare 帳號
  （例如個人 + 公司），可能會裝到錯的那個。
  `progress.result.accounts` 已經把完整清單存下來了，UI 補上即可。

### 中斷與重試（P0-2 / P0-3 ✅ 已修，[cloud-worker] 2026-07-21）
- **斷點續傳取代 rollback**（leo 拍板：不做 uninstall，改列「這次建了什麼」讓用戶自清）。
  資源命名改成 **email 推導的 8 碼可重現名**（`arcrun-rag-<slug>`），重裝認得上次那組；
  KV/D1 走 `ensure*`（先查同名取用、沒有才建）＝冪等；migration 種子 guard 掛 `entries`
  自身（單一原子語句，不賭 D1 多語句非交易），重跑不重複塞。→ 「重裝孤兒越積越多」已解。
- **逾時偵測已補**：`writeProgress` 蓋 `updatedAt`，`/api/install/status` 見 running 但
  超過 `STALL_MS`(120s) 沒更新即判 `error` 落庫，頁面停止空轉、導向「重新安裝」（續傳接手）。
  自檢輪詢每輪回寫 updatedAt，故正常慢步驟不會誤判；health fetch 另加 10s timeout。
- **仍未處理：防重入鎖**。兩分頁同時 POST `/api/install/start` 帶 `restart:true` 理論上
  仍可能各跑一套（KV 非原子）。冪等 ensure* 大幅降低傷害（同名取用不重建），但嚴格單跑
  需 Durable Object，超出 P0 範圍。

### KV 一致性
- **KV 是最終一致的**，不是強一致。進度寫入後前端立刻讀，理論上可能讀到舊值。
  實務上安裝步驟間隔夠長，不太會撞到，但快速連續的步驟（例如 schema 完成到
  deploy 開始）可能顯示順序有瑕疵。要嚴謹的話應該改用 Durable Object。

### 網址開通
- **workers.dev 子網域可能沒開通**。如果帳號從來沒用過 Workers，
  `/workers/subdomain` 可能回 404 或空值。目前的處理是降級顯示
  「服務已裝好但還沒有網址」，但**沒有提供讓使用者自己開通的指引**。
- **沒處理 workers.dev 被停用的帳號**（部分企業方案會關掉）。

### 權限與方案
- **沒有預先檢查帳號方案**。如果使用者的帳號在 D1 或 Workers 額度上限
  （例如免費方案 D1 database 數量上限），會直接撞 CF API 錯誤，
  雖然會顯示訊息，但不會事先告知「你的方案不夠」。
- **`vectorize.write` scope 有要但完全沒用到**。目前流程沒建任何 Vectorize index，
  卻要求了這個權限，是不必要的權限膨脹。

### Session 與安全
- **session cookie 沒有跨裝置概念**。使用者在手機授權、想在電腦看進度是不行的。
- **token 明文存在 KV**。雖然有 TTL，但 KV 內容對有安裝器 KV 存取權的人是可讀的。
  正式環境應該考慮加密後再存。
- **沒有 rate limiting**。`/auth/start` 可以被無限打，會塞爆 KV 的 state 條目
  （雖然有 10 分鐘 TTL 會自清）。
- **沒有登出 / 撤銷授權的路徑**。使用者裝完之後沒辦法從安裝器這邊主動撤掉 token。

### 部署內容
- **示範 Worker 的內容是寫死的**，不是真的 Arcrun RAG。它只做 binding 自檢，
  沒有實際的 RAG 功能（embedding、檢索、Vectorize）。
- **沒有版本管理**。重複安裝會建全新的一套，沒有「更新既有 instance」的路徑。
- **migration 沒有版本追蹤機制**。`meta.schema_version` 有寫進去但沒人讀它，
  將來要做 schema 升級時需要真正的 migration 框架。

### 其他
- **`compatibility_flags: ['nodejs_compat']` 是給部署出去的 instance worker 用的**，
  但那顆 worker 其實沒用到任何 node API，可以拿掉以減少不必要的設定。
- **`/install` 頁面重整後會重新 POST `start`**，靠 `alreadyRunning` 檢查擋住，
  但如同上面說的，KV 最終一致性讓這個檢查不是 100% 可靠。

## 測試（P0-1/2/3 離線回歸，[cloud-worker] 2026-07-21）

```bash
node --experimental-sqlite --test worker.test.mjs   # 需 Node ≥ 22，零依賴、不觸網
```

`worker.test.mjs` 把「README 宣稱已修」變成可重跑證據（22 案例，全綠）：
- **P0-1 辨識碼閘**：`verifyInviteCode` fail-closed（缺參/429/500/連不上/非 JSON 全拒）＋
  `/auth/start` 驗不過不進 OAuth、通過才記 `inviteVerified:true`＋`/api/install/start` 未驗 403。
- **P0-2 冪等**：`slugFromEmail` 可重現/正規化、`ensureKv/D1` 同名取用不重建、
  **`MIGRATION_SQL` 對真 `node:sqlite` 連跑兩次＝種子恰一筆**（D1 底層即 SQLite）。
- **P0-3 逾時**：`/api/install/status` 對 stalled(running 超時) 判 error、對剛更新的不誤殺。

CF API 與 landing 皆用 mock，D1 用內建 SQLite 真跑 migration，**不需任何 Cloudflare 帳號**。
（測試專用具名匯出見 `worker.js` 末段 `export {…}`；CF runtime 只認 `default.fetch`，無副作用。）

> ⚠️ 仍未涵蓋（需真部署）：完整 OAuth 授權往返、`deployBundledWorker` 帶 wasm 的多模組上傳
> （part 名 ↔ import specifier）＝P0-4 首次真部署驗（沙箱測不到）。
