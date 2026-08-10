# /sdd-check — 確認當前任務有沒有對應 SDD

動手前執行。確保 CC 有全局觀，不會在沒有設計文件的情況下猛衝。

---

## 生命週期（單一活性鐵律，全文見 `system-dev/docs/3-specs/SDD-LIFECYCLE.md`）

五條鐵律摘要：

1. **單一活性**：任何時刻整個 repo 只允許一份 `status: active` 的 SDD；所有開發任務對應它的 tasks，找不到對應任務 → 停下來問，不准直接做。
2. **禁止自行建立 SDD**：澄清問題→回答不動文件；任務層變更→更新現行 SDD 的 tasks（標日期與原因）；規格層變更→走第 3 條。
3. **規格變更只有一條路**：change proposal 寫進 `system-dev/docs/3-specs/pending-changes.md`（摘要＋觸發原因＋影響分析），然後**停止**等使用者「confirm」。
4. **開新 SDD 的唯一時機**：使用者 confirm 後——先把舊 SDD 未完成任務逐條搬入新 SDD（做完前不准寫 code）→ 舊的標 `closed` + `superseded_by` 移入 `archive/` → 新 SDD changelog 記繼承 → 列搬移/作廢清單請最終確認。
5. **每次 session 開始**先讀 active SDD 與 pending-changes.md，回報三個數字：

   ```
   📐 現行規格：〈SDD 名稱〉
   📋 未完成任務：N
   ⚖️ 待裁決 proposal：M
   ```

   若出現**兩份 active＝規則已被違反，當場糾正**（收斂到一份，其餘 paused/closed）。

---

## 執行流程

### 第一步：理解任務

確認使用者要做什麼：
- 涉及哪個子系統？
- 是新功能還是修改現有功能？
- 影響範圍？

### 第二步：尋找對應 SDD

在 `system-dev/docs/3-specs/` 下尋找對應的子系統目錄，確認有沒有：
- `design.md`（設計文件）
- `tasks.md`（任務清單）

### 第三步：根據結果回應

**情況 A：找到對應 SDD**
```
✅ 找到 SDD：system-dev/docs/3-specs/[子系統]/
📋 design.md：[確認]
📋 tasks.md：[確認，列出相關 task]
🎯 對應 task：[編號和描述]
繼續嗎？
```

**情況 B：找不到 SDD，任務明確**
```
⚠️ 找不到對應 SDD
任務：[描述]
建議在 system-dev/docs/3-specs/[建議子系統名]/ 建立 SDD

要我幫你起草 design.md 嗎？（需要你確認後才動手）
```

**情況 C：找不到 SDD，任務模糊**
```
⚠️ 找不到對應 SDD，而且任務範圍不夠清楚
請先回答：
1. 這個功能屬於哪個子系統？
2. 完成的標準是什麼？
3. 有沒有不能動的邊界？
```

### 注意

- 找不到 SDD **不等於可以直接動手**
- 小修改（修 bug、改文字）可以豁免，但要明確說「這是小修改，範圍是 X」
- 新功能、架構變動、跨模組的修改 → 一定要有 SDD
