/**
 * portal-pack-line.mjs — Portal 畫面軟更新的出貨線（inkstone/arcrun-rag#398）
 *
 * ── 為什麼有這支 ────────────────────────────────────────────────────────────
 * 只改 Portal 畫面（Arcrun `console-ui/public`）卻要走整條主程式出貨線、讓每個用戶按「立即更新」，
 * 是為一個畫面修正換了整套 worker（ADR 2026-11-22-market-line 第五節、「還沒做」第 2 項）。
 *
 * 做法：畫面是**資料**，走市集線同一個家（`market/portal/`）：
 *   market/portal/packs/<包版>.json   整份畫面（Arcrun `scripts/build-portal-pack.mjs` 的產出，不可變、長快取）
 *   market/portal/current.json        指標 {version, sha256, floor_bundle_version, ui_fingerprint, …}；最後才翻；回退＝翻回前一版
 * 安裝站 `/portal/current.json`、`/portal/packs/<包版>.json` 讀它（worker.js portalPackHandle）；
 * 用戶實例的 UI worker（env.PORTAL_PACK_BASE＝安裝站）每 60 秒看一次指標，換版就換上——
 * worker 沒重推、主程式版號與 /health 不動、用戶不必按任何鈕。
 *
 * 包版＝`YYYY.MM.DD-<畫面內容指紋前 7 碼>`（與市集版同一個哲學：同內容同後綴）。
 * floor_bundle_version＝這份畫面要求的最低主程式版本；低於它的實例不套（新畫面可能呼叫舊 API 沒有的端點），
 * 等它自己更新到 floor 以上才換。預設取目前主程式 release（保守：寧可晚套，不可配錯 API）。
 *
 * 純函式＋注入外部呼叫（同 market-line.mjs），好讓 portal-pack-line.test.mjs 用假檔案演練。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { r2PutArgs } from './stage-dist.mjs';
import { assertMarketDeclared, MARKET_PREFIX } from './market-line.mjs';

export const PORTAL_PREFIX = `${MARKET_PREFIX}/portal`;
export const PACK_VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SEMVER3 = /^\d+\.\d+\.\d+$/;

/** 包版號：UTC 日期＋畫面內容指紋（build-portal-pack 回報的 ui_fingerprint）前 7 碼。 */
export function packVersionOf(uiFingerprint, now = new Date()) {
  if (!/^[0-9a-f]{7,}$/.test(String(uiFingerprint))) throw new Error('畫面指紋不合法（要 build-portal-pack 回報的 ui_fingerprint）');
  return `${now.toISOString().slice(0, 10).replace(/-/g, '.')}-${String(uiFingerprint).slice(0, 7)}`;
}

/** 線上那份跟這份是不是同一份畫面？（比內容指紋，不比日期——隔天重跑不該算變動） */
export function samePortal(livePointer, uiFingerprint) {
  return !!(livePointer && livePointer.ui_fingerprint && livePointer.ui_fingerprint === uiFingerprint);
}

/**
 * 這一次要放的物件，順序即上傳順序：包 → 指標（最後，由 publish 寫）。
 * @returns {{ object:{key,path,contentType,cacheControl}, pointer:object }}
 */
export function planPortalPack({ packPath, uiFingerprint, fileCount, version, floor, ticket, previous, now = new Date() }) {
  if (!PACK_VERSION_RE.test(version)) throw new Error(`畫面包版號格式不合法：${version}`);
  if (!SEMVER3.test(String(floor || ''))) throw new Error(`floor_bundle_version 要是 x.y.z：${floor}`);
  const buf = readFileSync(packPath);
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { throw new Error('畫面包不是合法 JSON'); }
  if (!parsed || !parsed.files || !parsed.files['/portal/index.html']) throw new Error('畫面包缺 /portal/index.html——拒絕上架');
  return {
    object: { key: `${PORTAL_PREFIX}/packs/${version}.json`, path: packPath, contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' },
    pointer: {
      schema: 1,
      version,
      sha256: sha256(buf),
      bytes: buf.length,
      floor_bundle_version: floor,
      ui_fingerprint: uiFingerprint,
      file_count: fileCount ?? Object.keys(parsed.files).length,
      published_at: now.toISOString(),
      ticket: ticket || null,
      previous: previous || null,
    },
  };
}

/** 放上去：包先、指標最後。 */
export function publishPortalPack({ plan, market, run, writePointer }) {
  assertMarketDeclared(market);
  const o = plan.object;
  run(r2PutArgs({ bucket: market.bucket, key: o.key, file: o.path, contentType: o.contentType, cacheControl: o.cacheControl }), { label: o.key });
  const file = writePointer(plan.pointer);
  const key = `${PORTAL_PREFIX}/current.json`;
  run(r2PutArgs({ bucket: market.bucket, key, file, contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' }), { label: key });
  return { pointerKey: key, packKey: o.key };
}

/** 讀線上現在的畫面包指標；沒有（404）回 null。 */
export async function readLivePortal({ installerBase, fetchImpl = fetch }) {
  const base = String(installerBase).replace(/\/+$/, '');
  const r = await fetchImpl(`${base}/portal/current.json`, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`讀 ${base}/portal/current.json 失敗：HTTP ${r.status}`);
  return r.json();
}

/** 上架後從用戶實例會走的那條路讀回來：指標版號對、包的雜湊對得上指標。 */
export async function verifyLivePortal({ installerBase, expect, fetchImpl = fetch, tries = 4, waitMs = 2000 }) {
  const base = String(installerBase).replace(/\/+$/, '');
  let last = '';
  for (let k = 1; k <= tries; k++) {
    try {
      const p = await (await fetchImpl(`${base}/portal/current.json`, { headers: { 'cache-control': 'no-cache' } })).json();
      if (p.version !== expect.version) last = `指標版 ${p.version}，要的是 ${expect.version}`;
      else {
        const t = Buffer.from(await (await fetchImpl(`${base}/portal/packs/${p.version}.json`)).arrayBuffer());
        if (sha256(t) === p.sha256 && p.sha256 === expect.sha256) return { version: p.version };
        last = `包雜湊 ${sha256(t).slice(0, 12)} 與指標 ${String(p.sha256).slice(0, 12)}／預期 ${expect.sha256.slice(0, 12)} 對不上`;
      }
    } catch (e) { last = e.message; }
    if (k < tries) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`畫面包上架後從 ${base}/portal 讀回來對不上：${last}`);
}
