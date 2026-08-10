# 讓辨識碼信不要進垃圾桶（leo 要親手做的 DNS 設定）

> 2026-07-29 立。起因：封測者反映信件進垃圾信匣，建議做 SPF/DKIM/DMARC。
> **總管實查現況後寫**（不是照抄一般教學）——下面每一步都對應 arcrun.dev 的真實狀態。

## ✅ 進度（2026-07-29 14:1x，leo 做完①後總管實查）

| 記錄 | 現況 |
|---|---|
| MX | ✅ route1/2/3.mx.cloudflare.net 已加 |
| SPF | ✅ `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| DKIM | ✅ `cf2024-1._domainkey` 金鑰已發布 |
| DMARC | 🟡 仍 `p=none` — **剩這一步（見②）** |

> **總管驗到哪（07-29 14:2x）**：①DNS 記錄存在且值對得上 CF 官方格式
> （SPF `include:_spf.mx.cloudflare.net`=1／MX 三筆 mx.cloudflare.net／DKIM `v=DKIM1`=1）
> ②**實寄一封**到 leo21c@gmail.com：`{"ok":true,"email_sent":true}`。
> ⚠️ **總管驗不到最後一哩**——「這封信在 Gmail 是 PASS 還是進垃圾桶」要 leo 開信箱看
> （⋮ → 顯示原始郵件 → SPF/DKIM/DMARC 三個 PASS）。**在那之前不算通過。**

> 📌 **leo 回報「沒叫我給 email」**＝走 Email **Sending**／Onboard Domain 那條（只發信不收信），
> 不需要驗證收件信箱；走 Email **Routing**（要收信）才會要你驗證 Destination Address。**兩條都行。**

## 現況（總管 2026-07-29 實查，做之前的狀態）

| 項目 | 現況 | 判讀 |
|---|---|---|
| 寄信方式 | Cloudflare **Email Routing 的 send_email binding**（`landing/worker.js` 用 `EmailMessage`） | 不是 Resend/SendGrid，設定方式不同 |
| 寄件地址 | `noreply@arcrun.dev`（env `EMAIL_FROM`） | |
| `arcrun.dev` TXT（SPF） | **沒有任何 TXT** | 🔴 缺 SPF |
| `arcrun.dev` MX | **沒有 MX** | 🔴 Email Routing 沒啟用完整 |
| `_dmarc.arcrun.dev` | `v=DMARC1; p=none;` | 🟡 有但最寬鬆，且缺回報信箱 |
| DKIM | 需 Email Routing 啟用後由 CF 自動提供 | 🔴 待啟用 |
| DNS 代管 | Cloudflare（`dawn/ignat.ns.cloudflare.com`） | ✅ 都在同一個介面做，不用跑去別家 |

> **這張表的證據**（07-29 兩台 DNS 交叉驗證，1.1.1.1／8.8.8.8／9.9.9.9 結果一致）：
> `dig TXT arcrun.dev` 與 `dig MX arcrun.dev` **皆無回應內容**（對照組 `google.com` TXT、
> `gmail.com` MX 正常回應，證明查詢方法有效）；`_dmarc.arcrun.dev` 回 `"v=DMARC1; p=none;"`。

## 你要做的四件事（都在 Cloudflare 後台，約 10 分鐘）

### ① 啟用 Email Routing（這一步會自動幫你加 MX 與 DKIM）

**兩個入口都可以，看你現在在哪一頁：**

- **A. 從帳號層級**（左側選單有 Compute／AI 那個畫面，標題「Email Routing」、中間寫
  「Enable Email Routing」）→ 直接按 **「＋ Onboard Domain」** → 選 `arcrun.dev`
- **B. 從網域層級** → 左上 Cloudflare logo 回首頁 → 點 `arcrun.dev` → 左側 **Email → Email Routing**

**接著精靈會帶你走：**

1. **先驗證一個收件信箱**（Destination Address）：填你的 Gmail →
   **CF 會寄一封驗證信給你，要去按確認**（這步不做，後面走不下去）
2. 回到設定畫面，它會列出要加的 DNS 記錄 → **按「Add records automatically」／同意**
3. 它會提示「Add records automatically」→ **按同意**，CF 會自動加好：
   - 3 筆 **MX**（`route1/2/3.mx.cloudflare.net`）
   - 1 筆 **SPF TXT**（`v=spf1 include:_spf.mx.cloudflare.net ~all`）
   - **DKIM** 相關記錄
4. 完成後回 DNS 頁確認上面那些真的出現了

> ⚠️ 若 CF 沒自動加 SPF，手動加一筆 TXT：
> Name `@`／Content `v=spf1 include:_spf.mx.cloudflare.net ~all`

### ② 把 DMARC 從 `p=none` 改成有回報信箱的版本

DNS → 找到 `_dmarc` 那筆 TXT → 編輯成：

```
v=DMARC1; p=quarantine; rua=mailto:leo21c@gmail.com; fo=1; adkim=r; aspf=r
```

- `p=quarantine`：偽造你網域的信會被隔離（比 `none` 有保護力，又不像 `p=reject` 那麼激進）
- `rua=`：**每天會收到一封報告**，看得到誰在用你的網域寄信、通過率多少
- 先跑一兩週看報告都正常，再考慮升 `p=reject`

### ③ 反查（PTR）——**這一項你不用做，也做不了**

你朋友說的「網域要設反查」是指 PTR 記錄（IP → 網域）。
**PTR 是由 IP 的擁有者設定的**，我們的信從 Cloudflare 的 IP 出去，PTR 歸 Cloudflare 管、已經設好了。
自架郵件伺服器才需要自己處理這一項。✅ 略過。

### ④ 「pki-validation」——**這是誤會，不用做**

`/.well-known/pki-validation/` 是**申請 SSL 憑證**時的驗證方式，跟郵件無關。
我們的 HTTPS 憑證由 Cloudflare 自動處理。✅ 略過。

## 做完怎麼驗

1. **寄一封測試**：到 https://rag.arcrun.dev 填一個 **Gmail 地址**，送出
2. 收到信後，Gmail 右上角 **⋮ → 顯示原始郵件**，看這三行：
   ```
   SPF:   PASS
   DKIM:  PASS
   DMARC: PASS
   ```
   三個都 PASS ＝ 設定成功
3. 進階：把信轉寄到 `check-auth@verifier.port25.com`，會回一封完整檢測報告

## 還是進垃圾桶的話

三個都 PASS 但仍進垃圾桶，通常是**網域太新、寄信量太少**（信譽還沒建立）。
補救：
- 信裡別放太多連結與圖片（我們現在的辨識碼信很乾淨，OK）
- 請前幾位封測者**把信標為「非垃圾郵件」**並回信一次——這對新網域的信譽幫助最大
- 封測邀請裡直接寫「**如果沒收到請看垃圾信匣**」（封測說明已經有這句）
