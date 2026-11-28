#!/usr/bin/env node
/**
 * change-class.mjs — 這次變更是「軟」還是「硬」（inkstone/arcrun-rag#381，leo 2026-11-22）
 *
 * 軟更新＝只有資料變（App、市集目錄、內建工作流、skill、文件）：不碰 worker、不該出主程式新版號；
 * 硬更新＝零件／引擎／worker／前端變了：才走主程式出貨線（背景備好、一鍵換上，#163）。
 *
 * 判準只有一個：**這個路徑的內容，用戶端拿到它需不需要換掉一個執行中的 worker？** 要＝硬，不要＝軟。
 * 認不得的路徑一律算硬（寧可多出一班車，不可把要換 worker 的東西當資料悄悄漏掉）。
 *
 * 用法：node installer/scripts/change-class.mjs --repo <Arcrun 來源 repo> --from <sha> [--to <sha，預設 HEAD>]
 * 結束碼：0＝軟或沒變；1＝硬（要走主程式出貨線）。純函式 classify() 給測試與出貨線複用。
 */
import { execFileSync } from 'node:child_process';

/** 資料類路徑（前綴）。key＝怎麼送達：market＝市集上架線；portal＝Portal 畫面包線；pending＝資料類但軟更新匯入路徑還沒接，目前仍隨主程式帶。 */
export const SOFT_RULES = [
  { prefix: 'app-market/', via: 'market', why: 'App 與市集目錄（市集上架線）' },
  { prefix: 'console-ui/public/', via: 'portal', why: 'Portal 畫面（畫面包線，ship-portal.mjs；用戶不必按「立即更新」，inkstone/arcrun-rag#398）' },
  { prefix: 'skills/', via: 'pending', why: 'skill（資料）' },
  { prefix: 'workflows/', via: 'pending', why: '內建工作流（資料；匯入路徑待接，見 ADR 後續）' },
  { prefix: 'docs/', via: 'none', why: '文件' },
  { prefix: 'system-dev/', via: 'none', why: '知識庫' },
];
const NO_DELIVERY = [/\.md$/i, /(^|\/)tests?\//, /\.test\.(m?[jt]s)$/];

export function classify(paths) {
  const out = { kind: 'none', hard: [], soft: [], ignored: [] };
  for (const raw of paths) {
    const p = String(raw).trim();
    if (!p) continue;
    const rule = SOFT_RULES.find((r) => p.startsWith(r.prefix));
    if (rule && rule.via !== 'none') { out.soft.push({ path: p, via: rule.via, why: rule.why }); continue; }
    if (rule || NO_DELIVERY.some((re) => re.test(p))) { out.ignored.push(p); continue; }
    out.hard.push(p);
  }
  // 資料類但匯入路徑還沒接（pending）的，今天仍要隨主程式帶——所以也讓整體算硬，並說明原因。
  const pending = out.soft.filter((s) => s.via === 'pending');
  out.kind = out.hard.length || pending.length ? 'hard' : out.soft.length ? 'soft' : 'none';
  out.reason = out.hard.length
    ? `有 ${out.hard.length} 個路徑要換 worker／前端（例：${out.hard[0]}）`
    : pending.length ? `只有資料變，但「${pending[0].why}」的軟更新匯入路徑還沒接，今天仍隨主程式帶`
    : out.soft.length ? '只有市集資料或 Portal 畫面變——走市集上架線／畫面包線（ship-market／ship-portal），不出主程式新版號' : '沒有需要送達的變更';
  return out;
}

function cli() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const repo = arg('--repo'); const from = arg('--from'); const to = arg('--to') || 'HEAD';
  if (!repo || !from) { console.error('用法：--repo <Arcrun 來源> --from <sha> [--to <sha>]'); process.exit(2); }
  const files = execFileSync('git', ['diff', '--name-only', `${from}..${to}`], { cwd: repo, encoding: 'utf8' }).split('\n');
  const r = classify(files);
  console.log(`${r.kind === 'hard' ? '硬更新' : r.kind === 'soft' ? '軟更新' : '無需送達'}：${r.reason}`);
  if (r.soft.length) console.log('資料類：' + r.soft.map((s) => `${s.path}（${s.via}）`).join('、'));
  process.exit(r.kind === 'hard' ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) cli();
