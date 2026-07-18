# arcrun-rag 產品安裝手冊 v2 — 裝完你擁有什麼（2026-07-12，本機全鏈實測版）

> 讀者：外部工程師／導入者。風格：裝一支腳本、丟檔案、開界面。
> 鐵律：**只寫這次真的跑通的**；沒跑通的誠實列在「已知限制」。
> 本手冊對應「leo 實例能力對照」：leo 在自己的 Mira/leo21c 實例已證實整條鏈（筆記多管道推 Gitea → ingest 進 D1 → MCP/GUI 查詢＋LLM 精耕）；這個包＝把那份已證實的複製成「別人裝了就擁有同一套」，對照表見 `system-dev/docs/3-specs/rag-wave1/mira-instance-inventory.md`。

---

## 0. 裝完你擁有什麼（能力清單，對照 leo 實例）

| 能力 | leo 實例（已證實） | 這個包裝完（本機實測 2026-07-12） |
|---|---|---|
| 知識資料夾：檔案丟進去＝進庫 | Syncthing 兩條鏈＋Linode cron 腳本（leo 自建） | ✅ **collector 全自動**：watch→轉檔→commit/push，秒級（比 leo 的 30 分 cron 快） |
| docx/pptx/pdf 轉檔 | —（leo 餵的是 md 精耕卡） | ✅ Markitdown 自動轉（docx 實測：丟 .docx → 內容可搜） |
| Gitea 知識 repo（真相源） | git.uncle6.me（leo 手動開 repo/token） | ✅ **本機容器全自動佈建**（admin/org/repo/token/webhook 一鍵） |
| ingest 進 D1（機械、零 LLM） | km_wiki_ingest_drain（cron 慢推＋webhook delta） | ✅ rag_ingest workflow（Gitea push webhook 秒級觸發，事件驅動不輪詢） |
| 關鍵字查詢 | ✅ | ✅ |
| 知識圖譜查詢 | ✅（graph plugin＋workflow） | ✅ graph_neighbors workflow（圖隨檔案自動長：每檔一條 part_of 邊） |
| 語意查詢 | ✅（leo21c 有 Vectorize＋Workers AI） | ⚠️ 本機不可用（無 Vectorize），**誠實降級** keyword＋capability_hint，不 crash；雲端版部署即有 |
| LLM Wiki 精耕（AI 讀了長 wiki） | CC／Claude 萃取（leo 的 CC 環境） | ✅ **rag_wiki_digest（Gemini）＋自動接鏈**：檔案 ingest 完自動長 wiki 摘要頁（預設開、可關，見 §5）——用戶不需要 CC |
| 刪檔＝下架 | leo 手動清 | ✅ **G9 已實作**：資料夾刪檔 → 庫內 entries＋triplet 標 deprecated（append-only 不物理刪；graph 查詢自動略過） |
| 管理 GUI | Mira console（leo21c） | ✅ 同一個 Admin Console 本機起（登入/總庫搜尋/駕駛艙/工作流頁） |
| 多人帳號＋庫級權限 Portal | —（leo 單人 owner） | ❌ **產品目標、上游開發中**（Arcrun#24/#25）；現階段界面＝admin console 單人 owner 帳密 |
| MCP 查詢 | ✅（arcrun-mcp OAuth） | ⚠️ 本機未驗（miniflare 未起 MCP worker）；雲端版已上線件 |

## 1. 前置需求

macOS（Apple Silicon 實測）／Node 22＋pnpm＋全域 wrangler 4.98+／git／Docker（OrbStack 實測）。
選配：`pip install 'markitdown[docx,pptx,pdf]'`（沒裝＝docx/pptx/pdf 跳過、md 照常）。
Arcrun 引擎 checkout：`git clone https://git.uncle6.me/Leo/Arcrun.git`。
**不需要** Cloudflare 帳號。

## 2. 安裝（一支腳本）

```bash
# 工程件已落 repo（2026-07-13 G8 放行）
ARCRUN_REPO=<你的 arcrun checkout 路徑> ./install/install.sh
```

選配：repo 根放 `.env`（樣板 `install/env.sample`，只填 key 名的檔絕不進版控）——
`GEMINI_API_KEY=<AI Studio key>` 給 LLM 精耕用；`AUTO_DIGEST=true|false` 控制自動接鏈（見 §5）。

它依序做（全自動、冪等，重跑不炸）：
1. 前置檢查（缺什麼給明確指令後停）
2. Gitea 容器（port 3300，SQLite）＋admin＋org `demo`＋private repo `knowledge`＋API token＋push webhook
3. Arcrun 引擎 4 個 worker（kbdb 8787／cypher 8788／http_request 8789／code 8790，miniflare 本機，含 `--var` 保險：任何誤推導 URL 都打向不存在域名）＋migrations＋recipe seed
4. KBDB templates（triplet/entity/entity_pending，與 leo 實例同 schema）
5. 3 個 workflow 註冊（`acr push` 指本機）：rag_ingest（含 G9 刪檔分支＋G11 自動精耕接鏈）／graph_neighbors／rag_wiki_digest
6. collector 起 watch：`~/arcrun-rag-demo/knowledge-inbox/`

最後印出「✅ 裝完」＋下一步指令。約 3-5 分鐘（首次含 docker pull 與 npm 安裝會久些）。

## 3. 丟檔案 → 你會看到什麼（實測輸出）

把 md 或 docx 丟進 `~/arcrun-rag-demo/knowledge-inbox/`。約 5-10 秒內：

- collector log：`[collector] 寫入 新人入職指南.md` → `[collector] 已 commit+push（3 項變更）`
- cypher log：`POST /webhooks/named/demo/rag_ingest/trigger 200 OK (484ms)`
- 查詢立即命中：

```bash
curl "http://127.0.0.1:8787/entries/search?q=請假&owner_id=demo"
# → {"success":true,"entries":[{"content":"## 請假規定\n特休依年資計算…","page_name":"新人入職指南",…}],"mode":"keyword"}

curl "http://127.0.0.1:8788/q/demo/graph_neighbors?node=knowledge-base&depth=2&template=triplet&namespace=demo&kbdb_base=http://127.0.0.1:8787"
# → {"neighbors":[{"node":"採購作業辦法2",…},{"node":"新人入職指南",…},{"node":"資訊安全守則",…}]}
#   ——圖譜隨你丟的檔案自動長出來

# 語意查詢（本機誠實降級示範）
curl "…/entries/search?q=請假&owner_id=demo&mode=semantic"
# → {"requested_mode":"semantic","mode":"keyword","capability_hint":"語義查詢需先開 vectorize…"}
```

docx 實測：丟 `採購作業辦法.docx` → 自動轉 md 入庫、原檔進 `assets/originals/`（LFS 宣告），
`curl "…search?q=總經理"` 命中「五萬元以上需總經理簽核」。

## 4. 開界面（Admin Console）

瀏覽器開 `http://127.0.0.1:8788/console`：
- 首次進入引導設 email/密碼（單一管理員；實測 `POST /console/setup` 回 session＋tenant demo）
- **總庫搜尋**頁：直接搜你丟進去的內容（實測命中 ingest 的 blocks）
- 駕駛艙/工作流/憑證頁可開；無資料的顯示誠實空狀態
- ⚠️ 卡片「關聯」視圖需 kbdb-graph-plugin worker（本機未起）→ 顯示「關聯服務不可達」；圖查詢請用上面的 graph_neighbors API
- ⚠️ 品牌字樣仍是 Mira（Arcrun#21 rebrand 進行中）；多人帳號/庫級權限 Portal＝上游 Arcrun#24/#25 開發中

## 5. LLM 精耕（知識庫自己長 wiki，Gemini）

**自動接鏈（預設開，2026-07-13 拍板＝G11）**：`AUTO_DIGEST=true`（預設）時，每個檔案 ingest 完
自動觸發 rag_wiki_digest——丟檔案 → 幾秒後庫裡多一頁 `wiki-<頁名>` 精耕摘要，零手動。
機制＝arcrun 原生 `trigger_workflow` 內建零件（in-process 接鏈，非 workflow 回呼 LLM 判斷）。

**💰 成本註記**：每檔一次 Gemini generateContent API 呼叫＝token 花費。文件量大的導入
（首灌幾百檔）建議 `AUTO_DIGEST=false` 裝機，改手動／批次觸發，穩定後再開。改開關＝改 `.env` 重跑
`install/install.sh`（冪等，只會重推 workflow）。

手動觸發（AUTO_DIGEST=false 時、或想對單頁重跑）：

```bash
curl -X POST "http://127.0.0.1:8788/webhooks/named/rag_wiki_digest/query" \
  -H "X-Arcrun-API-Key: demo" -H 'Content-Type: application/json' \
  -d '{"page_name":"新人入職指南","gemini_key":"<你的 AI Studio key>"}'
```

實測回應：生成正體中文 wiki 頁（一句話定義／要點／關鍵實體）寫回庫（entry_type=wiki，page_name=`wiki-新人入職指南`），之後搜尋連 wiki 摘要一起命中。
本機限制：key 由 installer sed 代入 workflow config／手動觸發時呼叫端帶（miniflare 無 credential 解密鏈）；雲端版走 `acr creds push` 的 `{{credential.gemini_api_key}}`。

## 5.5 刪檔＝下架（G9）

從 `~/arcrun-rag-demo/knowledge-inbox/` 刪掉檔案 → collector 鏡像刪除 push → rag_ingest 的
removed 分支把該頁的 block entries、精耕 wiki entry、triplet 全標 `status=deprecated`：
- **append-only 不物理刪**：entries 是 PATCH metadata 標記；triplet 是翻 status slot（變形 CRUD）。
- graph 查詢（graph_neighbors）自動略過 deprecated → 圖上即消失。
- 誠實限制：keyword search 目前**仍會**回 deprecated blocks（KBDB base 的 search 尚無 metadata
  filter，屬上游能力缺口）；需要嚴格下架語意的客戶先以 graph／metadata 判讀。

## 6. 已知限制（誠實清單）

1. **語意查詢本機不可用**（Workers AI/Vectorize 綁真帳號）——降級行為正確；地端正式版等上游 Ollama/sqlite-vec 接縫（G2/G3）。
2. **多人帳號＋庫級權限 Portal 未有**（上游 Arcrun#24/#25）；現為單人 admin console。
3. ~~刪檔→deprecated 未實作~~ **G9 已實作（2026-07-13）**，見 §5.5；殘餘缺口＝keyword search 不過濾 deprecated（上游 KBDB 能力）。
4. **原檔 LFS**：.gitattributes 宣告自動寫入，但 clone 未 `git lfs install` 時大檔仍走一般 blob（installer 已補 `git lfs install --local`；首輪 demo 的 docx 是一般 blob）。
5. **Gitea token 以安裝參數注入 workflow**（本機 KV）；生產應走 credential 機制。
6. **MCP 本機未驗**；xlsx/圖片不在第一波轉檔承諾。
7. cypher 本機 log 有週期性 `Uncaught Error: internal error` 噪音（背景件打向保險域名的失敗，執行結果不受影響）——已記觀察。

## 7. 回報問題

開 issue 到 `Leo/arcrun-rag`（git.uncle6.me），附：跑到哪一步、完整指令與錯誤、`node --version`/`wrangler --version`。

## 8. 一鍵全拆

```bash
./install/teardown.sh   # 停 4 個 worker＋collector、刪 Gitea 容器、清 state
```
