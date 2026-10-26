#!/usr/bin/env node
/**
 * stage-portal-alias.mjs — youlin stage 的 portal 第二個網址（名稱帶 stage）
 *
 * 為什麼：Mac 上的 Claude 只肯在「網址名稱本身帶 stage／test」的頁面代打密碼；
 * 原網址 arcrun-rag-ui.<sub>.workers.dev 沒有這個字樣（inkstone/InkStoneCo#234 c22888）。
 * youlin 帳號沒有 zone，workers.dev 子網域又是整個帳號共用、不能改，
 * 所以做法是「同一份 UI 腳本、另一個 worker 名」＝ arcrun-rag-ui-stage.<sub>.workers.dev。
 *
 * 做三件事（冪等，可重跑）：
 *   ① 把 arcrun-rag-ui 的腳本＋bindings 原樣複製成 arcrun-rag-ui-stage，開 workers.dev 路由
 *   ② 把新 origin 追加進 cypher／kbdb／mcp 的 UI_ORIGINS（CORS 白名單；原值保留在最前面，
 *      其餘 binding 一律 `inherit`，secret 不會被洗掉）
 *   ③ 回頭驗：config.js 的 apiBase、新 origin 的 CORS 預檢
 *
 * 🔴 每次 `acr update`／出貨到 youlin stage 之後要重跑：
 *   bundle-deploy.ts 每趟都把 UI_ORIGINS 重寫成只有 arcrun-rag-ui 那一個，
 *   別名 worker 也停在舊版腳本。跑完才會回到「兩個網址都能用、版本一致」。
 *   （根治＝cypher 的 CORS 推導多認 `-stage` 兄弟，或出貨 stage 站呼叫本腳本；見 #234 c22888 回報）
 *
 * 只動 youlin（CLOUDFLARE_*_YOULIN）；不碰 leo21c／uncle6／geek6688。
 *
 * 用法： node installer/scripts/stage-portal-alias.mjs [--check]
 * 環境： CLOUDFLARE_API_TOKEN_YOULIN_CC_USE、CLOUDFLARE_ACCOUNT_ID_YOULIN
 */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN_YOULIN_CC_USE;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID_YOULIN;
const SUB = process.env.YOULIN_WORKERS_SUBDOMAIN || 'arcrun-yuga3bse';
const SRC = 'arcrun-rag-ui';
const DST = 'arcrun-rag-ui-stage';
const CORS_WORKERS = ['arcrun-cypher-executor', 'arcrun-kbdb', 'arcrun-mcp'];
const NEW_ORIGIN = `https://${DST}.${SUB}.workers.dev`;
const check = process.argv.includes('--check');
if (!TOKEN || !ACCT) { console.error('缺 CLOUDFLARE_API_TOKEN_YOULIN_CC_USE／CLOUDFLARE_ACCOUNT_ID_YOULIN'); process.exit(2); }

const B = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers`;
const H = { Authorization: `Bearer ${TOKEN}` };
const j = async (r) => { const d = await r.json(); if (!d.success) throw new Error(JSON.stringify(d.errors)); return d.result; };
const settings = (w) => fetch(`${B}/scripts/${w}/settings`, { headers: H }).then(j);

// ② 白名單
let drift = 0;
for (const w of CORS_WORKERS) {
  const s = await settings(w);
  const ui = s.bindings.find((b) => b.name === 'UI_ORIGINS');
  const vals = (ui?.text || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (vals.includes(NEW_ORIGIN)) { console.log(`✔ ${w} UI_ORIGINS 已含 ${DST}`); continue; }
  drift++;
  if (check) { console.log(`✘ ${w} UI_ORIGINS 缺 ${DST}（被 acr update 重寫過？）`); continue; }
  const bindings = s.bindings.map((b) => b.name === 'UI_ORIGINS'
    ? { type: 'plain_text', name: 'UI_ORIGINS', text: [...vals, NEW_ORIGIN].join(',') }
    : { type: 'inherit', name: b.name });
  const fd = new FormData();
  fd.append('settings', new Blob([JSON.stringify({ bindings })], { type: 'application/json' }));
  await j(await fetch(`${B}/scripts/${w}/settings`, { method: 'PATCH', headers: H, body: fd }));
  console.log(`✔ ${w} UI_ORIGINS += ${NEW_ORIGIN}`);
}

// ① 別名 worker（腳本與 bindings 跟 SRC 同步）
const src = await settings(SRC);
const raw = await fetch(`${B}/scripts/${SRC}`, { headers: H }).then((r) => r.text());
const m = raw.match(/name="index\.js"\r?\n\r?\n([\s\S]*?)\r?\n--[^\r\n]+/);
if (!m) throw new Error('解不出 arcrun-rag-ui 的 index.js');
const code = m[1];
const stamp = (s) => s.bindings.filter((b) => /^ARCRUN_BUNDLE_/.test(b.name)).map((b) => b.text).join('/');
let dstStamp = '';
try { dstStamp = stamp(await settings(DST)); } catch { dstStamp = '(不存在)'; }
if (dstStamp === stamp(src)) console.log(`✔ ${DST} 與 ${SRC} 同版（${dstStamp}）`);
else if (check) { console.log(`✘ ${DST} 版本 ${dstStamp} ≠ ${SRC} ${stamp(src)}`); drift++; }
else {
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify({ main_module: 'index.js', compatibility_date: src.compatibility_date, bindings: src.bindings, tags: [] })], { type: 'application/json' }));
  fd.append('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');
  await j(await fetch(`${B}/scripts/${DST}`, { method: 'PUT', headers: H, body: fd }));
  await j(await fetch(`${B}/scripts/${DST}/subdomain`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, previews_enabled: false }) }));
  console.log(`✔ ${DST} 已部署（${stamp(src)}）`);
}

// ③ 驗
await new Promise((r) => setTimeout(r, check ? 0 : 8000));
const cfg = await fetch(`${NEW_ORIGIN}/config.js`).then((r) => r.text());
const api = `https://arcrun-cypher-executor.${SUB}.workers.dev`;
const apiOk = cfg.includes(api);
const pre = await fetch(`${api}/portal/login`, { method: 'OPTIONS', headers: { Origin: NEW_ORIGIN, 'Access-Control-Request-Method': 'POST' } });
const corsOk = pre.headers.get('access-control-allow-origin') === NEW_ORIGIN;
console.log(`${apiOk ? '✔' : '✘'} apiBase ＝ cypher`);
console.log(`${corsOk ? '✔' : '✘'} CORS 預檢放行 ${NEW_ORIGIN}`);
process.exit(apiOk && corsOk && (!check || drift === 0) ? 0 : 1);
