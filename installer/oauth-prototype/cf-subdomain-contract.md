# workers.dev 子網域：Cloudflare 真的怎麼回（實打紀錄）

> 這份檔案存在的理由只有一個：**`worker.test.mjs` 裡那些 status/code 不准是猜的。**
>
> `inkstone/Arcrun#190` 的驗收條件寫著「沒有 CF 明文，只有旁證，**實打才算數**」。
> 2026-08-31 那一版的離線替身把「名字被占用」寫成 `HTTP 409`——那是推測值。
> 真的 Cloudflare 回的是 **`HTTP 403`**，而 403 在我們的程式裡是「授權不夠」的意思。
> ⇒ 測試 100% 綠，真用戶第一個名字撞名就整個裝不起來，畫面還告訴他「我們的授權範圍不夠」。
>
> **替身跟真身的差異不會被測試發現——只會被用戶發現。** 所以量到的值寫在這裡，
> 測試照這裡寫，改的時候回來重量一次（`node installer/oauth-prototype/cf-subdomain-probe.mjs`）。

## 量測條件

- 日期：2026-09-01
- 帳號：`1129efd7df2e8899d537e9c8fbabb6cb`（youlin，D37 的 AI stage）
- 憑證：`CLOUDFLARE_API_TOKEN_YOULIN_CC_USE`（API token，非 OAuth token——見最下面「還沒驗到的」）
- 全部是**唯讀或冪等**的呼叫；youlin 既有的子網域量測前後皆未改變。
- 🔴 **子網域名的註記（2026-09-18，inkstone/arcrun-rag#194）**：量測當時 youlin 的子網域名
  已在 09-02 清空重裝後改為 `arcrun-yuga3bse`（舊名 DNS 查無）。**本文件裡量到的 HTTP status／CF code
  才是重點，且不受子網域改名影響**；下表中原本寫死的舊子網域名一律換成佔位描述，避免留一個指向死名的字串。

## 量到的（原始回應）

| 呼叫 | HTTP | CF code | 回應 |
|---|---|---|---|
| `GET /accounts/{id}/workers/subdomain` | **200** | – | `{"subdomain":"<youlin 帳號的子網域>"}` |
| `GET /accounts/{id}/workers/subdomains/{自己的名字}` | **200** | – | `{"subdomain":"<youlin 帳號的子網域>"}` |
| `GET /accounts/{id}/workers/subdomains/arcrun-zzq7k4m2test`（沒人要的） | **404** | **10032** | `Subdomain '…' is available but not configured.` |
| `GET /accounts/{id}/workers/subdomains/uncle6-me`（別人的） | **403** | **10031** | `Subdomain 'uncle6-me' is unavailable. Please try a different one.` |
| 同上：`test` / `demo` / `cloudflare` / `workers` / `admin` | **403** | **10031** | 同上（六個名字全同一組，不是單一樣本） |
| `PUT /accounts/{id}/workers/subdomain {"subdomain":"{自己的名字}"}` | **409** | **10036** | `Account already has an associated subdomain.` |

## 三個結論，程式碼照這三條寫

1. 🔴 **「名字被占用」是 403，跟「我們沒權限」同一個 status。**
   ⇒ 判斷一律**先看 error code，再看 status**。反過來寫，撞名會被誤報成授權失敗並中止安裝。
2. 🔴 **子網域一旦設定就改不掉**——`PUT` 到一個已經有子網域的帳號回 409/10036，不是覆蓋。
   ⇒ 完成頁那句「這個名字會永久留在你的帳號上，之後不能修改」是**真的**，不是保守說法。
   ⇒ 也代表 `10036` 是「別人先開好了」的訊號：正解是**把它讀回來用**，不是報失敗。
3. **預檢端點 `/workers/subdomains/{name}` 不在 Cloudflare 官方 openapi.json 裡**
   （`cloudflare/api-schemas` 的 `openapi.json`，24.6 MB，2026-09-01 下載後 `json.load` 解析，
   `workers/subdomains` 零筆）⇒ 它沒有契約保證。它的回應只准用來「跳過會撞的名字」，
   **永遠不准用來中止安裝**；最終裁決永遠是 `PUT`。

## 權限：`workers-scripts.write` 夠不夠（票上的未決格 ①）

Cloudflare 官方 `openapi.json` 對 `/accounts/{account_id}/workers/subdomain` 自己宣告的
`x-api-token-group`：

```
PUT    → ["Workers Scripts Write"]
GET    → ["Workers Scripts Write", "Workers Scripts Read"]
DELETE → ["Workers Scripts Write"]
```

⇒ **開子網域不需要任何新的 scope**，我們 OAuth 已經要的 `workers-scripts.write` 就是它。
這是 CF 自己的 schema 宣告，不是推論。

## 還沒驗到的（誠實標記，不要當成驗過）

- **「乾淨帳號」那一格沒有實打過**：`GET /workers/subdomain` 回 `10007` 這個前提，
  以及 `PUT` 真的把子網域開起來的那一刻，**都需要一個從沒開通過 workers.dev 的帳號**。
  youlin 早就有子網域，而紅線禁止刪它 ⇒ 這台機器上量不到。
  10007 這個碼目前的依據是既有程式碼與 CF 文件，**不是我們量到的**。
- **上表是用 API token 量的，不是用安裝流程拿到的 OAuth token 量的。**
  所以「PUT 走到 409 而不是 401/403」證明的是**端點與請求格式正確**，
  **不等於**證明 OAuth 那顆 token 有權限——那一格由上面的 `x-api-token-group` 宣告支撐，
  仍待一次真的 OAuth 安裝來收尾。
