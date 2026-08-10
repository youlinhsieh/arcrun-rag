/**
 * bundle-components.mjs — **一個 bundle 裡有哪幾顆零件**的唯一定義。
 *
 * 🔴 leo 2026-08-09（arcrun-rag#27）立這個檔的理由，一句話：
 *   「我的現實是 prod 已經有人在用了，在你還沒進行任何修改前，stage = prod，至少一一對應。
 *     結果你重做，那你重做過程可能有問題，就造成 prod 新問題。」
 *   「如果都相同，我測試一次安裝，就發現 5 顆變 24 顆。**如果是複製，為什麼不一致？**」
 *
 * ── 病史（為什麼「兩邊各有一份人寫的清單」必然漂移）─────────────────────────
 *
 * 08-09 實測：prod manifest.core = 5 顆，stage manifest.core = 24 顆（那 5 顆 ＋ 另外 19 顆）。
 * 而 prod 自己宣告 `promoted_from.sha = ab4ef01`，也就是「複製自 stage 的那個 commit」——
 * 回頭查 stage 的 ab4ef01，它當時就是 **24 顆**。
 * ⇒ **「提升＝複製」這句話是假的**：複製的路上被一份白名單濾掉了 19 顆，
 *   而那份白名單只有 prod 這條路徑會走。stage 從來沒有被同一把尺量過。
 *
 * 那 19 顆哪來的？不是誰去建的——是 **ratchet（棘輪）**：
 *   `build-bundles.mjs` 只打 4 顆、`build-ui-bundle.mjs` 只打 1 顆（＝本檔這 5 顆），
 *   但兩支腳本都有一條「**舊 manifest 有、且檔案還在磁碟上，就沿用**」的保命邏輯
 *   （那條邏輯本身是對的，它救過 daemon 與 portal 前端被重打包砍掉的事故）。
 *   副作用是：**只要有東西曾經掉進 bundle 目錄，就永遠留在那裡，沒有任何路徑會把它拿掉。**
 *   stage 的 `tier1/` 是 1.4.17（ea96906，stage repo 的第一個 commit）播種時帶進來的
 *   舊世代版型；prod 從來沒有 `tier1/`。於是一邊有、一邊沒有，而且**只會越差越多**。
 *
 * ⇒ 所以病不是「數字不一樣」，是「**沒有任何一個地方說得出『一個 bundle 應該有哪幾顆』**」。
 *   本檔就是那個地方。從此：
 *     · 重打路徑（stage）＝照本檔打，本檔以外的一律不進 manifest
 *     · 提升路徑（prod）＝照本檔複製
 *     · 兩條路徑跑完都要過同一道 parity 閘（ship.mjs `parity` 步驟）：
 *       `manifest.core` 的名字集合**必須恰好等於本檔**——多一顆少一顆都當場失敗。
 *   ⇒ 「stage 與 prod 一一對應」不再靠人記得，而是**兩邊都被同一個定義夾住**。
 *
 * 要增減 bundle 內容＝改本檔，一個地方改完兩條路徑同時生效（這正是重點）。
 */

/**
 * 一個 bundle 的完整零件清單。
 *
 * 欄位：
 *   name    manifest.core[].name，也是 worker 名——所有路徑對帳都用它當主鍵
 *   relDir  相對 bundle 根目錄的產物資料夾（提升路徑照這個複製；parity 閘照這個查檔案在不在）
 *   builder 誰負責重打：'core' = build-bundles.mjs（esbuild 打 worker）
 *                       'ui'   = build-ui-bundle.mjs（把 console-ui/public 內嵌成單檔 worker）
 *   build   builder === 'core' 專用的打包參數（dir/entry/canonical/stripServices）
 */
export const BUNDLE_COMPONENTS = [
  {
    name: 'arcrun-cypher-executor',
    relDir: 'arcrun-cypher-executor',
    builder: 'core',
    // stripServices＝拿掉 13 個 service binding（懶載版）。prod 的 manifest 裡那個
    // `stripped: { services: 13 }` 就是這裡來的——stage 也走同一支腳本、同一個旗標，
    // 所以「stage 的懶載行為與 prod 一致」是結構保證，不是巧合。
    build: { dir: 'cypher-executor', entry: 'src/index.ts', canonical: null, stripServices: true },
  },
  {
    name: 'arcrun-kbdb',
    relDir: 'arcrun-kbdb',
    builder: 'core',
    build: { dir: 'kbdb', entry: 'src/index.ts', canonical: null },
  },
  {
    name: 'arcrun-http-request',
    relDir: 'arcrun-http-request',
    builder: 'core',
    build: { dir: '.component-builds/http_request', entry: 'src/index.ts', canonical: 'http_request' },
  },
  {
    name: 'arcrun-code',
    relDir: 'arcrun-code',
    builder: 'core',
    build: { dir: 'registry/components/code', entry: 'index.ts', canonical: 'code' },
  },
  {
    name: 'arcrun-rag-ui',
    relDir: 'tier2/ui',
    builder: 'ui',
  },
  {
    // 🔴 2026-08-10（leo：「今天只要清單含有 MCP 即可」）：**MCP 從來沒被裝過**。
    //
    // 病：prod 1.4.30 的 manifest.core 全文沒有 `arcrun-mcp` ⇒ 每個新用戶裝完都沒有 MCP
    //    ⇒ 產品承諾的「把自己的 AI 接上自己的知識庫」**從第一步就不成立**。
    //    安裝器那一側其實早就備妥（SERVICE_BINDINGS 有它、部署順序有它、租戶 var 有它、
    //    KBDB_INTERNAL_TOKEN 同步迴圈也有它）——**唯獨沒有人把它打進 bundle**。
    //    所以症狀長得像「MCP 壞了」而不是「MCP 不存在」：安裝器對一顆不存在的 worker
    //    寫 secret，`PUT /scripts/arcrun-mcp/secrets` 回 404，被 try/catch 吃成
    //    `secretSyncError` 一行字，沒有任何一步會因此紅燈。
    //    ⇒ 這是本檔存在理由的第二個實例：「**沒有任何一個地方說得出一個 bundle 應該有哪幾顆**」
    //      ——上次的後果是多了 19 顆，這次是少了關鍵的 1 顆，而少的那顆沒有棘輪會補。
    //
    // 依賴：三個 service binding 由安裝器的 SERVICE_BINDINGS 還原。其中
    //   COMPONENT_REGISTRY → `arcrun-registry` **不在本清單裡**，因此標成 optional
    //   （見 worker.js SERVICE_BINDINGS 那張表的說明）。
    // ⚠️ D48 仍然成立：本檔是止血帶，正解是「安裝＝一張清單」（arcrun-rag#37／#39）。
    //   在正解落地前，「加一筆」就是讓 MCP 真的到得了用戶手上的唯一路徑。
    name: 'arcrun-mcp',
    relDir: 'arcrun-mcp',
    builder: 'core',
    build: { dir: 'mcp', entry: 'src/index.ts', canonical: null },
  },
];

/** 全部零件名（parity 閘的比對基準）。 */
export const BUNDLE_COMPONENT_NAMES = BUNDLE_COMPONENTS.map((c) => c.name);

/** build-bundles.mjs 負責重打的那幾顆（附打包參數）。 */
export const CORE_COMPONENTS = BUNDLE_COMPONENTS
  .filter((c) => c.builder === 'core')
  .map((c) => ({ name: c.name, relDir: c.relDir, ...c.build }));

/**
 * 把一份 manifest.core 與本檔對帳。
 * 回傳 { missing, extra, ok }——`extra` 就是 08-09 那 19 顆棘輪殘留會落進來的地方。
 */
export function diffAgainstCanonical(core) {
  const have = new Set((core || []).map((c) => c && c.name).filter(Boolean));
  const want = new Set(BUNDLE_COMPONENT_NAMES);
  const missing = BUNDLE_COMPONENT_NAMES.filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 };
}
