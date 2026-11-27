/**
 * onprem-line.mjs — 「地端更新檔上架線」：官方簽好的地端更新檔與 latest.json 放到安裝站的 `/onprem/`（inkstone/arcrun-rag#394，母票 inkstone/InkStoneCo#325）
 *
 * ── 為什麼有這支 ────────────────────────────────────────────────────────────
 * 地端私有雲（大前）的 Portal「立即更新」會去抓 `ARCRUN_UPDATE_FEED` 指的 latest.json，驗簽、備份、換版。
 * 更新檔由 Arcrun 的 docker/private-cloud/build-update.mjs 打包並簽（簽章端點在 arcrun-release-signer 的 /sign，私鑰只在 CF Secret）。
 * 這支負責「放上去、讓用戶抓得到、從用戶那條路讀回來對得上」。形狀同 market-line.mjs（市集上架線）：純函式＋注入外部呼叫，好用假檔案演練。
 *
 * ── 官方的家（install.arcrun.dev/onprem/，R2 的 `onprem/` 前綴）──
 *   onprem/<版本>.tgz   簽好的更新檔。依版號命名、不可變、長快取
 *   onprem/latest.json  「最新版」指標 {version,url,sha256,size,notes,released_at}。**最後才翻**（指標一翻，它指到的檔必已就位）
 *   stage：同一顆 R2（DIST）的 `onprem/`；prod：專用 R2（binding ONPREM）。安裝站 worker.js `/onprem/*` 服務它（onpremHandle）。
 *
 * ── 版號 ──
 *   `<這一班主程式版號>-onprem.<N>`（例 1.4.299-onprem.1）；N 在同一個主程式版號底下依帳本遞增——引擎的 updater 認這個格式並拒絕舊版。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { r2PutArgs } from './stage-dist.mjs';

export const ONPREM_PREFIX = 'onprem';
export const ONPREM_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-onprem\.(\d+)$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 登錄簿 `onprem` 的必填欄位；缺就丟，不猜。 */
export function assertOnpremDeclared(onprem) {
  const lack = ['bucket', 'accountId', 'publicBase', 'signUrl'].filter((k) => !onprem || !onprem[k]);
  if (lack.length) throw new Error(`登錄簿 onprem 缺欄位：${lack.join('、')}（installer/ship.targets.json → targets.<目標>.onprem）`);
  if (/git\.uncle6\.me/i.test(String(onprem.publicBase))) throw new Error('onprem.publicBase 不能指到 git.uncle6.me。');
  if (!/^https:\/\//.test(String(onprem.publicBase))) throw new Error('onprem.publicBase 要是 https 網址（用戶的 Portal 會拿它當更新來源）。');
  if (!/^https:\/\//.test(String(onprem.signUrl))) throw new Error('onprem.signUrl 要是 https 網址（簽章端點）。');
}

/** 這一班要用的更新檔版號：`<release>-onprem.<N>`，N ＝帳本裡同一個 release 已出過的最大 N ＋ 1（沒出過＝1）。 */
export function nextOnpremVersion(release, ledger) {
  if (!/^\d+\.\d+\.\d+$/.test(String(release))) throw new Error(`主程式版號格式不對：${release}（要像 1.4.299）`);
  const used = (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    .map((e) => ONPREM_VERSION_RE.exec(String(e.version)))
    .filter((m) => m && `${m[1]}.${m[2]}.${m[3]}` === release)
    .map((m) => Number(m[4]));
  return `${release}-onprem.${used.length ? Math.max(...used) + 1 : 1}`;
}

/** 更新檔的公開網址（latest.json 的 url）。 */
export function packageUrl(onprem, version) {
  return `${String(onprem.publicBase).replace(/\/+$/, '')}/${version}.tgz`;
}
export const latestUrl = (onprem) => `${String(onprem.publicBase).replace(/\/+$/, '')}/latest.json`;

/** 要放進 R2 的東西：更新檔先、指標最後。 */
export function planOnprem({ pkgPath, latestPath, version }) {
  if (!ONPREM_VERSION_RE.test(String(version))) throw new Error(`更新檔版號格式不對：${version}（要像 1.4.299-onprem.1）`);
  if (!existsSync(pkgPath)) throw new Error(`找不到更新檔 ${pkgPath}`);
  if (!existsSync(latestPath)) throw new Error(`找不到 latest.json ${latestPath}`);
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  const actual = sha256(readFileSync(pkgPath));
  if (latest.version !== version) throw new Error(`latest.json 的版號 ${latest.version} ≠ 要上架的 ${version}`);
  if (latest.sha256 !== actual) throw new Error(`latest.json 的 sha256 與更新檔實檔不符（${String(latest.sha256).slice(0, 12)}… vs ${actual.slice(0, 12)}…）`);
  return {
    version, sha256: actual,
    object: { key: `${ONPREM_PREFIX}/${version}.tgz`, path: pkgPath, contentType: 'application/gzip', cacheControl: 'public, max-age=31536000, immutable' },
    pointer: { key: `${ONPREM_PREFIX}/latest.json`, path: latestPath, contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache', json: latest },
  };
}

/** 放上去：更新檔 → 指標。run 由呼叫端注入（真跑＝wrangler r2 object put）。 */
export function publishOnprem({ plan, onprem, run }) {
  assertOnpremDeclared(onprem);
  for (const o of [plan.object, plan.pointer]) {
    run(r2PutArgs({ bucket: onprem.bucket, key: o.key, file: o.path, contentType: o.contentType, cacheControl: o.cacheControl }), { label: o.key });
  }
  return { keys: [plan.object.key, plan.pointer.key] };
}

/** 讀「線上現在的指標」。還沒上架過＝null。 */
export async function readLiveOnprem({ onprem, fetchImpl = fetch }) {
  const r = await fetchImpl(latestUrl(onprem), { headers: { 'cache-control': 'no-cache' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`讀 ${latestUrl(onprem)} 失敗：HTTP ${r.status}`);
  return r.json();
}

/**
 * 從用戶那條路讀回來：指標版號對、指標指的 url 真的抓得到、抓回來的位元組 sha256 與指標一致。
 * （Portal 的「立即更新」做的就是這三步，之後還會用映像內建公鑰驗簽。）
 */
export async function verifyLiveOnprem({ onprem, expect, fetchImpl = fetch, tries = 4, waitMs = 2000 }) {
  let last = '';
  for (let k = 1; k <= tries; k++) {
    try {
      const p = await readLiveOnprem({ onprem, fetchImpl });
      if (!p) last = '指標還讀不到（404）';
      else if (p.version !== expect.version) last = `指標版號 ${p.version}，要的是 ${expect.version}`;
      else {
        const f = await fetchImpl(p.url);
        if (!f.ok) last = `指標指的 ${p.url} 抓不到：HTTP ${f.status}`;
        else {
          const got = sha256(Buffer.from(await f.arrayBuffer()));
          if (got !== p.sha256 || got !== expect.sha256) last = `抓回來的更新檔 sha256 ${got.slice(0, 12)}… 與指標／預期（${String(p.sha256).slice(0, 12)}…／${expect.sha256.slice(0, 12)}…）不符`;
          else return { version: p.version, url: p.url, sha256: got };
        }
      }
    } catch (e) { last = e.message; }
    if (k < tries) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`地端更新檔上架後從 ${latestUrl(onprem)} 讀回來對不上：${last}`);
}

export function appendOnpremLedger(ledger, entry) {
  const l = ledger && Array.isArray(ledger.entries) ? ledger : { entries: [] };
  if (l.entries.some((e) => e.version === entry.version && e.target === entry.target)) return l;
  return { entries: [...l.entries, entry] };
}
export function readOnpremLedger(repoRoot) {
  const p = join(repoRoot, 'installer', 'onprem-ledger.json');
  if (!existsSync(p)) return { entries: [] };
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j.entries) ? j : { entries: [] }; } catch { return { entries: [] }; }
}
