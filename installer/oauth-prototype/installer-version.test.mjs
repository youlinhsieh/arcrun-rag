/**
 * installer-version.test.mjs — 安裝器的版本號真的走到使用者眼前了嗎（inkstone/arcrun-rag#169）
 *
 * 跑法：node --test installer/oauth-prototype/installer-version.test.mjs
 *
 * 🔴 為什麼另開一個檔而不是加進 `worker.test.mjs`：那個檔正在被 PR #170
 *   （Arcrun#190／#191 的安裝器修法）大幅改動。加在那裡會製造合併衝突，
 *   而本輪的紅線第一條就是「不准把 PR #170 卡住」。
 *
 * 這份測試問三件事，全部離線（fetch 與 KV 都是替身）：
 *   ① `/api/latest` 真的吐得出安裝器的號碼（不是「程式碼裡有寫」）
 *   ② 首頁的**可見文字**裡有那個號碼——leo 07-29 的判準是「版本號寫在按鈕裡面」，
 *      而 2026-08-13 那次的教訓正是「只寫在 hover title 裡，掃 innerText 找不到」
 *   ③ 那個號碼與 repo 裡的版本檔是同一個（不是另一份手抄本）
 *
 * 🔴 2026-09-01 第二輪（inkstone/arcrun-rag#169 comment 5959）加 ④⑤⑥：
 *   `/api/latest` 還有一格 `installer_sha`（「線上跑的是哪一份原始碼」），
 *   而它**答錯了**——prod 跑 1.0.3、uncle6 staging 跑 1.0.4，兩條線回同一串 `5ada702b…`，
 *   兩個都對不上 main 的 `bc899878…`。病根是它讀 `env.INSTALLER_SRC_SHA`
 *   （住 wrangler.toml 的 vars），只有出貨線的 pin 站會寫，而手部署不經過那一站、
 *   `ship.targets.json` 裡也沒有 youlin-stage 這條線。
 *   ⇒ ④⑤⑥ 守的是「那條靠人記得的路不准長回來」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import worker, { homePage } from './worker.js';
import { INSTALLER_VERSION, INSTALLER_SRC_SHA } from './version.mjs';
import { installerFingerprint } from '../scripts/installer-line.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** 這份 manifest 是給 releaseOf／daemonOf／manifestCountsOf 吃的最小可用形狀。 */
const MANIFEST = {
  schema: 'arcrun-rag-bundles/v1',
  release: '1.4.63',
  built: '2026-08-29',
  core: [{ name: 'arcrun-rag-ui', main_file: 'ui.js', sha256: 'x', requires: {} }],
  daemon: { version: '0.18.49', notes: '修了一些東西', downloads: { mac: 'https://x/mac.dmg', win: 'https://x/win.exe' } },
};

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real; });
}
const manifestFetch = async () => new Response(JSON.stringify(MANIFEST), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('① /api/latest 吐得出安裝器那條線（實際呼叫，不是讀原始碼）', () => withFetch(manifestFetch, async () => {
  // `/api/latest` 本身不碰 KV，但 fetch 進來的第一道檢查要求有這個 binding
  // （沒有就整站回 500「安裝器還沒設定好」）⇒ 給一個空殼即可。
  const env = { INSTALLER_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
  const res = await worker.fetch(new Request('https://install.example/api/latest'), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.installer, { version: INSTALLER_VERSION },
    '/api/latest 少了 installer.version ⇒ 出貨線的 release-check 與 verify 兩站都會判這一版沒送達');
  // 三條線並排——這就是 release-line-gate 讀的那份「交付面」。
  assert.equal(body.release, '1.4.63');
  assert.equal(body.daemon.version, '0.18.49');
  assert.match(body.installer.version, /^\d+\.\d+\.\d+$/, '對外號就是三個數字（leo 2026-08-17「不要 v」）');
}));

test('② 安裝頁的可見文字裡就有那個號碼（不是只在 hover title 或摺疊區裡）', () => withFetch(manifestFetch, async () => {
  // homePage 回的是 HTML 字串（pageShell 的產物），不是 Response。
  const html = await homePage(null, {}, '1.4.63');

  // 按鈕本體（`<button …>…</button>` 之間），不是它的 title 屬性。
  const button = (html.match(/<button class="btn" type="submit"[^>]*>([\s\S]*?)<\/button>/) || [])[1] || '';
  assert.ok(button.includes(INSTALLER_VERSION),
    `按鈕上看不到安裝器版本（按鈕內容：${button.slice(0, 120)}）\n`
    + '2026-08-13 那次就是只補在摺疊的「技術細節」裡 ⇒ 三週後它停在一個手打字串而沒人發現。');
  assert.ok(button.includes('1.4.63'), '零件包版本仍要在（兩條線並排，leo 才分得出誰是誰）');

  // 摺疊區之前就要出現一次——`<details>` 之後才有的話，等於還是藏著。
  const beforeDetails = html.split('<details>')[0];
  assert.ok(beforeDetails.includes(INSTALLER_VERSION), '安裝器版本只出現在摺疊區裡 ⇒ 等於沒露出');

  // 舊的手填字串不准再出現在畫面上（它還在原始碼裡是刻意的：改那一行會跟 PR #170 衝突）。
  assert.ok(!html.includes('2026-08-10b'),
    '畫面上還印著手填的 INSTALLER_PATCH ⇒ 兩個版本字串同時是真相，而其中一個永遠不會更新');
}));

test('③ 頁面吐的號碼＝repo 裡那份版本檔（不是第二份手抄本）', () => {
  const src = readFileSync(join(REPO_ROOT, 'installer', 'oauth-prototype', 'version.mjs'), 'utf8');
  const declared = (src.match(/export const INSTALLER_VERSION = '([^']+)'/) || [])[1];
  assert.equal(INSTALLER_VERSION, declared);
  // changelog 裡有這一版（出貨線兩道閘問的就是這件事，這裡先在單元層釘一次）
  const log = readFileSync(join(REPO_ROOT, 'installer', 'CHANGELOG.md'), 'utf8');
  assert.ok(new RegExp(`^##\\s+${declared.replace(/\./g, '\\.')}(\\D|$)`, 'm').test(log),
    `installer/CHANGELOG.md 沒有 ${declared} 這一版`);
});

test('④ /api/latest 的 installer_sha ＝ 線上這棵樹的指紋（實算，不是讀宣告）', () => withFetch(manifestFetch, async () => {
  const env = { INSTALLER_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
  const res = await worker.fetch(new Request('https://install.example/api/latest'), env, {});
  const body = await res.json();
  assert.equal(body.installer_sha, INSTALLER_SRC_SHA, 'installer_sha 要是本 worker import 的那個常數');
  assert.equal(body.installer_sha, installerFingerprint(import.meta.dirname),
    '線上回的識別值對不上這棵樹 ⇒ 它是一個「看起來像答案、實際是別份碼」的欄位（#169 comment 5959）');
  assert.match(String(body.installer_sha), /^[0-9a-f]{64}$/);
}));

test('⑤ 部署參數塞一個假的識別值，也蓋不掉真的（那條靠人記得的路不准長回來）', () => withFetch(manifestFetch, async () => {
  const env = {
    INSTALLER_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    // 這就是 2026-09-01 之前線上實際的值：兩條線共用一串、兩個都不是自己那份碼。
    INSTALLER_SRC_SHA: '5ada702b0d3f3baed7f6141e129bdb270f15b5a2669a98a666bb74d35e3f951f',
  };
  const res = await worker.fetch(new Request('https://install.example/api/latest'), env, {});
  const body = await res.json();
  assert.equal(body.installer_sha, INSTALLER_SRC_SHA,
    'env 蓋得掉的話，「手部署忘了改那一格」這個破口就還在——而它就是本輪要治的病');
  assert.notEqual(body.installer_sha, env.INSTALLER_SRC_SHA);
}));

test('⑥ wrangler.toml 不准再宣告 INSTALLER_SRC_SHA（不留第二份手抄本）', () => {
  const toml = readFileSync(join(import.meta.dirname, 'wrangler.toml'), 'utf8');
  assert.ok(!/^\s*INSTALLER_SRC_SHA\s*=/m.test(toml),
    'wrangler.toml 又長出 INSTALLER_SRC_SHA ⇒ 同一個事實有兩份真相，而部署參數那一份靠人記得填 '
    + '⇒ 它一定會過期（2026-09-01 實測：三處手填值，兩處是別份碼的、一處是舊版的）');
  // worker 也不准回頭去讀它——註解會過期，這一條不會。
  const js = readFileSync(join(import.meta.dirname, 'worker.js'), 'utf8');
  assert.ok(!/env\s*&&\s*env\.INSTALLER_SRC_SHA|env\.INSTALLER_SRC_SHA\s*\?/.test(js),
    'worker.js 又從 env 讀識別值 ⇒ 部署腳本宣告的期望值會再度冒充「線上實際跑的那份」');
});
