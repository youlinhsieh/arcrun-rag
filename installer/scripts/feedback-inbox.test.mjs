import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInbox, describeMissing } from './feedback-inbox.mjs';

const mk = (wfs, creds) => async (url) => {
  const body = url.endsWith('/credentials') ? { credentials: creds } : { workflows: wfs };
  return { ok: true, status: 200, json: async () => body };
};

test('清空後的收件端：兩樣都缺要講出來', async () => {
  const r = await checkInbox({ fetchImpl: mk([], []) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['工作流 feedback_report', '金鑰 ahub_token']);
  assert.match(describeMissing(r.missing), /leo 同意/);
});
test('只有工作流沒有金鑰：只缺金鑰', async () => {
  const r = await checkInbox({ fetchImpl: mk([{ name: 'feedback_report' }], []) });
  assert.deepEqual(r.missing, ['金鑰 ahub_token']);
});
test('齊全', async () => {
  const r = await checkInbox({ fetchImpl: mk([{ name: 'feedback_report' }], [{ name: 'ahub_token' }]) });
  assert.equal(r.ok, true);
});
