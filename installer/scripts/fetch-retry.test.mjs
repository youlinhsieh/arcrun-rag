/**
 * fetch-retry.test.mjs — 純函式測試，不真的等（sleepImpl 注入）、不真的打網路。
 * 跑法：node --test installer/scripts/fetch-retry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, backoffMs } from './fetch-retry.mjs';

function noSleep() { return Promise.resolve(); }

test('backoffMs：遞增但有上限，且不為負', () => {
  const a1 = backoffMs(1, { baseMs: 100, maxMs: 1000 });
  const a2 = backoffMs(2, { baseMs: 100, maxMs: 1000 });
  const a5 = backoffMs(5, { baseMs: 100, maxMs: 1000 });
  assert.ok(a1 >= 100 && a1 < 130);
  assert.ok(a2 >= 200 && a2 < 260);
  assert.ok(a5 <= 1200, `a5=${a5} 不該遠超上限`);
});

test('withRetry：連線層失敗（fetch 丟例外）會重試，最終成功就回傳', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error('UND_ERR_CONNECT_TIMEOUT（模擬 c10724）');
    return { ok: true, status: 200 };
  };
  const f = withRetry({ fetchImpl: flaky, retries: 2, sleepImpl: noSleep });
  const res = await f('https://git.uncle6.me/api/v1/version');
  assert.equal(res.status, 200);
  assert.equal(calls, 3, '第三次才成功，應該剛好打了三次');
});

test('withRetry：超過重試上限，丟出彙總錯誤（帶 cause）', async () => {
  let calls = 0;
  const alwaysDown = async () => { calls += 1; throw new Error('connect timeout'); };
  const f = withRetry({ fetchImpl: alwaysDown, retries: 2, sleepImpl: noSleep });
  await assert.rejects(f('https://git.uncle6.me/x'), (e) => {
    assert.match(e.message, /重試 3 次都失敗/);
    assert.ok(e.cause);
    return true;
  });
  assert.equal(calls, 3, 'retries=2 ⇒ 總共嘗試 3 次');
});

test('withRetry：暫時性狀態碼（503）會重試；非暫時性（404）不重試、原樣回傳', async () => {
  let calls503 = 0;
  const flaky503 = async () => {
    calls503 += 1;
    if (calls503 < 2) return { ok: false, status: 503 };
    return { ok: true, status: 200 };
  };
  const f503 = withRetry({ fetchImpl: flaky503, retries: 2, sleepImpl: noSleep });
  const r503 = await f503('u');
  assert.equal(r503.status, 200);
  assert.equal(calls503, 2);

  let calls404 = 0;
  const always404 = async () => { calls404 += 1; return { ok: false, status: 404 }; };
  const f404 = withRetry({ fetchImpl: always404, retries: 2, sleepImpl: noSleep });
  const r404 = await f404('u');
  assert.equal(r404.status, 404, '404 是真答案，不該被重試機制吃掉');
  assert.equal(calls404, 1, '404 不重試——只打一次');
});

test('withRetry：retries=0 時只打一次，失敗就直接丟', async () => {
  let calls = 0;
  const alwaysDown = async () => { calls += 1; throw new Error('down'); };
  const f = withRetry({ fetchImpl: alwaysDown, retries: 0, sleepImpl: noSleep });
  await assert.rejects(f('u'));
  assert.equal(calls, 1);
});

test('withRetry：每次嘗試自己有逾時——底層 fetch 掛著不回應也會被判定失敗、進入重試', async () => {
  // 模擬本次實測撞到的狀況：fetch 呼叫掛著不回應也不拋例外（c10724 最壞情況，
  // 比 OS 層自然逾時還久）。這支要在 timeoutMs 到就放棄，不能無限等下去。
  // 用真的短逾時（20ms）＋真的短重試間隔，整個測試在數十毫秒內結束，不必 mock 計時器。
  let calls = 0;
  const hangsForever = (url, opts) => new Promise((resolve, reject) => {
    calls += 1;
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const f = withRetry({ fetchImpl: hangsForever, retries: 1, timeoutMs: 20, sleepImpl: () => new Promise((r) => setTimeout(r, 1)) });
  await assert.rejects(f('u'), /重試 2 次都失敗/);
  assert.equal(calls, 2, 'retries=1 ⇒ 總共嘗試 2 次，且兩次都被 20ms 逾時打斷');
});

test('withRetry：呼叫端自帶 signal 一樣會被尊重（合併逾時與呼叫端的 abort）', async () => {
  const ac = new AbortController();
  let sawSignal = null;
  const capture = async (url, opts) => { sawSignal = opts.signal; return { ok: true, status: 200 }; };
  const f = withRetry({ fetchImpl: capture, sleepImpl: noSleep });
  await f('u', { signal: ac.signal });
  assert.ok(sawSignal, '底層 fetch 應該收到一個 signal');
  assert.notEqual(sawSignal, ac.signal, '合併後的 signal 不等於呼叫端原本那個物件（AbortSignal.any 產生新的）');
});
