#!/usr/bin/env node
/**
 * compile-skills.mjs — 打包期（非 runtime）把 Arcrun registry/skills/*.md（agent skill playbook）
 * 預編成 src/skills.json + oauth-prototype/skills.json，讓安裝器 worker 裝機時能把 skills
 * 種進新實例的 kbdb（entry_type=agent-skill）——沒有這步，新實例的 AI 拿不到
 * 「怎麼寫意圖工作流」等 playbook（arcrun_get_skill 全空）。
 *
 * ⚠️ 不重寫 skill：只把 md 原文搬成 JSON（{slug, title, content}）。
 *    欄位形態（slug/title/tags/page_name=skill-{slug}）逐字對齊
 *    Arcrun repo scripts/sync-registry-to-kbdb.py（單一真相源，別另立格式）。
 *
 * 手法比照同目錄 compile-workflows.mjs（workflows/*.local.yaml → workflows.json）。
 *
 * 用法：
 *   SKILLS_DIR=/path/to/arcrun/registry/skills node installer/scripts/compile-skills.mjs
 *   （skills 住在 Arcrun repo，不在本 repo；未設 SKILLS_DIR 時嘗試 InkStoneCo 慣例相對位置）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ragRoot = join(here, '..', '..'); // arcrun-rag repo 根

// skills 真身在 Arcrun repo。候選：env 指定 > InkStoneCo 慣例佈局（products/arcrun-rag ↔ matrix/arcrun）
const candidates = [
  process.env.SKILLS_DIR,
  join(ragRoot, '..', '..', 'matrix', 'arcrun', 'registry', 'skills'),
  join(ragRoot, '..', 'arcrun', 'registry', 'skills'),
].filter(Boolean);
const skillsDir = candidates.find((p) => existsSync(p));
if (!skillsDir) {
  console.error('找不到 skills 目錄。請設 SKILLS_DIR=<arcrun repo>/registry/skills');
  process.exit(1);
}

// README.md 是給人看的目錄說明，不 seed；其餘（含 INDEX.md）全 seed。
const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
const out = files.map((f) => {
  const slug = f.replace(/\.md$/, '');
  const content = readFileSync(join(skillsDir, f), 'utf8');
  // title＝第一個 "# " 標題（對齊 sync-registry-to-kbdb.py 的抽法），沒有就用 slug
  let title = slug;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) { title = t.slice(2).trim(); break; }
  }
  return { slug, title, content };
});

const json = JSON.stringify(out, null, 2) + '\n';
const outPath = join(here, '..', 'src', 'skills.json');
// oauth-prototype/worker.js 直接 import ./skills.json，需同步更新（比照 workflows.json 雙寫）
const outPathProto = join(here, '..', 'oauth-prototype', 'skills.json');
writeFileSync(outPath, json, 'utf8');
writeFileSync(outPathProto, json, 'utf8');
console.log(`✓ 編出 ${out.length} 支 skill → ${outPath} + ${outPathProto}`);
for (const s of out) console.log(`  · ${s.slug.padEnd(36)} ${s.content.length} chars`);
