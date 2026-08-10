# Logseq 任務 marker 解析（單一真相源）

> **這是「Logseq 原生任務語法」解析的唯一權威規格。** 任何要從 Logseq graph
> 抓任務狀態的功能，一律 import 這份、不得各寫一份自己的 mapping。
>
> **已知兩個消費者**（共用同一套解析，見各自 issue）：
> 1. **vault 萃取**（`/wiki-extract`，template#5）：marker → 卡片 frontmatter `task_status`。
> 2. **tasks→Project 投影**（`system-dev/workflows/tasks-project-sync.*`，template#4）：
>    當投影來源是 Logseq graph（notes/kb）時，用這份判斷任務與狀態。
>
> 兩者**只共用「怎麼 parse」**（哪幾行是任務、marker 是什麼、正規狀態是什麼、跳過什麼）；
> parse 完各自要「拿狀態做什麼」（寫卡 vs 投影 issue）不同，那部分各管各的。

---

## 為什麼不是 GFM checkbox（規格更正，leo 2026-07-04 發現）

Logseq 的原生任務**不是** GFM 的 `- [ ]` / `- [x]`，而是**大寫 marker 開頭的 block**：

```
- TODO AI 查看 leo21c 內所有 Repo，找到本地 Repo 搬到 Gitea
- DOING 建立知識總庫，可查所有子庫
- DONE 手機和電腦 Logseq 可以被放進知識總庫
```

若照舊規格只抓 `- [ ]` checkbox，**notes / kb 兩個 Logseq graph 的任務會全數漏抓**。

> 兩種源、兩套語法、同一條下游管線：
> - **SDD `tasks.md`**（各 repo `system-dev/docs/3-specs/**`）→ GFM checkbox（現行不變）。
> - **Logseq graph（notes / kb）** → 本檔的大寫 marker。

---

## 解析規格

### 1. 任務行辨識（regex）

```
^\s*- (TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED|CANCELLED)\s+
```

- marker 必須是 block（`-` bullet）的**開頭第一個 token**、全大寫、後接空白。
- `CANCELED` 與英式 `CANCELLED` 皆收（Logseq 兩種都產）。
- marker 後面到行尾（或到子 bullet 之前）是**任務內文**。

### 2. marker → 正規狀態（task_status）

| Logseq marker | 正規 task_status |
|---------------|------------------|
| `TODO`、`LATER` | `todo` |
| `DOING`、`NOW` | `in-progress` |
| `WAITING` | `blocked` |
| `DONE` | `done` |
| `CANCELED`、`CANCELLED` | `closed` |

> `LATER`/`NOW` 是 Logseq「排程視圖」用的同義 marker（LATER≈TODO、NOW≈DOING），
> 正規化後與 TODO/DOING 併軌，下游不必區分。

### 3. 必須跳過的東西（別當任務內文）

Logseq 的任務 block 底下常掛時間戳與屬性行，這些**不是內文**，解析時整段略過：

- **`:LOGBOOK:` … `:END:` 區塊**：marker 被點擊計時產生的時間戳紀錄。
  遇到 `:LOGBOOK:` 那行起、到 `:END:` 那行止（含兩端），整塊丟掉。
- **屬性行 `key:: value`**：如 `collapsed:: true`、`id:: 65a...`、`SCHEDULED:: <...>`、
  `DEADLINE:: <...>`。凡符合 `^\s*[\w-]+:: ` 的行都是屬性，不是內文。
  （`SCHEDULED`/`DEADLINE` 的日期若下游要用可另抓，但**不得當任務描述文字**。）

### 4. 巢狀子 bullet

任務 block 底下縮排的子 bullet 是該任務的補充說明（非獨立任務，除非子 bullet 自己也帶 marker）。
萃取時可併入該任務的描述脈絡；投影時只取母 block 那行當任務標題。

---

## 自檢（實作或 LLM 執行前跑一遍）

- [ ] 用的是大寫 marker regex，**不是** `- [ ]` checkbox。
- [ ] 八個 marker 全部覆蓋（含 `LATER`/`NOW`/`CANCELLED` 別漏）。
- [ ] `:LOGBOOK:...:END:` 與 `key:: value` 屬性行有跳過，沒混進任務文字。
- [ ] 狀態用上表**正規名**（`todo`/`in-progress`/`blocked`/`done`/`closed`），不是原始 marker 字面。
