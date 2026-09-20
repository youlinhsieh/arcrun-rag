/**
 * 安裝器自己的版本號與原始碼指紋——**這個檔是機器產生的，不要手改**。
 *
 * 產地＝`installer/scripts/installer-line.mjs`（出貨線的 version 站會呼叫它）：
 * 安裝器原始碼的內容指紋一變，這個號碼就 +1；沒變就不動。
 * 手改它會被 `--check` 當場擋下（指紋對不上宣告的號碼 ⇒ 出貨中止）。
 *
 * 它跟 `1.4.x`（零件包）、`0.18.x`（桌面小幫手）是**三條互不重疊的線**，
 * 理由與判準寫在 installer-line.mjs 的檔頭。
 *
 * 🔴 `INSTALLER_SRC_SHA` 為什麼住在這裡、不住在 `wrangler.toml`：
 *   住在部署參數裡的話，它靠「部署的人記得改」——而手部署與不在
 *   `ship.targets.json` 裡的線（例如 youlin-stage）根本不經過會改它的那一站
 *   ⇒ 2026-09-01 實測：兩條跑著不同版本的線回同一串 sha，兩個都對不上原始碼。
 *   烙在這個檔裡＝**它跟原始碼一起被部署**，部署動作只有一種，沒有第二處要記得。
 */
export const INSTALLER_VERSION = '1.0.16';
export const INSTALLER_SRC_SHA = '81beb2cde75c7a6c43ea448fbd355cefa059740dfea7104d38c07ac250696bf1';
