# /wiki-recall — Session 開始，手動接關

開新對話時接上次進度。**Fallback 命令**：SessionStart hook 沒啟動時手動接關；要完整脈絡時也用。

> 主路徑是 SessionStart hook 自動注入 status 重點，不靠你打命令。
> 這支命令應對 hook 失效，以及需要比「status 重點」更完整脈絡的時候。

---

## 命名閉環

init(建) → update(存，session 末) ↔ **recall(接，session 初)** → capture(隨時存結論)

---

## 執行流程

### 第一步：讀 status.md（當前進度）

讀 `system-dev/wiki/status.md`，掌握：
- 正在做什麼、阻擋點
- 下次 session 第一件事
- 待負責人確認、已知問題

### 第二步：讀 decisions-summary.md（為什麼這樣做）

讀 `system-dev/wiki/decisions-summary.md`，掌握相關的架構決策——避免重新討論已定案的事。

### 第三步：讀 mistakes.md（別重犯）

讀 `system-dev/wiki/mistakes.md`，掌握已知誤解 + 快速檢查清單。

### 第四步：掃 wishlist / HANDOFF（如果有）

- `docs/wishlist.md`：待補功能
- 任何 `HANDOFF.md` / 交接note：上一棒留下的脈絡

### 第五步：回報接關結果

```
📍 接關完成
🔄 上次正在做：[status 的「正在做」]
🎯 下次第一件事：[status 的「下次 session 第一件事」]
⚠️ 待確認：[如有]
```

---

## 鐵律：快照非即時狀態

status / wiki 是 **point-in-time 快照，不是即時狀態**。

接關 ＝ 讀快照 **＋ 核實快照**，**不盲信**。

> 實例：某專案 status 曾寫「待 A 收尾 X」，實際 X 早已完成。
> 照舊資訊行動會去催一件已完成的事。

動手前，先用當前 code / git / 檔案核實快照寫的事項是否仍成立。發現落差 → 先更新 status，再動手。
