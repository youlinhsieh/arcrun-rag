#!/usr/bin/env node
/**
 * passages-backfill.mjs —— 已萃好的卡，把「原文層」補進向量層（inkstone/Arcrun#343 工單 B）。
 *
 * 做什麼：讀指定庫裡每張卡的「原文表格／原文條列／原文段落／讀圖原文」（arcrun-rag#277 逐字保留的原稿），
 *   切成段落，經雲端 `rag_ingest_passages`（arcrun-rag#296）寫成 source_passage、由 KBDB 嵌入 bge-m3 向量。
 *   每段第一行＝「卡名 › 層 › PDF 第 N 頁：小節」，段落 entry 的 page_name＝卡名、source_path＝原稿檔，
 *   所以每段都帶得回「原卡＋原稿＋頁」。
 * 不做什麼：卡本身一個字不動（只讀卡、只寫段落）；摘要／重點／實體／關聯不嵌；沒有原文層的舊卡＝零段落（如實列出）。
 *   🔴 error_codes（8.7 萬筆，錯誤碼走表格路線，#264）硬擋，不是靠參數，是程式拒絕。
 * 重工作在雲端：本腳本只切字（零模型）；嵌入由實例的 KBDB 在寫入時做。
 *
 * 用法（預設乾跑，什麼都不寫；--apply 才寫）：
 *   ARCRUN_BASE=https://arcrun-cypher-executor.<子網域>.workers.dev ARCRUN_NS=<租戶> \
 *   ARCRUN_SESSION_TOKEN=<console session> node scripts/passages-backfill.mjs --library ink-eval-343 [--card <卡名>] [--apply]
 *   憑證：ARCRUN_PROXY_KEY（租戶服務金鑰，現成就帶）或 KBDB_INTERNAL_TOKEN（算出金鑰）或 ARCRUN_SESSION_TOKEN（向 /console/kbdb-key 取）。
 *
 * 🔴 額度鐵律（頂層 CLAUDE.md「額度鐵律」，inkstone/InkStoneCo#271）——每跑一次的成本跟「這次用到的卡」成正比：
 *   讀：每庫 1 次目錄（library-cards，一列一卡）＋每卡 ⌈區塊數/60⌉ 次區塊讀（共讀 區塊數 列）＋每卡 1 次既有段落讀（只取 id，view=identity）。
 *   寫：每段 1 筆 entry（PUT 覆寫，冪等；同卡重跑＝同 id 覆寫、不長副本）；每 20 段 1 次 webhook。
 *   嵌入：每段 1 次 Workers AI bge-m3（寫入即嵌）。腳本結尾印出實際數字。
 *   不輪詢、不排程；一次最多處理 --max-cards（預設 30）張卡、--max-passages（預設 1500）段。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildPassages, withIds, layerHash, CARD_CHUNKER_REV } from './lib/card-passages.mjs';
import { cypherAuthHeaders } from '../installer/scripts/cypher-auth.mjs';

const BLOCKED_LIBRARIES = new Set(['error_codes']);
const BATCH = 20; // rag_ingest_passages 一次最多收 40，留一半餘裕
const PAGE = 60;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}
const flag = (n) => process.argv.includes(`--${n}`);
function die(msg) { console.error(`\n❌ ${msg}`); process.exit(1); }

export function isIndexCard(name) {
  return name === '00-INDEX' || /^資料夾總覽[：:]/.test(name) || /^00-INDEX@/.test(name);
}

/** 把一張卡的 block 列（含 metadata.source=…#i）依序組回 markdown。 */
export function assembleCard(blocks) {
  const idx = (b) => { const m = /#(\d+)$/.exec((() => { try { return JSON.parse(b.metadata_json || '{}').source || ''; } catch { return ''; } })()); return m ? Number(m[1]) : 1e9; };
  return blocks.slice().sort((a, b) => idx(a) - idx(b)).map((b) => String(b.content || '')).join('\n\n');
}

async function main() {
  const base = (process.env.ARCRUN_BASE || '').replace(/\/$/, '');
  const ns = process.env.ARCRUN_NS || '';
  if (!base || !ns) die('要設 ARCRUN_BASE（cypher 網址）與 ARCRUN_NS（租戶）');
  const libs = args('library');
  if (!libs.length) die('要用 --library 指定庫（可重複）；不提供「全庫」模式');
  for (const l of libs) if (BLOCKED_LIBRARIES.has(l)) die(`庫「${l}」不補段落：錯誤碼走表格路線（arcrun-rag#264），8.7 萬筆不碰。`);
  const only = args('card');
  const apply = flag('apply');
  const maxCards = Number(arg('max-cards', 30));
  const maxPassages = Number(arg('max-passages', 1500));

  let headers;
  if (process.env.ARCRUN_PROXY_KEY) headers = { 'X-Arcrun-API-Key': ns, Authorization: `Bearer ${process.env.ARCRUN_PROXY_KEY}` };
  else if (process.env.KBDB_INTERNAL_TOKEN) headers = cypherAuthHeaders(ns);
  else if (process.env.ARCRUN_SESSION_TOKEN) {
    const r = await fetch(`${base}/console/kbdb-key`, { headers: { Authorization: `Bearer ${process.env.ARCRUN_SESSION_TOKEN}` } });
    if (!r.ok) die(`向 /console/kbdb-key 取金鑰失敗：HTTP ${r.status}`);
    headers = { 'X-Arcrun-API-Key': ns, Authorization: `Bearer ${(await r.json()).key}` };
  } else die('沒有憑證：設 ARCRUN_PROXY_KEY、KBDB_INTERNAL_TOKEN 或 ARCRUN_SESSION_TOKEN 其中一個');

  const stats = { libraryReads: 0, blockRowsRead: 0, blockReads: 0, passageIdReads: 0, cards: 0, cardsNoLayer: [], passages: 0, deleted: 0, webhookCalls: 0 };
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { ...headers, accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  for (const library of libs) {
    const dir = await get(`/kbdb/entries/library-cards?library=${encodeURIComponent(library)}&limit=500`);
    stats.libraryReads++;
    const cards = (dir.cards || []).filter((c) => !isIndexCard(c.page_name) && (!only.length || only.includes(c.page_name)));
    console.log(`庫「${library}」：${cards.length} 張卡${apply ? '' : '〔乾跑〕'}`);
    for (const card of cards) {
      if (stats.cards >= maxCards) { console.log(`  已達 --max-cards ${maxCards}，其餘不處理`); break; }
      if (stats.passages >= maxPassages) { console.log(`  已達 --max-passages ${maxPassages}，其餘不處理`); break; }
      stats.cards++;
      const blocks = [];
      for (let off = 0; ; off += PAGE) {
        const j = await get(`/kbdb/entries?template=block&page_name=${encodeURIComponent(card.page_name)}&limit=${PAGE}&offset=${off}`);
        stats.blockReads++;
        const rows = (j.entries || []).filter((e) => { try { return JSON.parse(e.metadata_json || '{}').library === library; } catch { return false; } });
        stats.blockRowsRead += (j.entries || []).length;
        blocks.push(...rows);
        if ((j.entries || []).length < PAGE) break;
      }
      if (!blocks.length) { console.log(`  · ${card.page_name}：讀不到區塊，略過`); continue; }
      const meta = JSON.parse(blocks[0].metadata_json || '{}');
      const md = assembleCard(blocks);
      const ps = withIds(buildPassages(card.page_name, md), meta.machine || '', library, card.page_name);
      if (!ps.length) { stats.cardsNoLayer.push(card.page_name); console.log(`  · ${card.page_name}：沒有原文層（${blocks.length} 區塊）→ 0 段`); continue; }
      const byLayer = ps.reduce((a, p) => ((a[p.layer] = (a[p.layer] || 0) + 1), a), {});
      console.log(`  · ${card.page_name}：${blocks.length} 區塊 → ${ps.length} 段 ${JSON.stringify(byLayer)}`);
      if (!apply) { stats.passages += ps.length; continue; }

      // 既有段落（同卡、同前綴）：改短時刪尾巴，讓重跑冪等。
      const prefix = ps[0].id.replace(/-\d+$/, '');
      const ex = await get(`/kbdb/entries?template=source_passage&page_name=${encodeURIComponent(card.page_name)}&view=identity&limit=${PAGE * 5}`);
      stats.passageIdReads++;
      const stale = (ex.entries || []).map((e) => e.id).filter((id) => id.startsWith(prefix + '-') && Number(id.split('-').pop()) >= ps.length);
      const total = ps.length;
      const hash = layerHash(ps);
      const common = {
        path: meta.source_path || card.source_path || card.page_name, page_name: card.page_name, library,
        machine: meta.machine || '', machine_label: meta.machine_label || meta.machine || '',
        source_hash: `card:${meta.card_hash || ''}:${hash}`, chunker_rev: CARD_CHUNKER_REV, total,
      };
      for (let i = 0; i < ps.length; i += BATCH) {
        const slice = ps.slice(i, i + BATCH).map((p) => ({ id: p.id, idx: p.idx, heading: p.heading, content: p.content }));
        const body = { ...common, passages: slice, delete_ids: i === 0 ? stale.slice(0, 80) : [] };
        const r = await fetch(`${base}/webhooks/named/${encodeURIComponent(ns)}/rag_ingest_passages/trigger`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const text = await r.text();
        stats.webhookCalls++;
        if (!r.ok || /"success"\s*:\s*false/.test(text) || /"error"/.test(text.slice(0, 200))) die(`寫入失敗（${card.page_name} 第 ${i} 段起）：HTTP ${r.status} ${text.slice(0, 300)}`);
        stats.passages += slice.length;
        if (i === 0) stats.deleted += Math.min(stale.length, 80);
        await sleep(300);
      }
    }
  }
  console.log('\n── 用量（本次實際）──');
  console.log(JSON.stringify(stats, null, 1));
  if (!apply) console.log('（乾跑：沒有寫任何東西。要寫請加 --apply）');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => die(e.message));
