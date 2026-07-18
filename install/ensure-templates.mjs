#!/usr/bin/env node
// ensure-templates — arcrun-rag 包的 KBDB template 建立（冪等，走 API，零 SQL）
//
// 血統：kbdb-graph-plugin src/lib/templates.ts 的 ensurePluginTemplates()——
//   Mira 實例的 triplet/entity/entity_pending 三個「虛擬表」schema，slots 全對齊，
//   讓包裝出來的庫與 leo 實例同構（未來 graph plugin／精耕直接相容）。
// 用法：node ensure-templates.mjs [kbdb_base]（預設 http://127.0.0.1:8787）

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

// slots 逐字對齊 kbdb-graph-plugin/src/lib/templates.ts（TPL_TRIPLET/ENTITY/ENTITY_PENDING）
const TEMPLATES = [
  {
    name: 'triplet',
    slots: [
      'subject', 'predicate', 'object', 'source_block_id',
      'confidence', 'clusters_json', 'bridge_score',
      'subject_entity_type', 'object_entity_type',
      'status', 'superseded_by', 'source_uri', 'content_hash', 'source_anchor',
      'predicate_embed',
    ],
    description: 'knowledge graph triplet (S-P-O)',
  },
  {
    name: 'entity',
    slots: ['canonical', 'aliases_json', 'entity_type', 'owner', 'gloss', 'embed', 'node_id'],
    description: 'normalized entity (canonical + aliases)',
  },
  {
    name: 'entity_pending',
    slots: ['raw_name', 'candidate_entity_id', 'candidate_canonical', 'similarity'],
    description: 'pending entity alias for review',
  },
];

let fail = 0;
for (const t of TEMPLATES) {
  // 先查存在（冪等：已存在就跳過，不覆寫）
  const probe = await fetch(`${base}/templates/${encodeURIComponent(t.name)}`);
  if (probe.ok) { console.log(`= template ${t.name} 已存在，跳過`); continue; }
  const res = await fetch(`${base}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  const j = await res.json().catch(() => null);
  if (res.ok) console.log(`✓ template ${t.name} 建立`);
  else { fail++; console.error(`✗ template ${t.name} → HTTP ${res.status} ${JSON.stringify(j).slice(0, 150)}`); }
}
process.exit(fail ? 1 : 0);
