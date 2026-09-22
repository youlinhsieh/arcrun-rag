/**
 * ticket-arm-guard.test.mjs — 純函式測試（注入 fetch，不打真的 Gitea）。
 * 跑法：node --test installer/scripts/ticket-arm-guard.test.mjs
 *
 * 對應 inkstone/ISEP#30 comment 10739 的驗法①：
 *   「有簽名→放行、同樣的字由總管帳號寫→擋、簽 X 版出 Y 版→擋、沒簽→擋」
 * 這支逐一釘死這四種行為，加上分頁與格式邊界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTicketArmed, findArmMatch, extractArmLine, normVersion, APPROVER_LOGIN, OWNER,
} from './ticket-arm-guard.mjs';

function fakeFetch(pages) {
  // pages: array of comment-arrays, one per expected page fetch (in order)
  let call = 0;
  return async (url) => {
    const body = pages[call] ?? [];
    call += 1;
    return { ok: true, status: 200, json: async () => body };
  };
}

function leoComment(body, over = {}) {
  return { id: 1001, user: { login: 'Leo' }, body, created_at: '2026-09-22T05:20:00Z', ...over };
}
function aiComment(body, over = {}) {
  return { id: 1002, user: { login: 'claude-code' }, body, created_at: '2026-09-22T05:21:00Z', ...over };
}

// ── extractArmLine / normVersion：純字串邏輯 ────────────────────────────────

test('extractArmLine：獨立一行才算數', () => {
  assert.equal(extractArmLine('ARM: 1.4.73'), '1.4.73');
  assert.equal(extractArmLine('前言\nARM: 1.4.73\n後語'), '1.4.73');
  assert.equal(extractArmLine('  ARM:   1.4.73  '), '1.4.73');
  assert.equal(extractArmLine('我覺得可以 ARM: 1.4.73 了'), null, '同一行還有別的字 ⇒ 不算獨立一行');
  assert.equal(extractArmLine('這次先不要 ARM'), null);
  assert.equal(extractArmLine(''), null);
  assert.equal(extractArmLine(undefined), null);
});

test('normVersion：去掉單一前導 v/V，其餘逐字比對', () => {
  assert.equal(normVersion('1.4.73'), '1.4.73');
  assert.equal(normVersion('v1.4.73'), '1.4.73');
  assert.equal(normVersion('V1.4.73'), '1.4.73');
  assert.equal(normVersion('  1.4.73  '), '1.4.73');
  assert.notEqual(normVersion('v1.4.73'), normVersion('1.4.730'));
});

// ── findArmMatch：純函式核心判定 ─────────────────────────────────────────────

test('findArmMatch：① Leo 簽對版本 → ok', () => {
  const r = findArmMatch([leoComment('ARM: 1.4.73')], '1.4.73');
  assert.equal(r.ok, true);
  assert.equal(r.signedVersion, '1.4.73');
});

test('findArmMatch：② 同樣的字由總管／claude-code 帳號寫 → 不算數', () => {
  const r = findArmMatch([aiComment('ARM: 1.4.73')], '1.4.73');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-arm-by-leo', 'AI 帳號寫的完全不進入「已簽但版本不對」那一類——根本不算一次簽名');
});

test('findArmMatch：③ 簽 X 版、出 Y 版 → 擋', () => {
  const r = findArmMatch([leoComment('ARM: 1.4.72')], '1.4.73');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'version-mismatch');
  assert.deepEqual(r.signedVersions, ['1.4.72']);
});

test('findArmMatch：④ 完全沒簽 → 擋', () => {
  const r = findArmMatch([], '1.4.73');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-arm-by-leo');
});

test('findArmMatch：Leo 寫了別的話（沒有 ARM 行）不算數，也不誤判成 version-mismatch', () => {
  const r = findArmMatch([leoComment('這版我看過了，很好')], '1.4.73');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-arm-by-leo');
});

test('findArmMatch：多則裡有一則對上就過（不要求最新一則才算數）', () => {
  const r = findArmMatch([leoComment('ARM: 1.4.71'), leoComment('ARM: 1.4.73'), leoComment('ARM: 1.4.72')], '1.4.73');
  assert.equal(r.ok, true);
});

test('findArmMatch：v 前綴寬容——leo 簽 v1.4.73，出貨線讀到 1.4.73 一樣算對上', () => {
  const r = findArmMatch([leoComment('ARM: v1.4.73')], '1.4.73');
  assert.equal(r.ok, true);
});

// ── checkTicketArmed：端到端（fetch 注入），含分頁 ───────────────────────────

test('checkTicketArmed：①有簽名→放行', async () => {
  const fetchImpl = fakeFetch([[leoComment('ARM: 1.4.73')]]);
  const r = await checkTicketArmed({ version: '1.4.73', repo: 'InkStoneCo', issue: 140, fetchImpl });
  assert.equal(r.armed, true);
  assert.match(r.mission, /ARM: 1\.4\.73/);
  assert.match(r.mission, new RegExp(APPROVER_LOGIN));
});

test('checkTicketArmed：②同樣的字由總管帳號寫→擋', async () => {
  const fetchImpl = fakeFetch([[aiComment('ARM: 1.4.73')]]);
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', repo: 'InkStoneCo', issue: 140, fetchImpl }),
    /沒有任何一則來自 Leo/,
  );
});

test('checkTicketArmed：③簽 X 版出 Y 版→擋', async () => {
  const fetchImpl = fakeFetch([[leoComment('ARM: 1.4.72')]]);
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', repo: 'InkStoneCo', issue: 140, fetchImpl }),
    /版本對不上/,
  );
});

test('checkTicketArmed：④沒簽→擋', async () => {
  const fetchImpl = fakeFetch([[]]);
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', repo: 'InkStoneCo', issue: 140, fetchImpl }),
    /沒有任何一則來自 Leo/,
  );
});

test('checkTicketArmed：分頁——ARM 留言在第二頁也找得到', async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => aiComment(`留言 ${i}`, { id: i }));
  const page2 = [leoComment('ARM: 1.4.73')];
  const fetchImpl = fakeFetch([page1, page2]);
  const r = await checkTicketArmed({ version: '1.4.73', repo: 'InkStoneCo', issue: 30, fetchImpl });
  assert.equal(r.armed, true);
});

test('checkTicketArmed：缺 version 直接丟例外，不打網路', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, json: async () => [] }; };
  await assert.rejects(checkTicketArmed({ issue: 140, fetchImpl }), /缺 version/);
  assert.equal(called, false);
});

test('checkTicketArmed：issue 不合法（非正整數）直接丟例外', async () => {
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', issue: 0, fetchImpl: fakeFetch([[]]) }),
    /issue 必須是正整數/,
  );
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', issue: '140', fetchImpl: fakeFetch([[]]) }),
    /issue 必須是正整數/,
  );
});

test('checkTicketArmed：OWNER 是模組常數，不接受任何呼叫端覆蓋（連參數都沒開放）', () => {
  assert.equal(OWNER, 'inkstone');
  assert.equal(APPROVER_LOGIN, 'Leo');
});

test('checkTicketArmed：HTTP 非 200（非暫時性）直接回報，不假裝放行', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(
    checkTicketArmed({ version: '1.4.73', issue: 140, fetchImpl }),
    /HTTP 404/,
  );
});
