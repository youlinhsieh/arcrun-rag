# Microsoft Store 上架素材包（Arcrun RAG）

> **這份文件要解的問題**：Windows 的 Chrome 直接擋下載 ⇒ Windows 用戶連安裝檔都拿不到＝封測硬斷點
> （rag-beta CP **關 8**）。上 Microsoft Store 後，用戶從 Store 安裝，完全不經過瀏覽器下載＝繞開攔截。
>
> **落帳**：2026-07-31｜Gitea `Leo/arcrun-rag#8`
> **狀態（2026-08-06 更新）**：msix **已做得出來、Identity 是真的、可直接送審**（§1）。
> ✅ §4 隱私政策／支援頁**已上線並實抓 200**：
>   · 隱私政策 `https://rag.arcrun.dev/privacy`
>   · 技術支援 `https://rag.arcrun.dev/support`
> ⚠️ 這兩頁**早就做好了**，本文件一度還寫著「目前沒有」——假的擋點會讓人以為還卡著。
> 剩下**只有 leo 能做的**：§3 保留名稱、§7 送審（含一張 Windows 執行畫面截圖）。

---

## 📌 先講三個「和原本以為的不一樣」的地方

交辦時的假設有三處與官方現況不符，照錯的走會白做工，所以先列出來：

| 原本以為 | 官方實況 | 影響 |
|---|---|---|
| 開發者帳號要 **US$19**（要花錢） | **個人帳號現在免費**（2025 Build 宣布，已在 200+ 市場生效，連信用卡都不用）。公司帳號才 US$99 | **不用花錢**，少一道人閘 |
| 審核週期 **數天～兩週** | **通常幾小時，最多 3 個工作天** | 止血期比想像短很多，但仍需止血（§9） |
| msix 可能要自購簽章憑證 | **完全不用**。Store 過審後會**用微軟自己的憑證重簽**，開發者不必買 CA 憑證、不必 USB token | 省下 US$280-560/年 |

⚠️ 但有一項**比原本以為的更嚴格**：
**Win32 桌面程式（我們就是）「一定」要有隱私政策網址**，不是「有蒐集個資才要」。
政策 10.5.1 原文：「Product types that inherently have access to Personal Information must always have
privacy policies. These include, but are not limited to, **Desktop Bridge and Win32 products**.」
⇒ **rag.arcrun.dev 現在沒有這頁，這是送審的硬擋點**（§4）。

---

## 1️⃣ msix：做得出來，已實測 ✅

**結論：Mac 上就打得出可上傳的 msix，不需要 Windows 機器。**

原本擔心的是「`MakeAppx` 只有 Windows 有」——這點沒錯，但微軟另外開源了**跨平台**的
[`msix-packaging`](https://github.com/microsoft/msix-packaging)，裡面的 `makemsix` 就是 `MakeAppx` 的跨平台移植版，
支援 `pack`。實際在這台 Mac 上跑通了。

### 實測證據（2026-07-31）

```
$ bash build-msix.sh
🏷  msix 版本：1.0.0.0（來源 142f1d5）
① 編 Windows exe（沿用既有腳本，單一 exe 內嵌 collector）
② 複製 Store 圖示（品牌素材，2026-07-31 換成 leo 的 CIS）
③ 寫 AppxManifest.xml（能力宣告誠實且最小化）
④ 打包 msix
⑤ 回讀驗證（unpack 會驗 blockmap 雜湊，能過＝結構合法）

✅ 完成：dist-msix/ArcrunRAG.msix（ 18M，未簽章＝送 Store 正確狀態）
```

包內結構（`unzip -l`，2026-07-31 換品牌 icon 後重打包）：
```
 39068160  arcrun-tray.exe
     4422  Assets/Square150x150Logo.png
     8968  Assets/Square310x310Logo.png
     2145  Assets/Square71x71Logo.png
     1350  Assets/Square44x44Logo.png
     1497  Assets/StoreLogo.png
     5330  Assets/Wide310x150Logo.png
      538  Assets/Square44x44Logo.targetsize-16.png
      718  Assets/Square44x44Logo.targetsize-24.png
      834  Assets/Square44x44Logo.targetsize-32.png
     1206  Assets/Square44x44Logo.targetsize-48.png
     5662  Assets/Square44x44Logo.targetsize-256.png
     1747  AppxManifest.xml
          AppxBlockMap.xml      ← 自動產生
          [Content_Types].xml   ← 自動產生
```

**完整性驗證**：`makemsix unpack` 回讀（這步會驗 blockmap 的 SHA256 雜湊，過得了＝包沒壞），
回讀出的 exe 與原檔 shasum 一致：
```
2ff4afdf57917514aaf7b784f1ba66e7780d6da5  verify/arcrun-tray.exe
2ff4afdf57917514aaf7b784f1ba66e7780d6da5  dist-windows/arcrun-tray.exe
```

### 產生方式（已寫成腳本，可重跑）

`collector/cmd/arcrun-tray/build-msix.sh`

```bash
brew install mingw-w64 cmake icu4c    # 前置，一次就好
bash build-msix.sh --setup            # 建 makemsix，約 5-10 分鐘，只需一次
bash build-msix.sh                    # 之後每次打包只跑這行
```

> **建 makemsix 踩到的兩個坑**（腳本已自動處理，記在這裡免得未來重踩）：
> 1. 這套 SDK 停在 2022 年、寫死 **C++14**，但 Homebrew 現在的 ICU 標頭用了 C++17 語法
>    ⇒ 直接建必炸 `no template named 'is_same_v'`。**要改兩個檔**——只改頂層
>    `CMakeLists.txt` 會被 `lib/xerces/CMakeLists.txt` 蓋回去（實際踩過）。
> 2. 打包功能**預設是關的**，`cmake` 要帶 `-DMSIX_PACK=on`（`makemac.sh --pack`）。

### ⛔ 這台機器驗不到的部分（誠實界定）

`makemsix` 只證明**包合法**，不證明**裝得起來、跑得對**。以下**必須真 Windows 機器**才驗得到：
- msix 實際能不能安裝、能不能啟動
- 托盤 icon 顯示、選資料夾對話框
- `broadFileSystemAccess` 在真機上的授權流程

⇒ 建議 leo 送審前先在 Windows 上側載測一次（§8）。

---

## 2️⃣ 官方查證結果（含出處）

### Q1. 首次提交一定要在網頁手動保留名稱嗎？→ **是，且沒有 API**

> 「If your app does not yet exist in Partner Center, you must create your app by **reserving its name
> in Partner Center**.」
> 「You **cannot use the Microsoft Store submission API to create an app** in Partner Center; you must
> work in Partner Center to create it, and then after that you can use the API to access the app and
> programmatically create submissions for it.」
> 「before you can create a submission for a given app using this API, you must **first create one
> submission for the app in Partner Center, including answering the age ratings questionnaire**.」

⇒ **第一次上架，網頁手動是唯一路徑，無法自動化。**第二次之後才能用 API。
名稱可提前保留，**保留後 3 個月內沒用會被收回**。
出處：[Create and manage submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)、[Reserve your app's name](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)

### Q2. Store submission API 要什麼憑證？能建 app 嗎？

需要把 **Azure AD 應用程式**關聯到 Partner Center 帳號，取得三個值：**Tenant ID／Client ID／Key（client secret）**，
且該 Azure AD 應用程式要指派 **Manager** 角色。
**不能建立新 app**（見 Q1），只能對「已存在且已手動送過一次」的 app 建立/更新後續提交。
出處：[同上](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)

> 💡 **建議**：第一次上架不要碰 API（反正也不能用）。等首次過審後再評估要不要接自動化更新。

### Q3. msix 一定要簽章嗎？→ **送 Store 不用，微軟代簽**

> 「Your MSIX and AppX packages **don't have to be signed** with a certificate rooted in a trusted
> certificate authority when submitting to the Microsoft Store. The Microsoft Store will **automatically
> re-sign your MSIX/AppX packages with a Microsoft certificate** during the publishing process after
> your app passes certification. This means:
> - You **don't need to purchase** a CA-trusted code signing certificate for MSIX/AppX Store submissions
> - You don't need to provide a .pfx or .cer file
> - USB tokens or hardware security modules (HSMs) are **not required**」

⚠️ **兩個例外**（很重要，別搞混）：
- 送 **MSI/EXE 安裝程式**（非 msix）到 Store：**Store 不代簽**，你必須自己 Authenticode 簽好才送。
- msix **側載**（不走 Store，自己發給人裝）：**必須自己簽**。

出處：[App package requirements for MSIX app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)

### Q4. 審核週期與常見退件原因

**週期**：通常幾小時，**最多 3 個工作天**；過審後約 15 分鐘上架。
出處：[App certification process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process)

**與我們相關的退件風險**（依政策全文比對，按風險排序）：

| 風險 | 政策 | 我們的狀況 | 對策 |
|---|---|---|---|
| ✅ 隱私政策 | 10.5.1 — Win32 產品**一律**要 | **已上線** `https://rag.arcrun.dev/privacy`（實抓 200） | 送審時填這個網址 |
| 🟡 受限能力要審查 | 10.6 — 宣告的能力須與功能相符 | 用了 2 個受限能力 | §6 備好說明詞 |
| 🟡 產品無法測試 | 10.3 — 要能測；需登入要給測試帳號 | 需連自己的 CF 帳號 | §6 憑證備註給測試帳號 |
| 🟢 提權 | 不允許 runtime/啟動提權 | 我們不需提權 | 無 |
| 🟢 除錯組建 | 必須是最佳化組建 | 已用 `-s -w` strip | 無 |
| 🟢 乾淨解除安裝 | 10.2.7 | msix 由系統管理，天生符合 | 無 |

出處：[Microsoft Store Policies 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)、[Top 5 reasons apps fail certification](https://learn.microsoft.com/en-us/archive/blogs/msdn/mspfe/top-5-reasons-your-windows-store-app-fails-store-certification)

---

## 3️⃣ 👤 leo 要做：保留 app 名稱（第一步，卡住其他所有事）

**為什麼只能你做**：需要 Partner Center 登入，且官方明說沒有 API。

**建議名稱（依序試，前面被佔用就用下一個）**：

| 順位 | 名稱 | 理由 |
|---|---|---|
| 1 | `Arcrun RAG` | 與現有品牌、網域一致 |
| 2 | `Arcrun Knowledge` | 「RAG」對一般人是黑話，這個較白話 |
| 3 | `Arcrun 知識庫` | 中文名，被佔機率極低 |
| 4 | `Arcrun RAG Collector` | 加後綴避開撞名 |

> ⚠️ 政策 10.1.1：名稱**不能含行銷或描述性文字**（例如不要叫「Arcrun RAG - 最強知識庫」）。

**操作步驟**：
1. 開 https://partner.microsoft.com/dashboard/apps-and-games/overview
2. 點 **New product** → 選 **MSIX or PWA app**
3. 輸入名稱 → 點 **Check availability** → 綠勾＝可用
4. 點 **Reserve product name**
5. **把三個值抄回來給我**（在〔產品〕→〔產品管理〕→〔**產品識別資料 / Product identity**〕）：
   - `Package/Identity/Name`（形如 `12345ArcrunSoftware.ArcrunRAG`）
   - `Package/Identity/Publisher`（形如 `CN=XXXXXXXX-XXXX-...`）
   - `Package/Properties/PublisherDisplayName`

   我拿到就用這行重打包（現在包裡是佔位值，**不改不能送審**）：
   ```bash
   IDENTITY_NAME='<上面第1個值>' PUBLISHER='<上面第2個值>' \
   PUBLISHER_DISPLAY='<上面第3個值>' bash build-msix.sh
   ```

---

## 4️⃣ ✅ 隱私政策 + 支援網址（**已完成**，2026-08-06 實抓 200）

**查證結果：`rag.arcrun.dev` 目前沒有隱私政策頁，也沒有支援頁。**
（`landing/worker.js` 的路由只有 `/`、`/api/health`、`/api/request-code`、`/api/verify-code`、`/logo.svg`、`/favicon.*`）

政策 10.5.1 明訂 Win32 產品**一律**要隱私政策 ⇒ **沒有這頁就送不出去**。

### ✅ 我可以直接做（不需 leo，四題全否）
在 `landing/worker.js` 加兩條路由，內容我已擬好（見下），部署後即有網址：
- `https://rag.arcrun.dev/privacy` — 隱私政策
- `https://rag.arcrun.dev/support` — 支援頁

### 隱私政策該寫什麼（我們的實際情況對我們有利）

Arcrun RAG 的架構是**資料留在用戶自己的電腦 + 用戶自己的 Cloudflare 帳號**，
我們（開發者）**自己不收任何個資、沒有伺服器存用戶資料**。這點要寫清楚，
既是事實，也正好是產品賣點。

草稿（白話版，leo 可直接改）：

> **Arcrun RAG 隱私政策**（最後更新：2026-07-31）
>
> **簡單講：你的檔案不會傳給我們。**
>
> - **我們不會蒐集你的檔案內容。** Arcrun RAG 讀取的是你自己指定的資料夾，
>   讀完後編成知識卡，**直接存進你自己的 Cloudflare 帳號**。整條路徑上沒有我們的伺服器。
> - **我們不會蒐集你的個人資料。** 這個程式不需要註冊我們的帳號、不會回傳使用紀錄、
>   不做行為分析、沒有廣告、沒有第三方追蹤。
> - **網路連線用在哪：** 只有兩件事——(1) 把你的知識卡同步到**你自己的** Cloudflare 帳號；
>   (2) 檢查有沒有新版本可以更新。
> - **你的憑證存在哪：** 你的 Cloudflare 金鑰只存在**你自己電腦**的設定檔裡，不會傳給我們。
> - **要刪掉資料怎麼辦：** 資料都在你自己手上——移除程式、刪掉你 Cloudflare 帳號裡的資料即可。
>   我們這邊沒有你的資料可以刪。
> - **有問題找誰：** <leo 要填一個能收信的地址>

**✅ 已定案（leo 2026-08-01 裁決）：支援信箱＝`support@arcrun.dev`**
leo 初裁用 `uncle6.me@gmail.com`，總管實測發現 `rag.arcrun.dev/support` 頁上寫的是
`support@arcrun.dev`，兩邊不一致會被送審方比對出來 → 提案後 leo 選「**設轉寄，兩邊都用
`support@arcrun.dev`**」。好處：對外專業、未來換信箱只改轉寄目標，商店頁與網站都不用動。

⚠️ **送審前 leo 要先確認轉寄真的通**（總管無該 zone API 權限，代勞不了）：
Cloudflare 後台 → `arcrun.dev` → **Email Routing** → 確認/新增 `support@arcrun.dev`
→ 轉寄至 `uncle6.me@gmail.com` → **從別的信箱寄一封測試信驗證收得到**。
（基礎建設已就緒：總管實測 MX 三筆已指 `route1/2/3.mx.cloudflare.net`、
SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` 也在 ⇒ 不必新建路由，只差這條規則。）
⚠️ 轉寄目標若沒點確認信，規則處於未驗證狀態，信一樣不會到——**測試信別省**。
回一個地址我就把兩頁做好部署。

---

## 5️⃣ 商店文案（照白話原則寫，不用開發者術語）

**短描述**（Store 列表用，建議 100 字內）：
> 把你電腦裡的資料夾變成可以問問題的知識庫。檔案留在自己電腦、知識卡存進你自己的雲端。

**完整描述**：
> **你的檔案，變成你的 AI 查得到的知識庫。**
>
> 選一個資料夾，Arcrun RAG 會把裡面的文件讀完、整理成一張張「知識卡」，
> 存進**你自己的** Cloudflare 帳號。之後你的 AI 助理就能查這些內容來回答你的問題。
>
> **和一般做法不一樣的地方**
> 常見的做法是把文件切成碎片存起來，回答時撈幾片碎片、現場拼一個答案——
> 資料只會越堆越多，也沒辦法修正。
> Arcrun RAG 是先把資料**讀完、寫成定稿的知識卡**，之後才拿卡來回答。
> 卡片可以編修、可以下架，知識庫不會無限膨脹。
>
> **你的資料在哪裡**
> - 原始檔案：**留在你自己的電腦**，不會上傳給我們
> - 整理好的知識卡：存進**你自己的 Cloudflare 帳號**
> - 我們沒有伺服器存你的東西，也不需要你註冊我們的帳號
>
> **怎麼用**
> 1. 裝好後程式待在工作列（右下角）
> 2. 選一個要看守的資料夾
> 3. 連上你自己的 Cloudflare 帳號
> 4. 資料夾裡的檔案有變動時，知識卡會自動跟著更新
>
> **需要準備**
> 一個 Cloudflare 帳號（免費方案就夠用）。

**搜尋關鍵詞**（政策上限 7 個）：
`知識庫`、`RAG`、`AI 助理`、`文件搜尋`、`Cloudflare`、`筆記`、`知識管理`

**類別**：`生產力（Productivity）`

---

## 6️⃣ 分級問卷 + 認證備註（照抄即可）

### 年齡分級（IARC 問卷）
第一題問「哪個類別最能描述你的產品」→ 選 **Utility / Productivity（工具或生產力）**。
接著的題目都是問暴力、性、毒品、賭博、粗話之類的內容 —— **我們全部都是「否」**。
預期結果：**3+ / PEGI 3 / ESRB Everyone**（最低分級）。

唯一要留意的題目：會問**「app 是否讓使用者彼此分享個人資訊、或連到社群網路」**
→ **否**（我們沒有任何使用者之間的互動）。

### 認證備註（Notes for certification）—— 這欄很重要，直接貼下面這段

審核人員拿到我們的 app 會遇到「需要 Cloudflare 帳號才能完整測試」的問題，
不先講清楚容易因為「無法測試」（政策 10.3）被退。建議照貼：

```
This app indexes files from a user-selected local folder and syncs the resulting
knowledge cards to the USER'S OWN Cloudflare account. We (the developer) do not
operate any server that receives user data.

Capability justification:
- runFullTrust: This is a Win32 desktop application (Go + system tray). This
  capability is required for any packaged non-UWP desktop app to run.
- broadFileSystemAccess: The core function is indexing a folder that the user
  explicitly chooses via a folder picker. Access is limited to what the user selects.
- internetClient: Used only to (1) sync to the user's own Cloudflare account and
  (2) check for application updates. No telemetry or analytics are collected.

The app does NOT start automatically at boot; tray residency is user-controlled.

Testing note: Full end-to-end testing requires a Cloudflare account (free tier is
sufficient). The application's UI, folder selection, and tray behaviour can all be
verified without one. If a test account is required, please contact us at
support@arcrun.dev and we will provide credentials.
```

> ⚠️ 最後一行的 `<支援信箱>` 換成 **`support@arcrun.dev`**（已定案，見 §4）。

---

## 6️⃣半 🎨 品牌圖示（2026-07-31 換成 leo 的 CIS，已打進包）

**這一段 leo 不用做事**——msix 裡的圖示已經是品牌 icon，打包時自動帶進去。
只有 Store listing 頁面若要另外上傳宣傳圖時才需要手動選圖（見下表最後兩列）。

### 換了什麼

| 位置 | 換之前 | 換之後 |
|---|---|---|
| Windows 系統匣 | Fyne 內建的通用「儲存」圖示 | 墨底 `a` + 雙 chevron |
| macOS 選單列 | 同上（彩色、深色列上很醜） | **template 單色**，隨系統深淺自動反色 |
| app 圖示（.app/.icns） | 舊版 icon | CIS 方形 icon，含 16→1024 全套 |
| msix 磚 | 由 1024 現縮，寬磚**被拉扁** | 方形磚等比縮；寬磚改用**橫式 lockup** |
| `rag.arcrun.dev` favicon | 琥珀金圓圈暫代圖 | 同一顆品牌 mark ✅ 已部署 |
| `install.arcrun.dev` favicon | **完全沒有**（`/favicon.ico` 回 404） | ⏳ 待做，見下 |

> 目標是**四處一致**：landing → 安裝頁 → 用戶自己的 portal → 托盤，看到的是同一個 icon。

> ⚠️ **install.arcrun.dev 這次沒動**：它的真身是 `installer/oauth-prototype/worker.js`
> （worker 名 `arcrun-installer`），**不是** `installer/src/index.js`，且**不在 `feat/daemon` 分支上**
> （在 `feat/installer` / `fix/t75-remove-config-card` / `work/installer-batch-0725`，三份內容還互不相同）。
> 判別法與教訓見 `system-dev/wiki/decisions-summary.md`「installer 有兩個 worker，改錯＝白做」。
> ⇒ 要補這顆 favicon，得先確認哪個分支是線上版，另立一筆做。

### msix 包內圖示（`collector/cmd/arcrun-tray/assets/store/`）

| 檔案 | 尺寸 | 用途 |
|---|---|---|
| `Square44x44Logo.png` | 44×44 | 應用程式清單、工作列 |
| `StoreLogo.png` | 50×50 | Store 頁面小圖 |
| `Square71x71Logo.png` | 71×71 | 小磚 |
| `Square150x150Logo.png` | 150×150 | 中磚（預設磚） |
| `Square310x310Logo.png` | 310×310 | 大磚 |
| `Wide310x150Logo.png` | 310×150 | 寬磚（橫式 lockup） |
| `Square44x44Logo.targetsize-{16,24,32,48,256}.png` | 16–256 | 工作列 / 檔案總管各檢視 |

**16/24px 用的是單獨的雙 chevron**，不是完整方形 icon——CIS 規定 26px 以下降級，
完整字符在那個尺寸只剩約 4px 高會糊掉。

### 要重新產生時

```bash
cd collector/cmd/arcrun-tray/assets/store && python3 gen-store-assets.py
```

素材真身在 `InkStoneCo/arcrun-cis/`（leo 的 CIS）。**不要直接編修產出的 PNG**——
改品牌就改 CIS 再重跑腳本。規範細節見同目錄 `README.md`。

---

## 7️⃣ 👤 leo 的完整操作清單（Partner Center）

> 前提：`https://partner.microsoft.com/` 用**個人帳號**註冊（**免費**，不用信用卡）。
> 順序有相依性，**照順序做**。

| # | 步驟 | 在哪裡 | 貼什麼 |
|---|---|---|---|
| 1 | 註冊開發者帳號 | partner.microsoft.com → Windows & Xbox | 個人帳號、免費 |
| 2 | **保留名稱** | Apps and games → New product → MSIX or PWA app | §3 的名稱 |
| 3 | **把三個識別值回給我** | 產品 → 產品管理 → 產品識別資料 | 見 §3 第 5 點 |
| 4 | （等我）重打包 + 建隱私政策頁 | — | 我做 |
| 5 | 建立提交 | 產品 → Submissions → New submission | — |
| 6 | 上傳套件 | Submission → **Packages** | `dist-msix/ArcrunRAG.msix` |
| 7 | 定價 | **Pricing and availability** | **免費（Free）**、市場全選 |
| 8 | 年齡分級 | **Age ratings** | 照 §6 答，全否 |
| 9 | 商店文案 | **Store listing** | 照 §5 貼 |
| 10 | **隱私政策網址** | Store listing → Privacy policy URL | `https://rag.arcrun.dev/privacy` |
| 11 | 支援網址 | Store listing → Support contact info | `https://rag.arcrun.dev/support` |
| 12 | 螢幕截圖 | Store listing → Screenshots | **至少 1 張**，1366x768 以上（見下） |
| 13 | 認證備註 | Submission options → Notes for certification | 照 §6 整段貼 |
| 14 | 送出 | **Submit to the Store** | — |

**⚠️ 第 12 項螢幕截圖是我做不到的**：需要在**真 Windows 機器**上跑起來截圖
（托盤選單、選資料夾畫面各一張就夠）。這台是 Mac，截不出真實畫面，
而截假的違反政策 10.1.1（metadata 必須真實反映產品）。

---

## 8️⃣ 建議：送審前先在 Windows 側載測一次

msix 包合法 ≠ 裝得起來。建議 leo 在 Windows 機器上先測：

```powershell
# 側載需要自簽（Store 版才由微軟代簽），或開開發人員模式後：
Add-AppxPackage -Path .\ArcrunRAG.msix -AllowUnsigned
```
確認：能安裝 → 托盤 icon 出現 → 能選資料夾 → 順便把截圖拍了（第 12 項）。

沒過的話回報我，比被 Store 退件快得多（退件一次要再等最多 3 個工作天）。

---

## 9️⃣ 並行止血：Store 過審前，Windows 用戶怎麼進來

即使審核只要 3 個工作天，**這 3 天 Windows 用戶仍然進不來**，且步驟 3 卡在 leo 手上，
實際可能更久。以下是止血選項，**依「見效速度 ÷ 成本」排序**：

### 🥇 第一優先：下載頁加「Chrome 擋下載時怎麼辦」圖文
- **見效**：立即（部署完就有）
- **成本**：低，**我可以直接做**
- **效果**：不能讓警告消失，但能讓「會看說明的人」順利裝完
- **做法**：下載按鈕旁加一段圖文——
  > Chrome 說「無法安全地下載」？這是因為我們的程式還很新、下載次數不夠多，
  > 不是因為有問題。點下載列右邊的 **⋮** → 選 **保留（Keep）** 就能繼續。
  > 之後 Windows 可能再跳一次藍色視窗，點 **詳細資訊** → **仍要執行**。
- **必要性**：**就算 Store 上架成功，這頁也還是要有**——不是所有人都會從 Store 裝。

### 🥈 第二優先：winget 發佈
- **見效**：中（PR 審核，通常數天）
- **成本**：低，**技術上我可以做**，但**發 PR 要走 GitHub ⇒ 撞 D20 紅線，需 leo 裁**
- **查證結果**：winget 社群倉庫接受 `.exe` 安裝程式，門檻確實比 Store 低（走 PR + 自動驗證 + 社群審核）
  出處：[winget-pkgs](https://github.com/microsoft/winget-pkgs)、[Moderation.md](https://github.com/microsoft/winget-pkgs/blob/master/doc/Moderation.md)
- ⚠️ **但對「封測階段」效益有限**：winget 是**命令列**工具（`winget install ...`），
  會用的人本來就不會被 Chrome 擋住嚇退。**對我們的封測者（非工程師）幫助不大。**
- **建議**：**先不做**。等 Store 上了、要擴散到技術用戶時再說。

### 🥉 第三：買 EV 程式碼簽章憑證
- **見效**：快（簽了就大幅減少攔截，EV 憑證在 SmartScreen 有較高信譽）
- **成本**：**US$280～560／年**（💰 **要花錢＝leo 決定**）
  出處：[SSL Dragon](https://www.ssldragon.com/ssl-certificates/code-signing/extended-validation/)、[Sectigo](https://www.sectigo.com/ssl-certificates-tls/code-signing)
- **建議**：**現在不要買**。Store 上架是免費的、且微軟代簽，效果一樣。
  只有在「決定長期走網頁直接下載（不靠 Store）」時才值得。
  ⚠️ 另註：2026-03-01 起憑證最長效期壓到 460 天。

### ❌ 不建議的做法
- **改副檔名**（`.exe` → `.e_e` 讓對方改回來）：leo 07-28 已否決過，
  「完全不行」——增加封測者的操作負擔，且對非工程師是災難。
- **換直接連結／換 CDN**：攔截是基於**檔案信譽**不是來源網址，換位置沒用。

### 📋 止血建議順序（結論）
1. **我現在就做**：下載頁「被擋怎麼辦」圖文 + 隱私政策頁 + 支援頁（一起部署）
2. **leo 做**：保留名稱 → 回三個值（§3）
3. **我做**：重打包正式 msix
4. **leo 做**：Windows 側載測 + 截圖 → 送審
5. winget、EV 憑證：**都先不做**（理由如上）

---

## 🔟 現在卡在哪（一句話版）

> **msix 已經做得出來也驗過了；卡在「只有你能做」的兩件事：**
> **① Partner Center 保留 app 名稱（免費，不用信用卡）→ 回我三個識別值**
> **② ~~支援信箱要用哪個地址~~ ✅ 已定案 `support@arcrun.dev`（08-01）；改為：確認 CF Email Routing 轉寄通**

---

## 附錄：出處清單

- [Reserve your app's name](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)
- [Create and manage submissions using Store services](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [App package requirements for MSIX app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)（簽章段）
- [The app certification process for MSIX app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process)
- [Microsoft Store Policies 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)（10.5.1 隱私政策／10.6 能力）
- [Age ratings (IARC)](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings)
- [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer)
- [How to build MSIX package on Linux](https://learn.microsoft.com/en-us/windows/msix/msix-sdk/msix-linux)
- [microsoft/msix-packaging](https://github.com/microsoft/msix-packaging)
- [App capability declarations](https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations)
- [winget-pkgs](https://github.com/microsoft/winget-pkgs)
