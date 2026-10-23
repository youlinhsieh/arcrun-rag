#!/usr/bin/env node
/**
 * render-feedback-report.mjs — 依 installer/forge.conf 產出「要部署到收件端」的 feedback_report 工作流
 * （inkstone/InkStoneCo#234）
 *
 * 為什麼要有渲染這一步：用戶回報工作流要把票開在「票的正本」所在的那一家。
 * Gitea 版（workflows/feedback-report.yaml）網址寫死在 Gitea REST；AHub 版（workflows/feedback-report.ahub.yaml）
 * 的 AHub 網址與 namespace 是佔位（`__AHUB_CYPHER_URL__`／`__AHUB_NS__`），因為
 * 「用戶實例上的工作流不得出現通往 leo 個人實例的網址」（#235 的地板，feedback-report-contract 釘住）。
 * 這支把兩者接起來：TICKET_FORGE 翻哪邊，輸出就是哪一份；翻回 gitea ＝ 回退。
 *
 * 用法：
 *   node installer/scripts/render-feedback-report.mjs            # 印到 stdout
 *   node installer/scripts/render-feedback-report.mjs --out f.yaml
 *   TICKET_FORGE=gitea node installer/scripts/render-feedback-report.mjs   # 臨時翻
 *
 * 🔴 渲染後仍殘留任何 `__X__` 佔位 ⇒ 直接丟（佔位原字串上線＝開票永遠失敗，且是靜默的）。
 * 🔴 這支只**產出**，不部署。部署到 youlin 的 `inbox-feedback` namespace 是切換手冊的一步。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveForgeSettings } from './forge-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WF_DIR = join(HERE, '..', '..', 'workflows');
export const GITEA_FILE = join(WF_DIR, 'feedback-report.yaml');
export const AHUB_FILE = join(WF_DIR, 'feedback-report.ahub.yaml');

/** 純函式：給定設定，回 { forge, yaml }。ahub 版替換佔位並檢查殘留。 */
export function renderFeedbackReport(settings = resolveForgeSettings(), { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (settings.kind === 'gitea') return { forge: 'gitea', yaml: readFile(GITEA_FILE) };
  if (!settings.cypherUrl || !settings.ns) throw new Error('渲染 AHub 版需要 AHUB_CYPHER_URL 與 AHUB_NS（installer/forge.conf）');
  const subs = { __AHUB_CYPHER_URL__: settings.cypherUrl, __AHUB_NS__: settings.ns };
  let yaml = readFile(AHUB_FILE);
  for (const [k, v] of Object.entries(subs)) yaml = yaml.split(k).join(v);
  // 只看生效行：註解裡提到佔位（解釋為什麼有它）不算殘留。
  const liveText = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const left = [...new Set(liveText.match(/__[A-Z][A-Z0-9_]*__/g) || [])];
  if (left.length) throw new Error(`feedback-report.ahub.yaml 渲染後仍有未代換的佔位：${left.join('、')}`);
  return { forge: 'ahub', yaml };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { forge, yaml } = renderFeedbackReport();
    const i = process.argv.indexOf('--out');
    if (i > 0 && process.argv[i + 1]) {
      writeFileSync(process.argv[i + 1], yaml);
      console.error(`✅ 已渲染 ${forge} 版 feedback_report → ${process.argv[i + 1]}`);
    } else {
      process.stdout.write(yaml);
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(2);
  }
}
