#!/usr/bin/env node
/**
 * env-parity-gate.test.mjs — 環境對等閘**自己**的演練（D90）
 *
 * 跑法：node --test installer/scripts/env-parity-gate.test.mjs
 *
 * 為什麼這份特別重要：`copy-contract.test.mjs` 那份文案閘就是**沒人跑**，
 * 於是從來沒擋過任何東西（見 ship.mjs 的 (b5) 註解）。閘要有牙齒，
 * 就必須有人餵它「該擋的」與「不該擋的」兩種輸入——只驗一邊的閘不算驗過。
 *
 * 這份測試分四組：
 *   ①「該擋的」——每一種行為差異都要真的被抓到
 *   ②「不該擋的」——這道閘之前失敗過兩次的那兩種假警報，各鎖一條
 *   ③ 豁免機制——完整的放行，缺欄位／過期／對不到差異的一律擋
 *   ④ 真檔回歸——本 repo 現況（三份設定）必須全過，掃到 0 對必須失敗
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareEnv, diffVars, diffBindings, resolveEnv, isIdentityShaped, bindingKeyField,
  stripJsonComments, parseWranglerConfig, findConfigs, runGate, applyWaivers, runSelfTest, REPO_ROOT,
} from './env-parity-gate.mjs';

/** 最小可用的設定骨架：兩邊都宣告了不可繼承的鍵，所以基準線是乾淨的。 */
const base = () => ({
  name: 'w',
  main: 'worker.js',
  compatibility_date: '2026-01-01',
  vars: { A: 'https://prod.example.com' },
  kv_namespaces: [{ binding: 'KV', id: 'aaaaaaaaaaaaaaaa' }],
  env: {
    staging: {
      name: 'w-staging',
      vars: { A: 'https://stage.example.com' },
      kv_namespaces: [{ binding: 'KV', id: 'bbbbbbbbbbbbbbbb' }],
    },
  },
});
const keys = (r) => r.problems.map((p) => p.key).sort();

// ═══════════════════════════════════════════════════════════════════════════
// ① 該擋的
// ═══════════════════════════════════════════════════════════════════════════

test('擋：compatibility_flags 只加在 stage（D90 的觸發點，2026-08-14 實撞）', () => {
  const c = base();
  c.env.staging.compatibility_flags = ['global_fetch_strictly_public'];
  const r = compareEnv(c, 'staging');
  assert.equal(r.ok, false);
  assert.deepEqual(keys(r), ['compatibility_flags']);
  // 訊息要讓人知道兩邊各是什麼，不是只說「不一致」
  assert.match(r.problems[0].detail, /prod ＝ （沒有這個設定）/);
  assert.match(r.problems[0].detail, /global_fetch_strictly_public/);
});

test('擋：compatibility_date 不一樣（相容性設定＝行為）', () => {
  const c = base();
  c.env.staging.compatibility_date = '2026-08-01';
  assert.deepEqual(keys(compareEnv(c, 'staging')), ['compatibility_date']);
});

test('擋：程式進入點不一樣（main＝程式路徑）', () => {
  const c = base();
  c.env.staging.main = 'worker-stage.js';
  assert.deepEqual(keys(compareEnv(c, 'staging')), ['main']);
});

test('擋：cron 與 observability 不一樣（重試逾時參數／功能開關一族）', () => {
  const c = base();
  c.triggers = { crons: ['*/2 * * * *'] };
  c.observability = { enabled: true };
  c.env.staging.triggers = { crons: ['*/30 * * * *'] };
  c.env.staging.observability = { enabled: false };
  assert.deepEqual(keys(compareEnv(c, 'staging')), ['observability.enabled', 'triggers.crons']);
});

test('擋：binding 集合不同（資源形狀＝行為，少一顆＝另一邊讀到 undefined）', () => {
  const c = base();
  c.env.staging.kv_namespaces = [
    { binding: 'KV', id: 'bbbbbbbbbbbbbbbb' },
    { binding: 'EXTRA_KV', id: 'cccccccccccccccc' },
  ];
  const r = compareEnv(c, 'staging');
  assert.deepEqual(keys(r), ['kv_namespaces']);
  assert.match(r.problems[0].detail, /EXTRA_KV/);
});

test('擋：binding 裡的 class_name 不同（指到程式碼＝行為，不是 id）', () => {
  const r = diffBindings('durable_objects', 'name',
    [{ name: 'DO', class_name: 'Room', script_name: 'w' }],
    [{ name: 'DO', class_name: 'RoomV2', script_name: 'w-staging' }]);
  assert.deepEqual(r.problems.map((p) => p.key), ['durable_objects[DO].class_name']);
  // script_name 是身分（DO 寄居在哪顆 worker）⇒ 同一次比對裡要被放行
  assert.equal(r.identityDiffs.length, 1);
  assert.match(r.identityDiffs[0], /script_name/);
});

test('擋：var 只有單邊有（另一邊那條程式路徑吃到 undefined）', () => {
  const c = base();
  c.env.staging.vars.FEATURE_X = 'on';
  assert.deepEqual(keys(compareEnv(c, 'staging')), ['vars.FEATURE_X']);
});

test('擋：var 的值長得像開關（"true" vs "false"）', () => {
  const r = diffVars({ EMAIL_ENABLED: 'true' }, { EMAIL_ENABLED: 'false' });
  assert.deepEqual(r.problems.map((p) => p.key), ['vars.EMAIL_ENABLED']);
});

test('擋：不可繼承的鍵只宣告在頂層（wrangler 各版本處置變過，不准靠它）', () => {
  const c = base();
  delete c.env.staging.vars;      // vars 不可繼承 ⇒ staging 這邊會是空的
  const r = compareEnv(c, 'staging');
  assert.ok(keys(r).includes('vars'), `應該報 vars，實際：${keys(r)}`);
  assert.match(r.problems.find((p) => p.key === 'vars').why, /不可繼承/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 不該擋的——這道閘之前失敗過的兩種假警報，各鎖一條
// ═══════════════════════════════════════════════════════════════════════════

test('放行（第一版的錯）：頂層宣告、env 沒宣告的**可繼承**鍵不是差異', () => {
  const c = base();                       // main／compatibility_date 只寫在頂層
  const r = compareEnv(c, 'staging');
  assert.equal(r.ok, true, `不該有問題，實際：${JSON.stringify(r.problems)}`);
  const { config } = resolveEnv(c, 'staging');
  assert.equal(config.main, 'worker.js');
  assert.equal(config.compatibility_date, '2026-01-01');
});

test('放行（第二版的錯）：KV namespace id 與各種 *_BASE 網址是身分', () => {
  const c = base();
  c.vars = { LANDING_BASE: 'https://a.example.com', BUNDLE_BASE: 'https://b.example.com/x' };
  c.env.staging.vars = { LANDING_BASE: 'https://c.workers.dev', BUNDLE_BASE: 'https://d.uncle6.me/y' };
  const r = compareEnv(c, 'staging');
  assert.equal(r.ok, true, `不該有問題，實際：${JSON.stringify(r.problems)}`);
  assert.equal(r.identityDiffs.length, 4); // name + KV id + 兩個網址
});

test('放行：worker 名稱、對外網址、環境標記（D90 明列的四類身分）', () => {
  const c = base();
  c.routes = [{ pattern: 'x.example.com/*', zone_name: 'example.com' }];
  c.env.staging.routes = [];
  c.env.staging.workers_dev = true;
  c.env.staging.vars.DEPLOY_ENV = 'staging';
  assert.equal(compareEnv(c, 'staging').ok, true);
});

test('放行：跟著身分值走的 var（BUNDLE_BUILT 跟著 BUNDLE_BASE 的釘點）', () => {
  const r = diffVars(
    { BUNDLE_BASE: 'https://cdn.example.com/@aaa', BUNDLE_BUILT: '2026-08-01' },
    { BUNDLE_BASE: 'https://git.example.com/@bbb', BUNDLE_BUILT: '2026-08-14' });
  assert.deepEqual(r.problems, [], '這是出貨視窗裡的正常狀態，響了就是永遠在響');
  assert.equal(r.identityDiffs.length, 2);
});

test('身分形狀的判準：網址／長 hex／環境標記算，開關值與版本號不算', () => {
  for (const v of ['https://a.b/c', 'ab12cd34ef567890', 'staging', 'PROD'])
    assert.equal(isIdentityShaped(v), true, `${v} 應該算身分形狀`);
  for (const v of ['true', 'false', '3', '1.4.45', 'gemma-4-31b-it', 'deadbeef', ''])
    assert.equal(isIdentityShaped(v), false, `${v} 不該算身分形狀`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 豁免（D90：真的需要行為差異 ⇒ 必須有日期、理由、解除條件）
// ═══════════════════════════════════════════════════════════════════════════

const waivedCase = () => {
  const c = base();
  c.env.staging.compatibility_flags = ['x'];
  return [compareEnv(c, 'staging', 'a/wrangler.toml')];
};
const full = { 檔案: 'a/wrangler.toml', 鍵: 'compatibility_flags', 到期: '2099-01-01', 理由: 'r', 解除條件: 'c' };

test('豁免：欄位齊全且未過期 ⇒ 放行，但要在報告上留痕', () => {
  const r = applyWaivers(waivedCase(), [full], '2026-08-14');
  assert.deepEqual(r.problems, []);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].waived.length, 1);
});

test('豁免：缺任何一個欄位都不收（那不是豁免，是藉口）', () => {
  for (const f of ['到期', '理由', '解除條件']) {
    const w = { ...full }; delete w[f];
    const r = applyWaivers(waivedCase(), [w], '2026-08-14');
    assert.equal(r.problems.length, 1, `缺 ${f} 應該被擋`);
    assert.match(r.problems[0], new RegExp(f));
    assert.equal(r.results[0].ok, false, `缺 ${f} 時原本的差異必須照樣擋著`);
  }
});

test('豁免：過期不自動續期', () => {
  const r = applyWaivers(waivedCase(), [{ ...full, 到期: '2026-08-13' }], '2026-08-14');
  assert.match(r.problems[0], /豁免過期/);
  assert.equal(r.results[0].ok, false);
});

test('豁免：對不到任何差異＝殭屍，要刪掉（不然下次真的出現差異會被安靜放行）', () => {
  const c = base();                                   // 沒有任何行為差異
  const r = applyWaivers([compareEnv(c, 'staging', 'a/wrangler.toml')], [full], '2026-08-14');
  assert.match(r.problems[0], /對不到任何差異/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 真檔回歸
// ═══════════════════════════════════════════════════════════════════════════

test('JSONC：註解與尾逗號剝得掉（installer/wrangler.jsonc 是這個格式）', () => {
  const o = JSON.parse(stripJsonComments('{\n // a\n "x": "//not-a-comment", /* b */ "y": [1,2,],\n}'));
  assert.deepEqual(o, { x: '//not-a-comment', y: [1, 2] });
});

test('真檔：本 repo 掃得到 wrangler 設定，且宣告 env 的那幾份都比得動', () => {
  const files = findConfigs(REPO_ROOT);
  assert.ok(files.includes(join('installer', 'oauth-prototype', 'wrangler.toml')), `實際掃到：${files}`);
  assert.ok(files.includes(join('landing', 'wrangler.toml')));
  assert.ok(files.includes(join('docs-site', 'wrangler.toml')));
  // 產生出來的公開鏡像（.github-public）不該被掃進來，不然同一件事會被報兩次
  assert.equal(files.filter((f) => f.startsWith('.github-public')).length, 0);
  assert.ok(parseWranglerConfig(join(REPO_ROOT, 'installer', 'oauth-prototype', 'wrangler.toml')).env.staging);
});

test('真檔：現況全過——prod 與 stage 的差異全部落在身分白名單裡（D90 基準線）', () => {
  // selfTest:false ＝ 別在自己的測試裡再 spawn 一次自己（那一路由 runSelfTest 的環境變數擋著，
  // 這裡只是不要白跑一次）。
  const g = runGate(REPO_ROOT, { today: '2026-08-14', selfTest: false });
  const bad = g.sections.filter((s) => !s.ok);
  assert.deepEqual(bad.map((s) => `${s.name}\n${s.problems.join('\n')}`), [], '現況不該有行為差異');
  assert.ok(g.pairs >= 3, `至少要比到 installer／landing／docs-site 三對，實際 ${g.pairs}`);
});

test('假綠防護：一對都沒比到 ⇒ 失敗（掃描範圍設錯比壞掉更糟）', () => {
  const g = runGate(REPO_ROOT, { configs: [], selfTest: false });
  assert.equal(g.ok, false);
  assert.equal(g.pairs, 0);
  assert.match(g.sections.map((s) => s.problems.join('\n')).join('\n'), /一對 prod／stage 都沒比到/);
});

test('閘自己的演練：遞迴保險有效（不然出貨時會無限往下 spawn）', () => {
  const prev = process.env.ENV_PARITY_GATE_SELFTEST;
  process.env.ENV_PARITY_GATE_SELFTEST = '1';
  try {
    const r = runSelfTest(REPO_ROOT);
    assert.equal(r.ok, true);
    assert.match(r.note, /不遞迴/);
  } finally {
    if (prev === undefined) delete process.env.ENV_PARITY_GATE_SELFTEST; else process.env.ENV_PARITY_GATE_SELFTEST = prev;
  }
});

test('真檔＋反向演練：把 prod 的 compatibility_flags 拿掉 ⇒ 這道閘要當場擋下', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-parity-'));
  const src = parseWranglerConfig(join(REPO_ROOT, 'installer', 'oauth-prototype', 'wrangler.toml'));
  assert.ok(src.compatibility_flags?.length, 'prod 現在應該有 flag（D90 修過了）；沒有的話這條演練沒意義');
  delete src.compatibility_flags;                        // 退回 2026-08-14 那個實撞狀態
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(src));
  const g = runGate(dir);
  assert.equal(g.ok, false);
  assert.match(g.sections[0].problems.join('\n'), /compatibility_flags/);
});
