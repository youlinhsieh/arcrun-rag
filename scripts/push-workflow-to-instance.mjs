// ⛔ 禁用於生產實例（2026-07-29 兩次事故）：此腳本組出的圖不過 cypher 的 graphSchema，
// 推上去會讓該 workflow 變成「圖定義已失效」＝功能全掛。
// **workflow 一律走安裝器部署**（實戰驗證過的路徑）；本檔僅留作研究。
console.error('⛔ 此腳本已禁用（推出的圖不合 schema，會弄壞實例）。請改用安裝器部署 workflow。');
process.exit(2);

// 把 workflows.json 的指定 workflow 推到指定實例（照 oauth worker pushWorkflowTo 手法）
import { readFileSync } from 'node:fs';
const [,, wfName, sub, ns] = process.argv;
const W = JSON.parse(readFileSync(new URL('./workflows.json', `file://${process.env.WFDIR}/`)));
const wf = Array.isArray(W) ? W.find(x=>x.name===wfName) : { name: wfName, ...W[wfName] };
if (!wf || !wf.flow) { console.error('找不到', wfName, Object.keys(W)); process.exit(2); }
const base = `https://arcrun-cypher-executor.${sub}.workers.dev`;
const subs = {
  '__NAMESPACE__': ns,
  '__CYPHER_BASE__': base,
  '__KBDB_BASE__': `https://arcrun-kbdb.${sub}.workers.dev`,
  '__HTTP_REQ_URL__': `https://arcrun-http-request.${sub}.workers.dev`,
  '__CODE_URL__': `https://arcrun-code.${sub}.workers.dev`,
  '__LLM_MODEL__': 'gemma-4-31b-it',
  '__GEMINI_API_KEY__': '',
};
const apply = (o) => { let s = JSON.stringify(o); for (const [k,v] of Object.entries(subs)) s = s.split(k).join(String(v)); return JSON.parse(s); };
const hdr = { 'content-type':'application/json', 'X-Arcrun-API-Key': ns, 'user-agent':'curl/8.5.0' };
const cres = await fetch(`${base}/cypher/search`, { method:'POST', headers:hdr, body: JSON.stringify({ triplets: apply(wf.flow) }) });
const compiled = await cres.json();
if (!cres.ok || (compiled.missing||[]).length) { console.error('編圖失敗', cres.status, compiled.missing); process.exit(1); }
const cfg = apply(wf.config); const g = compiled.cypher;
const nodes = (g.nodes||[]).map(n => { const c = cfg[n.id]; if (!c) return n;
  const p = Object.fromEntries(Object.entries(c).filter(([k])=>k!=='component'));
  const m = { ...n }; if (typeof c.component==='string') m.componentId=c.component;
  if (Object.keys(p).length) m.data={...(n.data||{}),...p}; return m; });
const dres = await fetch(`${base}/webhooks/named`, { method:'POST', headers:hdr,
  body: JSON.stringify({ name: wf.name, description: wf.description || '收本地萃好的卡寫入知識庫（含分庫章）', graph: { ...g, nodes } }) });
console.log(wf.name, '→', dres.status, (await dres.text()).slice(0,150));
