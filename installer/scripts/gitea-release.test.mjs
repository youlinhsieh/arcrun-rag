/**
 * gitea-release.test.mjs — 純函式測試（注入 fetch，不打真的 Gitea）。
 * 跑法：node --test installer/scripts/gitea-release.test.mjs
 *
 * 真的打 Gitea API 的驗收（arcrun-rag#88 要求「Gitea 上真的建出版本發佈」）
 * 另外用一支手動腳本跑過、貼在 PR 說明——這裡只驗「函式邏輯對不對」，
 * 理由與 github-release.mjs 沒有 .test.mjs 的现况一致：純函式邏輯用 mock 測，
 * 「真的打出去」的證據不該靠自動測試留下副作用（會在真的 repo 建出測試用 release）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  releaseExists, createRelease, deleteRelease, listReleases, commitExists,
  giteaWriteCredentialsFromRemote, redactToken,
} from './gitea-release.mjs';

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    for (const [pattern, handler] of routes) {
      if (pattern.test(key)) return handler(url, opts);
    }
    throw new Error(`未預期的請求：${key}`);
  };
}

test('releaseExists：404 回 null，不丟例外', async () => {
  const fetchImpl = fakeFetch([[/\/releases\/tags\/v1\.4\.44$/, () => ({ status: 404, ok: false })]]);
  const r = await releaseExists('acme/widget', 'v1.4.44', { token: 't', fetchImpl });
  assert.equal(r, null);
});

test('releaseExists：200 回物件', async () => {
  const fetchImpl = fakeFetch([[/\/releases\/tags\/v1\.4\.44$/, () => ({
    status: 200, ok: true, json: async () => ({ id: 7, tag_name: 'v1.4.44' }),
  })]]);
  const r = await releaseExists('acme/widget', 'v1.4.44', { token: 't', fetchImpl });
  assert.equal(r.id, 7);
});

test('releaseExists：非 404 非 2xx 丟例外（不要把錯誤靜默當成「不存在」）', async () => {
  const fetchImpl = fakeFetch([[/\/releases\/tags\//, () => ({ status: 500, ok: false })]]);
  await assert.rejects(() => releaseExists('acme/widget', 'v1', { token: 't', fetchImpl }), /HTTP 500/);
});

test('createRelease：缺 token 當場拒絕，不打網路（D36：只碰名字不碰真身）', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  await assert.rejects(
    () => createRelease({ repoSlug: 'acme/widget', tag: 'v1', name: 'v1', body: 'x', target: 'main', fetchImpl }),
    /缺寫入權杖/,
  );
  assert.equal(called, false);
});

test('createRelease：成功時把 tag/name/body/target 原樣送出，回傳 API 結果', async () => {
  let sentBody;
  const fetchImpl = fakeFetch([[/\/releases$/, (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 9, html_url: 'https://gitea.example/acme/widget/releases/tag/v1.4.44' }) };
  }]]);
  const r = await createRelease({
    repoSlug: 'acme/widget', tag: 'v1.4.44', name: '1.4.44', body: '正文', target: 'deadbeef', token: 't', fetchImpl,
  });
  assert.equal(sentBody.tag_name, 'v1.4.44');
  assert.equal(sentBody.name, '1.4.44');
  assert.equal(sentBody.body, '正文');
  assert.equal(sentBody.target_commitish, 'deadbeef');
  assert.equal(sentBody.draft, false);
  assert.equal(r.id, 9);
});

test('createRelease：非 2xx 把錯誤內文包進例外訊息（截斷到 300 碼）', async () => {
  const fetchImpl = fakeFetch([[/\/releases$/, () => ({ ok: false, status: 422, text: async () => 'tag already exists' })]]);
  await assert.rejects(
    () => createRelease({ repoSlug: 'acme/widget', tag: 'v1', name: 'v1', body: 'x', target: 'main', token: 't', fetchImpl }),
    /HTTP 422.*tag already exists/,
  );
});

test('deleteRelease：204 或 ok 視為成功', async () => {
  const fetchImpl = fakeFetch([[/\/releases\/9$/, () => ({ ok: false, status: 204 })]]);
  const r = await deleteRelease({ repoSlug: 'acme/widget', id: 9, token: 't', fetchImpl });
  assert.equal(r, true);
});

test('listReleases：回傳陣列', async () => {
  const fetchImpl = fakeFetch([[/\/releases\?limit=50$/, () => ({ ok: true, json: async () => [{ id: 1 }, { id: 2 }] })]]);
  const r = await listReleases('acme/widget', { token: 't', fetchImpl });
  assert.equal(r.length, 2);
});

test('giteaWriteCredentialsFromRemote：從 remote URL 內嵌帳密解出 login/token（既有做法，不新開一條路）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-cred-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'gitea', 'https://alice:sekret123@gitea.example/acme/widget.git']);
    const cred = giteaWriteCredentialsFromRemote(dir);
    assert.equal(cred.login, 'alice');
    assert.equal(cred.token, 'sekret123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('giteaWriteCredentialsFromRemote：沒有 gitea remote 回 null，不丟例外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-cred-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    const cred = giteaWriteCredentialsFromRemote(dir);
    assert.equal(cred, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactToken：不洩漏真身，只印長度', () => {
  const s = redactToken({ login: 'alice', token: 'abcdefghij' });
  assert.equal(s.includes('abcdefghij'), false);
  assert.match(s, /alice:\*\*\*\(10 碼\)/);
});

test('commitExists：404 回 false（＝那顆 commit 還沒交貨到 Gitea），不丟例外', async () => {
  const fetchImpl = fakeFetch([[/\/git\/commits\//, () => ({ status: 404, ok: false })]]);
  assert.equal(await commitExists('acme/widget', 'deadbeef', { token: 't', fetchImpl }), false);
});

test('commitExists：200 回 true', async () => {
  const fetchImpl = fakeFetch([[/\/git\/commits\/deadbeef$/, () => ({ status: 200, ok: true })]]);
  assert.equal(await commitExists('acme/widget', 'deadbeef', { token: 't', fetchImpl }), true);
});

test('commitExists：非 404 非 2xx 丟例外——**讀不到不等於不存在**，不准靜默當成「還沒交貨」', async () => {
  const fetchImpl = fakeFetch([[/\/git\/commits\//, () => ({ status: 500, ok: false })]]);
  await assert.rejects(() => commitExists('acme/widget', 'deadbeef', { token: 't', fetchImpl }), /HTTP 500/);
});
