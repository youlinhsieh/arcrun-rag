---
description: 處理本 repo 的 GitHub issue（讀/回/結案），跨 repo 發要先問人
---

# /issue-handle — GitHub issue 處理指引

你（CC）可以、也該主動用內建的 `gh` CLI 讀寫**自己 repo** 的 GitHub issue。
很多人不知道這件事——`gh` 已內建認證，零開發、零外部依賴。issue 同源於 repo，
比 Notion / Sheets 更適合做交辦與待辦，不必引入外部 SaaS。

這份指引分四層，界線要守住。

---

## 1. 讀 / 回 / 結案（普世基本功 — 直接做，不用問）

對**自己這個 repo**，主動處理 open issue：

```bash
gh issue list --state open          # 看有哪些待辦
gh issue view <n>                   # 讀完整內容
# …實作…
gh issue comment <n> --body "[<本 repo> CC] 做了什麼、怎麼決定的、改了哪些檔"
gh issue close <n>                  # 確認解決後結案
```

回覆要有料：說清楚**做了什麼、為什麼這樣決定、動了哪些檔**，而不是只回「done」。
issue 作者（可能是另一個 repo 的 CC，或人類）要靠你的回覆判斷對不對。
跨 repo 的 issue/comment 開頭一律署名 `[<本 repo> CC]`（見第 3 節鐵律）。

---

## 2. 發 issue 給「別的 repo」（要先問人 — 不可擅自）

當你發現**別的 repo** 有值得修正的地方時：

> ❌ 不要擅自 `gh issue create -R other/repo …`
> ✅ 先問人類：「我發現 X repo 有 Y 問題，要我幫你去那邊發 issue 嗎？」得到同意才發。

理由：通用 template 不知道使用者對那個 repo 有沒有權限、想不想發。留一道人類確認最安全。
（對**自己 repo** 開 issue 記待辦則可直接做——那是自己的 repo。）

---

## 3. 跨 repo 署名（鐵律 — 絕不可漏）

所有 repo（mira / graph-plugin / ingest-plugin / Arcrun / template…）共用**同一個 GitHub 帳號**發 issue/comment，
所以 issue/comment 的 author **全顯示同一個帳號、看不出是哪個 repo 的 CC 發的**。

> **跨 repo 的 issue/comment 一律在開頭署名 `[<本 repo> CC]`**，靠內容署名溯源。

- 收件方 CC 回報：`[graph-plugin CC]` / `[mira CC]` / `[ingest CC]` / `[arcrun CC]`…
- 總管下令/追問：`[InkStoneCo 總管]`
- 署名放 comment **第一行或標題式開頭**（既有的「## 回報（graph CC）」即合格）。

為什麼只能這樣：GitHub issue/comment 的 author = 發送帳號，**沒有 per-repo 身份這設定**；
`git config user.name` 只影響 commit 作者、不影響 issue/comment author；
給每個 repo 開獨立帳號 = 多帳號自動化 = 踩下方第 4 節 flag 鐵律，**不可**。
身份只能在**內容層自報**。本 repo 名稱 → 看 `git remote -v` 或 repo 根目錄名。

---

## 4. flag 安全界線（最重要 — 絕不可越）

**「有事才讀」，禁止自動輪詢。**

- ✅ 想看 issue → 當下主動 `gh issue list`。
- 🚫 **禁止**掛 GitHub Actions / cron / webhook 去**自動輪詢** issue。

為什麼這條是硬底線：自動輪詢 + 事件 fan-out 正是會觸發 GitHub 異常偵測、
害你的 token 被 rate limit 砍掉的流量模式。template 給很多人用，這條界線必須守住，
保護使用者不踩雷。需要「定期檢查」就由人類主動跑這個指令，不要自動化。

---

## （可選）用 label 分來源

若想用同一套流程同時管「內部交辦」與「外部回報」，可建兩個 label：
`internal`（協作/交辦）、`user`（外部使用者回報），靠 label 分流。
這對通用 template 不預設——你的 repo 需要再建。
