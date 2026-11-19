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
 * 不輪詢、不排程；重清空 youlin 之後人／總管跑一次 deploy。根治（搬到 uncle6，arcrun-rag#282）未做。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderFeedbackReport } from './render-feedback-report.mjs';
import { cypherAuthHeaders } from './cypher-auth.mjs';

export const INBOX_BASE = 'https://arcrun-cypher-executor.arcrun-yuga3bse.workers.dev';
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

export function describeMissing(missing) {
  const lines = missing.map((m) => `  - 缺 ${m}`);
  if (missing.some((m) => m.includes(CREDENTIAL))) {
    lines.push(`  ${CREDENTIAL} 要 leo 同意後產生：在 leo21c AHub 登記 agent 登入名 feedback-inbox（只送雜湊，workflows/ahub/register-token.sh），原文只寫進 ${INBOX_NS} 的金鑰中心（名字 ${CREDENTIAL}）。AI 不代為產生、不找替代路。`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (!['check', 'deploy'].includes(cmd)) { console.error('用法：node installer/scripts/feedback-inbox.mjs check|deploy'); process.exit(2); }
  const require = createRequire(fileURLToPath(import.meta.url));
  const loadYaml = (t) => require('js-yaml').load(t);
  try {
    if (cmd === 'deploy') { const r = await deployInbox({ loadYaml }); console.log(`✅ ${WORKFLOW} 已推到 ${INBOX_NS}（HTTP ${r.status}）`); }
    const c = await checkInbox();
    if (c.ok) console.log('✅ 收件端齊全（工作流＋金鑰名字都在）');
    else { console.error('❌ 收件端不完整：\n' + describeMissing(c.missing)); process.exit(1); }
  } catch (e) { console.error('❌ ' + e.message); process.exit(2); }
}
