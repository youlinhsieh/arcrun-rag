// oversize-block-split.test.mjs — inkstone/Arcrun#291：單一章節超過 64 KB 的卡（錯誤碼總表）。
// 跑 YAML 裡真的 parse_card：每個 block 都要小到任何一次整塊讀回來都裝得進 http_request 的 64 KB。
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const yaml = fs.readFileSync(new URL('../rag-ingest-card.local.yaml', import.meta.url).pathname, 'utf8');
const parseCard = new Function('input', codeOf(yaml, 'parse_card'));
let pass = 0, fail = 0;
const t = (label, cond, extra = '') => { cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++); };
const d = (r) => (r && r.data !== undefined && r.success !== undefined && r.data && typeof r.data === 'object' ? r.data : r);
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const run = (md) => d(parseCard({ card: md, page_name: '總表', path: 'e/總表.md', library: 'error_codes', machine: 'm', machine_label: 'm', card_hash: 'h' }));

const rows = Array.from({ length: 6000 }, (_, i) => `| E${i} | 錯誤碼說明第${i}項 | 處置建議與排除步驟 |`);
const md = `# 總表\n\n## 摘要\n短。\n\n## 錯誤碼總表\n${rows.join('\n')}\n\n## 關聯\n- 總表 >> 屬於 >> 測試\n`;
t('前提：原章節確實超過 64 KB', bytes(rows.join('\n')) > 64 * 1024);
const r = run(md);
t('每個 block 的 UTF-8 大小都小於 40 KB', r.blocks.every((b) => bytes(b.content) < 40 * 1024), String(Math.max(...r.blocks.map((b) => bytes(b.content)))));
t('內容一列不少：把切開的 block 接回去，每一列都還在', rows.every((x) => r.blocks.some((b) => b.content.includes(x))));
t('card_blocks 是切後的數量，source #N 連號不重複', r.blocks.every((b) => b.card_blocks === String(r.blocks.length)) && new Set(r.blocks.map((b) => b.source)).size === r.blocks.length);
t('小章節不被切（摘要仍是一個 block）', r.blocks.filter((b) => b.content.startsWith('## 摘要')).length === 1);
const longLine = '長'.repeat(30000);
const r2 = run(`# x\n## a\n${longLine}\n`);
t('單行超長也會硬切', r2.blocks.every((b) => b.content.length <= 12000) && r2.blocks.map((b) => b.content).join('').includes(longLine));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
