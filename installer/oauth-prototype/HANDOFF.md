# OAuth 安裝器原型 — 交接給雲端總管（2026-07-21 本機總管）

> **一句話**：這是**第二條安裝路線（CF OAuth）的原型**，與同目錄上層的第一刀
> （`installer/src/index.js`，GitHub Builds 部署路線）是**不同路線**，不是取代、不要合併。
> 本機已驗到「leo 親自實裝成功」，交你接手往 P0 推進。

## 為什麼有兩條路線

| | 第一刀（`installer/src/index.js`） | 本原型（`oauth-prototype/worker.js`） |
|---|---|---|
| 部署動力 | GitHub Builds（deploy-all.mjs 非互動版） | **用戶 CF OAuth 授權 → 安裝器代呼 CF API** |
| 用戶要做 | 按 Deploy 按鈕、fork repo 到自己 GitHub | **只點一次授權，不碰 GitHub/token/終端機** |
| 現況 | 第一刀交付、e2e 對 youlin 帳號跑通 | 原型 live、leo 實裝成功、六步全過 |

**leo 2026-07-20 判死 Deploy 按鈕**（強迫用戶懂 GitHub/repo/branch，與「用戶跟複雜 git 脫鉤」衝突）
→ OAuth 是接續主線。第一刀的**部署邏輯（deploy-all.mjs / migrations.json / workflows.json）
仍是真產品安裝的核心資產**，OAuth 路線最終要接上它（見下方 P0-4）。

## 這個原型已驗證什麼（都是實測，非文件推論）

- OAuth client `a314ca87b40e13f5a794c4714560e9ec`（**private，可逆，未升 public**）
- 授權→換 token→建 KV/D1→跑 migration→部署 Worker 並綁定，**全成功**
- access_token 16h；refresh 實測成功（rotation 制，**用過即失效必須存回新的**）
- **CF error 1010**：純腳本請求會被擋（授權端點與 token 端點都會），帶瀏覽器 headers 放行；
  **但 Worker 內部 server-to-server 呼叫不會被擋**（已 probe）→ token 交換可做後端
- 斷點續傳實測依據：worker `PUT` 覆蓋無害／KV·D1 同名報錯需先查詢／
  **migration 會重複塞資料 → 需自建記帳表**

原型網址（private，只有 youlin 帳號可授權）：
https://arcrun-installer.youlin-hsieh-dev.workers.dev/

## 你接手要做的（P0，優先序見頂層 wiki status.md「明天第一件事」）

1. **P0-1 辨識碼驗證**：接 landing `/api/verify-code`（端點已可用，leo 的碼實測回 ok:true）。
   現行輸入框只存 session 不驗證 → 任何拿到網址的人都能裝。
2. **P0-2 斷點續傳**（leo 拍板策略「裝了 1/3 再一次跳過從 2/3 開始」）：
   ⚠️ **連帶必改資源命名**——現行用隨機後綴（`arcrun-rag-<6碼>`），第二次進來認不出上次那組，
   會再建一整套。改用**與用戶身分綁定的可重現名稱**（辨識碼或帳號 id 推導）。
   migration 冪等要自建記帳表（wrangler 用 `d1_migrations` 表，但那是 CLI 功能，Worker 內要自己做）。
3. **P0-3 逾時偵測**：`waitUntil` 中斷→進度永遠停在 running，頁面一直轉。
   加「`startedAt` 超過 N 分鐘仍 running 即判失敗」。
4. **P0-4 接真產品（最大塊）**：現行只裝一顆示範 worker。真產品最小 **15 顆**
   （cypher `wrangler.toml` 寫死 13 個 service binding，缺一顆部署即失敗）。
   **唯一卡點＝bundling**：repo 無 pre-built JS（`.gitignore` 排除 dist/），
   CF API 不做 bundling → 解法＝CI 預先 build 放 R2/CDN，安裝器純 API 抓來上傳
   （wasm 已 commit 進 repo 不必編）。**這裡要接上第一刀的 deploy-all 資產。**

## 已知缺陷（README 有完整清單，這三個最要緊）

- 辨識碼未驗證（同 P0-1）
- 失敗不回收資源 → **不做自動 rollback**（leo 拍板：不做 uninstall，改列「這次建了什麼」清單讓用戶自清）
- 卡在 running 無逾時（同 P0-3）
- 權限膨脹：要了 `vectorize.write` 但流程沒用到 → 用到再要（傷用戶信任）

## 紅線（別踩）

- **OAuth client 升 public ＝ leo 人閘**（永久不可逆＋網域驗證 DNS TXT，CF 輪詢約兩天）。
  P0 修完、private 測到滿意再切。**別自作主張升 public。**
- 判準（leo 定，凌駕分關標準）：**「就算對象是工程師，還是要夠簡單」**——
  任何人不需理解我們內部結構就能裝完。
- **不做 uninstall**（Mac 也沒有，大家用得好好的）。

## 完整脈絡

九關現況與缺口：`system-dev/docs/3-specs/journeys/tester-guide-9-steps.md`（頂層 repo，唯一真相源）。
