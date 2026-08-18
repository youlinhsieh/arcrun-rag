/**
 * release-line-gate.test.mjs — **閘自己要能被演練**。
 *
 * 跑法：node --test installer/scripts/release-line-gate.test.mjs
 *
 * 一道沒被演練過的閘等於沒有閘。所以這裡餵的**該擋**的輸入，全部是
 * 2026-08 真的發生過的狀態（不另外編一個「像 offender 的假東西」）：
 *   ① 2026-08-16 的實況：daemon v0.18.28 送出去了，產品頁只有 v1.4.46 → 要擋
 *   ② 2026-08-09 的實況：release 發在 CDN 倉庫（arcrun-rag-bundles）→ 要擋
 *   ③ 未來的破口：交付面多一條版本線，沒人宣告要發佈它 → 要擋
 *   ④ 兩條線都沒發 → 兩條都要點名（不是只報第一條）
 * **不該擋**的也要演練，否則它會變成第二支「關鍵字誤攔七次」的閘：
 *   ⑤ 兩條線都發了 → 放行
 *   ⑥ 舊 tag 帶 `v`（10 筆不回頭改）而新規範是裸號 → 兩種都算數，放行
 *   ⑦ manifest 裡的 `promoted_from.release`（長得像版本號的歷史帳）→ 不誤判成第三條線
 *   ⑧ 真的登錄簿（stage／prod）→ 落點檢查要過
 * 外加：留痕真的寫得出來（擋下與放行都要有一行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  linesFrom, versionFieldsIn, undeclaredVersionFields, tagMatches, bareVersion,
  releaseTagFor, releaseTitleFor, assetsFor,
} from './release-lines.mjs';
import {
  slugOfRemote, checkDestination, checkCoverage, checkPublished, runGate,
  appendGateLog, loadTargets,
} from './release-line-gate.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// 測資：真實 payload（2026-08-18 匿名實測 https://install.arcrun.dev/api/latest）
// ═══════════════════════════════════════════════════════════════════════════

/** 🔴 2026-08-18 實際回應（notes/downloads 節略，版本欄位一字不改）。 */
const LIVE_LATEST = {
  release: '1.4.46',
  pin: 'c63e86a',
  built: '2026-08-15',
  daemon: {
    version: 'v0.18.28',
    notes: '一指到資料夾，馬上就能問「裡面有什麼」（細節見說明文件）',
    downloads: {
      mac: 'https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/c63e86a/daemon/Arcrun-v0.18.28.dmg',
      win: 'https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/c63e86a/daemon/Arcrun-win-v0.18.28.exe',
    },
  },
  install_url: 'https://install.arcrun.dev/',
  installer_sha: 'eb3f3bd237a873a379b94910be01dda55b16e342ce430e78a5602fa57d5cae39',
};

/** 🔴 2026-08-18 匿名實測 youlinhsieh/arcrun-rag 的 9 筆 release tag（一字不改）。 */
const PRODUCT_TAGS_REAL = [
  'v1.4.46', 'v1.4.45', 'v1.4.44', 'v1.4.43', 'v1.4.42', 'v1.4.41', 'v1.4.36', 'v1.4.35', 'v1.4.33',
];

/** 產品 repo 的目標（正確落點）。 */
const T_PRODUCT = {
  bundles: { remote: 'github.com/youlinhsieh/arcrun-rag-bundles' },
  releaseRecord: { host: 'github', repoSlug: 'youlinhsieh/arcrun-rag' },
};

/** 🔴 2026-08-09 真的發生的落點：release 建在產物倉庫上。 */
const T_CDN = {
  bundles: { remote: 'github.com/youlinhsieh/arcrun-rag-bundles' },
  releaseRecord: { host: 'github', repoSlug: 'youlinhsieh/arcrun-rag-bundles' },
};

// ═══════════════════════════════════════════════════════════════════════════
// ① 2026-08-16 的實況：daemon 送出去了，產品頁沒有它
// ═══════════════════════════════════════════════════════════════════════════

test('① 實況重演：daemon v0.18.28 已送到使用者手上，產品頁只有 v1.4.46 ⇒ 擋', () => {
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: LIVE_LATEST, publishedTags: PRODUCT_TAGS_REAL,
  });
  assert.equal(r.ok, false, '這正是 2026-08-16 那趟 21 站全綠的出貨，本閘必須擋下它');
  const msg = r.sections.flatMap((s) => s.problems).join('\n');
  assert.match(msg, /桌面小幫手/);
  assert.match(msg, /v0\.18\.28/);
  // 零件包那條線是通的，不該被連坐點名
  assert.doesNotMatch(msg, /Arcrun RAG.*1\.4\.46.*沒有對應/s);
});

test('①b 同一份輸入，補上 daemon 的 release 之後 ⇒ 放行（閘有出路，不是永遠擋著）', () => {
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: LIVE_LATEST, publishedTags: [...PRODUCT_TAGS_REAL, '0.18.28'],
  });
  assert.equal(r.ok, true, r.sections.flatMap((s) => s.problems).join('\n'));
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 2026-08-09 的實況：發在 CDN 倉庫（舊判準下這是綠的）
// ═══════════════════════════════════════════════════════════════════════════

test('② 實況重演：版本發佈落在產物倉庫 ⇒ 擋（就算兩條線都「有發」）', () => {
  const r = runGate({
    targetName: 'prod', target: T_CDN,
    latestPayload: LIVE_LATEST,
    publishedTags: ['1.4.46', 'v0.18.28'],  // 兩條線都發了——只驗「有沒有發」會是綠的
  });
  assert.equal(r.ok, false, '「有發」不等於「發到對的地方」——這是四版無聲的真因');
  const msg = r.sections.flatMap((s) => s.problems).join('\n');
  assert.match(msg, /產物倉庫/);
  assert.match(msg, /arcrun-rag-bundles/);
});

test('②b 落點對了就不吭聲（不是看到 bundles 這個字就叫）', () => {
  // 產物倉庫的名字照樣出現在 target 裡，但 releaseRecord 指的是產品 repo ⇒ 要過。
  assert.equal(checkDestination('prod', T_PRODUCT).ok, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 未來的破口：多一條沒人負責發佈的版本線
// ═══════════════════════════════════════════════════════════════════════════

test('③ 交付面多一條版本線（例：MCP 外掛）而沒人宣告要發佈它 ⇒ 擋', () => {
  const payload = { ...LIVE_LATEST, mcp_plugin: { version: '2.0.1' } };
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: payload, publishedTags: [...PRODUCT_TAGS_REAL, '0.18.28'],
  });
  assert.equal(r.ok, false);
  assert.match(r.sections.flatMap((s) => s.problems).join('\n'), /mcp_plugin\.version = 2\.0\.1/);
});

test('④ 兩條線都沒發 ⇒ 兩條都要點名（不是報一條就閉嘴）', () => {
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: LIVE_LATEST, publishedTags: [],
  });
  assert.equal(r.ok, false);
  const msg = r.sections.flatMap((s) => s.problems).join('\n');
  assert.match(msg, /Arcrun RAG/);
  assert.match(msg, /桌面小幫手/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤⑥⑦ 不該擋的（這一組是防止本閘變成第二支「關鍵字誤攔」）
// ═══════════════════════════════════════════════════════════════════════════

test('⑤ 兩條線都發了 ⇒ 放行', () => {
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: LIVE_LATEST, publishedTags: ['1.4.46', '0.18.28'],
  });
  assert.equal(r.ok, true, r.sections.flatMap((s) => s.problems).join('\n'));
});

test('⑥ 過渡期兩種 tag 寫法並存（舊的帶 v、新的裸號）⇒ 都算數，不誤判成沒發', () => {
  // leo 2026-08-17：既有 10 個帶 v 的 tag 不回頭改，新的一律裸號。
  assert.equal(tagMatches('v1.4.46', '1.4.46'), true);
  assert.equal(tagMatches('1.4.46', 'v1.4.46'), true);
  assert.equal(tagMatches('v0.18.28', 'v0.18.28'), true);
  assert.equal(tagMatches('1.4.45', '1.4.46'), false);
  assert.equal(tagMatches('', ''), false, '空的不准互相對上（否則「沒版本」會變成「有發」）');
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: LIVE_LATEST, publishedTags: ['v1.4.46', 'v0.18.28'],
  });
  assert.equal(r.ok, true);
});

test('⑦ manifest 的 promoted_from.release 長得像版本號，但使用者讀不到 ⇒ 不當成第三條線', () => {
  // 這是本閘刻意不做「掃 manifest 找版本字串」的理由：那樣會誤擋。
  const manifestish = {
    release: '1.4.46',
    daemon: { version: 'v0.18.28' },
    promoted_from: { target: 'stage', release: '1.4.33', sha: 'aaa98a5' },
  };
  // 交付面（/api/latest）根本沒有 promoted_from ⇒ 用交付面判，天生就不會撞到它
  assert.deepEqual(undeclaredVersionFields(LIVE_LATEST), []);
  // 而就算有人把整份 manifest 餵進來，本閘也只在**它真的露在交付面**時才叫
  assert.equal(undeclaredVersionFields(manifestish).length, 1,
    '餵整份 manifest 就會撞到歷史帳 ⇒ 所以 CLI 只餵 /api/latest 的投影，這條斷言把那個前提釘住');
  assert.equal(linesFrom(manifestish, 'manifest').length, 2);
});

test('⑦b 版本欄位掃描不進陣列（零件庫每顆各自的版本不是「版本線」）', () => {
  const payload = { release: '1.4.46', core: [{ name: 'x', version: '9.9.9' }] };
  assert.deepEqual(versionFieldsIn(payload).map((f) => f.path), ['release']);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ 真的登錄簿：現行設定的落點檢查
// ═══════════════════════════════════════════════════════════════════════════

test('⑧ 真的 ship.targets.json：stage／prod 的版本發佈都不落在自己的產物倉庫', () => {
  const cfg = loadTargets();
  for (const name of ['stage', 'prod']) {
    const r = checkDestination(name, cfg.targets[name]);
    assert.equal(r.ok, true, `${name}：${r.problems.join('\n')}`);
  }
});

test('⑧b remote → slug 的擷取（含 Gitea 自架網域與沒有主機名的 selftest）', () => {
  assert.equal(slugOfRemote('github.com/youlinhsieh/arcrun-rag-bundles'), 'youlinhsieh/arcrun-rag-bundles');
  assert.equal(slugOfRemote('https://github.com/youlinhsieh/arcrun-rag-bundles.git'), 'youlinhsieh/arcrun-rag-bundles');
  assert.equal(slugOfRemote('git.uncle6.me/Leo/arcrun-rag-bundles-staging'), 'Leo/arcrun-rag-bundles-staging');
  assert.equal(slugOfRemote('local-selftest'), null);
  assert.equal(slugOfRemote(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ 命名規範（leo 2026-08-17：不要 v，標題＝產品名＋裸號）
// ═══════════════════════════════════════════════════════════════════════════

test('⑨ 新 release 的 tag 是裸號、標題是產品名＋裸號', () => {
  assert.equal(bareVersion('v0.18.29'), '0.18.29');
  assert.equal(releaseTagFor('v0.18.29'), '0.18.29');
  assert.equal(releaseTagFor('1.4.47'), '1.4.47');
  assert.equal(releaseTitleFor('桌面小幫手', 'v0.18.29'), '桌面小幫手 0.18.29');
  assert.equal(releaseTitleFor('Arcrun RAG', '1.4.47'), 'Arcrun RAG 1.4.47');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑩ 留痕（InkStoneCo#48：閘要記錄自己擋了什麼）
// ═══════════════════════════════════════════════════════════════════════════

test('⑩ 擋下與放行都會留下一行紀錄，且擋下的那行寫得出「擋了什麼」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlgate-log-'));
  const logPath = join(dir, 'installer', 'release-line-gate-log.md');
  try {
    const blocked = runGate({
      targetName: 'prod', target: T_PRODUCT,
      latestPayload: LIVE_LATEST, publishedTags: PRODUCT_TAGS_REAL,
    });
    const rowB = appendGateLog(logPath, { ts: '2026-08-18 12:00:00', targetName: 'prod', result: blocked });
    assert.match(rowB, /⛔ 擋下/);
    assert.match(rowB, /daemon v0\.18\.28/);
    assert.match(rowB, /每條版本線都已發佈/);

    const passed = runGate({
      targetName: 'prod', target: T_PRODUCT,
      latestPayload: LIVE_LATEST, publishedTags: ['1.4.46', '0.18.28'],
    });
    const rowP = appendGateLog(logPath, { ts: '2026-08-18 12:05:00', targetName: 'prod', result: passed });
    assert.match(rowP, /✅ 放行/);

    const text = readFileSync(logPath, 'utf8');
    assert.match(text, /^# release-line-gate 執行紀錄/);
    assert.equal(text.trim().split('\n').filter((l) => l.startsWith('| 2026-')).length, 2,
      '兩次執行要留兩行——只記擋下的話分母是未知的');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑪ 「檢查了 0 個卻通過」——假綠的經典形狀
// ═══════════════════════════════════════════════════════════════════════════

test('⑪ 交付面一條版本線都讀不到 ⇒ 不准當成「全過」', () => {
  const r = runGate({
    targetName: 'prod', target: T_PRODUCT,
    latestPayload: { install_url: 'https://install.arcrun.dev/' }, publishedTags: [],
  });
  // 沒有線可查 ⇒ checkPublished 不會有 problem，但 detail 必須誠實說「一條都沒對上」，
  // 且 lines 為空這件事要看得見（呼叫端 ship.mjs 據此中止，見該站註解）。
  assert.equal(r.lines.length, 0);
  assert.match(r.sections.map((s) => s.detail).join('\n'), /一條都沒對上|交付面版本線 0 條/);
});

// ── 每條線該掛哪些成品（inkstone/arcrun-rag#88，2026-08-18）────────────────
// leo 指著 release 頁問「assets 都寫 source code，這兩個附檔實際是什麼？是 dmg 還是 go？」
// ⇒ 「這一版的成品是什麼」要是每條線各自宣告的事實，不是猜的。

// 真的 manifest 的形狀（取自 2026-08-18 線上那份，含兩筆歷史遺留鍵）
const REAL_ISH = {
  release: '1.4.46',
  daemon: {
    version: '0.18.29',
    mac: { file: 'daemon/Arcrun-0.18.29.dmg' },
    win: { file: 'daemon/Arcrun-win-0.18.29.exe' },
    msix: { file: 'daemon/Arcrun-0.18.29.msix' },
    // 🔴 這兩筆釘在 0.15.7，是歷史遺留，**不該被掛到新版頁面上**
    mac_dmg: { file: 'daemon/ArcrunRAG-mac.dmg' },
    win_msix: { file: 'daemon/ArcrunRAG-v0.15.7.msix' },
  },
};

test('assetsFor：daemon 線掛三個當版成品，**不掛兩筆歷史遺留**', () => {
  const [, daemon] = linesFrom(REAL_ISH, 'manifest');
  assert.deepEqual(assetsFor(daemon, REAL_ISH), [
    'daemon/Arcrun-0.18.29.dmg',
    'daemon/Arcrun-win-0.18.29.exe',
    'daemon/Arcrun-0.18.29.msix',
  ]);
  const got = assetsFor(daemon, REAL_ISH).join('|');
  assert.ok(!got.includes('ArcrunRAG-mac.dmg'), '把 0.15.7 的舊檔掛上新版頁面＝點下去給錯東西');
  assert.ok(!got.includes('ArcrunRAG-v0.15.7.msix'));
});

test('assetsFor：零件包線掛 manifest（那就是「這一版裝了什麼」的定義）', () => {
  const [bundle] = linesFrom(REAL_ISH, 'manifest');
  assert.deepEqual(assetsFor(bundle, REAL_ISH), ['manifest.json']);
});

test('assetsFor：daemon 區塊缺檔案欄 → 回空陣列（呼叫端該擋，不是默默發空頁）', () => {
  const m = { release: '1.4.46', daemon: { version: '0.18.29' } };
  const [, daemon] = linesFrom(m, 'manifest');
  assert.deepEqual(assetsFor(daemon, m), []);
});
