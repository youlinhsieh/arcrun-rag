# CLAUDE.md — [專案名稱]

> 導航牌。細節在兩個地方，不在這裡。
> 這個檔案不增長——超過 100 行就是放錯地方了。

---

## 絕對鐵律（違反 = 停手）

1. **任何 code 變動前必須有對應 SDD**，且遵守 **SDD 生命週期鐵律**（全文：`system-dev/docs/3-specs/SDD-LIFECYCLE.md`）：
   - **單一活性**：任何時刻只有一份 `status: active` 的 SDD，所有任務對應它的 tasks
   - **禁止自行建立 SDD**：找不到對應 → 停手問 [負責人]
   - **規格層變更**：proposal 寫進 `3-specs/pending-changes.md`，等使用者「confirm」才動
   - **開新 SDD**（confirm 後）：先把舊 SDD 未完成任務搬進新 SDD，才准寫 code
   - **session 開始**回報：「現行規格〈名稱〉＋未完成任務 N＋待裁決 proposal M」
2. [技術棧限制，例如：前端只用 React，不引入其他框架]
3. [其他專案特定限制]

---

## 工作流程（強制）

開始任一任務，按順序：

1. 讀 `system-dev/wiki/status.md`（3 分鐘，了解當前狀態）
2. 確認有對應 SDD（`system-dev/docs/3-specs/`）
3. 在回覆開頭宣告：
   ```
   📋 已讀 SDD：<路徑>
   🎯 對應 task：<編號>
   🚧 執行範圍：<會動哪些檔案>
   ```
4. 完成後更新 `system-dev/wiki/status.md`

---

## 🔴 第一鐵律：wiki 是判準，不准跳過（2026-07-20/21 leo 兩度點破）

**要查任何東西之前，先搜尋 wiki——用 grep，不是只讀開頭幾行。**

> leo：「花很多力氣去產生 wiki，最重要的就是要可以查詢，**結果要查的時候就跳過，那就白寫了**。」
> 「重點是你自己的記憶對嗎？而你有按照規定去切實讀 wiki 嗎？」

```bash
grep -rin "<本題關鍵字>" system-dev/wiki/
```

**三條硬規則**：
1. **wiki 與程式碼/歷史文件衝突 → 以 wiki 為準**。程式碼反映「還沒清乾淨」，不等於「還在用」。
2. wiki 寫「不可動／待廢除／進行中」→ **讀它的解除條件並逐條核對**。那是當時狀態，不是永久禁令。
3. 翻原文後得到新結論 → **回頭更新 wiki**（wiki 過時是債，要還）。

**動外部系統（部署／curl／wrangler／acr／gh）前**：先找 repo 有沒有**現成腳本或 README 部署段**，
別自創方法。（實例：2026-07-21 明明有 `npx wrangler deploy` 這條驗過的路，卻自己 curl 硬幹踩坑。）

> hook `wiki-first-search.sh` 會在你查 code／下高風險指令時自動推 wiki 命中行；
> **但機制只是提醒，判斷是你的責任**。


## Wiki 讀取順序

| 檔案 | 時機 | 用途 |
|------|------|------|
| `system-dev/wiki/status.md` | session 開始第一件事 | 當前進度、下一步 |
| `system-dev/wiki/mistakes.md` | 做新功能前 | 已知誤解 + 快速檢查清單 |
| `system-dev/wiki/decisions-summary.md` | 遇到設計判斷時 | 架構決策快速查 |

> 開 session 由 `SessionStart` hook 自動注入 status 重點。沒自動接關 → 打 `/wiki-recall`。
> status/wiki 是 **快照非即時狀態**：讀快照 **+ 核實快照**，不盲信。

---

## 整理 wiki 的方法（採集規則所在地）

> 要「採集／改寫 wiki」時，完整規則（三層架構、frontmatter 標籤、typed-edge 三元組、**gloss 定義句**）
> 不在本檔，而在下表。**動手採集前先讀對應那份**，不要憑印象做。

| 由誰整理 | 規則檔（採集當下必讀） |
|----------|------------------------|
| **Claude Code（CC）** | `/wiki-init`（初始化／採集）、`/wiki-capture`（存結論），規則寫在指令內文 |
| **Claude.ai（Cowork）** | `system-dev/docs/SKILL.md`（skill `wiki-cowork-scan`），與 CC 共用同一套規則 |

兩條路徑**輸出格式相同、規則一致**：gloss、typed-edge、標籤的寫法在兩份裡都有，任一方整理過另一方不覆蓋。

---

## 規範索引

| 檔案 | 內容 |
|------|------|
| `system-dev/docs/README.md` | 文件分類規則 |
| `system-dev/docs/3-specs/` | 所有 SDD |
| `system-dev/docs/2-architecture/decisions/` | 架構決策記錄 |

---

## 文件位置速查

| 類別 | 位置 |
|------|------|
| 架構決策 | `system-dev/docs/2-architecture/decisions/` |
| SDD | `system-dev/docs/3-specs/[子系統]/` |
| 操作手冊 | `system-dev/docs/4-guides/` |
| 事件記錄 | `system-dev/docs/5-records/incidents/` |
| 測試報告 | `system-dev/docs/5-records/test-reports/` |
