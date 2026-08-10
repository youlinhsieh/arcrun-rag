#!/usr/bin/env node
/**
 * compile-migrations.mjs — 打包期把 Arcrun kbdb 的 D1 migration（0001_base.sql +
 * 0002_credentials.sql）預切成「單語句陣列」→ installer/src/migrations.json。
 *
 * 為何要預切：安裝器 worker 走自己的 D1 binding（TEST_D1）跑 migration（設計指定的唯一
 *   「安裝器直碰 D1」例外＝建表）。D1 binding 的 prepare().run() 一次一句，不吃註解/多語句檔；
 *   故此處剝 `--` 註解、依 `;` 切句，worker 端逐句 run（全 IF NOT EXISTS / INSERT OR IGNORE → 冪等）。
 *
 * 來源：ARCRUN_REPO_ROOT/kbdb/migrations/*.sql（與 deploy.ts applyD1Migration 同源，不重寫 schema）。
 * 用法：ARCRUN_REPO_ROOT=/path/to/Arcrun node installer/scripts/compile-migrations.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'migrations.json');

function findArcrunRoot() {
  if (process.env.ARCRUN_REPO_ROOT) return process.env.ARCRUN_REPO_ROOT;
  // 常見相對位置：arcrun-rag 與 Arcrun 並列
  for (const c of [join(here, '..', '..', '..', 'Arcrun'), join(here, '..', '..', '..', '..', 'Arcrun')]) {
    if (existsSync(join(c, 'kbdb', 'migrations'))) return c;
  }
  throw new Error('找不到 Arcrun repo；請設 ARCRUN_REPO_ROOT');
}

/** 剝 -- 行註解，依 ; 切句，去空白句。字串常值裡沒有 ; 或 --（這兩份 migration 已確認），故簡單切法安全。 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))          // 剝行尾/整行註解
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const root = findArcrunRoot();
const files = ['0001_base.sql', '0002_credentials.sql'];
const statements = [];
for (const f of files) {
  const p = join(root, 'kbdb', 'migrations', f);
  const stmts = splitStatements(readFileSync(p, 'utf8'));
  for (const s of stmts) statements.push(s);
  console.log(`  · ${f} → ${stmts.length} 句`);
}

writeFileSync(outPath, JSON.stringify({ source: files, statements }, null, 2) + '\n', 'utf8');
console.log(`✓ 共 ${statements.length} 句 → ${outPath}`);
