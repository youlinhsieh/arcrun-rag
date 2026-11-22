/**
 * market-line.mjs — 「市集上架線」：App 與市集目錄自己的上架、版本、簽核（inkstone/arcrun-rag#381）
 *
 * ── 為什麼有這支 ────────────────────────────────────────────────────────────
 * leo 2026-11-22：「主程式、store、app 全部打包在一起，這個不好……主程式內就是零件，只要零件不動，
 * 主程式就不會亂動……就像你要上不同網站要先更新瀏覽器，這是很荒謬的事。」「這並不是程式的問題，而是流程的問題，把流程改了。」
 *
 * 以前：App 包跟著主程式出貨線打進 bundle，prod 的 `<安裝站>/apps` 讀「bundle 釘子」底下的 apps/
 *       ⇒ App 新版＝等主程式出一班車、跟主程式一起簽 prod。
 * 現在：市集是一份**資料**，有自己的家、自己的版本、自己的簽核；主程式出貨線不再帶它。
 *
 * ── 市集的家（`market/` 前綴；stage 在 youlin 的 R2，prod 在官方服務那一側，不放 youlin／leo21c）──
 *   market/packages/<id>-<版本>.json     App 包。依版號命名、不可變、長快取（版號重用同內容＝冪等）
 *   market/index/<市集版>.json           這個市集版的目錄。一個市集版一旦寫好就不再變
 *   market/current.json                  「最後一次簽過的市集版」指標。**最後才翻**；回退＝把指標翻回前一版
 *
 * 安裝站的 `/apps/index.json` 讀 `current.json` 指到的那份目錄；網址不變，引擎一個字不用改。
 *
 * ── 市集版號 ────────────────────────────────────────────────────────────────
 * `YYYY.MM.DD-<目錄指紋前 7 碼>`：內容指紋＝同一份目錄永遠同一個後綴（與主程式版號同一個哲學：版號說得出內容是不是變了）。
 * 這是**第四條版本線**，跟主程式（1.4.x）、小幫手（0.18.x）、安裝器（1.0.x）都無關——主程式版號不動，市集版號照動。
 *
 * ── 純函式＋注入外部呼叫（同 stage-dist.mjs 的做法），好讓 market-line.test.mjs 用假檔案演練 ──
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planAppsFeed, r2PutArgs, contentTypeOf } from './stage-dist.mjs';

export const MARKET_PREFIX = 'market';
export const MARKET_VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 登錄簿 `market` 的必填欄位；缺就丟，不猜。 */
export function assertMarketDeclared(market) {
  const lack = ['bucket', 'accountId', 'publicBase', 'installerBase'].filter((k) => !market || !market[k]);
  if (lack.length) throw new Error(`登錄簿 market 缺欄位：${lack.join('、')}（installer/ship.targets.json → targets.<目標>.market）`);
  if (/git\.uncle6\.me/i.test(String(market.publicBase))) throw new Error('market.publicBase 不能指到 git.uncle6.me。');
  if (/arcrun-installer-youlin|youlin|leo21c/i.test(String(market.bucket)) && market.official === true) {
    throw new Error('官方市集不放 youlin／leo21c（leo 2026-11-22：官方服務放 uncle6）。');
  }
}

/** 市集版號：UTC 日期＋目錄 index.json 的內容指紋前 7 碼。 */
export function marketVersionOf(indexText, now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '.');
  return `${d}-${sha256(Buffer.from(indexText)).slice(0, 7)}`;
}

/** 目錄裡「id → 版本」的小表（略過沒有 id／version 的列）。 */
export function appVersions(index) {
  const out = {};
  for (const a of (index && Array.isArray(index.apps) ? index.apps : [])) {
    if (a && a.id && a.version) out[a.id] = { version: String(a.version), engine_min: a.engine_min ?? null, retired: !!a.retired };
  }
  return out;
}

/** a < b？（x.y.z 數字比；任一邊不是三段數字就當不小於——不誤報降版） */
export function semverLess(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}

/**
 * 這次上架跟「現在線上那份」比：哪些 App 從幾版到幾版。這張表就是 AHub 簽核單要貼的內容。
 * @returns {{id:string, from:string|null, to:string|null, kind:'added'|'updated'|'downgraded'|'removed'|'unchanged', engine_min:string|null}[]}
 */
export function diffMarket(oldIndex, newIndex) {
  const a = appVersions(oldIndex);
  const b = appVersions(newIndex);
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return ids.map((id) => {
    const from = a[id] ? a[id].version : null;
    const to = b[id] ? b[id].version : null;
    const kind = from === null ? 'added' : to === null ? 'removed' : from === to ? 'unchanged' : semverLess(to, from) ? 'downgraded' : 'updated';
    return { id, from, to, kind, engine_min: b[id] ? b[id].engine_min : null };
  });
}

export const hasChanges = (diff) => diff.some((d) => d.kind !== 'unchanged');

/** 簽核單／報告用的文字：列出這次哪些 App 從幾版到幾版。 */
export function renderDiff(diff, marketVersion) {
  const rows = diff.filter((d) => d.kind !== 'unchanged');
  const lines = [`市集版 ${marketVersion}`];
  if (!rows.length) lines.push('（沒有 App 變動）');
  for (const d of rows) {
    const tail = d.engine_min ? `（需要平台 ≥ ${d.engine_min}）` : '';
    if (d.kind === 'added') lines.push(`- ${d.id}：新上架 ${d.to}${tail}`);
    else if (d.kind === 'removed') lines.push(`- ${d.id}：下架（原 ${d.from}）`);
    else if (d.kind === 'downgraded') lines.push(`- ${d.id}：${d.from} → ${d.to}（⚠ 降版）${tail}`);
    else lines.push(`- ${d.id}：${d.from} → ${d.to}${tail}`);
  }
  const same = diff.filter((d) => d.kind === 'unchanged').map((d) => `${d.id}@${d.to}`);
  if (same.length) lines.push(`不變：${same.join('、')}`);
  return lines.join('\n');
}

/**
 * 這一次上架要放的所有物件，**順序即上傳順序**：包 → 這一版的目錄 → 指標（最後）。
 * feedDir 是 build-feed.mjs 的產出；每包重算 sha256 對目錄宣告（planAppsFeed 已驗）。
 */
export function planMarket({ feedDir, marketVersion, diff, ticket, previous, now = new Date(), prefix = MARKET_PREFIX }) {
  if (!MARKET_VERSION_RE.test(marketVersion)) throw new Error(`市集版號格式不合法：${marketVersion}`);
  const base = planAppsFeed(feedDir); // 驗包雜湊、目錄在、非空市集
  const indexPath = join(feedDir, 'index.json');
  const indexText = readFileSync(indexPath, 'utf8');
  const objs = [];
  for (const o of base) {
    if (o.key === 'apps/index.json') continue;
    objs.push({ key: `${prefix}/${o.key.replace(/^apps\//, '')}`, path: o.path, contentType: o.contentType, cacheControl: o.cacheControl });
  }
  objs.push({ key: `${prefix}/index/${marketVersion}.json`, path: indexPath, contentType: contentTypeOf('index.json'), cacheControl: 'public, max-age=31536000, immutable' });
  const pointer = {
    schema: 1,
    version: marketVersion,
    index_sha256: sha256(Buffer.from(indexText)),
    published_at: now.toISOString(),
    ticket: ticket || null,
    previous: previous || null,
    changes: (diff || []).filter((d) => d.kind !== 'unchanged').map(({ id, from, to, kind }) => ({ id, from, to, kind })),
  };
  return { objects: objs, pointer, indexText };
}

/**
 * 放上去。指標用呼叫端給的 `writePointer(key, json, cacheControl)`（寫暫存檔再 put），所以這裡不碰檔案系統。
 * @param {{objects:object[], pointer:object}} plan
 * @param {{bucket:string}} market
 * @param {(args:string[], opts:{label:string})=>void} run   執行 `npx <args>`（呼叫端已帶好 env／cwd）
 * @param {(json:object)=>string} writePointer  把指標寫成暫存檔，回路徑
 */
export function publishMarket({ plan, market, run, writePointer, prefix = MARKET_PREFIX }) {
  assertMarketDeclared(market);
  for (const o of plan.objects) {
    run(r2PutArgs({ bucket: market.bucket, key: o.key, file: o.path, contentType: o.contentType, cacheControl: o.cacheControl }), { label: o.key });
  }
  const file = writePointer(plan.pointer);
  run(r2PutArgs({ bucket: market.bucket, key: `${prefix}/current.json`, file, contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' }), { label: `${prefix}/current.json` });
  return { count: plan.objects.length, pointerKey: `${prefix}/current.json` };
}

/** 讀「現在線上那份」：先讀安裝站的 /apps/current.json 再讀它指的目錄。沒有指標：舊路的目錄當基準（pointer:null）；連目錄都沒有＝回 null。 */
export async function readLiveMarket({ installerBase, fetchImpl = fetch }) {
  const base = String(installerBase).replace(/\/+$/, '');
  const p = await fetchImpl(`${base}/apps/current.json`, { headers: { accept: 'application/json' } });
  if (p.status === 404) {
    // 還沒有市集指標：線上現在讀的是舊路（跟著零件包釘子）的目錄——拿它當比較基準，簽核單才說得出「從幾版到幾版」。
    const legacy = await fetchImpl(`${base}/apps/index.json`, { headers: { accept: 'application/json' } });
    if (!legacy.ok) return null;
    let idx = null;
    try { idx = await legacy.json(); } catch { return null; }
    return { pointer: null, index: idx };
  }
  if (!p.ok) throw new Error(`讀 ${base}/apps/current.json 失敗：HTTP ${p.status}`);
  const pointer = await p.json();
  const i = await fetchImpl(`${base}/apps/index.json`, { headers: { accept: 'application/json' } });
  if (!i.ok) throw new Error(`讀 ${base}/apps/index.json 失敗：HTTP ${i.status}`);
  return { pointer, index: await i.json() };
}

/** 上架後從用戶會走的那條路讀回來：指標版號對、目錄指紋對。對不上丟錯。 */
export async function verifyLiveMarket({ installerBase, expect, fetchImpl = fetch, tries = 4, waitMs = 2000 }) {
  let last = '';
  for (let k = 1; k <= tries; k++) {
    try {
      const base = String(installerBase).replace(/\/+$/, '');
      const p = await (await fetchImpl(`${base}/apps/current.json`, { headers: { 'cache-control': 'no-cache' } })).json();
      const t = await (await fetchImpl(`${base}/apps/index.json`, { headers: { 'cache-control': 'no-cache' } })).text();
      if (p.version === expect.version && sha256(Buffer.from(t)) === expect.index_sha256) return { version: p.version };
      last = `讀到版 ${p.version}／目錄指紋 ${sha256(Buffer.from(t)).slice(0, 12)}，要的是 ${expect.version}／${expect.index_sha256.slice(0, 12)}`;
    } catch (e) { last = e.message; }
    if (k < tries) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`市集上架後從 ${installerBase}/apps 讀回來對不上：${last}`);
}

/** 市集落帳（進版控，與主程式的 release-ledger 分開）。冪等：同一市集版再記不重複。 */
export function appendMarketLedger(ledger, entry) {
  const l = ledger && Array.isArray(ledger.entries) ? ledger : { entries: [] };
  if (l.entries.some((e) => e.version === entry.version && e.target === entry.target)) return l;
  return { entries: [...l.entries, entry] };
}

export function readMarketLedger(repoRoot) {
  const p = join(repoRoot, 'installer', 'market-ledger.json');
  if (!existsSync(p)) return { entries: [] };
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j.entries) ? j : { entries: [] }; } catch { return { entries: [] }; }
}
