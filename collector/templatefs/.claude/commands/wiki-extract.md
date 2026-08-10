# /wiki-extract — vault 增量萃取（Logseq / Obsidian → system-dev/wiki）

把**筆記 vault**（Logseq graph 如 `notes`/`kb`、或 Obsidian）的原始筆記，**增量、冪等**地
萃成 `system-dev/wiki/` 的精耕卡＋`[[wikilink]]`。這是知識一庫 ingest 的**前段**：
AI 只產卡片檔，下游 Arcrun ingest 再從 wikilink 機械拉三元組進 KBDB。

> **跟 `/wiki-init` 的分工**：
> - `/wiki-init` 是**首次**建結構 + 全庫首萃（一次性）。
> - `/wiki-extract` 是**之後每次**的增量重萃——vault 會被 Syncthing/cron 持續灌新筆記，
>   這支負責「只萃變動的、沒變的不碰、不浪費 AI run」。給 Routine / cloud-worker 反覆跑。
> - **跑它的是你（CC / Routine）＝LLM 本人，不需任何 token**。

> **邊界（硬規矩，別越界）**
> - 只往 `system-dev/wiki/` 寫。**絕不寫入 KBDB、絕不拉三元組紀錄**——三元組是下游
>   Arcrun 從你產的 `[[wikilink]]` + `## 關聯` 機械映射（另一張 issue），不是這支的事。
> - **原始筆記唯讀**：`journals/`、`pages/`、Obsidian 根 `.md` 是 leo 的手寫真身，
>   改了會被 Syncthing 推回他手機污染筆記 App。萃取＝只讀原文、只寫 wiki。
> - **D16 精耕非 RAG**：萃「知識點」成自包含原子卡 + 建 wikilink，**不地毯灌原文全文**。

---

## 執行流程

### 第一步：確認這是 vault repo，定位 raw source

偵測邏輯**同 install.sh / wiki-init**：

| 偵測到 | 型態 | raw source（要掃的原文） |
|--------|------|--------------------------|
| 根目錄有 `logseq/` | Logseq vault | `journals/*.md` + `pages/*.md` |
| 根目錄有 `.obsidian/` | Obsidian vault | vault 根下所有 `.md` |
| 都沒有 | **不是 vault** | → 停手。這支只處理 vault；一般 dev repo 開發時就手寫 `.claude`/`system-dev/wiki`，不需萃取 |

沒有 `system-dev/wiki/`？→ 先跑 `/wiki-init`（首次建結構＋首萃），再回來用這支做增量。

### 第二步：content_hash 冪等 —— 決定哪些檔要萃（省 run 的核心）

讀萃取 manifest：`system-dev/wiki/.extract-manifest.json`（不存在＝首次，視同全部要萃）。
格式：

```json
{
  "version": 1,
  "algo": "sha256",
  "sources": {
    "journals/2026_07_01.md": {
      "content_hash": "<sha256 of file bytes>",
      "extracted_at": "2026-07-06",
      "cards": ["Prompt能力即拆解自己邏輯的能力", "程式化邏輯可圖解任何主題不限AI"],
      "skipped_reason": null
    },
    "journals/2026_06_25.md": {
      "content_hash": "<sha256>",
      "extracted_at": "2026-07-06",
      "cards": [],
      "skipped_reason": "空檔／訊息量不足，無可萃知識點"
    }
  }
}
```

對每個 raw source 檔：

1. 算目前 `content_hash`（`sha256sum <file>`，取檔案 bytes 的 hash）。
2. 跟 manifest 裡該檔的 `content_hash` 比：
   - **相同 → skip，不讀不萃、不呼叫任何 AI 推理**（就算它上次 `cards: []` 也 skip——空檔沒變還是空）。
   - **不同或不在 manifest → 這檔要（重）萃**。
3. manifest 有、但檔已不存在 → 該檔被刪，把它的 entry 從 manifest 移除（卡片是否連帶處理見第五步）。

> **這一步是「省 run」的重點**：vault 每天可能只動 1～2 個 journal，其餘幾十個檔 hash 沒變
> 就整批跳過，AI 只對真正變動的檔動腦。**重跑一個沒變動的 vault ＝ 零 AI 呼叫、零 diff。**

### 第三步：對「要萃」的檔，抓知識點 + 任務

逐個變動檔讀原文，分兩類抽取：

**(a) 知識點 → 概念原子卡**
判準與卡片格式**完全依 `/wiki-init` 第五步**（frontmatter `tags:`/`gloss:`、H1、麵包屑
`← [[<bucket>/00-INDEX]]`、`**來源**`、`## 摘要`、`## 重點`、`## 實體`、`## 關聯` 的
typed-edge 三元組、TAXONOMY 受控標籤、硬自檢等）——**不在這裡重寫格式，一律回去讀那份**。
廢話/訊息量薄的段落略過（在 manifest 記 `skipped_reason`，誠實留痕、不留卡）。

**(b) Logseq 任務 marker → 任務卡（task_status）**
解析**完全依** `system-dev/docs/4-guides/logseq-markers.md`（單一真相源，與 template#4
tasks 投影共用同一套；**別自己另寫 mapping**）。摘要：

- 任務行 regex：`^\s*- (TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED|CANCELLED)\s+`
- 狀態正規化：TODO/LATER→`todo`、DOING/NOW→`in-progress`、WAITING→`blocked`、
  DONE→`done`、CANCELED/CANCELLED→`closed`。
- 跳過 `:LOGBOOK:…:END:` 區塊與 `key:: value` 屬性行（`collapsed::`、`id::`、
  `SCHEDULED::`、`DEADLINE::`…），**別把 marker 或屬性當任務內文**。

有實質內容的任務 → 產一張任務卡進 `cards/tasks/` bucket，frontmatter 帶 `task_status`：

```markdown
---
tags: [<領域標籤，依 TAXONOMY>]
task_status: todo        # ← 依上表正規名；這是任務卡才有的欄位
gloss: 一句話定義這個任務要達成什麼（供下游 normalize）
---
# <任務一句話標題（marker 後的內文，去掉 marker）>

← [[tasks/00-INDEX]]

**來源**：`journals/2026_07_01.md`（TODO block）
**最後更新**：YYYY-MM-DD

## 摘要
[任務要做什麼、脈絡]

## 實體
- **<關鍵實體正規名>**（<同義詞>）— <一句描述>

## 關聯
### 內文知識關係（端點＝上方 `## 實體` 正規名，一字不差）
- <實體A> >> <謂詞> >> <實體B>
### 卡片關係（卡對卡）
- [[本任務卡]] >> 涉及 >> [[相關概念卡]]
```

> 純瑣事任務（「買菜」這種無知識量）不必成獨立卡——可在 `cards/tasks/00-INDEX.md`
> 列一行帶狀態即可，避免灌垃圾卡。判準同 D16：有沒有知識/專案價值。

### 第四步：更新桶索引與 INDEX

- 每個動到的 bucket（如 `cards/notes/`、`cards/tasks/`）更新其 `00-INDEX.md`
  （容器：只連不重寫，H2/H3 分節）。
- 更新 `system-dev/wiki/INDEX.md` 的標籤視圖與卡片清單。
- 任務卡可在 INDEX 開一個「任務視圖」按 `task_status` 聚類。

### 第五步：寫回 manifest + 驗證原文 0 動

1. 把這次萃過的每個檔的**新 `content_hash`**、`extracted_at`、產出的 `cards`、
   （或 `skipped_reason`）寫回 `system-dev/wiki/.extract-manifest.json`。
   **沒動到的檔的 entry 原樣保留**（別整檔重寫掉別人的 hash）。
2. 驗證原文零異動（踩過的坑）：
   ```
   git status --short journals/ pages/    # Obsidian 則看根目錄 .md ——須 0 新增 0 修改
   ```
   有任何原文變動 → 你誤寫了 raw source，回滾。

### 第六步：完成報告

```
✅ wiki-extract 完成（增量）
掃描：N 個 raw source 檔
  萃取：M 個（content_hash 變動）→ 產出 X 張概念卡 + Y 張任務卡
  跳過：K 個（hash 未變，零 AI 呼叫）
任務狀態分布：todo A / in-progress B / done C / …
原文驗證：journals/ pages/ git status 0 異動 ✅
manifest：system-dev/wiki/.extract-manifest.json 已更新
```

---

## 冪等自檢（Routine 反覆跑必守）

- [ ] 跑之前先讀 manifest，hash 相同的檔**完全不進 AI**（不是「讀了才發現一樣」，是靠 hash 先擋）。
- [ ] 對「同一個沒變動的 vault」連跑兩次：第二次應是**零萃取、零卡片 diff、零 manifest 變化**。
- [ ] 只有 `system-dev/wiki/` 有寫入；`journals/`、`pages/` git status 全乾淨。
- [ ] 任務狀態用正規名，marker/屬性沒混進內文（照 `logseq-markers.md` 自檢）。
