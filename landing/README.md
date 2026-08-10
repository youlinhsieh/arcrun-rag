# arcrun-landing — Landing page + 啟動碼中央服務

Arcrun RAG 的門面：一顆 Cloudflare Worker，同時是 landing page 和啟動碼發放/驗證的中央小 API。純 JS module worker，零框架、零 npm 依賴，整個目錄自足（未來 Deploy 按鈕的子目錄隔離需求）。

- **預覽站**：https://arcrun-landing.uncle6-me.workers.dev （uncle6 帳號＝**官方件**）
- 🔴 **部署它＝出貨動作，需 leo 開閘**；uncle6 不是測試場，測試一律走 youlin（見 repo `CLAUDE.md`「範例在哪、測試在哪」）
- SDD：ingest-hash-trigger task 12 第一片

## 端點

| 端點 | 方法 | 說明 |
|---|---|---|
| `/` | GET | 單頁 landing（HTML 內嵌，正體中文，responsive） |
| `/api/request-code` | POST | `{email, subscribe}` → 驗格式、生 8 碼啟動碼（大寫、去 0/O/1/I 混淆字元）、存 KV。**冪等**：同 email 重複請求回同一碼。**回應絕不吐 code**（防略過 email 驗證）。 |
| `/api/verify-code` | POST | `{email, code}` → 比對 KV，中 → 標 `activated:true` 回 `{ok:true}`，不中回 `{ok:false}`。 |
| `/api/health` | GET | `{ok:true}` |

兩個 POST 端點有極簡防灌：同 IP 每分鐘 10 次（KV TTL 計數）。

## KV 資料（binding `SIGNUPS`）

- `email:<email>` = `{code, subscribe, created_at, activated, activated_at?}`
- `code:<code>` = email
- `rl:<ip>:<minute>` = 計數（TTL 120s，防灌用）

## EMAIL_ENABLED 開關（寄信路徑）

程式碼已寫好寄信路徑，預設關閉。開通前置：

1. uncle6（或未來官方）帳號要有一個 zone 設好 **Email Routing** 的寄件位址（如 `noreply@arcrun.dev`）。
2. `wrangler.toml` 取消註解 `[[send_email]]` binding（名 `EMAIL`），`EMAIL_FROM` 設為該位址。
3. `EMAIL_ENABLED` 改 `"true"` 重新 deploy。

關閉時 `/api/request-code` 回「已登記！封測期間啟動碼由邀請你的人提供（寄信功能開通中）」——誠實告知，不假裝有寄。

## 部署

```bash
cd landing
# 首次：建 KV，把 id 填進 wrangler.toml 的 kv_namespaces
npx wrangler kv namespace create SIGNUPS
npx wrangler deploy
```

account_id 直接寫在 `wrangler.toml`（目前 = uncle6 `58309bb90fd93ad6d0fe0aae99170e9d`）。憑證走 `CLOUDFLARE_API_TOKEN` 環境變數，**絕不進 repo**。

## 正式站計畫

目前是 uncle6 帳號上的預覽站。正式上線時搬到 youlin 官方帳號：改 `wrangler.toml` 的 `account_id`、在官方帳號重建 KV namespace 換 id、重新 deploy，再綁正式網域。預覽站屆時可整顆刪除（worker + KV），完全可逆。
