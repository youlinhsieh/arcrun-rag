# /wiki-capture — 把對話結論存進 wiki

把這次對話中產生的決策、誤解釐清、或重要結論存入 wiki。
解決「討論過了但知識消失」的問題。

---

## 執行流程

### 第零步：機敏檢查（寫入前一律先過）

把任何內容寫進 wiki 前，先確認**不含**密碼 / API 金鑰 / 私鑰 / 連線字串帳密 / 個資（身分證、信用卡）。
- 命中 → 不要記「值」，改記「位置」（例：「DB 密碼放 `.env`，不入 wiki」）
- 來源整檔機敏 → 提醒使用者加進 `system-dev/wiki/.wikiignore`
- 真要保留示範格式 → 該行尾加 `wiki-secret-ok` 標記
> 這是協議層自律。最後一道 `wiki-secret-scan.sh` hook 會在寫入 `system-dev/wiki/` 時機械攔截，但別依賴它兜底——當場就不要把機敏值帶進來。

### 第一步：辨識對話中的可記錄內容

掃描當前對話，找出：

| 類型 | 判斷標準 | 存到哪 |
|------|---------|-------|
| 架構決策 | 「為什麼選A不選B」「我們決定用X」 | `decisions-summary.md` + `system-dev/docs/2-architecture/decisions/` |
| CC 的誤解被糾正 | CC 說了某件事，使用者說「不是，是...」 | `mistakes.md` |
| 重要狀態更新 | 完成了某件事、阻擋了某件事 | `status.md` |
| 技術發現 | 踩到坑、找到解法、重要行為確認 | `mistakes.md` 或對應 SDD |

### 第二步：列出清單給使用者確認

格式：
```
這次對話我整理了以下內容要存入 wiki：

1. [MISTAKE] CC 誤解了 X，正確是 Y
2. [DECISION] 決定用 A 不用 B，原因是 C
3. [STATUS] 完成了 task 2.3，下一步是 2.4

確認後存入，有需要修改的嗎？
```

**停下來等確認。**

### 第三步：寫入

確認後，依照格式寫入對應檔案：

**mistakes.md 格式：**
```
⚠️ MISTAKE: [錯誤描述]
   症狀: [CC 的表現]
   正確做法: [應該怎麼做]
   原因: [背景]
   日期: [YYYY-MM-DD]
```

**decisions-summary.md 格式：**
```
## [主題] — [YYYY-MM-DD]
**結論**：[一句話]
**原因**：[簡短說明]
**詳細**：system-dev/docs/2-architecture/decisions/[檔名]
```

重大決策同時在 `system-dev/docs/2-architecture/decisions/` 建立 ADR 檔案。

### 第四步：確認

告知存到哪些檔案，共幾條記錄。
