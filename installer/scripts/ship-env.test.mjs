/**
 * ship-env.test.mjs — 出貨線自取認證（inkstone/InkStoneCo#249 第 3 格）。
 * 跑法：node --test installer/scripts/ship-env.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareShipEnv, artifactsGitEnv, ahubTokenFile, ARTIFACTS_CF_TOKEN_NAME } from './ship-env.mjs';

const ORIGIN = 'https://' + 'a'.repeat(32) + '.artifacts.cloudflare.net';
const gitCfg = `credential.${ORIGIN}.helper /x/git-credential-artifacts\ncredential.${ORIGIN}/git/InkStoneCo/ISEP.git.helper /y/other`;
const runner = (out) => () => ({ status: 0, out });
const noFill = () => ({ resolved: [], missing: [ARTIFACTS_CF_TOKEN_NAME], searched: ['a', 'b'] });

test('① ahub 模式：shell 沒給 ⇒ 自檔案取 AHUB_TOKEN；值不在說明裡', () => {
  const env = {};
  const { lines } = prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'ahub', home: '/h', readFile: () => 'SECRET-VALUE\n', runner: runner(''), fill: noFill });
  assert.equal(env.AHUB_TOKEN, 'SECRET-VALUE');
  assert.ok(!lines.join('\n').includes('SECRET-VALUE'));
  assert.match(lines.join('\n'), /ahub-token/);
});

test('② 操作者給的值永遠贏：不讀檔、不覆蓋', () => {
  const env = { AHUB_TOKEN: 'MINE' };
  prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'ahub', readFile: () => { throw new Error('不該讀'); }, runner: runner(''), fill: noFill });
  assert.equal(env.AHUB_TOKEN, 'MINE');
  const e2 = { TICKET_FORGE_TOKEN: 't' };
  prepareShipEnv({ env: e2, repoRoot: '/r', forgeKind: 'ahub', readFile: () => { throw new Error('不該讀'); }, runner: runner(''), fill: noFill });
  assert.equal(e2.AHUB_TOKEN, undefined);
});

test('③ 取不到就不動、不丟（斷點留給 preflight）', () => {
  const env = {};
  const { lines } = prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'ahub', readFile: () => { throw new Error('ENOENT'); }, runner: runner(''), fill: noFill });
  assert.equal(env.AHUB_TOKEN, undefined);
  assert.match(lines.join('\n'), /沒有取到/);
});

test('④ gitea 模式：不碰 AHub 權杖、不找 Artifacts 金鑰', () => {
  const env = {};
  prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'gitea', readFile: () => 'X', runner: runner(''), fill: () => { throw new Error('不該找'); } });
  assert.equal(env.AHUB_TOKEN, undefined);
});

test('⑤ Artifacts 金鑰從 .env 補進 env（fill 注入）', () => {
  const env = {};
  const fill = (names, o) => { o.env[names[0]] = 'CF'; return { resolved: [{ name: names[0], source: '/top/.env' }], missing: [], searched: [] }; };
  prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'ahub', readFile: () => 'T', runner: runner(''), fill });
  assert.equal(env[ARTIFACTS_CF_TOKEN_NAME], 'CF');
});

test('⑥ git：只取「網域層」helper（路徑層不算），先清空再指定，寫成 GIT_CONFIG_*', () => {
  const env = {};
  prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'gitea', home: '/h', runner: runner(gitCfg) });
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, `credential.${ORIGIN}.helper`);
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_VALUE_1, '/x/git-credential-artifacts');
  assert.match(env.CLAUDE_PROJECT_DIR, /InkStoneCo$/);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('⑦ git：不蓋掉既有的 GIT_CONFIG_*（往後接）', () => {
  const o = artifactsGitEnv([{ origin: ORIGIN, helper: 'h' }], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_VALUE_0: 'v' });
  assert.equal(o.GIT_CONFIG_COUNT, '3');
  assert.equal(o.GIT_CONFIG_KEY_0, 'k');
  assert.equal(o.GIT_CONFIG_VALUE_2, 'h');
});

test('⑧ 沒有 helper 設定 ⇒ 不動 env', () => {
  const env = {};
  const { lines } = prepareShipEnv({ env, repoRoot: '/r', forgeKind: 'gitea', runner: runner('') });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.match(lines.join('\n'), /沒有 Artifacts 的 credential helper/);
});

test('⑨ 權杖檔位置：AHUB_TOKEN_FILE 蓋過，否則 <state>/isep-forge/ahub-token', () => {
  assert.equal(ahubTokenFile({ AHUB_TOKEN_FILE: '/z' }, '/h'), '/z');
  assert.equal(ahubTokenFile({}, '/h'), '/h/.local/state/isep-forge/ahub-token');
});
