// takedown-input-guard.test.mjs — inkstone/arcrun-rag#237：不可逆真刪，必要輸入缺失就要在刪之前停。
//
// 2026-10-05 實撞（Arcrun#44 comment 17488）：沒帶 path 觸發 rag_takedown_direct，
// `{{input.path}}` 以字面字串進來（不是 falsy，預設值不接手），一路查 `kb://{{input.path}}`
// 並真刪命中的 record，無法復原。
//
// 這支直接跑 YAML 裡 prep 節點的真實程式碼（不抄一份），並檢查 flow 結構：
// 所有會刪東西的節點都只能經 prep 的 ON_SUCCESS 到達。
import fs from 'node:fs';
import { codeOf } from './_yaml-code.mjs';

const y = fs.readFileSync(new URL('../rag-takedown-direct.local.yaml', import.meta.url).pathname, 'utf8');
const prep = new Function('input', codeOf(y, 'prep'));

let pass = 0, fail = 0;
const t = (label, cond, extra = '') => {
  cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label, extra), fail++);
};
const stops = (r) => r && r.success === false && typeof r.error === 'string' && r.error.length > 0;

// ── 該停（什麼都不准刪）──────────────────────────────────────────────
{
  const r = prep({ page_name: '加班規定', path: '{{input.path}}' });
  t('path 是未代換的 {{input.path}} ⇒ 停', stops(r), JSON.stringify(r));
  t('  訊息講明是 path', stops(r) && r.error.includes('path'), JSON.stringify(r));
}
{
  const r = prep({ page_name: '加班規定' });
  t('完全沒帶 path ⇒ 停（不再默默補 page_name.md）', stops(r) && r.error.includes('path'), JSON.stringify(r));
}
{
  const r = prep({ page_name: '加班規定', path: '   ' });
  t('path 只有空白 ⇒ 停', stops(r) && r.error.includes('path'), JSON.stringify(r));
}
{
  const r = prep({ page_name: '{{input.page_name}}', path: 'a.md' });
  t('page_name 是未代換的佔位符 ⇒ 停', stops(r) && r.error.includes('page_name'), JSON.stringify(r));
}
{
  const r = prep({ path: 'a.md' });
  t('沒帶 page_name ⇒ 停', stops(r) && r.error.includes('page_name'), JSON.stringify(r));
}
{
  const r = prep({ page_name: 'x', path: 'dir/{{input.path}}.md' });
  t('佔位符夾在路徑中間也算 ⇒ 停', stops(r), JSON.stringify(r));
}

// ── 正常觸發行為不變 ─────────────────────────────────────────────────
{
  const r = prep({ page_name: '加班規定', path: '加班規定.md', library: 'hr_docs', machine: 'm1' });
  t('正常 payload 通過', r.success === true, JSON.stringify(r));
  t('  source_uri／library／machine 照舊', r.source_uri === 'kb://加班規定.md' && r.library === 'hr_docs' && r.machine === 'm1', JSON.stringify(r));
  t('  CJK 照舊 encodeURIComponent', r.page_enc === encodeURIComponent('加班規定') && r.src_uri_enc === encodeURIComponent('kb://加班規定.md'));
}
{
  const r = prep({ page_name: 'notes', path: 'sub/notes.md' });
  t('舊版 daemon（不帶 library／machine）照舊通過', r.success === true && r.library === '' && r.machine === '', JSON.stringify(r));
}
{
  const r = prep({ page_name: 'C++ {設計}', path: 'docs/C++ {設計}.md' });
  t('單個大括號、一般符號的檔名不誤擋', r.success === true, JSON.stringify(r));
}

// ── flow 結構：刪除只能在 prep 成功之後 ───────────────────────────────
{
  const flow = [...y.matchAll(/^  - "(.+)"$/gm)].map((m) => m[1]);
  const entry = flow.filter((l) => /^input >>/.test(l));
  t('input 只連到 prep（沒有繞過 prep 的入口）',
    entry.length === 1 && entry[0] === 'input >> ON_SUCCESS >> prep', JSON.stringify(entry));
  const into = (n) => flow.filter((l) => l.endsWith('>> ' + n));
  const sources = (n) => into(n).map((l) => l.split(' >> ')[0]);
  // 往上追到 input，路上必須經過 prep、且 prep 之前不能有分叉
  const chain = (n, seen = new Set()) => {
    if (n === 'input') return true;
    if (seen.has(n)) return false;
    seen.add(n);
    const src = sources(n);
    return src.length > 0 && src.every((s) => s === 'prep' || chain(s, seen));
  };
  for (const n of ['deprecate_entry', 'deprecate_triplet']) {
    t(`${n} 只經 prep 之後到達`, chain(n), JSON.stringify(into(n)));
  }
  t('prep 的出邊是 ON_SUCCESS（失敗時不往下）', flow.includes('prep >> ON_SUCCESS >> list_dead_blocks'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
