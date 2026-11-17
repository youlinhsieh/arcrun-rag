/**
 * inkstone/arcrun-rag#347：jsDelivr 暫時 404（內文 `Failed to fetch the requested commit`）
 * 要重試、用盡後走 GitHub raw；真的不存在的檔案仍要報「找不到」。
 * 跑法：node --experimental-sqlite --test fetch-bundle-asset-347.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBundleAsset } from './worker.js';

const CDN = 'https://cdn.jsdelivr.net/gh/o/r@57195d3/bundle/x/worker.mjs';
const RAW = 'https://raw.githubusercontent.com/o/r/57195d3/bundle/x/worker.mjs';
const TRANSIENT = 'Failed to fetch the requested commit 57195d3';

function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return handler(String(url), calls.length); };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}

test('CDN 暫時 404 一次後恢復：重試成功，不用備援', () =>
  withFetch((u, n) => n === 1 ? new Response(TRANSIENT, { status: 404 }) : new Response('ok'), async (calls) => {
    const r = await fetchBundleAsset(CDN, '主模組', {});
    assert.equal(r.usedFallback, false);
    assert.equal(await r.response.text(), 'ok');
    assert.equal(calls.length, 2);
  }));

test('CDN 一直暫時 404：用盡後走 GitHub raw 並標 usedFallback', () =>
  withFetch((u) => u === RAW ? new Response('raw-ok') : new Response(TRANSIENT, { status: 404 }), async (calls) => {
    const r = await fetchBundleAsset(CDN, '主模組', {});
    assert.equal(r.usedFallback, true);
    assert.equal(await r.response.text(), 'raw-ok');
    assert.equal(calls.length, 5, '主來源 4 次＋備援 1 次');
  }));

test('真的 404（內文不是暫時錯誤）：立刻報找不到，不重試不備援', () =>
  withFetch(() => new Response('Not Found', { status: 404 }), async (calls) => {
    await assert.rejects(fetchBundleAsset(CDN, '主模組', {}), /找不到 主模組（HTTP 404）/);
    assert.equal(calls.length, 1);
  }));

test('CDN 暫時 404、備援也真的 404：報找不到', () =>
  withFetch((u) => u === RAW ? new Response('404: Not Found', { status: 404 }) : new Response(TRANSIENT, { status: 404 }), async () => {
    await assert.rejects(fetchBundleAsset(CDN, '主模組', {}), /找不到 主模組（HTTP 404）/);
  }));
