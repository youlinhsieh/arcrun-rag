# collector — 收集端骨架（rag-wave1 T3+T4）

> design.md §4；跑在**客戶端機器**（NAS/VM，或導入者代管的 VPS），不是 arcrun workflow（arcrun 零件禁檔案系統，見 CLAUDE.md 紅線）。
> ⚠️ **本骨架端到端（真實 NAS/VM + 真實 Gitea remote + systemd 常駐）需在本機/客戶環境驗，雲端 sandbox 沒有這些條件**——這裡只做得到：程式邏輯本身可跑、對本機臨時目錄的煙測（見下方「已驗證」）。

## 做什麼

```
watch 知識資料夾 ──(新增/修改)──► transform（.md passthrough／docx,pptx,pdf→Markitdown）──► 寫入 target repo 工作目錄
                 ──(刪除)      ──► target repo 移除對應檔
                                          │
                                    git add/commit/push
                                          │
                              Gitea push webhook（既有機制，非本骨架自建）
                                          │
                                  arcrun ingest workflow（另案，如 km_wiki_ingest_drain 同款模式）
```

**關鍵設計判斷**：collector 的責任止於「commit + push」。design.md §4 說的「打 ingest webhook」＝ Gitea 自己的 push webhook 機制（同 `Leo/Arcrun` `registry/examples/km-wiki-ingest` 已驗證的模式：Gitea push webhook → arcrun workflow），**不是** collector 自己再打一支 HTTP webhook。collector 不需要知道 ingest 的內部細節（哪個 workflow、哪個 KBDB），它只管「客戶檔案的忠實鏡像」進 Gitea repo。

## 事件驅動、不輪詢

用 `chokidar`（Node）watch 檔案系統事件（inotify/FSEvents，非 polling），對齊「單一 repo、事件驅動」的鐵律。debounce 視窗（預設 3 秒）把同一批變更合併成一次 commit，避免每個檔案獨立 commit 洗歷史。

## 刪檔語意

檔案在來源資料夾被刪除 → collector 在 target repo 對應路徑也 `git rm` → commit → push。**deprecated 標記不是 collector 的責任**——ingest workflow 收到 Gitea push event 裡的 `removed` 檔案清單後，自己去 KBDB 把對應 entry 標 `status: deprecated`（append-only，不物理刪，見 km-wiki-ingest description.md 冪等設計）。collector 只管檔案鏡像忠實，不碰 KBDB。

## 轉檔（T4）

`transform.js`：`.md`/`.markdown` passthrough（frontmatter 補 `source_path` 溯源欄位）；`.docx`/`.pptx`/`.pdf` 呼叫 `markitdown` CLI（子行程，需部署機器已 `pip install markitdown[docx,pptx,pdf]`）轉出 md，輸出路徑副檔名換成 `.md`，同時把**原檔**複製進 target repo 的 `assets/originals/<相對路徑>`（design.md §4「原檔進 LFS」）。`git-sync.js` 的 `ensureGitAttributes()` 在啟動時冪等寫入 `.gitattributes`（`assets/originals/**/*.{pdf,docx,pptx} filter=lfs ...`）。

⚠️ **LFS 是否真的生效待本機驗**：`.gitattributes` 宣告本身雲端驗過內容正確，但 LFS smudge/clean filter 要部署機器裝了 `git-lfs` 並 `git lfs install` 才真的把大檔案存進 LFS store（否則 git 仍會把二進位檔案當一般 blob 存進版控歷史——功能上檔案還是會進 repo，只是沒享受到 LFS 的空間/頻寬優化）。雲端 sandbox 沒有 `git-lfs` 二進位，這段驗不到。

其餘格式（xlsx、圖片等）不在 design.md §4 第一波承諾範圍，仍丟 `NotImplementedError` 並記警告日誌，誠實不假裝轉好。

## 檔案

| 檔案 | 職責 |
|---|---|
| `index.js` | 進入點：watch＋debounce＋事件分派＋原檔複製 |
| `transform.js` | 檔案 → md 轉換：`.md` passthrough／`docx,pptx,pdf` 走 Markitdown |
| `git-sync.js` | target repo 的 git add/commit/push 封裝＋`.gitattributes` LFS 宣告 |
| `config.js` | 環境變數讀取（`WATCH_DIR`/`TARGET_REPO_DIR`/`DEBOUNCE_MS`） |

## 設定（環境變數）

| 變數 | 說明 | 預設 |
|---|---|---|
| `WATCH_DIR` | 客戶知識資料夾（來源） | 必填 |
| `TARGET_REPO_DIR` | 已 clone 好、有 push 權限的 Gitea repo 工作目錄（去向） | 必填 |
| `TARGET_SUBDIR` | 在 target repo 內落地的子目錄 | `collected/` |
| `DEBOUNCE_MS` | 合併變更的等待視窗 | `3000` |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | commit 署名 | `collector` / `collector@localhost` |

## 部署（客戶端機器，設計稿——本輪未實際跑 systemd）

```ini
# /etc/systemd/system/arcrun-rag-collector.service（範本，未部署未測）
[Unit]
Description=arcrun-rag collector
After=network.target

[Service]
Environment=WATCH_DIR=/mnt/knowledge
Environment=TARGET_REPO_DIR=/opt/collector-repo
ExecStart=/usr/bin/node /opt/arcrun-rag/collector/index.js
Restart=always
User=collector

[Install]
WantedBy=multi-user.target
```

`TARGET_REPO_DIR` 需事先 `git clone`＋設好有 push 權限的 remote（credential 用該機器的 git credential helper 或 SSH key，不是本骨架管的事）。

## 已驗證（雲端 sandbox 能做到的部分）

- `node --check` 語法檢查全過。
- 本機臨時目錄煙測（非真實客戶環境，兩輪）：起一個 scratch git repo 當 target、一個 scratch 資料夾當 watch 來源：
  1. **T3 事件機制**：新增/修改/刪除 `.md` 檔案 → collector 正確偵測、寫入/移除、debounce 後產生一次 commit，`git log` 驗到 commit 內容與變更一致。
  2. **T4 Markitdown**：用 `python-docx` 生一份真實 `.docx`（含標題+段落）丟進 watch 資料夾 → collector 呼叫 `markitdown` 轉出真實 md 內容（人工核對文字與原檔一致）、原檔複製進 `assets/originals/`、`.gitattributes` 正確寫入三種格式的 LFS 宣告、整批 commit+push 送達 bare remote（`git log` 驗證）。
  
  **不含**（待本機/客戶環境）：真實 Gitea remote push（需真實 token+repo）、真實 git-lfs smudge/clean filter（sandbox 無 `git-lfs` 二進位）、systemd 常駐、NAS/VM 環境、Gitea push webhook 是否真觸發 ingest workflow。

## 待本機/客戶環境驗（端到端）

1. 真實客戶知識資料夾 watch（含各類真實 docx/pptx/pdf 樣本，非合成測試檔）。
2. 真實 Gitea remote push（含憑證管理）。
3. 真實 git-lfs 安裝＋`git lfs track`，確認大檔案真的走 LFS store 而非塞進一般 blob 歷史。
4. push 後確認 Gitea push webhook 真觸發 ingest workflow（另案）。
5. systemd 常駐穩定性（重開機自動起、崩潰自動重啟）。
