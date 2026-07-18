#!/usr/bin/env node
// gen-library-map.mjs — 總庫地圖（Arcrun#39 藏書地圖的 demo 切片，spec §7「人機共用同一份地圖」）
//
// 原則（照 leo spec）：地圖是「算的」不是「猜的」——骨架全部由 graph 統計導出，零 LLM。
// 產出＝知識庫 repo 的 system-dev/wiki/00-MAP.md：給 AI 的定向層（開場注入本檔＝
// 不用搜尋就知道館藏全貌），也是 portal「總圖」頁的文字版。
//
// 用法：node install/gen-library-map.mjs <知識庫repo路徑> [KBDB base] [namespace]
//   預設 KBDB=https://arcrun-kbdb.uncle6-me.workers.dev、NS=demo。
//   產出寫到 <知識庫repo>/system-dev/wiki/00-MAP.md；commit/push 由呼叫者做。
// 穩態自動重算（ingest 副產品）歸 Arcrun#39 SDD；本腳本是 demo 期的手動/排程重算器。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2];
const KBDB = process.argv[3] || 'https://arcrun-kbdb.uncle6-me.workers.dev';
const NS = process.argv[4] || 'demo';
if (!repo || !existsSync(join(repo, 'system-dev/wiki'))) {
  console.error('用法：node gen-library-map.mjs <知識庫repo路徑> [KBDB base] [namespace]');
  process.exit(1);
}

// ── 1) 知識關聯（active 三元組）──
const res = await fetch(`${KBDB}/records/by-template/triplet?owner_id=${encodeURIComponent(NS)}`, {
  headers: { 'X-Arcrun-API-Key': NS, 'User-Agent': 'curl/8.5.0' },
});
const { records = [] } = await res.json();
const seen = new Set();
const edges = [];
for (const r of records) {
  const v = r?.values;
  if (!v || v.status === 'deprecated' || !v.subject || !v.object) continue;
  const key = `${v.subject}|${v.predicate}|${v.object}`;
  if (seen.has(key)) continue;
  seen.add(key);
  edges.push({ s: String(v.subject).trim(), p: String(v.predicate || '關聯').trim(), o: String(v.object).trim() });
}
const degree = new Map();
const predCount = new Map();
for (const e of edges) {
  degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
  degree.set(e.o, (degree.get(e.o) ?? 0) + 1);
  predCount.set(e.p, (predCount.get(e.p) ?? 0) + 1);
}

// ── 2) 藏書（定稿卡＋一句話定義，抽自卡片而非生成）──
const cardsDir = join(repo, 'system-dev/wiki/cards');
const cards = [];
for (const f of (existsSync(cardsDir) ? readdirSync(cardsDir) : []).sort()) {
  if (!f.endsWith('.md')) continue;
  const md = readFileSync(join(cardsDir, f), 'utf8');
  const m = /##\s*一句話定義\s*\n+([^\n]+)/.exec(md);
  cards.push({ name: f.replace(/\.md$/, ''), gloss: m ? m[1].trim() : '（無一句話定義）' });
}

// ── 3) 組地圖 ──
const topEntities = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
const preds = [...predCount.entries()].sort((a, b) => b[1] - a[1]);
const byCardEdges = new Map();
for (const e of edges) {
  // part_of 目錄邊自成一段；內容邊全列（demo 量級可全列＝AI 拿到完整知識網）
  const bucket = e.p === 'part_of' ? '__catalog__' : '__content__';
  if (!byCardEdges.has(bucket)) byCardEdges.set(bucket, []);
  byCardEdges.get(bucket).push(e);
}
const contentEdges = byCardEdges.get('__content__') ?? [];

const lines = [];
lines.push('# 00-MAP — 總庫地圖');
lines.push('');
lines.push('> **機械計算產物，勿手改**（由 arcrun-rag `install/gen-library-map.mjs` 從知識圖譜算出，');
lines.push('> Arcrun#39 藏書地圖 demo 切片）。給 AI 的定向層：**開場注入本檔＝不用搜尋就知道館藏全貌**；');
lines.push('> 人看的同一份地圖＝portal「總圖」頁。細節查法：keyword/semantic 搜卡名、graph 查實體鄰居。');
lines.push('');
lines.push(`## 館藏規模`);
lines.push('');
lines.push(`- 定稿卡 ${cards.length} 張・知識關聯 ${contentEdges.length} 條・實體 ${degree.size} 個（庫：${NS}/general）`);
lines.push('');
lines.push('## 藏書（卡名＋一句話定義）');
lines.push('');
for (const c of cards) lines.push(`- **《${c.name}》** — ${c.gloss}`);
lines.push('');
lines.push('## 核心實體（依關聯數）');
lines.push('');
lines.push(topEntities.map(([n, d]) => `${n}(${d})`).join('・'));
lines.push('');
lines.push('## 關聯性格（謂詞分布）');
lines.push('');
lines.push(preds.map(([p, n]) => `${p}×${n}`).join('・'));
lines.push('');
lines.push('## 知識網全表');
lines.push('');
for (const e of contentEdges) lines.push(`- ${e.s} >> ${e.p} >> ${e.o}`);
lines.push('');

const out = join(repo, 'system-dev/wiki/00-MAP.md');
writeFileSync(out, lines.join('\n'));
console.log(`✅ ${out}（卡 ${cards.length}・關聯 ${contentEdges.length}・實體 ${degree.size}）`);
