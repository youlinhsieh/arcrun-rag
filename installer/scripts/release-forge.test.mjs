/**
 * release-forge.test.mjs — 出貨線「版本發佈紀錄」那一站換家（inkstone/InkStoneCo#234，總管 c22852）
 *
 * 跑法：node --test installer/scripts/release-forge.test.mjs
 *
 * 釘死的事（對應 Arcrun c22851 點名的三件，加上冪等與回退）：
 *   ① gitea 模式：原樣就是 gitea-release.mjs 的函式（回退＝翻回 gitea，行為一字未改）
 *   ② ahub 模式建 release：打 AHub 具名工作流；寫入**不自動重送**；
 *      第一發其實成功但連線逾時 ⇒ 回頭用 tag 查，內容一致 ＝ 成功（不是 409 報錯）；
 *      同 tag 但內容不同 ⇒ 丟錯，不蓋
 *   ③ 附件：先寫 R2 再登記指標；key ＝ releases/<owner>/<repo>/<tag>/<檔名>；
 *      重跑冪等（不重寫 R2、不重登記）；同名不同內容 ⇒ 丟錯；R2 寫失敗 ⇒ 不登記指標（不留一個點下去沒東西的附件）
 *   ④ AHub 沒有 DELETE ⇒ 明講，不假裝
 *   ⑤ 缺金鑰／缺帳號 ⇒ preflight 就能發現
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releaseForgeApi, r2KeyFor, localRemoteContains, AHUB_TIMEOUT_MS } from './release-forge.mjs';
import * as G from './gitea-release.mjs';

const AHUB = { TICKET_FORGE: 'ahub', AHUB_CYPHER_URL: 'https://cy.example', AHUB_NS: 'ns1', RELEASE_R2_ACCOUNT: 'acc1', RELEASE_R2_BUCKET: 'bk' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** 假的 AHub：只實作 release 六條路由，記下每個請求。onPost 可在建 release 時注入故障。 */
function fakeAhub({ failFirstCreateAfterStoring = false, create409 = false } = {}) {
  const releases = [];
  const assets = [];
  const posts = { create: 0, asset: 0 };
  let nextId = 1;
  const f = async (url, init) => {
    const env = JSON.parse(init.body);
    const wf = url.split('/').slice(-2)[0];
    const reply = (status, body) => ({ status: 200, text: async () => JSON.stringify({ success: true, data: { status, body } }) });
    const view = (r) => ({ id: r.id, tag_name: r.tag, name: r.name || r.tag, body: r.body, target_commitish: r.target, html_url: `https://cy.example/${r.repo}/releases/tag/${r.tag}`, assets: [] });
    const repo = `${env.params.owner}/${env.params.repo}`;
    if (wf === 'ahub__release_by_tag') {
      const r = releases.find((x) => x.repo === repo && x.tag === env.params.tag);
      return r ? reply(200, view(r)) : reply(404, { message: 'not found' });
    }
    if (wf === 'ahub__release_get') {
      const r = releases.find((x) => x.repo === repo && String(x.id) === env.params.id);
      return r ? reply(200, view(r)) : reply(404, { message: 'not found' });
    }
    if (wf === 'ahub__release_list') return reply(200, releases.filter((x) => x.repo === repo).map(view));
    if (wf === 'ahub__release_create') {
      posts.create += 1;
      if (create409 || releases.some((x) => x.repo === repo && x.tag === env.body.tag_name)) return reply(409, { message: 'Release tag already exists.' });
      const r = { id: nextId++, repo, tag: env.body.tag_name, name: env.body.name, body: env.body.body, target: env.body.target_commitish };
      releases.push(r);
      if (failFirstCreateAfterStoring && posts.create === 1) throw new Error('socket hang up'); // 存進去了，但回應沒收到
      return reply(201, view(r));
    }
    if (wf === 'ahub__release_asset_list') return reply(200, assets.filter((a) => a.rid === env.params.id));
    if (wf === 'ahub__release_asset_add') {
      posts.asset += 1;
      if (assets.some((a) => a.rid === env.params.id && a.name === env.body.name)) return reply(409, { message: 'asset exists' });
      const a = { rid: env.params.id, id: assets.length + 1, ...env.body };
      assets.push(a);
      return reply(201, a);
    }
    return reply(404, { message: `unrouted ${wf}` });
  };
  Object.assign(f, { releases, assets, posts });
  return f;
}

function fakeR2() {
  const objs = new Map();
  const calls = { put: 0, exists: 0 };
  return {
    objs, calls,
    async exists(key, size) { calls.exists += 1; return objs.has(key) && objs.get(key).length === size; },
    async put(key, data) { calls.put += 1; objs.set(key, data); return true; },
  };
}

const mk = (over = {}) => releaseForgeApi({ env: {}, conf: AHUB, ...over });

test('① gitea 模式：函式就是 gitea-release.mjs 的那幾支（回退行為一字未改）', () => {
  const api = releaseForgeApi({ env: {}, conf: { TICKET_FORGE: 'gitea' } });
  assert.equal(api.kind, 'gitea');
  assert.equal(api.createRelease, G.createRelease);
  assert.equal(api.releaseExists, G.releaseExists);
  assert.equal(api.uploadReleaseAsset, G.uploadReleaseAsset);
  assert.equal(api.commitExists, G.commitExists);
  assert.equal(api.listReleases, G.listReleases);
});

test('② 建 release：打 AHub 的 release_create，信封帶 token 與 Gitea 形狀的 body；回的物件有 id／tag_name', async () => {
  const under = fakeAhub();
  const api = mk({ fetchImpl: under });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-1', name: 'T', body: 'B', target: 'abc123', token: 'TOK' });
  assert.equal(rel.tag_name, 'RAG-1');
  assert.equal(under.releases.length, 1);
  assert.equal(under.posts.create, 1);
  assert.equal(await api.releaseExists('inkstone/arcrun-rag', 'RAG-1').then((r) => r.id), rel.id);
  assert.equal(await api.releaseExists('inkstone/arcrun-rag', 'NOPE'), null);
  assert.equal(AHUB_TIMEOUT_MS >= 30000, true, '逾時至少 30 秒（Arcrun c22851：8 秒不夠 AHub 冷啟動）');
});

test('② 第一發其實成功、回應卻沒收到（逾時／斷線）⇒ 回頭用 tag 查，內容一致＝成功；只送過一次 POST', async () => {
  const under = fakeAhub({ failFirstCreateAfterStoring: true });
  const api = mk({ fetchImpl: under });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-2', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  assert.equal(rel.tag_name, 'RAG-2');
  assert.equal(under.posts.create, 1, '寫入不自動重送（重送會撞上自己建的那筆而 409）');
  assert.equal(under.releases.length, 1);
});

test('② 同 tag 已有、內容不同（真的撞號）⇒ 丟錯，不蓋', async () => {
  const under = fakeAhub();
  const api = mk({ fetchImpl: under });
  await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-3', name: 'T', body: 'old', target: 'abc', token: 'TOK' });
  await assert.rejects(
    api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-3', name: 'T', body: 'DIFFERENT', target: 'abc', token: 'TOK' }),
    /內容與這次要建的不同/);
  assert.equal(under.releases.length, 1);
  assert.equal(under.releases[0].body, 'old');
});

test('② 缺 token ⇒ 當場丟，不打網路', async () => {
  const under = fakeAhub();
  const api = mk({ fetchImpl: under });
  await assert.rejects(api.createRelease({ repoSlug: 'a/b', tag: 't', name: 'n', body: 'b', target: 'x' }), /缺寫入權杖/);
  assert.equal(under.posts.create, 0);
});

test('③ 附件：先寫 R2、再登記指標；key／指標欄位正確；重跑冪等', async () => {
  const under = fakeAhub();
  const r2 = fakeR2();
  const api = mk({ fetchImpl: under, r2 });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-4', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  const data = Buffer.from('hello-bundle');
  const a1 = await api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'manifest.json', data, token: 'TOK' }); // tag 沒給 ⇒ 用 id 查
  const key = 'releases/inkstone/arcrun-rag/RAG-4/manifest.json';
  assert.ok(r2.objs.has(key), '本體進了 R2');
  assert.deepEqual(r2.objs.get(key), data);
  assert.equal(a1.sha256, sha(data));
  assert.equal(a1.size, data.length);
  assert.equal(a1.r2_key, key);
  assert.equal(a1.url, `r2://bk/${key}`);

  const listed = await api.listReleaseAssets('inkstone/arcrun-rag', rel.id);
  assert.deepEqual(listed.map((x) => x.name), ['manifest.json']);

  // 再跑一次：不重寫 R2、不重登記
  const a2 = await api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'manifest.json', data, token: 'TOK', tag: 'RAG-4' });
  assert.equal(a2.sha256, sha(data));
  assert.equal(r2.calls.put, 1);
  assert.equal(under.posts.asset, 1);
});

test('③ 附件同名但內容不同 ⇒ 丟錯（AHub 沒有改附件的口），R2 不被覆蓋', async () => {
  const under = fakeAhub();
  const r2 = fakeR2();
  const api = mk({ fetchImpl: under, r2 });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-5', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  await api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'a.bin', data: Buffer.from('one'), token: 'TOK', tag: 'RAG-5' });
  await assert.rejects(
    api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'a.bin', data: Buffer.from('two'), token: 'TOK', tag: 'RAG-5' }),
    /sha256 與這次要掛的不同/);
  assert.equal(r2.calls.put, 1);
});

test('③ R2 寫失敗 ⇒ 丟錯，而且沒有登記任何指標（不留一個點下去沒東西的附件）', async () => {
  const under = fakeAhub();
  const r2 = { async exists() { return false; }, async put() { throw new Error('R2 403'); } };
  const api = mk({ fetchImpl: under, r2 });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-6', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  await assert.rejects(api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'x', data: Buffer.from('z'), token: 'TOK', tag: 'RAG-6' }), /R2 403/);
  assert.equal(under.assets.length, 0);
});

test('③ 檔已在 R2（上一發寫完、指標沒登記到）⇒ 不重寫本體，只補登記', async () => {
  const under = fakeAhub();
  const r2 = fakeR2();
  const api = mk({ fetchImpl: under, r2 });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-7', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  const data = Buffer.from('payload');
  r2.objs.set('releases/inkstone/arcrun-rag/RAG-7/p.bin', data);
  await api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'p.bin', data, token: 'TOK', tag: 'RAG-7' });
  assert.equal(r2.calls.put, 0);
  assert.equal(under.assets.length, 1);
});

test('r2KeyFor：tag／檔名不准含斜線或 ..（防止寫到別人的路徑）', () => {
  assert.equal(r2KeyFor('o/r', 'v1', 'a.zip'), 'releases/o/r/v1/a.zip');
  assert.throws(() => r2KeyFor('o/r', 'v1', '../x'), /不合法/);
  assert.throws(() => r2KeyFor('o/r', 'a/b', 'x'), /不合法/);
  assert.throws(() => r2KeyFor('o/r', 'v1', '..'), /不合法/);
  assert.throws(() => r2KeyFor('only', 'v1', 'x'), /owner\/repo/);
});

test('④ AHub 沒有 DELETE ⇒ deleteRelease 明講，不假裝成功', async () => {
  await assert.rejects(mk({ fetchImpl: fakeAhub() }).deleteRelease(), /沒有刪除 release 的口/);
});

test('commitExists（ahub）：問本機遠端追蹤分支有沒有含這顆 commit；沒有／不認得 ⇒ false', async () => {
  assert.equal(localRemoteContains('/x', 'abc', { run: () => '  origin/main\n' }), true);
  assert.equal(localRemoteContains('/x', 'abc', { run: () => '\n' }), false);
  assert.equal(localRemoteContains('/x', 'abc', { run: () => { throw new Error('no such commit'); } }), false);
  const calls = [];
  const api = mk({ fetchImpl: fakeAhub(), repoDir: '/default', gitRun: (cmd, args) => { calls.push(args); return 'origin/x'; } });
  assert.equal(await api.commitExists('o/r', 'deadbeef'), true);
  assert.equal(await api.commitExists('o/r', 'deadbeef', { repoDir: '/other' }), true);
  assert.deepEqual(calls.map((a) => a[1]), ['/default', '/other']);
});

test('⑤ preflight：缺 AHub 權杖／R2 金鑰／R2 帳號 ⇒ 列出來；補齊 ⇒ 空；writeCredentials 只認 AHub 的名字', () => {
  const bare = releaseForgeApi({ env: {}, conf: { ...AHUB, RELEASE_R2_ACCOUNT: '' } });
  const probs = bare.preflightProblems();
  assert.equal(probs.length, 3);
  assert.match(probs.join('\n'), /AHUB_TOKEN/);
  assert.match(probs.join('\n'), /CLOUDFLARE_API_TOKEN_LEO21C_ARTIFACTS/);
  assert.match(probs.join('\n'), /RELEASE_R2_ACCOUNT/);
  assert.equal(bare.writeCredentials(), null);

  const full = releaseForgeApi({ env: { AHUB_TOKEN: 't', CLOUDFLARE_API_TOKEN_LEO21C_ARTIFACTS: 'r' }, conf: AHUB });
  assert.deepEqual(full.preflightProblems(), []);
  assert.equal(full.writeCredentials().token, 't');

  // Gitea 的金鑰不准送去 AHub
  const wrong = releaseForgeApi({ env: { GITEA_TOKEN_CLAUDE_CODE: 'gitea-secret' }, conf: AHUB });
  assert.equal(wrong.writeCredentials(), null);

  // 演練可以把 R2 金鑰的「名字」換掉（值仍只在環境）
  const alt = releaseForgeApi({ env: { MY_R2: 'x', AHUB_TOKEN: 't' }, conf: { ...AHUB, RELEASE_R2_TOKEN_ENV: 'MY_R2' } });
  assert.deepEqual(alt.preflightProblems(), []);
});

test('ahub 模式缺 R2 金鑰時真的要寫附件 ⇒ 當場丟並點名環境變數，不安靜略過', async () => {
  const under = fakeAhub();
  const api = releaseForgeApi({ env: {}, conf: AHUB, fetchImpl: under });
  const rel = await api.createRelease({ repoSlug: 'inkstone/arcrun-rag', tag: 'RAG-8', name: 'T', body: 'B', target: 'abc', token: 'TOK' });
  await assert.rejects(api.uploadReleaseAsset({ repoSlug: 'inkstone/arcrun-rag', id: rel.id, name: 'x', data: Buffer.from('z'), token: 'TOK', tag: 'RAG-8' }), /CLOUDFLARE_API_TOKEN_LEO21C_ARTIFACTS/);
  assert.equal(under.assets.length, 0);
});

test('releaseForgeApi 設定壞掉（ahub 缺 cypher／ns）⇒ 當場丟，不退回 Gitea', () => {
  assert.throws(() => releaseForgeApi({ env: {}, conf: { TICKET_FORGE: 'ahub' } }), /AHUB_CYPHER_URL|AHUB_NS/);
});
