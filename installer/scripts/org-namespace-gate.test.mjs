/**
 * org-namespace-gate.test.mjs — 出貨線與安裝器不准指回 Leo/（inkstone/InkStoneCo#98 c7795）
 *
 * 跑法：node --test installer/scripts/org-namespace-gate.test.mjs
 *
 * 兩半：① 閘本身該擋／不該擋的輸入 ② **真的 repo**：被追蹤的非 md 檔裡，
 * 執行路徑上沒有任何 `git.uncle6.me/Leo/…`——有人改回去，這支就紅。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { checkTargets, checkText, runtimeProblems, isCommentLine } from './org-namespace-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── ① 閘本身 ────────────────────────────────────────────────────────────────

test('登錄簿：bundles.remote／pin／delivery 指 Leo/ 一律擋（owner 不分大小寫）', () => {
  const cfg = { targets: { stage: {
    bundles: { remote: 'git.uncle6.me/Leo/arcrun-rag-bundles-staging' },
    pin: { template: 'https://git.uncle6.me/leo/arcrun-rag-bundles-staging/raw/commit/{sha7}' },
    delivery: { movingPointer: 'https://git.uncle6.me/LEO/x/raw/branch/main/manifest.json' },
  } } };
  assert.equal(checkTargets(cfg).length, 3);
});

test('登錄簿：ssh 形式與 Gitea repoSlug 指 Leo/ 也擋', () => {
  const cfg = { a: { remote: 'git@git.uncle6.me:Leo/arcrun-rag.git' },
    rr: { host: 'gitea', repoSlug: 'Leo/arcrun-rag' } };
  assert.deepEqual(checkTargets(cfg).map((h) => h.path).sort(), ['a.remote', 'rr.repoSlug']);
});

test('登錄簿：指 inkstone／GitHub 的 Leo 同名 slug／說明欄裡的歷史票號，都不擋', () => {
  const cfg = { targets: { stage: {
    _: ['Leo/arcrun-rag#79 第一個驗收條件', 'git.uncle6.me/Leo/arcrun-rag-bundles-staging 是舊址'],
    bundles: { remote: 'git.uncle6.me/inkstone/arcrun-rag-bundles-staging' },
    releaseRecord: { host: 'github', repoSlug: 'leo/something' },
    note: '這張票是 Leo/Arcrun#97',
  } } };
  assert.deepEqual(checkTargets(cfg), []);
});

test('文字檔：註解行不算，設定行算', () => {
  const toml = [
    '# 舊址 https://git.uncle6.me/Leo/arcrun-rag-bundles-staging（已改）',
    'BUNDLE_BASE = "https://git.uncle6.me/Leo/arcrun-rag-bundles-staging/raw/commit/3814773"',
    'OTHER = "https://git.uncle6.me/inkstone/arcrun-rag-bundles-staging/raw/commit/3814773"',
  ].join('\n');
  const hits = checkText(toml);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(isCommentLine('   // x'), true);
  assert.equal(isCommentLine(' * x'), true);
  assert.equal(isCommentLine('const a = 1; // x'), false);
});

test('runtimeProblems：登錄簿乾淨但 wrangler.toml 指 Leo/（youlin-stage 手部署那種）照樣擋', () => {
  const files = {
    [join('/r', 'installer', 'oauth-prototype', 'wrangler.toml')]:
      '[env.youlin-stage.vars]\nBUNDLE_BASE = "https://git.uncle6.me/Leo/arcrun-rag-bundles-staging/raw/commit/a40af26"\n',
    [join('/r', 'installer', 'oauth-prototype', 'worker.js')]: "const X = 'https://git.uncle6.me/inkstone/y';\n",
  };
  const p = runtimeProblems('/r', { targets: {} }, (f) => files[f]);
  assert.equal(p.length, 1);
  assert.match(p[0], /wrangler\.toml:2/);
});

// ── ② 真的 repo ─────────────────────────────────────────────────────────────

test('真的登錄簿＋安裝器設定：ship.mjs 開跑時的檢查是乾淨的', () => {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
  assert.deepEqual(runtimeProblems(REPO_ROOT, cfg), []);
});

/**
 * 全 repo 掃描的例外——每一條都要寫理由。
 * · github-publish-sanitize.py：它本身就是「擋讀者被帶去 Leo/arcrun-rag」的檢查器，
 *   那串網址是它要抓的樣本，不是它要連的地方。
 * · system-dev/：system-dev-template 的套件本體（由上游 template 發佈、不是出貨線），
 *   它的 `Leo/system-dev-template` 另案處理（inkstone 那份匿名讀 404，照改會壞掉安裝）。
 */
const ALLOW = [
  /^scripts\/github-publish-sanitize\.py$/,
  /^system-dev\//,
];

test('真的 repo：被追蹤的非 md 檔，執行路徑上沒有 git.uncle6.me/Leo/', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => !/\.md$/i.test(f))
    .filter((f) => !ALLOW.some((re) => re.test(f)))
    .filter((f) => /\.(m?js|cjs|ts|json|jsonc|toml|ya?ml|sh|py|go|html)$/i.test(f));
  const problems = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { continue; }
    if (!/uncle6\.me/i.test(text)) continue;
    if (f.endsWith('.json')) {
      try { for (const h of checkTargets(JSON.parse(text))) problems.push(`${f} → ${h.path} = ${h.value}`); continue; }
      catch { /* 不是合法 JSON，就當文字掃 */ }
    }
    for (const h of checkText(text)) problems.push(`${f}:${h.line} → ${h.text}`);
  }
  // 本檔自己的樣本字串用來證明閘會擋，排除
  const mine = 'installer/scripts/org-namespace-gate.test.mjs';
  assert.deepEqual(problems.filter((p) => !p.startsWith(mine)), [],
    '有人把出貨線／安裝器改回 Leo/——一律指 inkstone org（inkstone/InkStoneCo#98 c7795）');
});
