# prod 市集切換手冊（inkstone/arcrun-rag#381）

狀態（2026-11-28）：市集的家已建、程式與登錄簿已就位；**prod 安裝站還沒部署、第一次市集上架還沒做**（兩步都要 AHub 簽核，簽核人 leo）。

## 已做（不動 prod 行為）
1. uncle6 帳號建了私有 R2 bucket `arcrun-market`（未開公開網域；r2.dev／arcrun.dev DNS 被自動檢查擋下，改走 worker binding，免公開面）。
2. `installer/oauth-prototype/wrangler.toml` 頂層（prod）綁 `MARKET`；`worker.js marketRead` 優先讀它（測試 `worker-apps.test.mjs`）。
3. `ship.targets.json` prod 加 `market` 區塊，標 `mainShipCarriesApps: true`（過渡旗標：切換完成前主程式出貨照舊帶 /apps 目錄，不留空窗）。

## 之後（等簽核，一條一條）
1. **簽核單 A（主程式切換版）**：prod 主程式出一班（`ship.mjs --target prod --confirm --ship-version <版> --ship-ticket <票>`），內容＝安裝站認得 `MARKET`。此時 bucket 空、沒有指標，/apps 照舊讀零件包釘子（行為不變）。
2. **簽核單 B（第一次市集上架）**：`node installer/scripts/ship-market.mjs --target prod --source <已上 stage 的 Arcrun commit 的乾淨 checkout> --ticket <票>` 預演會印出「哪些 App 從幾版到幾版」，貼進簽核單；簽完加 `--confirm`。上架後 `/apps/current.json` 由 404 變 200。
3. 落帳後把 `ship.targets.json` prod `market` 的 `mainShipCarriesApps` 兩行拿掉，主程式出貨從此不再帶 App 包。
4. 之後 App 新版只走 `ship-market.mjs --target prod`＋一張市集簽核單。回退＝把 `market/current.json` 翻回前一版。

## 注意
- 預演的 App 原稿來源要是「已上 stage 的那顆 Arcrun commit」。2026-11-28 實測 Arcrun main 的 ahub 0.75.0 過不了 build-feed 的 code 節點棘輪（Arcrun#562），用 c02cb22（stage 1.4.335 的來源）預演得到市集版 `2026.11.28-adb7445`（ahub 0.72.0 → 0.74.0）。
- 不要在步驟 1 完成前宣告 `mainShipCarriesApps` 以外的 market 行為；順序反了會出現 /apps 空窗。
