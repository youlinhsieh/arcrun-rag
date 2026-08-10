#!/usr/bin/env node
/**
 * verify-manifest.mjs — 機械閘：擋「內容變了但版本沒跟上」的 bundle 出貨
 *
 * leo 2026-08-02：「這個更新版本請做成自動化，不依賴你記得去更新」
 * ⇒ build 腳本自動算版本（release.mjs）是第一層；**這支是第二層**——
 *   萬一有人繞過 build 腳本手改檔案、或未來新增第三條 build 路徑忘了接，
 *   這支會在出貨前擋下來，而不是等 leo 在前端看到假版本號才發現。
 *
 * 用法：
 *   node installer/scripts/verify-manifest.mjs <bundles目錄>
 * 退出碼：0＝通過；1＝有問題（印出每一條）。可直接掛 pre-commit / ship 腳本。
 */
import { verifyManifest } from './release.mjs';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node installer/scripts/verify-manifest.mjs <bundles目錄>');
  process.exit(2);
}

const repoRoot = join(import.meta.dirname, '..', '..');
const problems = verifyManifest(dir, { repoRoot });

if (problems.length) {
  console.error('❌ bundle manifest 驗證失敗，拒絕出貨：\n');
  for (const p of problems) console.error(`   • ${p}`);
  console.error('\n修法：重跑 build 腳本（會自動 syncManifest），或直接跑：');
  console.error(`   node -e "import('${join(import.meta.dirname, 'release.mjs')}').then(m=>m.syncManifest('${dir}',{repoRoot:'${repoRoot}'}))"`);
  process.exit(1);
}

const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
console.log(`✅ manifest 驗證通過｜版本 ${m.release}｜${m.core.length} 顆｜built ${m.built}`);
