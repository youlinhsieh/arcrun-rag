#!/usr/bin/env node
/**
 * feedback-inbox.mjs — 小幫手「回報」收件端（youlin `inbox-feedback` 的 feedback_report）的部署與體檢
 * （inkstone/arcrun-rag#362 c1795074512267387）
 *
 * 為什麼有它：收件端住在 youlin（stage）上，而 stage 會被清空重裝（youlin-stage-reset.sh、實例重裝）。
 * 清空後 namespace `inbox-feedback` 裡的工作流與 `ahub_token` 一起消失，**小幫手送出去只得到「送不出去」，
 * 沒有任何東西告訴我們收件端沒了**（2026-11-19 實查：workflows 0 個、credentials 0 把，trigger 回 404）。
 * 這支做兩件事：
 *   check   唯讀：工作流在不在、ahub_token 在不在（只看名字，不讀值、不開票）。缺了 exit 1 並講出缺什麼。
 *   deploy  渲染 AHub 版（render-feedback-report.mjs）→ 編圖 → 推到收件端；推完再 check。
 *           **只推工作流**。ahub_token 的值 AI 不碰（D36）：缺的話印出要 leo 做什麼，exit 1。
 * 收件端現在預設是 uncle6（arcrun-rag#282）；youlin 清空與它無關。
 *   probe   每日探針：送一則測試回報，開得出票才算收件端活著（見 probeInbox）。
 * 不輪詢、不排程；probe 由「現有每天會跑的流程」呼叫，不自己起排程。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderFeedbackReport } from './render-feedback-report.mjs';
import { renderFeedbackProbe, PROBE_WORKFLOW } from './render-feedback-probe.mjs';
import { cypherAuthHeaders } from './cypher-auth.mjs';

// 收件端住 uncle6（核心帳號，arcrun-rag#282；leo 2026-10-20／11-20：官方內容不放 youlin，stage 隨時會清）。
// 要對別的收件端（演練）用環境變數 ARCRUN_FEEDBACK_INBOX_BASE 覆蓋；預設永遠是 uncle6。
export const INBOX_BASE = (process.env.ARCRUN_FEEDBACK_INBOX_BASE || 'https://arcrun-cypher-executor.uncle6-me.workers.dev').replace(/\/+$/, '');
export const INBOX_NS = 'inbox-feedback';
export const WORKFLOW = 'feedback_report';
export const CREDENTIAL = 'ahub_token';

const hdr = (ns) => ({ 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0', ...cypherAuthHeaders(ns) });

/** 唯讀體檢。回 { ok, missing:[…], detail }。 */
export async function checkInbox({ base = INBOX_BASE, ns = INBOX_NS, fetchImpl = fetch } = {}) {
  const missing = [];
  const wfRes = await fetchImpl(`${base}/webhooks/named`, { headers: hdr(ns) });
  const wf = wfRes.ok ? await wfRes.json() : null;
  if (!wf) missing.push(`無法列出工作流（HTTP ${wfRes.status}）`);
  else if (!(wf.workflows || []).some((w) => (w.name || w) === WORKFLOW)) missing.push(`工作流 ${WORKFLOW}`);
  const crRes = await fetchImpl(`${base}/credentials`, { headers: hdr(ns) });
  const cr = crRes.ok ? await crRes.json() : null;
  if (!cr) missing.push(`無法列出金鑰（HTTP ${crRes.status}）`);
  else if (!(cr.credentials || []).some((c) => (c.name || c) === CREDENTIAL)) missing.push(`金鑰 ${CREDENTIAL}`);
  return { ok: missing.length === 0, missing };
}

/** 渲染＋編圖＋推。回 { status }。 */
export async function deployInbox({ base = INBOX_BASE, ns = INBOX_NS, fetchImpl = fetch, yamlText, loadYaml } = {}) {
  const wf = loadYaml(yamlText ?? renderFeedbackReport().yaml);
  const h = hdr(ns);
  const r = await fetchImpl(`${base}/cypher/search`, { method: 'POST', headers: h, body: JSON.stringify({ triplets: wf.flow, mode: 'compile' }) });
  if (!r.ok) throw new Error(`編圖失敗 HTTP ${r.status}`);
  const d = await r.json();
  const cfg = wf.config || {};
  const nodes = d.cypher.nodes.map((n) => {
    const c = cfg[n.id]; if (!c) return n;
    const { component, ...p } = c;
    return { ...n, componentId: typeof component === 'string' ? component : n.componentId, data: Object.keys(p).length ? { ...(n.data || {}), ...p } : n.data };
  });
  const graph = { id: wf.name, name: wf.name, nodes, edges: d.cypher.edges };
  const r2 = await fetchImpl(`${base}/webhooks/named`, { method: 'POST', headers: h, body: JSON.stringify({ name: wf.name, graph, config: cfg, description: wf.description || '' }) });
  if (!r2.ok) throw new Error(`部署失敗 HTTP ${r2.status}`);
  return { status: r2.status };
}

/**
 * 每日探針：照小幫手「?」實際走的那條路（ns＋名字的 trigger 網址）送一則帶標記的測試回報，
 * 回 { ok, number, url, error }。ok:false ＝收件端現在收不了用戶回報，**要立刻叫總監**（落在 AHub 票上）。
 * event_key 固定 `probe:<日期>`：同一天重跑併成同一張，不會一天開出一疊票。
 * 開出的測試票由呼叫端（每日跑它的那個流程）關掉；本函式不碰票。
 */
export async function probeInbox({ base = INBOX_BASE, ns = INBOX_NS, fetchImpl = fetch, now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const send = async (compared) => {
    let res;
    try {
      res = await fetchImpl(`${base}/webhooks/named/${ns}/${WORKFLOW}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
        body: JSON.stringify({
          text: `【每日探針 ${day}】收件端自動測試，請直接關閉，不用處理。`,
          version: 'probe', instance: 'probe', os: 'probe', event_key: `probe:${day}`,
          ...(compared ? { compared } : {}),
        }),
      });
    } catch (e) { return { ok: false, error: `連不上收件端：${e.message}` }; }
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    // 引擎把工作流最後一個節點的輸出包在 data 裡，常見兩層（{data:{data:{number}}}，2026-11-21 youlin 實測）：往下找第一個帶 number 的物件，略過 trace。
    const seek = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 6) return undefined;
      if (typeof o.number === 'number') return o;
      for (const k of Object.keys(o)) { if (k === 'trace') continue; const r = seek(o[k], d + 1); if (r) return r; }
      return undefined;
    };
    const data = res.ok && body && body.success !== false ? seek(body) : undefined;
    if (data) return { ok: true, number: data.number, url: String(data.url || data.html_url || '') };
    const why = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    return { ok: false, error: String(why).slice(0, 300) };
  };
  const r1 = await send();
  if (r1.ok) return r1;
  // AHub 開票前會拿新票比對全部票（含已關）：探針票天天相近，第二天起必被擋（409「重複候選=…」）。
  // 這是預期會發生的事，和小幫手（collector feedback.go postFeedbackRef）、每日工作流（judge1→send2）一樣：
  // 事件鍵還沒有票＝新事件，帶逐張交代重送一次。其他失敗（沒金鑰、工作流不見、AHub 擋下）不重送，照實回報。
  const m = /重複候選=([^"\\]*)/.exec(r1.error);
  const refs = [...new Set((m ? m[1].match(/[^\s=,]+\/[^\s=,#]+#\d+/g) : null) || [])];
  if (!refs.length) return r1;
  return send(refs.slice(0, 10).map((ref) => ({ ref, reason: '每日自動探針的測試票，與前幾天的探針票內容相近但不是同一件事' })));
}

/**
 * 種 ahub_token：在 leo21c AHub 登記專用 agent 登入名 `feedback-inbox`（**只送 sha256 雜湊**），
 * 原文只寫進收件端的金鑰中心（POST /credentials，帶 X-CF-Secrets-Token 讓 cypher 寫 Workers Secret）。
 * 🔴 這是「替系統加一把權限」：只有 AHub 簽核通過後才准跑（leo 11-06 同意過同一動作、11-20 搬 uncle6 要再簽）。
 * 🔴 原文只活在這個行程的記憶體：不印、不落檔、不進 argv。回傳值只有名字與狀態碼。
 */
export async function seedToken({ base = INBOX_BASE, ns = INBOX_NS, ahubUrl, ahubNs, cfToken, fetchImpl = fetch, randomHex } = {}) {
  if (!ahubUrl || !ahubNs) throw new Error('缺 AHUB_CYPHER_URL／AHUB_NS（installer/forge.conf）');
  if (!cfToken) throw new Error('缺寫 Workers Secret 的 Cloudflare 鑰匙（環境變數 CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE）');
  const { createHash, randomBytes } = await import('node:crypto');
  const token = 'ahub_' + (randomHex ? randomHex() : randomBytes(24).toString('hex'));
  const hash = createHash('sha256').update(token).digest('hex');
  // ① 先把原文寫進收件端（失敗就停，**還沒登記任何雜湊**——2026-11-20 uncle6 實撞：先登記後寫入，
  //    寫入 502 留下兩筆孤兒雜湊）。
  // 只走引擎的 /credentials（金鑰中心，D36）：鑰匙隨請求交給 CF（X-CF-Secrets-Token），不直寫 Workers Secret。
  // 引擎回 502「寫入路徑未就緒」＝uncle6 還沒升到認得這個標頭的版本 ⇒ 照實失敗，不退回繞過金鑰中心的路
  // （Arcrun#454；leo 11-18「修機制、不准繞過再開票補」；本票 c1795188801681620）。
  const put = await fetchImpl(`${base}/credentials`, {
    method: 'POST', headers: { ...hdr(ns), 'X-CF-Secrets-Token': cfToken },
    body: JSON.stringify({ name: CREDENTIAL, value: token, service: 'ahub' }),
  });
  if (!put.ok) {
    const why = await put.text().catch(() => '');
    throw new Error(`寫入收件端金鑰中心失敗 HTTP ${put.status}${put.status === 502 ? '（收件端引擎版本太舊，寫入路徑未就緒：要先升級 uncle6，不要改走別條路）' : ''}${why ? ' ' + why.slice(0, 160) : ''}（還沒登記任何雜湊）`);
  }
  // ② 原文落地了，才向 AHub 登記雜湊（只送 sha256）。
  const reg = await fetchImpl(`${ahubUrl.replace(/\/+$/, '')}/webhooks/named/${ahubNs}/ahub__token_register/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' },
    body: JSON.stringify({ method: 'POST', path: '/ahub/tokens', body: { login: 'feedback-inbox', kind: 'agent', token_sha256: hash } }),
  });
  if (!reg.ok) throw new Error(`AHub 登記失敗 HTTP ${reg.status}（金鑰原文已寫入收件端但 AHub 不認它；重跑會換一把新的並覆蓋）`);
  const regBody = await reg.json().catch(() => null);
  let hit = null; for (let d = regBody; d && typeof d === 'object'; d = d.data) if (typeof d.status === 'number' && 'body' in d) hit = d;
  if (!hit || hit.status !== 201) throw new Error('AHub 沒有回登記成功（金鑰原文已寫入收件端但 AHub 不認它；重跑會換一把新的並覆蓋）');
  return { credential: CREDENTIAL, status: put.status };
}

/**
 * probe-status：只讀 uncle6 的執行紀錄（不需要任何金鑰）——每日探針（feedback_probe_daily）自己有沒有在跑、最近一次成不成。
 * 這是「探針自己壞掉也要有人看得到」的最後一道：警報走 AHub 需要 ahub_token，金鑰沒了警報也發不出去，
 * 但失敗的執行紀錄還在。由「現有每天會跑的流程」呼叫；非 ok 就非零退出。
 * 回 { ok, reason, last }。maxAgeHours 預設 26（每天一次＋2 小時寬限）。
 */
export async function probeStatus({ base = INBOX_BASE, ns = INBOX_NS, fetchImpl = fetch, now = new Date(), maxAgeHours = 26 } = {}) {
  const res = await fetchImpl(`${base}/workflows/${PROBE_WORKFLOW}/executions?limit=5`, { headers: hdr(ns) });
  if (res.status === 404) return { ok: false, reason: `每日探針 ${PROBE_WORKFLOW} 不在 ${ns}（沒部署或被清掉）` };
  if (!res.ok) return { ok: false, reason: `讀不到探針的執行紀錄（HTTP ${res.status}）` };
  const body = await res.json().catch(() => null);
  const ex = (body && body.data && body.data.executions) || [];
  if (!ex.length) return { ok: false, reason: '探針還沒有任何執行紀錄（排程沒跑過）' };
  // 執行紀錄的 timestamp 是「秒」（2026-11-20 youlin 實測 1795188315），不是毫秒。
  const ms = (t) => (Number(t) < 1e12 ? Number(t) * 1000 : Number(t));
  const last = ex.slice().sort((a, b) => ms(b.timestamp) - ms(a.timestamp))[0];
  const ageH = (now.getTime() - ms(last.timestamp)) / 3600000;
  if (last.verdict !== 'success') return { ok: false, reason: `探針最近一次失敗：${String(last.message || '').slice(0, 300)}`, last };
  if (ageH > maxAgeHours) return { ok: false, reason: `探針超過 ${maxAgeHours} 小時沒跑（最近一次在 ${Math.floor(ageH)} 小時前）`, last };
  return { ok: true, last };
}

export function describeMissing(missing) {
  const lines = missing.map((m) => `  - 缺 ${m}`);
  if (missing.some((m) => m.includes(CREDENTIAL))) {
    lines.push(`  ${CREDENTIAL} 要 AHub 簽核（leo 同意）後才准種：node installer/scripts/feedback-inbox.mjs seed-token（登記雜湊＋原文只寫進 ${INBOX_NS} 的金鑰中心，不印值）。未簽核不准跑、不找替代路。`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (!['check', 'deploy', 'deploy-probe', 'probe', 'probe-status', 'seed-token'].includes(cmd)) { console.error('用法：node installer/scripts/feedback-inbox.mjs check|deploy|deploy-probe|probe|probe-status|seed-token'); process.exit(2); }
  if (cmd === 'seed-token') {
    const { resolveForgeSettings } = await import('./forge-config.mjs');
    const f = resolveForgeSettings();
    try {
      const r = await seedToken({ ahubUrl: f.cypherUrl, ahubNs: f.ns, cfToken: process.env.CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE });
      console.log(`✅ 已種 ${r.credential}（HTTP ${r.status}），值未顯示`); process.exit(0);
    } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
  }
  if (cmd === 'probe-status') {
    const r = await probeStatus();
    if (r.ok) { console.log('PROBE_STATUS_OK 每日探針最近一次成功'); process.exit(0); }
    console.error('PROBE_STATUS_FAIL ' + r.reason); process.exit(1);
  }
  if (cmd === 'probe') {
    const r = await probeInbox();
    if (r.ok) { console.log(`PROBE_OK #${r.number} ${r.url}（測試票，請關掉）`); process.exit(0); }
    console.error(`PROBE_FAIL ${r.error}`); process.exit(1);
  }
  const require = createRequire(fileURLToPath(import.meta.url));
  const loadYaml = (t) => require('js-yaml').load(t);
  try {
    if (cmd === 'deploy-probe') {
      // 🔴 uncle6＝prod：沒有 AHub 簽核不准跑（本票 c1795187556046542）。演練請用 ARCRUN_FEEDBACK_INBOX_BASE 指 youlin 隔離租戶。
      const r = await deployInbox({ loadYaml, yamlText: renderFeedbackProbe().yaml });
      console.log(`✅ ${PROBE_WORKFLOW} 已推到 ${INBOX_NS}（HTTP ${r.status}）`); process.exit(0);
    }
    if (cmd === 'deploy') { const r = await deployInbox({ loadYaml }); console.log(`✅ ${WORKFLOW} 已推到 ${INBOX_NS}（HTTP ${r.status}）`); }
    const c = await checkInbox();
    if (c.ok) console.log('✅ 收件端齊全（工作流＋金鑰名字都在）');
    else { console.error('❌ 收件端不完整：\n' + describeMissing(c.missing)); process.exit(1); }
  } catch (e) { console.error('❌ ' + e.message); process.exit(2); }
}
