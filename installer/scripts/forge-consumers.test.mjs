/**
 * forge-consumers.test.mjs — 『每一個讀寫舊家的地方都在清單上』（inkstone/InkStoneCo#234 驗收第一條）
 *
 * 跑法：node --test installer/scripts/forge-consumers.test.mjs
 *
 * 為什麼是測試而不是一份文件：母票 #232 的原話是「才不會切完才發現某條線還在寫舊的家」。
 * 文件清單會過期；這支每次都去數被追蹤的檔案，**新寫了一個舊址卻沒登記 ⇒ 紅**，
 * 登記了卻早就不含舊址（清單過期）⇒ 也紅。
 *
 * 範圍：git ls-files 的非 .md 檔（md 是文件，不是連線；它們提到舊址不會讓任何東西寫到舊家）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = /git\.uncle6\.me/;
const SELF = new Set(['installer/forge-consumers.json', 'installer/scripts/forge-consumers.test.mjs']);

const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'forge-consumers.json'), 'utf8'));
const STATUSES = new Set(['已換', '不必換', '待決']);

function trackedWithHost() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)
    .filter((f) => !/\.md$/i.test(f))
    .filter((f) => !SELF.has(f));
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { continue; }
    if (HOST.test(text)) hits.push(f);
  }
  return hits;
}

test('登記簿的每一列：狀態合法、理由非空、「待決」要寫清楚誰決定什麼', () => {
  const bad = [];
  for (const [file, e] of Object.entries(registry.files)) {
    if (!STATUSES.has(e.status)) bad.push(`${file}：status 不合法（${JSON.stringify(e.status)}）`);
    if (!e.reason || String(e.reason).trim().length < 4) bad.push(`${file}：沒有理由`);
    if (e.status === '待決' && (!e.decision || String(e.decision).trim().length < 6)) bad.push(`${file}：待決卻沒寫 decision（誰要決定什麼）`);
  }
  assert.deepEqual(bad, []);
});

test('被追蹤的非 md 檔裡，每一個寫著舊家網址的檔都登記了（新增一個舊址卻沒登記 ⇒ 紅）', () => {
  const unregistered = trackedWithHost().filter((f) => !(f in registry.files));
  assert.deepEqual(unregistered, [],
    '這些檔含 git.uncle6.me 卻不在 installer/forge-consumers.json：切換日會漏掉。'
    + '要嘛改讀 installer/forge.conf（installer/scripts/forge-config.mjs），要嘛登記「已換／不必換／待決」＋理由。');
});

test('登記簿不說謊：登記的檔都還在，而且都還含舊址（過期的列要刪）', () => {
  const stale = [];
  for (const file of Object.keys(registry.files)) {
    const p = join(REPO_ROOT, file);
    if (!existsSync(p)) { stale.push(`${file}：檔案不存在`); continue; }
    if (!HOST.test(readFileSync(p, 'utf8'))) stale.push(`${file}：已經不含舊址，從清單移除`);
  }
  assert.deepEqual(stale, []);
});

test('「待決」不准藏起來：把數量與清單印出來，切換前這份要歸零或有人簽收', () => {
  const pending = Object.entries(registry.files).filter(([, e]) => e.status === '待決').map(([f]) => f);
  console.log(`# 待決 ${pending.length} 處：${pending.join('、')}`);
  assert.ok(Array.isArray(pending));
});
