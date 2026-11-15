#!/usr/bin/env node
/**
 * passages-eval.mjs —— 段落向量層評測（Arcrun#343 工單 B）。
 * 對同一批「中文換說法問英文原稿」的題目，量兩件事：
 *   ① 向量層（mode=semantic，只看 source_passage）：正解段落排第幾（hit@1/3/5）
 *   ② 字面比對（mode=keyword，同庫同題）：撈得到含正解字串的東西嗎——這是「改版前搜不到」的基線
 * 用法：ARCRUN_BASE=… ARCRUN_NS=… ARCRUN_PROXY_KEY=… node scripts/passages-eval.mjs --library ink-eval-343 [--questions scripts/eval/passages-343.questions.json]
 */
import { readFileSync } from 'node:fs';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const base = (process.env.ARCRUN_BASE || '').replace(/\/$/, ''), ns = process.env.ARCRUN_NS, key = process.env.ARCRUN_PROXY_KEY;
if (!base || !ns || !key) { console.error('要設 ARCRUN_BASE／ARCRUN_NS／ARCRUN_PROXY_KEY'); process.exit(1); }
const library = arg('library', 'ink-eval-343');
const spec = JSON.parse(readFileSync(arg('questions', new URL('./eval/passages-343.questions.json', import.meta.url)), 'utf8'));
const H = { 'X-Arcrun-API-Key': ns, Authorization: `Bearer ${key}` };
async function search(q, mode) {
  const u = new URL(base + '/kbdb/search');
  u.searchParams.set('q', q); u.searchParams.set('mode', mode); u.searchParams.set('library', library); u.searchParams.set('top_k', '10'); if (mode === 'semantic') u.searchParams.set('template', 'source_passage');
  if (mode === 'semantic') u.searchParams.set('min_score', '0.05');
  const r = await fetch(u, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).entries || [];
}
const rows = []; let calls = 0;
for (const t of spec.questions) {
  const re = new RegExp(t.answer_re);
  const sem = (await search(t.q, 'semantic')).filter((e) => e.template === 'source_passage'); calls++;
  const kw = await search(t.q, 'keyword'); calls++;
  const rank = sem.findIndex((e) => re.test(e.content)) + 1; // 0＝沒命中
  const kwHit = kw.some((e) => re.test(e.content));
  const pages = sem.slice(0, 3).map((e) => /第 (\d+) 頁/.exec((() => { try { return JSON.parse(e.metadata_json).heading; } catch { return ''; } })())?.[1]);
  rows.push({ id: t.id, q: t.q, expect_page: t.page, passage_rank: rank || '-', top3_pages: pages.join(','), keyword_found: kwHit, regression: !!t.regression });
}
console.table(rows);
const n = rows.length, hit = (k) => rows.filter((r) => r.passage_rank !== '-' && r.passage_rank <= k).length;
console.log(`向量層 hit@1=${hit(1)}/${n}  hit@3=${hit(3)}/${n}  hit@5=${hit(5)}/${n}  hit@10=${hit(10)}/${n}`);
console.log(`字面比對（基線）撈到含正解字串的東西：${rows.filter((r) => r.keyword_found).length}/${n}`);
console.log(`（本次 ${calls} 次查詢；每次語意查詢＝1 次 Workers AI 嵌入 ＋ 1 次向量查詢）`);
