// inkstone/Arcrun#374：GitHub API 被環境擋 ≠ repo 不存在。只做匿名讀的退路，不寫任何東西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoExists } from './line-source-repo.mjs';
import { isEnvBlocked, listTagsViaGit } from './github-read.mjs';

const BLOCK = { status: 403, ok: false, text: async () => '{"message":"GitHub access to this repository is not enabled for this session."}' };
const okGit = (out) => () => ({ status: 0, stdout: out, stderr: '' });
const badGit = () => ({ status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com'" });

test('API 匿名讀被擋（403）⇒ isEnvBlocked 為真；一般 403 為假', async () => {
  assert.equal(await isEnvBlocked(BLOCK), true);
  assert.equal(await isEnvBlocked({ status: 403, text: async () => '{"message":"API rate limit exceeded for 1.2.3.4"}' }), true);
  assert.equal(await isEnvBlocked({ status: 403, text: async () => 'Forbidden' }), false);
  assert.equal(await isEnvBlocked({ status: 500, text: async () => '' }), false);
});

test('repoExists(github)：環境擋 + git ls-remote 讀得到 ⇒ true（preflight 過）', async () => {
  const seen = [];
  const spawnImpl = (cmd, args, o) => { seen.push({ cmd, args, env: o.env }); return okGit('abc\tHEAD\n')(); };
  assert.equal(await repoExists('github', 'youlinhsieh/arcrun-rag', { fetchImpl: async () => BLOCK, spawnImpl }), true);
  assert.deepEqual(seen[0].args, ['ls-remote', 'https://github.com/youlinhsieh/arcrun-rag.git', 'HEAD']);
  assert.equal(seen[0].env.GIT_TERMINAL_PROMPT, '0');
});

test('repoExists(github)：環境擋 + git 也讀不到 ⇒ 丟，且講清楚是環境擋、分不出存在與否', async () => {
  await assert.rejects(
    () => repoExists('github', 'a/b', { fetchImpl: async () => BLOCK, spawnImpl: badGit }),
    /匿名讀被擋[\s\S]*不猜/);
});

test('repoExists：404 仍是 false；一般 403 仍照舊丟 HTTP 403（不被退路吃掉）', async () => {
  assert.equal(await repoExists('github', 'a/b', { fetchImpl: async () => ({ status: 404, ok: false }), spawnImpl: badGit }), false);
  await assert.rejects(() => repoExists('github', 'a/b', { fetchImpl: async () => ({ status: 403, ok: false, text: async () => 'x' }), spawnImpl: badGit }), /HTTP 403/);
});

test('listTagsViaGit：只取 refs/tags 名、略過 ^{}', () => {
  const out = 'a\trefs/tags/v1.4.1\nb\trefs/tags/v1.4.1^{}\nc\trefs/tags/v1.4.2\n';
  assert.deepEqual(listTagsViaGit('a/b', { spawnImpl: okGit(out) }), ['v1.4.1', 'v1.4.2']);
  assert.throws(() => listTagsViaGit('a/b', { spawnImpl: badGit }), /匿名讀被擋/);
});

// ── inkstone/arcrun-rag#343：release-record 的 releaseExists 遇環境擋 403 改走 git 讀 ──
import { releaseExists, listReleaseAssets } from './github-release.mjs';

test('releaseExists：環境擋 + git 沒有該 tag ⇒ null（可建）', async () => {
  const r = await releaseExists('a/b', 'v1.4.201', { fetchImpl: async () => BLOCK, spawnImpl: okGit('x\trefs/tags/v1.4.200\n') });
  assert.equal(r, null);
});

test('releaseExists：環境擋 + git 有該 tag ⇒ 回 viaGit（不猜 release 在不在）', async () => {
  const r = await releaseExists('a/b', 'v1.4.201', { fetchImpl: async () => BLOCK, spawnImpl: okGit('x\trefs/tags/v1.4.201\n') });
  assert.equal(r.viaGit, true);
  assert.match(r.html_url, /releases\/tag\/v1\.4\.201$/);
});

test('releaseExists：環境擋 + git 也讀不到 ⇒ 丟，錯誤帶 API 回應內文', async () => {
  await assert.rejects(
    () => releaseExists('a/b', 'v1', { fetchImpl: async () => BLOCK, spawnImpl: badGit }),
    /not enabled for this session[\s\S]*匿名讀被擋|匿名讀被擋[\s\S]*not enabled for this session/);
});

test('releaseExists：rate limit 403 同樣走 git；一般 403 照舊丟且帶內文；404 仍 null', async () => {
  const RL = { status: 403, ok: false, text: async () => '{"message":"API rate limit exceeded"}' };
  assert.equal(await releaseExists('a/b', 'v1', { fetchImpl: async () => RL, spawnImpl: okGit('') }), null);
  await assert.rejects(() => releaseExists('a/b', 'v1', { fetchImpl: async () => ({ status: 403, ok: false, text: async () => 'Forbidden' }), spawnImpl: okGit('') }), /HTTP 403 Forbidden/);
  assert.equal(await releaseExists('a/b', 'v1', { fetchImpl: async () => ({ status: 404, ok: false }) }), null);
});

test('listReleaseAssets：環境擋 ⇒ 錯誤帶 envBlocked 與內文', async () => {
  await assert.rejects(() => listReleaseAssets('a/b', 1, { fetchImpl: async () => BLOCK }),
    (e) => e.envBlocked === true && /not enabled/.test(e.message));
});
