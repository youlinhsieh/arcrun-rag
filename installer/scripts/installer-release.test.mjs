/**
 * installer-release.test.mjs — 安裝器那筆**內部版本物件**的內容契約。
 *
 * 跑法：node --test installer/scripts/installer-release.test.mjs
 *
 * 這一組釘的是 leo 2026-09-02 那句話的可驗版本：
 *   「不獨立發版本，但那是用戶，**我不能沒有版本，內部所有開發都要有版本**」
 * 而「有版本」的定義不是「有一個 tag」，是**打得開、答得出問題**：
 *   ① 這一版改了什麼（使用者語言）
 *   ② 這是哪一份原始碼（commit ＋ `installer_sha`，線上會回同一串）
 *   ③ 怎麼驗（打開那個網址比對）
 *
 * 該擋的也要演練：**缺任何一格就不准建**——一筆寫著「未知」的版本物件比沒有更貴，
 * 因為它看起來像答案，leo 會拿它去對帳（CLAUDE.md：不准交出帶著不確定聲明的東西）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTALLER_TAG_PREFIX, SOURCE_HEADING, VERIFY_HEADING,
  installerReleaseTitle, installerReleaseBody, installerReleaseBodyProblems, deliveredProblem,
} from './installer-release.mjs';
import { releaseTagFor, tagPrefixFor } from './release-lines.mjs';

const OK = {
  version: '1.0.5',
  srcSha: '98213e3be28097cb73b1058377df85dd6285177cdd63d2bfced4b21836f31def',
  commit: '0fb45440ec2f0a1b1a2f3c4d5e6f70819a2b3c4d',
  repoSlug: 'inkstone/arcrun-rag',
  changelog: '- 安裝頁現在說得出自己是哪一版',
  liveUrl: 'https://arcrun-rag-installer-staging.uncle6-me.workers.dev',
  targetName: 'stage',
  bundleRelease: '1.4.63',
};

test('① 前綴與 release-lines 的宣告是同一件事（兩份不准各自漂）', () => {
  assert.equal(INSTALLER_TAG_PREFIX, tagPrefixFor('installer'));
  assert.equal(releaseTagFor('1.0.5', INSTALLER_TAG_PREFIX), 'installer-1.0.5');
});

test('② 標題：安裝器 <裸號>（零件包 <號>）——同 leo 2026-09-02 手動補開那筆的寫法', () => {
  assert.equal(installerReleaseTitle('1.0.5', { bundleRelease: '1.4.63' }), '安裝器 1.0.5（零件包 1.4.63）');
  assert.equal(installerReleaseTitle('1.0.5'), '安裝器 1.0.5');
  assert.throws(() => installerReleaseTitle(''), /沒有號碼/);
});

test('③ 內文答得出三件事：改了什麼／哪一份原始碼／怎麼驗', () => {
  const body = installerReleaseBody(OK);
  assert.match(body, /安裝頁現在說得出自己是哪一版/, '① 使用者語言那一段要在最上面');
  assert.ok(body.indexOf(OK.changelog) < body.indexOf(SOURCE_HEADING), 'changelog 要在技術細節之前');
  assert.match(body, new RegExp(SOURCE_HEADING));
  assert.match(body, new RegExp(VERIFY_HEADING));
  assert.match(body, /98213e3be28097cb73b1058377df85dd6285177cdd63d2bfced4b21836f31def/, '② 指紋要寫全（要拿去逐字元比對）');
  assert.match(body, /0fb4544/, '② commit 要在（票→PR→commit→version 那條鏈）');
  assert.match(body, /inkstone\/arcrun-rag/);
  assert.match(body, /1\.4\.63/, '同一趟出貨的零件包版本');
  assert.match(body, /arcrun-rag-installer-staging\.uncle6-me\.workers\.dev\/api\/latest/, '③ 驗法要給得出可以打的網址');
  assert.match(body, /內部版本物件/, '要講明這一面是對內的（leo：那是說不用告訴用戶）');
  assert.match(body, /沒有附檔是刻意的/, '沒有附檔要說明理由，否則下一個人會以為是漏掉了');
});

test('③b 沒有零件包版本時不硬寫一行（沒有的東西不編）', () => {
  const body = installerReleaseBody({ ...OK, bundleRelease: undefined });
  assert.equal(/同一趟出貨的零件包/.test(body), false);
  assert.deepEqual(installerReleaseBodyProblems(body, { version: OK.version, srcSha: OK.srcSha }), []);
});

test('④ 缺任何一格 ⇒ 丟，而且訊息指名缺哪一格（不補「未知」）', () => {
  for (const k of ['version', 'srcSha', 'commit', 'repoSlug', 'changelog', 'liveUrl', 'targetName']) {
    const bad = { ...OK, [k]: '' };
    assert.throws(() => installerReleaseBody(bad), new RegExp(k),
      `缺 ${k} 卻建得出來 ⇒ 會發出一筆答不出問題的版本物件`);
  }
});

test('⑤ 回頭查證：讀回來的內文缺哪一節都要報（不聽 create 說它成功了）', () => {
  const body = installerReleaseBody(OK);
  assert.deepEqual(installerReleaseBodyProblems(body, { version: '1.0.5', srcSha: OK.srcSha }), []);

  assert.match(installerReleaseBodyProblems('', {})[0], /內文是空的/);
  assert.match(
    installerReleaseBodyProblems(body.replace(SOURCE_HEADING, '### 別的'), { version: '1.0.5' }).join('\n'),
    /答不出這是哪一份原始碼/);
  assert.match(
    installerReleaseBodyProblems(body.replace(VERIFY_HEADING, '### 別的'), { version: '1.0.5' }).join('\n'),
    /沒有人知道怎麼驗/);
  // 🔴 最壞那種：頁面建好了，內文卻是**別一版**的（指紋對不上線上那份碼）
  assert.match(
    installerReleaseBodyProblems(body, { version: '1.0.5', srcSha: '5ada702b0d3f3baed7f6141e129bdb270f15b5a2669a98a666bb74d35e3f951f' }).join('\n'),
    /對不回線上那份碼/);
  assert.match(
    installerReleaseBodyProblems(body, { version: '1.0.9' }).join('\n'),
    /找不到版本號 1\.0\.9/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 送達之後才留紀錄——**測資是 2026-09-01 兩條線的真實回應，不是編的**
//   stage：installer 1.0.5｜98213e3b…（＝這棵樹）
//   prod ：installer 1.0.3｜5ada702b…（舊機制殘留的手填值）
//   ⇒ 拿 prod 的回應來建 1.0.5 的版本物件，內文會寫「這一版部到 <prod 網址>」而那是假的。
// ═══════════════════════════════════════════════════════════════════════════

const LIVE_STAGE = {
  release: '1.4.63',
  installer: { version: '1.0.5' },
  installer_sha: '98213e3be28097cb73b1058377df85dd6285177cdd63d2bfced4b21836f31def',
};
const LIVE_PROD = {
  release: '1.4.62',
  installer: { version: '1.0.3' },
  installer_sha: '5ada702b0d3f3baed7f6141e129bdb270f15b5a2669a98a666bb74d35e3f951f',
};

test('⑥ 線上就是這一版 ⇒ 放行（版本與指紋都逐字元相同）', () => {
  assert.equal(deliveredProblem({
    version: '1.0.5', srcSha: LIVE_STAGE.installer_sha, live: LIVE_STAGE, liveUrl: 'https://x',
  }), null);
});

test('⑥b 線上是別一版 ⇒ 中止，訊息把兩邊的值都印出來（不只說「對不上」）', () => {
  const p = deliveredProblem({
    version: '1.0.5', srcSha: LIVE_STAGE.installer_sha, live: LIVE_PROD, liveUrl: 'https://install.arcrun.dev',
  });
  assert.ok(p, 'prod 跑著 1.0.3，卻放行去建 1.0.5 的版本物件 ⇒ 建出一筆會騙人的紀錄');
  assert.match(p, /線上 1\.0\.3 ／ 這棵樹 1\.0\.5/);
  assert.match(p, /install\.arcrun\.dev/);
});

test('⑥c 號碼對但指紋不對 ⇒ 照樣中止（這是「兩條線回同一串 sha」那個病的形狀）', () => {
  const faked = { installer: { version: '1.0.5' }, installer_sha: LIVE_PROD.installer_sha };
  const p = deliveredProblem({
    version: '1.0.5', srcSha: LIVE_STAGE.installer_sha, live: faked, liveUrl: 'https://x',
  });
  assert.ok(p, '號碼一樣就放行 ⇒ 回到 comment 5959 量到的那個狀態：號碼對、跑的碼不對');
  assert.match(p, /指紋/);
});

test('⑥d 線上根本沒有 installer 那一格（舊碼）⇒ 中止，不當成「到了」', () => {
  const old = { release: '1.4.62', installer_sha: 'x' };
  const p = deliveredProblem({ version: '1.0.5', srcSha: 'y', live: old, liveUrl: 'https://x' });
  assert.ok(p);
  assert.match(p, /線上 \(無\)/);
});
