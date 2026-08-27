// response-size-cap.test.mjs — `inkstone/arcrun-rag#104`：
// 沒有一個 http_request 節點可以去要一份「會跟著租戶長大」的回應。
//
// 為什麼要有這支（2026-08-27 實測，youlin）：
//
//   `http_request` 零件的輸出緩衝區是寫死的 `make([]byte, 65536)`
//   （`matrix/arcrun/registry/components/http_request/main.go:88`）。回應超過 64 KiB
//   就整顆 WASM trap，執行器把它記成
//     {"success":false,"status":500,"error":"{\"success\":false,\"error\":\"unreachable\"}"}
//   而 named-webhook 的**外層照樣回 HTTP 200**——所以 daemon 看到綠的、
//   使用者看到綠的，知識卻一個字都沒進知識庫。
//
//   逐格量出來的分界線（`/records/by-template/triplet`，單筆 avg 381 B）：
//     limit=170 → 62,297 B ✅   limit=180 → 65,450 B ✅
//     limit=181 → 65,797 B ❌   limit=182 → 66,106 B ❌   ⇒ 65,536 ＝ 64 KiB
//
// 本支守的規則（只守「無界」那一類，不是所有 limit）：
//
//   一個請求如果**沒有任何把範圍縮到「這一份文件」的參數**（page_name／source／
//   library…），它的回應大小就等於「這個租戶累積了多少東西」——那是一條註定
//   會被跨過去的線，差別只在哪一天。這類請求的 limit 必須 ≤ MAX_UNSCOPED_LIMIT。
//
//   有 scope 的請求（例：`/entries?page_name=X`）不在本支管轄範圍：它的大小由
//   「同頁名有幾筆」決定，成長慢得多，而且把它調小會直接傷到 upsert 前的清舊
//   （少刪＝重複，正是 #14 當初要修的東西）。⚠️ 它仍然有同一個天花板，
//   只是本支不假裝自己守得住——那一格的正解是零件別再 trap（Arcrun 核心，B 類）。
//
// 跑法：node workflows/tests/response-size-cap.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wfDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 64 KiB 是硬牆；100 筆＝實測 42,446 B（65%），單筆漲到 600 B 也只有 60,000 B。
const HTTP_REQUEST_BUFFER_BYTES = 65536;
const MAX_UNSCOPED_LIMIT = 100;

// 「有把範圍縮到這一份」的參數。任何一個出現就算 scoped。
const SCOPE_PARAMS = ['page_name=', 'source=', 'source_prefix=', 'page_name_prefix=', 'library=', 'q='];

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};

const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yaml'));
t('找得到 workflow yaml', files.length > 0, `wfDir=${wfDir}`);

// 只看真的會發出去的 url:（跳過註解行——註解裡引用舊值是說明歷史，不是行為）
const URL_LINE = /^\s*url:\s*"([^"]+)"/;
const LIST_ENDPOINT = /\/records\/by-template\/|\/entries\?/;
const LIMIT_PARAM = /[?&]limit=(\d+)/;

let checked = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(URL_LINE);
    if (!m) return;
    const url = m[1];
    // 只管「列一堆東西回來」的讀取端點
    if (!LIST_ENDPOINT.test(url)) return;
    if (SCOPE_PARAMS.some((p) => url.includes(p))) return;
    checked++;
    const lm = url.match(LIMIT_PARAM);
    t(`${f}:${i + 1} 無 scope 的清單請求必須帶 limit`, lm !== null, url);
    if (lm) {
      t(
        `${f}:${i + 1} limit=${lm[1]} ≤ ${MAX_UNSCOPED_LIMIT}（64 KiB 天花板：${HTTP_REQUEST_BUFFER_BYTES} B）`,
        Number(lm[1]) <= MAX_UNSCOPED_LIMIT,
        url,
      );
    }
  });
}

// 迴歸閘：這支測的東西真的存在（避免正則寫壞 → 一個都沒檢到 → 假綠）。
// 已知的無 scope 清單請求：ingest-card 1 條、takedown 1 條、ingest 2 條、ingest-cards 2 條。
t('確實檢查到無 scope 的清單請求（不是正則失效）', checked >= 6, `checked=${checked}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
