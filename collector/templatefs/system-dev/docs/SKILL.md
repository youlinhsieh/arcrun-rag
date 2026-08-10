---
name: wiki-cowork-scan
description: "掃描本機 Documents 下所有裝了 system-dev-template 的資料夾，自動整理 LLM Wiki。支援一般專案、Logseq vault、Obsidian vault 三種結構，偵測方式與 install.sh 一致。觸發時機：使用者說「整理 wiki」「幫我掃 wiki」「更新我的 wiki」「wiki 掃描」，或 Cowork cron 定期觸發。"
---

# Wiki Cowork Scan

## 核心原則

這個 skill 與 Claude Code 的 `/wiki-init` `/wiki-capture` 共用同一套規則：

| 層         | 規則                                      |
|------------|-------------------------------------------|
| raw source | 只讀，不動                                |
| `system-dev/wiki/` | 唯一輸出地點，只增不覆                |
| `CLAUDE.md` | 不動                                     |
| `logseq/`、`.obsidian/`、`assets/` | 絕對不動     |

**CC 和 Cowork 輸出格式相同，任何一方整理過的內容，另一方看到就跳過或補充，不覆蓋。**

---

## 第一步：發現所有目標資料夾

掃描 `~/Documents`（遞迴深度 3 層），找出所有含 `system-dev/wiki/` 的資料夾。

```
~/Documents/
  project-a/system-dev/wiki/     ← ✅ 目標
  Logseq/system-dev/wiki/        ← ✅ 目標
  其他資料夾/                  ← ❌ 跳過
```

找到後列出清單，告訴使用者：「找到 N 個 wiki 資料夾，開始整理。」

---

## 第二步：對每個資料夾偵測 vault 類型

進入每個目標資料夾的**根目錄**（`system-dev/wiki/` 的上兩層），依序判斷：

### 判斷順序（與 install.sh 一致）

```
if 根目錄有 logseq/ 資料夾
  → vault 類型：Logseq
  → raw source：pages/、journals/
  → 忽略：logseq/、assets/

else if 根目錄有 .obsidian/ 資料夾
  → vault 類型：Obsidian
  → raw source：根目錄下所有 .md（排除 .obsidian/ 內的檔案）

else
  → vault 類型：一般專案
  → raw source：docs/ 下所有 .md
```

---

## 第三步：讀取現有 wiki 狀態

進入 `system-dev/wiki/`，讀取：

- `INDEX.md`：目前已有哪些 wiki 頁面（多角度視圖入口）
- `status.md`：上次整理時間、進度
- `principles.md`（如果有）：本專案跨全局的設計原則——整理時必須服從

目的：**知道哪些已整理過，只處理新增或有變動的 raw source**，不重複整理。

---

## 第四步：整理規則

### 核心判準：push vs pull（wiki 是給 AI 看的）

整理任何內容前，先判斷它該進 **push 檔** 還 **cards（pull）**——判準是「**CC 做事時會不會被動看見**」：

- **push 檔**（`status.md` / `mistakes.md` / `principles.md`）：CC session 開始就被 hook 注入。給「CC 不會主動查、但不看就出事」的東西。
- **pull**（`cards/`）：CC 想到要查才看見。一切知識內容（原文摘要、AI 筆記、決策、概念…）都寫成 cards。

| 內容 | 去哪 | 理由 |
|------|------|------|
| 當前進度、下一步 | `status.md`（push 全文） | 時態狀態，不看會重做 |
| 跨全局設計原則（一行一條，≤15） | `principles.md`（push 全文） | 會被遺忘的盲區，CC 設計時必服從 |
| 踩坑、被糾正的誤解 | `mistakes.md`（push 摘要+按需展開） | 防 CC 不自覺的盲區 |
| 決策、原文摘要、概念知識、其餘一切 | `cards/<bucket>/`（pull） | 知識內容；CC 面對時自然會查 |

> `decisions-summary.md` 已**降級為 cards + INDEX 決策視圖**（決策＝知識內容）。既有的保留為相容，不刪。
> CC 與 Cowork **共用此判準**，產出一致：任一方寫進 push 檔或 cards，另一方看到就跳過或補充，不覆蓋。

### 讀 raw source

逐一讀取 raw source 的 `.md` 檔。跳過：
- 檔名以 `.` 開頭的隱藏檔
- `.wikiignore` 裡列出的 glob pattern（如果存在）
- 含有 `<!-- wiki:ignore -->` 標記的區段

### 整理邏輯

每個 raw source 檔案，判斷：

1. **INDEX.md 裡已有對應條目，且 raw source 未修改** → 跳過
2. **INDEX.md 裡已有條目，但 raw source 有新內容** → 更新對應 wiki 頁面，補充新資訊，不刪舊內容
3. **INDEX.md 裡沒有對應條目** → 新建 wiki 頁面

### Wiki 卡片格式（概念原子卡，存到 `cards/<bucket>/`）

```markdown
---
tags: [知識管理, AI協作, 方法論]
gloss: 一句話定義這個概念是什麼（給下游語義 normalize 用，選填、deep tier 才產）
---
# 概念全名

← [[<bucket>/00-INDEX]]

**來源**：`[raw source 相對路徑]`
**最後更新**：YYYY-MM-DD

## 摘要

[一句話核心]

## 重點

- [自包含改寫的要點，不寫「詳見原文」]

## 實體

> 本卡內文的關鍵實體（也是 graph node）。名＋描述一起供下游 embedding normalize。
> AI 生產、人不必讀；集中放、一實體一行、不縮排、不重複。
- **原子筆記**（atomic note／卡片原子化）— 每張卡只承載一個不可再分論點的知識記錄單元。
- **傳統筆記**（大鍋炒筆記）— 把多主題混雜在同一篇、難精確引用的記錄方式。

## 關聯

### 內文知識關係（內文實體間；端點＝上方 `## 實體` 的正規名，一字不差）

- 原子筆記 >> 對立於 >> 傳統筆記
- 傳統筆記 >> 犧牲 >> 精確引用

### 卡片關係（卡對卡）

- [[本卡]] >> 謂詞（動詞短語） >> [[他卡]]
```

### 架構：三層 + 標籤橫切（183 卡實證）

```
INDEX.md              ← 頂層：標籤視圖（非資料夾列表）
TAXONOMY.md           ← 標籤字典（受控擴充：先查重再登記）
cards/<bucket>/
  ├── 00-INDEX.md     ← 桶子索引（固定名，容器：只連不重寫）
  └── <概念全名>.md    ← 概念原子卡
```

- **資料夾只是儲存桶，分類由 frontmatter `tags:` 承載**——不繼承原稿目錄，由 AI 重新組織。
- **桶子索引固定名 `00-INDEX.md`**：`00-` 排序最前、一眼可辨，載入任何桶先讀它。
- **frontmatter `tags:` 而非行內 `#tag`**：內文常用 `#`（如 `#猜想`），行內標籤會讓 ingest 分不清「分類」與「內文範例」污染 graph；frontmatter 零歧義。標籤只能用 `TAXONOMY.md` 列出的；**禁止繞過字典在卡片直接冒新標籤**，但字典可受控擴充（遇新軸先查重、確認非同義詞，再登記進本 repo 的 TAXONOMY.md）。
- **麵包屑帶路徑**：H1 次行 `← [[<bucket>/00-INDEX]]`。指 `00-INDEX` 因固定名跨桶撞名，**一律帶路徑**；卡片間連結用裸 `[[卡名]]`。

### 使用 typed-edge 三元組（抓內文實體關係，不只卡對卡）

用**帶語義的三元組** `A >> 謂詞 >> B` 寫進 `## 關聯`。**重點是抓內文裡的實體關係**——卡對卡（`[[卡A]] >> 謂詞 >> [[卡B]]`）只是把既有雙鏈加個動詞、資訊量幾乎沒增加；知識圖譜的價值在內文概念間的關係（`原子筆記 >> 對立於 >> 傳統筆記`，這些 A/B 是內文概念、不是卡標題）。

格式 `A >> 謂詞 >> B`，規則：
1. **方向性**：必須讀成「A（謂詞）B」一句通順的話；A、B 順序＝主→賓真實方向。
2. **謂詞用動詞 / 動詞短語**（反駁、奠基於、犧牲），天然帶方向。**禁名詞當謂詞**——`>> 存儲格式 >>`、`>> 操作體驗 >>` 讀不通，是錯的。
3. **謂詞自由書寫但別太天馬行空**：寫「參考／參照」皆可（下游 embed 自動聚類同義謂詞），別寫「瞄了一眼」這種抓不到同義的。
4. **內文三元組端點用裸文字**（非 `[[wikilink]]`），避免在 Logseq 產生大量紅色斷鏈；卡對卡那層才用 `[[]]`。
5. **向後相容**：純 `[[A]]` 仍合法（無類型邊），盡量補謂詞。

> **★ 硬自檢（Haiku 量產必備護欄）★** —— 內文三元組的「端點 = `## 實體` 詞條」
> `A >> 謂詞 >> B` 的 A、B 必須與 `## 實體` 某個粗體正規名【一字不差】。**寫完後逐條自檢**：把 A、B 拿去 `## 實體` 找有沒有完全相同的正規名，沒有 → 這條錯了。
> 修法擇一：(a) 改用實體表已有的詞；(b) 端點確是重要實體 → 補進 `## 實體` 再指它。
> 禁止：端點帶括號註解、端點是整句補語、端點是形容詞短語。
> （實證：光寫規則 Haiku 會略過，端點對不齊 14 條；寫成自檢動作後 14→0。跑 1-2 張看不出，跑 12 張才暴露。）

`>>` 為分隔語法，全程一致即可。這是 Karpathy LLM Wiki「知識互連」的強化版——連結不只存在，還帶類型與方向。

### 萃 gloss（node 一句說明，供下游語義 normalize）

每張卡＝一個 entity / graph node。deep tier 改寫時，frontmatter 補一句 `gloss:`——這個 node 是什麼的一句定義。下游 KBDB 對「entity 名 + gloss」一起做 embedding 求相似度，自動歸一同義詞（比只對名字準、比手維護 alias 表自動）。

- **在知識生產的當下、由整理者（CC / Cowork）建**：gloss 跟三元組同階段萃，**不留給下游 ingest 臨時補**——下游只有單檔／跨庫視角，編不出貼合的 gloss。
- **選填、deep tier 才產**：淺萃不浪費。
- **gloss ≠ 摘要**：`gloss` 是 frontmatter 給機器 normalize 的定義句（「X 是…」）；`## 摘要` 是給人讀的核心句。
- **兩層 gloss**：① frontmatter `gloss:` 描述「卡標題」這個 node；② `## 實體` 區塊的每行描述句，描述「內文實體」這些 node。**內文實體也是 graph node、也需描述句**才能被下游 embedding normalize（`黃仁勳` vs `Jensen Huang` 靠描述拉近向量）。
- **實體要描述、謂詞不用**：實體同義詞字面差遠需描述拉近；謂詞同義詞字面本就近，裸詞 embed 自動聚類。
- **對齊下游 envelope**：frontmatter `gloss:` 與 `## 實體` 詞條對應 ingest envelope 的 `nodes[].gloss`。

> **改寫時必守**：① 絕不寫入 raw source（只往 `cards/<bucket>/` 寫，事後驗 raw source 0 異動）；② 檔名＝卡片全名，冒號用全形「：」、斜線用全形「／」，全程一種字元避免斷鏈。

---

## 第五步：更新 INDEX.md 和 status.md

### INDEX.md 格式（頂層 = 標籤視圖）

頂層 INDEX 按 `TAXONOMY.md` 的軸聚類，指向各桶子索引（帶路徑），不是平鋪頁面列表：

```markdown
# Wiki Index

> 最後更新：YYYY-MM-DD HH:MM | 來源：cowork-scan | 總卡數：N

### 知識管理
- [[pkm/00-INDEX]] — PKM 知識管理（N 卡）

### AI 協作
- [[ai/00-INDEX]] — AI 協作（M 卡）
```

桶子索引 `cards/<bucket>/00-INDEX.md` 是容器（只連不重寫，H2/H3 分節列出該桶卡片）。

### status.md 更新

在現有內容**末尾追加**（不覆蓋）：

```markdown
## YYYY-MM-DD HH:MM｜cowork-scan

- vault 類型：[Logseq / Obsidian / 一般專案]
- 掃描檔案：N 個
- 新增頁面：N 個
- 更新頁面：N 個
- 跳過：N 個（未變動）
```

---

## 第六步：回報結果

整理完所有資料夾後，輸出摘要：

```
✅ Wiki 整理完成

資料夾 1：~/Documents/project-a
  類型：一般專案
  新增：3 頁，更新：1 頁，跳過：12 頁

資料夾 2：~/Documents/Logseq
  類型：Logseq vault
  新增：5 頁，更新：2 頁，跳過：47 頁

總計：8 頁新增，3 頁更新
```

---

## 絕對禁止

- ❌ 修改任何 raw source 檔案
- ❌ 修改 `CLAUDE.md`
- ❌ 動 `logseq/`、`.obsidian/`、`assets/` 資料夾
- ❌ 刪除 `system-dev/wiki/` 裡已有的頁面（只增補，不刪除）
- ❌ 把機敏資訊（密碼、金鑰、個資）寫進 wiki（遇到跳過並記錄）
- ❌ 整理沒有 `system-dev/wiki/` 的資料夾（那不是這個 skill 的目標）
