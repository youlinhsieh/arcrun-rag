#!/usr/bin/env node
/**
 * render-feedback-probe.mjs — 渲染 workflows/feedback-probe-daily.yaml（每日探針，inkstone/arcrun-rag#282）
 *
 * 模板裡的 `__X__` 佔位：AHub 網址／namespace 取自 installer/forge.conf（同 render-feedback-report.mjs）；
 * 警報票、探針 repo、cron 有預設，可由參數覆蓋。金鑰一律是 `{{credential.ahub_token}}`（D36）——
 * 只有演練（youlin 隔離租戶、用 stub 當 AHub）才可傳 tokenLiteral 換成假值；正式渲染不傳。
 * 渲染後殘留任何 `__X__`（生效行）直接丟。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveForgeSettings } from './forge-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_FILE = join(HERE, '..', '..', 'workflows', 'feedback-probe-daily.yaml');
export const PROBE_WORKFLOW = 'feedback_probe_daily';
export const DEFAULTS = { alertRepo: 'inkstone/arcrun-rag', alertNumber: '282', probeRepo: 'inkstone/arcrun-rag', cron: '10 1 * * *', inboxNs: 'inbox-feedback' };

export function renderFeedbackProbe(settings = resolveForgeSettings(), opts = {}, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (settings.kind === 'gitea') throw new Error('每日探針只支援 AHub（TICKET_FORGE=ahub）');
  if (!settings.cypherUrl || !settings.ns) throw new Error('渲染需要 AHUB_CYPHER_URL 與 AHUB_NS（installer/forge.conf）');
  const o = { ...DEFAULTS, ...opts };
  if (!/^[^/\s]+\/[^/\s]+$/.test(o.alertRepo) || !/^[^/\s]+\/[^/\s]+$/.test(o.probeRepo)) throw new Error('repo 要寫成 owner/name');
  if (!/^\d+$/.test(String(o.alertNumber))) throw new Error('alertNumber 要是數字');
  if (String(o.cron).trim().split(/\s+/).length !== 5) throw new Error('cron 要 5 欄');
  const subs = {
    __AHUB_CYPHER_URL__: settings.cypherUrl.replace(/\/+$/, ''), __AHUB_NS__: settings.ns,
    __ALERT_REPO__: o.alertRepo, __ALERT_OWNER__: o.alertRepo.split('/')[0], __ALERT_NAME__: o.alertRepo.split('/')[1], __ALERT_NUMBER__: String(o.alertNumber), __PROBE_REPO__: o.probeRepo, __PROBE_CRON__: o.cron, __INBOX_NS__: o.inboxNs,
  };
  let yaml = readFile(PROBE_FILE);
  for (const [k, v] of Object.entries(subs)) yaml = yaml.split(k).join(v);
  if (o.tokenLiteral) yaml = yaml.split('{{credential.ahub_token}}').join(String(o.tokenLiteral));
  const live = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const left = [...new Set(live.match(/__[A-Z][A-Z0-9_]*__/g) || [])];
  if (left.length) throw new Error(`feedback-probe-daily.yaml 渲染後仍有未代換的佔位：${left.join('、')}`);
  return { yaml };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { yaml } = renderFeedbackProbe();
    const i = process.argv.indexOf('--out');
    if (i > 0 && process.argv[i + 1]) { writeFileSync(process.argv[i + 1], yaml); console.error('✅ 已渲染 → ' + process.argv[i + 1]); }
    else process.stdout.write(yaml);
  } catch (e) { console.error('❌ ' + e.message); process.exit(2); }
}
