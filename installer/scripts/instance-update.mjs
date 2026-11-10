/**
 * instance-update.mjs — 出貨線上 stage 的最後一哩：讓 youlin 主實例真的跑在這一版上
 * （inkstone/arcrun-rag#303）。
 *
 * 為什麼有這支（總監 2026-11-10 查證）：
 *   出貨線原本只負責把零件包和安裝器「發出去」，**沒有任何一站去更新 youlin 實例本身**；
 *   實例自己去拉的路（`POST /portal/admin/update`）還回 501 `fallback_to_installer`。
 *   結果 1.4.146 出完時安裝器 `/api/latest` 是 1.4.146、實例 `/health` 卻還是 1.4.145，
 *   而 `verify` 判通過（它不查實例的版號）；stage 佇列閘（#271）拿實例 `/health` 的 `bundle_commit`
 *   當「線上那一版」⇒ 拿舊版當基準，各條線也以為自己驗到新版。
 *
 * 這支做三件事（順序固定）：
 *   ① 先讀實例 `/health`：版號與 commit 已經是這一版 ⇒ 不重複更新（冪等），直接當作通過。
 *   ② 不是 ⇒ 跑 `acr update`（實例更新的正門：吃安裝器同一份 bundle，版號與 commit 是同一份 manifest 的欄位）。
 *   ③ 更新完**讀回** `/health`（有界重試，只在這一站內，不是背景輪詢）：版號與 commit 要對上這一版，
 *      對不上就丟例外 ⇒ 出貨線紅燈，**不准綠燈收工**。
 *
 * 守的邊界：
 *   · 憑證只碰名字（D36）：Cloudflare 鑰匙由 ship.mjs 的 cloudflareDeployEnv 依登錄簿取進「那一個子行程」的 env，
 *     這裡只負責把它傳下去，不印、不落檔；輸出另經 redact 才進報告。
 *   · 只動 stage 實例（登錄簿 `targets.stage.instanceUpdate`）。prod 沒有這個宣告 ⇒ 整站跳過；
 *     leo21c 照舊由 leo 在 Portal 按「立即更新」（leo21c 只接受公開更新）。
 *   · 不輪詢、不排程、不 fan-out：一次出貨走一次；等實例換版的重試有上限、只在這一站內。
 *
 * 純函式＋fetch／spawn／sleep 注入，可離線演練（見 instance-update.test.mjs）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HEX = /^[0-9a-f]{7,40}$/i;

/** manifest.source（形如 `Arcrun@4759c3e91185`）→ 這一版的 Arcrun 來源 commit 前綴。解不出回 ''。 */
export function commitFromManifestSource(source) {
  const m = /@([0-9a-f]{7,40})/i.exec(String(source || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 兩個 commit（可能長短不同）是不是同一顆：短的那個（至少 7 碼）是長的前綴。 */
export function sameCommit(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (!HEX.test(x) || !HEX.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * 從 cypher 網址抽 workers.dev 子網域——與 Arcrun `cli/src/commands/update.ts` 的 extractSubdomain 同一條規則。
 * acr 拿到空子網域不會停，會把 kbdb 網址組成 `https://arcrun-kbdb..workers.dev` 並照樣回報「25/25 部署成功」
 * （2026-11-10 youlin stage 壞掉的根因）⇒ 所以出貨線在呼叫 acr 之前自己先擋。
 */
export function extractSubdomain(url) {
  const m = /arcrun-cypher-executor\.([^./]+)\.workers\.dev/.exec(String(url || ''));
  return m ? m[1] : '';
}

/** 跑 `acr update` 前的子網域檢查：回 { ok, subdomain, error }。空就是不准跑。 */
export function checkSubdomain(cypherUrl) {
  const subdomain = extractSubdomain(cypherUrl);
  if (subdomain) return { ok: true, subdomain };
  return {
    ok: false, subdomain: '',
    error: `從 ARCRUN_CYPHER_EXECUTOR_URL（${cypherUrl || '空'}）抽不出 workers.dev 子網域——acr update 會把零件網址組成 arcrun-xxx..workers.dev 並照樣「部署成功」，所以不跑`,
  };
}

/**
 * 讀實例 cypher 的 `/health`。回 { ok, version, commit, status, detail, error }。
 * 不丟例外（網路層錯誤進 error），由呼叫端決定怎麼吵。
 */
export async function readInstanceHealth(cypherUrl, fetchImpl = fetch) {
  if (!cypherUrl) return { ok: false, error: '登錄簿沒宣告 stage 實例的 cypher 網址（instanceUpdate.cypherUrl）' };
  const url = `${String(cypherUrl).replace(/\/+$/, '')}/health`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } });
    // /health 在 degraded 時可能回 503，body 仍然有版號——有 JSON 就讀，沒有才算讀不到
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { ok: false, error: `${url} → HTTP ${res.status}，沒有 JSON` };
    return {
      ok: true,
      version: typeof body.bundle_version === 'string' ? body.bundle_version.trim() : '',
      commit: typeof body.bundle_commit === 'string' ? body.bundle_commit.trim() : '',
      status: typeof body.status === 'string' ? body.status : '',
      // 資料層是否健康：只認明確的 ok===true。沒有這個欄位（很舊的實例）＝狀態未知，未知不等於健康
      dataLayerOk: !!(body.data_layer && body.data_layer.ok === true),
      detail: body.data_layer && body.data_layer.reason ? `data_layer.reason=${body.data_layer.reason}` : '',
      httpStatus: res.status,
    };
  } catch (e) {
    return { ok: false, error: `${url} 連不上：${e && e.message ? e.message : e}` };
  }
}

/**
 * 實例現在這一版 vs 這次出貨要的那一版。
 * 三件都要對：版號、commit、資料層（data_layer.ok）。版號對了但資料層不健康＝這版算出貨失敗。
 * @param {{ok:boolean,version?:string,commit?:string,dataLayerOk?:boolean,error?:string}} health
 * @param {{version:string, commit:string}} expect commit 是 manifest.source 的 Arcrun commit（/health 的 bundle_commit 蓋的也是它）
 * @returns {{match:boolean, problems:string[]}}
 */
export function compareHealth(health, expect) {
  const problems = [];
  if (!health || !health.ok) {
    return { match: false, problems: [`讀不到實例 /health：${health && health.error ? health.error : '沒有回應'}`] };
  }
  if (!expect || !expect.version) problems.push('不知道這次出貨的版號（ctx.release 空）——無從比對，不當作通過');
  else if (health.version !== expect.version) problems.push(`實例 bundle_version 是 ${health.version || '（空）'}，這次出貨是 ${expect.version}`);
  if (!expect || !HEX.test(expect.commit || '')) problems.push('不知道這次出貨的 Arcrun 來源 commit（manifest.source 解不出）——無從比對，不當作通過');
  else if (!sameCommit(health.commit, expect.commit)) problems.push(`實例 bundle_commit 是 ${health.commit || '（空）'}，這次出貨是 ${expect.commit}`);
  if (health.dataLayerOk !== true) problems.push(`實例 /health 的 data_layer 不是 ok（status ${health.status || '（空）'}${health.detail ? `，${health.detail}` : ''}）——版本換了但資料層讀不到，不算出貨成功`);
  return { match: problems.length === 0, problems };
}

/**
 * 找得到的 acr CLI 入口（cli/dist/index.js）。回 { entry, cliDir } 或 { error, buildable }。
 * @param {string[]} cliDirs 候選的 Arcrun `cli/` 目錄（依序）
 */
export function findAcr(cliDirs, exists = existsSync) {
  let buildable = null;
  for (const d of cliDirs.filter(Boolean)) {
    const entry = join(d, 'dist', 'index.js');
    if (exists(entry)) return { entry, cliDir: d };
    if (!buildable && exists(join(d, 'package.json')) && exists(join(d, 'node_modules'))) buildable = d;
  }
  return { error: `找不到 acr（cli/dist/index.js）：${cliDirs.filter(Boolean).join('、') || '（沒有候選目錄）'}`, buildable };
}

/** 組 `acr update` 的子行程環境：只放這次要用的名字。值由呼叫端從憑證層取來，這裡不讀 process.env 的金鑰。 */
export function acrEnv({ cfEnv, namespace, cypherUrl, mcpUrl, releaseApi, base = process.env }) {
  const env = { ...base, ...cfEnv, ARCRUN_MODE: 'self-hosted', ARCRUN_NAMESPACE: namespace, ARCRUN_CYPHER_EXECUTOR_URL: cypherUrl, ARCRUN_RELEASE_API: releaseApi };
  if (mcpUrl) env.ARCRUN_MCP_URL = mcpUrl;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** 預設的 `acr update` 執行器（spawnSync；cwd 用空目錄，避免就近往上撈到別的 .arcrun.yaml）。 */
export function defaultRunAcr({ entry, env, args = ['update'], spawn = spawnSync, cwd }) {
  const dir = cwd || mkdtempSync(join(tmpdir(), 'acr-update-'));
  const r = spawn(process.execPath, [entry, ...args], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  return { code: r.status === null ? -1 : r.status, output: `${r.stdout || ''}${r.stderr || ''}`, signal: r.signal || '' };
}

/**
 * 讓實例跑在這一版上，並讀回證明。對不上就丟例外。
 *
 * @param {object} p
 * @param {{version:string, commit:string}} p.expect
 * @param {string} p.cypherUrl  交給 acr 的 ARCRUN_CYPHER_EXECUTOR_URL（要抽得出子網域，否則不跑 acr update）
 * @param {() => Promise<object>} p.readHealth     讀 /health（readInstanceHealth 綁好網址）
 * @param {() => {code:number, output:string}} p.runUpdate  跑 acr update（由呼叫端綁好環境）
 * @param {number} [p.tries=6]      更新後讀回的次數上限（含第一次）
 * @param {number} [p.waitMs=8000]  每次讀回之間的等待
 * @param {(ms:number)=>Promise<void>} [p.sleep]
 * @param {(s:string)=>string} [p.redact]  輸出進報告前的遮蔽
 * @returns {Promise<{ status:'done', updated:boolean, detail:string[], health:object }>}
 */
export async function ensureInstanceOnRelease({ expect, cypherUrl, readHealth, runUpdate, tries = 6, waitMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), redact = (s) => s }) {
  const before = await readHealth();
  const cmp0 = compareHealth(before, expect);
  const fmt = (h) => (h && h.ok ? `${h.version || '?'}／${h.commit || '?'}${h.status ? `／status ${h.status}${h.detail ? `（${h.detail}）` : ''}` : ''}` : `讀不到（${h && h.error}）`);
  if (cmp0.match) {
    return {
      status: 'done', updated: false, health: before,
      detail: [`實例 /health 已經是 ${expect.version}／${expect.commit}（${fmt(before)}）⇒ 不重複更新`],
    };
  }

  const sub = checkSubdomain(cypherUrl);
  if (!sub.ok) {
    throw new Error(`不跑 acr update：${sub.error}\n     更新前 /health：${fmt(before)}`);
  }

  const r = await runUpdate();
  const tail = redact(String(r.output || '')).trim().split('\n').slice(-14).map((l) => `       ${l}`).join('\n');
  if (r.code !== 0) {
    throw new Error(
      `acr update 失敗（exit ${r.code}${r.signal ? `／${r.signal}` : ''}）：youlin 實例沒有換到 ${expect.version}\n`
      + `     更新前 /health：${fmt(before)}\n     輸出最後幾行：\n${tail}`);
  }

  let last = null;
  let cmp = { match: false, problems: [] };
  for (let i = 1; i <= tries; i++) {
    last = await readHealth();
    cmp = compareHealth(last, expect);
    if (cmp.match) {
      return {
        status: 'done', updated: true, health: last,
        detail: [
          `acr update 跑完（exit 0），讀回 /health：${fmt(last)}（第 ${i}/${tries} 次讀到）`,
          `更新前：${fmt(before)}`,
        ],
      };
    }
    if (i < tries) await sleep(waitMs);
  }
  throw new Error(
    `acr update 說成功了，但實例 /health 讀回仍不合格（版號／commit／data_layer 至少一項不對；讀了 ${tries} 次）：\n`
    + cmp.problems.map((p) => `     - ${p}`).join('\n')
    + `\n     更新前 /health：${fmt(before)}\n     最後一次 /health：${fmt(last)}\n     acr 輸出最後幾行：\n${tail}`);
}
