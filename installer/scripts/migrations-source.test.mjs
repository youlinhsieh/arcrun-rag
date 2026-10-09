// node --test installer/scripts/migrations-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMigrationSourceRoot, assertMigrationsComplete } from './migrations-source.mjs';

function arcrun(files) {
  const d = mkdtempSync(join(tmpdir(), 'arc-'));
  mkdirSync(join(d, 'kbdb', 'migrations'), { recursive: true });
  for (const f of files) writeFileSync(join(d, 'kbdb', 'migrations', f), '-- x');
  return d;
}
function installer(source) {
  const d = mkdtempSync(join(tmpdir(), 'inst-'));
  writeFileSync(join(d, 'migrations.json'), JSON.stringify({ source }));
  return d;
}

test('有 shipRoot（worktree）時，ARCRUN_REPO_ROOT 指到 main 也不准用 ⇒ 閘讀 worktree', () => {
  const main = arcrun(['0001_a.sql', '0013_b.sql']);
  const wt = arcrun(['0001_a.sql', '0013_b.sql', '0014_card_write_trim.sql']);
  const r = resolveMigrationSourceRoot({ shipRoot: wt, env: { ARCRUN_REPO_ROOT: main } });
  assert.equal(r.root, wt);
  assert.match(r.note, /忽略 ARCRUN_REPO_ROOT/);
});

test('1.4.88 事故重現：安裝器只到 0013、worktree 有 0014 ⇒ 閘擋下（改前用 main 會誤綠）', () => {
  const main = arcrun(['0001_a.sql', '0013_b.sql']);
  const wt = arcrun(['0001_a.sql', '0013_b.sql', '0014_card_write_trim.sql']);
  const inst = installer(['0001_a.sql', '0013_b.sql']);
  assert.doesNotThrow(() => assertMigrationsComplete(inst, main)); // 舊行為：假綠
  const { root } = resolveMigrationSourceRoot({ shipRoot: wt, env: { ARCRUN_REPO_ROOT: main } });
  assert.throws(() => assertMigrationsComplete(inst, root), /0014_card_write_trim\.sql/);
});

test('安裝器帶齊 ⇒ 通過', () => {
  const wt = arcrun(['0001_a.sql', '0014_c.sql']);
  assert.match(assertMigrationsComplete(installer(['0001_a.sql', '0014_c.sql']), wt)[0], /全部 2 支/);
});

test('沒有 shipRoot 時維持舊行為：env 優先，其次 fallbacks', () => {
  const a = arcrun(['0001_a.sql']);
  assert.equal(resolveMigrationSourceRoot({ env: { ARCRUN_REPO_ROOT: '/x' }, fallbacks: [a] }).root, '/x');
  assert.equal(resolveMigrationSourceRoot({ env: {}, fallbacks: ['/nope', a] }).root, a);
});

// ── inkstone/Arcrun#293 c18365：安裝器世代探針表要跟 Arcrun 同步 ──────────────────────
import { assertGenerationChecksInSync, extractGenerationChecks } from './migrations-source.mjs';
import { dirname as dn } from 'node:path';

function arcWithGen(tsText) {
  const d = mkdtempSync(join(tmpdir(), 'arcgen-'));
  mkdirSync(join(d, 'kbdb', 'src', 'actions'), { recursive: true });
  writeFileSync(join(d, 'kbdb', 'src', 'actions', 'schema-generation.ts'), tsText);
  return d;
}
function instWithGen(js) {
  const d = mkdtempSync(join(tmpdir(), 'instgen-'));
  writeFileSync(join(d, 'worker.js'), 'x\nconst GENERATION_CHECKS = [\n' + js);
  return d;
}
const TS = "{\n    n: 1,\n    what: 'a',\n    checks: [{ kind: 'table', name: 'entries' }],\n  },\n  {\n    n: 2,\n    checks: [{ kind: 'trigger', name: 'v2' }],\n  },";

test('世代表：安裝器少一代 ⇒ 擋下（1.4.88 事故形狀）', () => {
  const a = arcWithGen(TS);
  const i = instWithGen("{ n: 1, checks: [{ kind: 'table', name: 'entries' }] },\n];");
  assert.throws(() => assertGenerationChecksInSync(i, a), /第 2 代.*沒有/);
});
test('世代表：指紋不同 ⇒ 擋下；一致 ⇒ 通過', () => {
  const a = arcWithGen(TS);
  const bad = instWithGen("{ n: 1, checks: [{ kind: 'table', name: 'entries' }] },\n{ n: 2, checks: [{ kind: 'trigger', name: 'other' }] },\n];");
  assert.throws(() => assertGenerationChecksInSync(bad, a), /第 2 代：指紋不同/);
  const ok = instWithGen("{ n: 1, checks: [{ kind: 'table', name: 'entries' }] },\n{ n: 2, checks: [{ kind: 'trigger', name: 'v2' }] },\n];");
  assert.match(assertGenerationChecksInSync(ok, a)[0], /共 2 代/);
});
test('世代表：對真的 Arcrun 1.4.88 候選與目前 worker.js ⇒ 一致', (t) => {
  const real = process.env.ARCRUN_REPO_ROOT;
  if (!real) return t.skip('設 ARCRUN_REPO_ROOT 才跑');
  const here = dn(new URL(import.meta.url).pathname);
  assert.match(assertGenerationChecksInSync(join(here, '..', 'oauth-prototype'), real)[0], /一致/);
});
