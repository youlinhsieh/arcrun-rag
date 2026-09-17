/**
 * secret-redact.test.mjs — 出貨線印出去的字不准帶金鑰（inkstone/arcrun-rag#202 c7599）。
 *
 * 跑法：node --test installer/scripts/secret-redact.test.mjs
 *
 * 該遮：
 *   ① 09-17 實洩那一行的形狀：execFileSync 錯誤訊息裡的 `extraheader=Authorization: Basic <b64>`
 *   ② 網址內嵌帳密 `https://帳號:權杖@host`
 *   ③ 形狀認不出來、但字串就是環境變數裡那把鑰匙（含它的 Basic base64）
 *   ④ 真的讓 git 失敗一次：用 GIT_CONFIG_* 帶標頭時，錯誤訊息裡**本來就沒有**金鑰
 *   ⑤ console 出口：包起來之後印出去的字已遮
 * 不該遮（誤傷會讓人看不懂出貨輸出）：
 *   ⑥ 一般網址、短值環境變數（`main`、`true`）、名字不像金鑰的變數
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redactSecrets, redactError, installConsoleRedaction, gitHeaderEnv, secretValuesFrom,
} from './secret-redact.mjs';

const TOKEN = 'ghp_FAKEfakeFAKEfake1234567890abcdef';
const ENV = { GITHUB_MIRROR_TOKEN: TOKEN, GITHUB_ACCOUNT_NAME: 'youlinhsieh', BRANCH: 'main', FLAG_KEY: 'true' };
const B64 = Buffer.from(`youlinhsieh:${TOKEN}`).toString('base64');

test('① 09-17 實洩那一行：extraheader 裡的 Basic 值被遮掉', () => {
  const line = `Command failed: git -c http.https://github.com/youlinhsieh/arcrun-rag.git.extraheader=Authorization: Basic ${B64} push https://github.com/youlinhsieh/arcrun-rag.git HEAD:refs/heads/main`;
  const out = redactSecrets(line, { env: {} }); // 連環境變數都沒有，也要靠形狀遮掉
  assert.ok(!out.includes(B64), out);
  assert.match(out, /Authorization: Basic \*\*\*REDACTED\*\*\*/);
  assert.match(out, /HEAD:refs\/heads\/main/); // 其餘資訊保留，人才看得懂斷在哪
});

test('② 網址內嵌帳密', () => {
  const out = redactSecrets(`remote: https://claude-code:${TOKEN}@git.uncle6.me/inkstone/arcrun-rag.git`, { env: {} });
  assert.ok(!out.includes(TOKEN));
  assert.match(out, /\/\/\*\*\*:\*\*\*@git\.uncle6\.me/);
});

test('③ 認值：裸的 token 與它的 base64', () => {
  const out = redactSecrets(`token=${TOKEN} header=${B64} git:${Buffer.from(`git:${TOKEN}`).toString('base64')}`, { env: ENV });
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes(B64));
  assert.ok(!out.includes(Buffer.from(`git:${TOKEN}`).toString('base64')));
});

test('④ 真的讓 git push 失敗：標頭走 GIT_CONFIG_* 時錯誤訊息裡沒有金鑰；遮蔽後也沒有', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-'));
  execFileSync('git', ['init', '-q', dir]);
  const remote = join(dir, 'no-such-remote.git');
  const env = { ...process.env, ...gitHeaderEnv(remote, `Authorization: Basic ${B64}`, process.env), GITHUB_MIRROR_TOKEN: TOKEN };
  let err;
  try {
    execFileSync('git', ['push', remote, 'HEAD:refs/heads/main'], { cwd: dir, encoding: 'utf8', env, stdio: 'pipe' });
  } catch (e) { err = e; }
  assert.ok(err, 'push 應該失敗');
  const raw = `${err.message}\n${err.stderr || ''}`;
  assert.ok(!raw.includes(B64), '標頭不該出現在 argv／錯誤訊息裡');
  const red = redactError(err, { env });
  assert.ok(!`${red.message}${red.stderr}${red.stack}`.includes(TOKEN));
});

test('④b 舊寫法（標頭放 argv）的錯誤，經 redactError 之後乾淨', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-'));
  execFileSync('git', ['init', '-q', dir]);
  const remote = join(dir, 'no-such-remote.git');
  let err;
  try {
    execFileSync('git', ['-c', `http.${remote}.extraheader=Authorization: Basic ${B64}`, 'push', remote, 'HEAD:main'],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { err = e; }
  assert.ok(err.message.includes(B64), '前提：舊寫法的錯誤訊息真的帶著金鑰（09-17 的形狀）');
  const red = redactError(err, { env: ENV });
  for (const k of ['message', 'stack', 'stderr', 'stdout']) {
    assert.ok(!String(red[k] ?? '').includes(B64), `${k} 還帶著金鑰`);
  }
  assert.ok(!red.spawnargs || red.spawnargs.every((a) => !a.includes(B64)));
});

test('⑤ console 出口被包起來之後，印出去的字已遮', () => {
  const printed = [];
  const fake = { log: (...a) => printed.push(a.join(' ')), error: (...a) => printed.push(a.join(' ')), warn() {}, info() {} };
  const restore = installConsoleRedaction(fake, { env: ENV });
  fake.log(`❌ 斷在這一步 Authorization: Basic ${B64}`);
  fake.error(new Error(`boom ${TOKEN}`));
  restore();
  assert.equal(printed.length, 2);
  for (const p of printed) {
    assert.ok(!p.includes(B64) && !p.includes(TOKEN), p);
  }
});

test('⑥ 不誤傷：一般網址、短值、名字不像金鑰的變數', () => {
  const env = { BRANCH: 'main-release-2026-09-17', FLAG_KEY: 'true', SOME_URL: 'https://github.com/youlinhsieh/arcrun-rag.git' };
  assert.deepEqual(secretValuesFrom(env), []);
  const text = 'push https://github.com/youlinhsieh/arcrun-rag.git main-release-2026-09-17 true';
  assert.equal(redactSecrets(text, { env }), text);
});

test('冪等：遮兩次跟遮一次一樣', () => {
  const once = redactSecrets(`Authorization: Bearer ${TOKEN}`, { env: ENV });
  assert.equal(redactSecrets(once, { env: ENV }), once);
});
