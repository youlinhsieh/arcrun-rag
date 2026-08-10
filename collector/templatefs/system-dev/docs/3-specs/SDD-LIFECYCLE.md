# SDD 生命週期鐵律（不可違反）

> 來源：leo 2026-07-17 拍板。
> 適用：`system-dev/docs/3-specs/` 下的「規格 SDD」（requirements/design/tasks 三件式資料夾）。
> **不適用**：派工表／sprint 檔、journeys/ 卷宗、TEMPLATE-sdd、README、pending-changes.md——它們不是 SDD，不掛 status。

## 狀態標記（機器可查）

每個 SDD 資料夾的 `design.md` 最上方掛 YAML frontmatter：

```yaml
---
status: active        # active | draft | paused | closed
superseded_by: ""     # closed 且被取代時填接替的 SDD 資料夾名
---
```

- `active`：現行規格，全 repo 開發任務唯一對應源。**任何時刻整個 repo 最多一份。**
- `draft`：起草中，尚未採納。
- `paused`：動過工、暫停中；恢復＝升回 active（先收掉現任 active）或被新 SDD 繼承。
- `closed`：已完成或被取代；被取代者填 `superseded_by` 並移入 `3-specs/archive/`。

## 五條鐵律

1. **單一活性**：任何時刻只允許一份 `status: active`。所有開發任務必須對應這份 SDD 的 tasks。找不到對應任務 → 停下來問，不准直接做。
2. **禁止自行建立 SDD**：CC 在任何情況下不得主動建新 SDD。收到使用者意見先分類：澄清問題→回答即可不動文件；任務層變更（不影響核心設計）→更新現行 SDD 的 tasks 區段並標日期與原因；規格層變更（核心設計/方向改變）→走第 3 條，不准直接改 spec。
3. **規格變更只有一條路**：產出 change proposal 寫入 `system-dev/docs/3-specs/pending-changes.md`（變更摘要與觸發原因＋影響分析：現行 SDD 哪些任務作廢/修改/不受影響/尚未完成），然後**停止**，等使用者明說「confirm」。沒 confirm 就繼續依現行 SDD 工作。多個 proposal 可並存緩衝區、由人一次裁決——CC 的速度導向影響分析，不是規格增生。
4. **開新 SDD 的唯一時機**：使用者 confirm 一份規格層 proposal 時，依序：
   a. 舊 SDD 未完成且仍有效的任務**逐條搬入**新 SDD 的 tasks——**這步做完前不准寫任何程式碼**（強迫顯式盤點，遺漏會在 d 的清單被看到，而不是三天後才發現）。
   b. 舊 SDD frontmatter 改 `status: closed, superseded_by: <新SDD>`，資料夾移入 `3-specs/archive/`。
   c. 新 SDD 的 changelog 首行記錄：繼承自哪份、為何取代。
   d. 向使用者列出「已搬移任務清單」與「已作廢任務清單」請求最終確認。
5. **每次 session 開始**：先讀現行 active SDD 與 pending-changes.md，回報三個數字——「現行規格〈名稱〉＋未完成任務 N＋待裁決 proposal M」——再開始工作。若回報出現兩份 active＝規則已被違反，當場糾正。

## 硬約束（不信任單點自律，用結構保證不變量）

- `.claude/hooks/sdd-guard.sh`（PreToolUse Write|Edit）：active 數 >1 → 任何寫檔一律擋；寫 code 檔需恰好 1 份 active。
- `scripts/sdd-active-check.sh`：獨立檢查，pre-commit / CI 可掛，違反 exit 1。
- 誠實限制：hook 只擋語法層明顯違規，繞道可行但留痕可審；不聲稱不可繞過。
