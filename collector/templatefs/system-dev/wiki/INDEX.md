# system-dev/wiki/ — LLM 記憶系統

> 新 session 開始時從這裡導航。
> 目的：讓 CC 不需要重新學習已知的事。
> 維護者：CC（人不手動編輯這裡）

---

## push 檔（session 開始由 hook 主動注入，CC 行動前必看見）

| 檔案 | 注入形態 | 內容 |
|------|---------|------|
| `status.md` | 全文 | 當前進度、下一步（時態狀態）|
| `principles.md` | 全文（一行一條）| 跨全局設計原則，行動前必服從 |
| `mistakes.md` | 標題+一行症狀，全文按需展開 | 踩過的坑、被糾正的誤解（防不自覺盲區）|

> 為什麼這三個 push 而非 pull：它們是「CC 不會主動查、但不看就出事」的盲區。詳見 `/wiki-init` 的「push vs pull」。

---

## pull：cards/（CC 按需檢索）

一切知識內容——原文摘要、AI 筆記、決策、概念知識——都寫成 `cards/<bucket>/` 的概念原子卡。
`decisions-summary.md` 已降級為 cards（決策＝知識內容）；既有的保留為相容。

---

## 維護規則

1. 只增不刪——記錄 append，內容改了加新條目說明「舊的已更新」
2. status.md 每次 session 結束更新；mistakes/principles 一發現就 append
3. principles 一行一條、≤15 條（超過代表該合併或下放成 card）
4. **新增一個檢索角度 = 在下方「多角度視圖」加一節，不開新實體檔、不問用戶**

---

## 多角度視圖（由 /wiki-init、/wiki-capture 填入）

INDEX 是**所有檢索角度的入口**，不只標籤。原文是唯讀 SSoT，wiki 是改寫過的記憶。
新增角度只要在這裡加一節（如「決策角度」「原則角度」），指向對應 cards 或 push 檔——**不必新增實體特殊檔**。

### 標籤角度（按 `TAXONOMY.md` 的軸聚類，指向桶子索引）

```markdown
#### 知識管理
- [[pkm/00-INDEX]] — PKM 知識管理（N 卡）

#### AI 協作
- [[ai/00-INDEX]] — AI 協作（M 卡）
```

### 決策角度（取代舊 decisions-summary.md 的視圖）

```markdown
- [[某決策卡]] — 一句話結論（YYYY-MM-DD）
```

> 結構：INDEX（多角度入口）→ `cards/<bucket>/00-INDEX.md`（桶子索引，固定名）→ 概念原子卡。
> 指 `00-INDEX` **一律帶路徑** `[[bucket/00-INDEX]]`（固定名跨桶撞名）；卡片間用裸 `[[卡名]]`。
> 分類由卡片 frontmatter `tags:` 承載，標籤字典見 `TAXONOMY.md`。詳見 `/wiki-init` 規範。
