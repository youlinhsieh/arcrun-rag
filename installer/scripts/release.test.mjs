/**
 * release.test.mjs — 證明「跨目標共用版本狀態」真的讓 stage／prod 兩個獨立 bundle repo
 * 對同一份內容算出同一個版本號（取代 promoteFrom 的版本繼承，D65 二次補述，arcrun-rag#73 缺③）。
 *
 * 跑法：node --test installer/scripts/release.test.mjs
 * （零依賴、全程用臨時目錄，不碰任何真的 bundle repo）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncManifest, readReleaseState, RELEASE_STATE_FILE } from './release.mjs';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一個最小可用的 bundle 目錄：一顆零件 + manifest.json。 */
function seedBundle(dir, { content, release, fingerprint, source = 'Arcrun@deadbee' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'comp.zip'), content);
  const manifest = {
    schema: 1,
    core: [{ name: 'comp', main_file: 'comp.zip', sha256: 'stale-placeholder', bytes: 0 }],
    source,
  };
  if (release) manifest.release = release;
  if (fingerprint) manifest.fingerprint = fingerprint;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

test('✅ 第一次啟用共用狀態（檔案還不存在）⇒ 用磁碟上這份 bundle 自己的舊值接手，不歸零', () => {
  const repoRoot = tempDir('release-test-repo-');
  const stageDir = tempDir('release-test-stage-');
  try {
    seedBundle(stageDir, { content: 'v1-content' });
    // 先用「舊行為」跑一次，讓這份 bundle 自洽（release/fingerprint 真的對應這份內容）——
    // 這就是「已經真的出過貨」的既有 bundle repo 現況，不是憑空捏造的測試資料。
    const first = syncManifest(stageDir, { repoRoot, quiet: true });
    assert.equal(first.release, '1.4.0'); // 全新 bundle，line.0 起跳，正常

    // 模擬「這份 bundle 早就出過好幾版，現在停在 1.4.33」：直接把它墊高，
    // 且 fingerprint 對應目前磁碟內容（自洽）。
    const m = manifestOf(stageDir);
    m.release = '1.4.33';
    writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(m, null, 1));

    // 還沒有任何 release-state.json ⇒ 第一次打開共用狀態。
    assert.equal(readReleaseState(repoRoot), null);
    const boot = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });

    assert.equal(boot.release, '1.4.33', '接手磁碟上的舊版號，不能倒退回 1.4.0 或 1.4.1');
    const state = readReleaseState(repoRoot);
    assert.equal(state.release, '1.4.33');
    assert.equal(state.fingerprint, boot.fingerprint);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

test('✅ 兩個獨立 bundle repo（stage／prod），相同內容 ⇒ 拿到同一個版本號（即使各自歷史不同）', () => {
  const repoRoot = tempDir('release-test-repo-');
  const stageDir = tempDir('release-test-stage-');
  const prodDir = tempDir('release-test-prod-');
  try {
    // stage：這期間已經重跑很多次，自己的版本史墊到 1.4.33。
    seedBundle(stageDir, { content: 'shared-content-A', release: '1.4.32', fingerprint: 'stale' });
    const stageRun = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });
    assert.equal(stageRun.release, '1.4.33', 'stage 是新內容 ⇒ 從 1.4.32 bump 到 1.4.33');

    // prod：完全獨立的 bundle repo，自己的版本史還停在很久以前的 1.4.20——
    // 舊機制（各自比自己的歷史）會讓 prod 算出自己的號碼；新機制要讓它拿到
    // 跟 stage **一模一樣**的號碼，因為內容一模一樣。
    seedBundle(prodDir, { content: 'shared-content-A', release: '1.4.20', fingerprint: 'also-stale' });
    const prodRun = syncManifest(prodDir, { repoRoot, sharedState: true, quiet: true });

    assert.equal(prodRun.release, '1.4.33', 'prod 內容跟 stage 一樣 ⇒ 必須拿到 stage 那個號碼，不是自己累計出 1.4.21');
    assert.equal(prodRun.fingerprint, stageRun.fingerprint);
    assert.equal(manifestOf(prodDir).built, manifestOf(stageDir).built, '同一份內容不准有兩個建置日');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(prodDir, { recursive: true, force: true });
  }
});

test('🔴 內容真的不一樣 ⇒ 版本號也不一樣（不是無論如何都對齊）', () => {
  const repoRoot = tempDir('release-test-repo-');
  const stageDir = tempDir('release-test-stage-');
  const prodDir = tempDir('release-test-prod-');
  try {
    seedBundle(stageDir, { content: 'content-X', release: '1.4.10', fingerprint: 'x' });
    const stageRun = syncManifest(stageDir, { repoRoot, sharedState: true, quiet: true });

    seedBundle(prodDir, { content: 'content-Y-different', release: '1.4.10', fingerprint: 'y' });
    const prodRun = syncManifest(prodDir, { repoRoot, sharedState: true, quiet: true });

    assert.notEqual(prodRun.release, stageRun.release, '內容不同就該是不同版本號——共用狀態不是把兩邊硬黏在一起');
    assert.notEqual(prodRun.fingerprint, stageRun.fingerprint);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(prodDir, { recursive: true, force: true });
  }
});

test('sharedState:false（預設）＝舊行為，只跟自己的 manifest 比，不碰 release-state.json', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-selftest-');
  try {
    seedBundle(dir, { content: 'c', release: '1.4.5', fingerprint: 'stale' });
    syncManifest(dir, { repoRoot, quiet: true }); // sharedState 預設 false
    assert.equal(existsSync(join(repoRoot, RELEASE_STATE_FILE)), false, '不開共用狀態就不該生出這個檔案');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('冪等：同一個 bundle 用共用狀態重跑，版本號與建置日都不變', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedBundle(dir, { content: 'stable-content' });
    const r1 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    const r2 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    assert.equal(r1.release, r2.release);
    assert.equal(manifestOf(dir).built, manifestOf(dir).built);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #141：工作流／skill 改了，版本號必須跳 ───────────────────────────────────
// 這三個測試釘的是**病本身**，不是實作：
//   「一顆 worker 的 bytes 都沒動，但使用者實例上被種下去的東西變了」
//   這種改動以前**完全不會讓 1.4.x 動** ⇒ portal 對既有用戶說「已是最新版」
//   ⇒ 按鈕不出現 ⇒ 修法永遠到不了他手上，而且沒有任何畫面會顯示異常。

/** 在假 repoRoot 底下擺一份實例酬載（安裝器會種進使用者實例的那些）。 */
function seedPayload(repoRoot, { workflows = '[]', skills = '[]' } = {}) {
  const dir = join(repoRoot, 'installer', 'oauth-prototype');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflows.json'), workflows);
  writeFileSync(join(dir, 'skills.json'), skills);
}

test('🔴 #141 worker 一個位元都沒動、只有工作流改了 ⇒ release 仍然要 bump', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedBundle(dir, { content: 'worker-bytes-never-change' });
    seedPayload(repoRoot, { workflows: '[{"name":"rag_takedown_direct","v":1}]' });
    const before = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });

    // 只動工作流（bundle 目錄一個檔都沒碰）——這就是 2026-09-20 那三筆修法的形狀。
    seedPayload(repoRoot, { workflows: '[{"name":"rag_takedown_direct","v":2}]' });
    const after = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });

    assert.notEqual(after.release, before.release, '工作流變了卻不跳號＝portal 會說「已是最新版」');
    assert.equal(after.release, '1.4.1');
    assert.notEqual(manifestOf(dir).payload_fingerprint, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#141 工作流沒變就不虛增：重跑同一份酬載，版本號不動', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedBundle(dir, { content: 'same' });
    seedPayload(repoRoot, { workflows: '[{"name":"a"}]' });
    const r1 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    const r2 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    assert.equal(r1.release, r2.release);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 #141 repoRoot 給錯（讀不到酬載）不准靜默通過——verifyManifest 當場紅', async () => {
  const { verifyManifest } = await import('./release.mjs');
  const repoRoot = tempDir('release-test-repo-');
  const wrongRoot = tempDir('release-test-wrong-');
  const dir = tempDir('release-test-stage-');
  try {
    seedBundle(dir, { content: 'x' });
    seedPayload(repoRoot, { workflows: '[{"name":"a"}]' });
    syncManifest(dir, { repoRoot, sharedState: true, quiet: true });

    assert.deepEqual(verifyManifest(dir, { repoRoot }), [], '對的 repoRoot 要全綠');
    const problems = verifyManifest(dir, { repoRoot: wrongRoot });
    assert.ok(problems.some((p) => p.includes('讀不到')),
      '讀不到酬載卻通過＝版本號會無聲倒退成只認 worker 的舊算法');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(wrongRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 🔴 #141 向後相容：**沒有酬載時，指紋要跟 2026-09-20 之前逐位元相同** ──────
// 為什麼這一條要有獨立測試（總管審查時最在意的就是它）：
//   指紋一變，**每一台既有實例都會被判成「有新版」**——那是另一種說謊
//   （把人騙去重裝一份內容一模一樣的東西，正是 installer-line.mjs 檔頭禁的那件事）。
//   所以「payload 為空 ⇒ 不加任何後綴」不是實作細節，是**契約**。
//   這裡把 2026-09-20 之前那份實作**逐字複製**進來當對照組，兩邊必須永遠相等。
test('🔴 #141 向後相容：payload 為空時，指紋與改動前的舊演算法逐位元相同', async () => {
  const { contentFingerprint } = await import('./release.mjs');
  const { createHash } = await import('node:crypto');

  /** 2026-09-20 之前的實作，逐字複製自 `gitea/main:installer/scripts/release.mjs`。 */
  const legacyFingerprint = (core) => createHash('sha256')
    .update([...core].map((c) => `${c.name}:${c.sha256}`).sort().join('|'))
    .digest('hex');

  const samples = [
    [],
    [{ name: 'arcrun-kbdb', sha256: 'aa11' }],
    [{ name: 'b', sha256: '2' }, { name: 'a', sha256: '1' }],           // 順序不同也要一樣
    Array.from({ length: 23 }, (_, i) => ({ name: `w${i}`, sha256: `${i}`.repeat(8) })),
  ];
  for (const core of samples) {
    assert.equal(contentFingerprint(core), legacyFingerprint(core),
      '沒有酬載時指紋變了 ⇒ 每一台既有實例都會被誤報「有新版」');
    assert.equal(contentFingerprint(core, ''), legacyFingerprint(core), '明寫空字串也要相同');
  }

  // 反面：有酬載時**必須**不一樣，否則整張票等於沒修
  assert.notEqual(contentFingerprint(samples[1], 'deadbeef'), legacyFingerprint(samples[1]));
});

// ── inkstone/arcrun-rag#353：只換 daemon（雲端零件沒動）也要出新的 release 號 ─────────────
function seedDaemonBundle(dir, daemonVersion) {
  seedBundle(dir, { content: 'cloud-parts-unchanged' });
  const m = manifestOf(dir);
  m.daemon = { version: daemonVersion };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
}

test('🔴 #353 雲端零件一個位元都沒動、只有 daemon 版本變 ⇒ release 必須跳號（同版號不換包）', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    writeFileSync(join(repoRoot, 'RELEASE_LINE'), '1.4\n');
    seedDaemonBundle(dir, '0.18.123');
    const r1 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    const r1again = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    assert.equal(r1again.release, r1.release, 'daemon 沒變就不虛增');
    const m = manifestOf(dir); m.daemon = { version: '0.18.124' };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
    const r2 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    assert.notEqual(r2.release, r1.release, '只換 daemon 卻沒跳號 ⇒ 同一個版號換了包');
    assert.equal(manifestOf(dir).fingerprint_daemon, '0.18.124');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 #353 verifyManifest：只改 daemon 版本沒跑 syncManifest ⇒ 當場紅', async () => {
  const { verifyManifest } = await import('./release.mjs');
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedDaemonBundle(dir, '0.18.123');
    syncManifest(dir, { repoRoot, quiet: true });
    assert.deepEqual(verifyManifest(dir, { repoRoot }).filter((p) => /daemon 版本變了/.test(p)), []);
    const m = manifestOf(dir); m.daemon = { version: '0.18.124' };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
    assert.ok(verifyManifest(dir, { repoRoot }).some((p) => /daemon 版本變了但 release 沒 bump/.test(p)));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 #353 向後相容：#353 之前出的簽核舊版（指紋沒算 daemon）仍能重出，且不被覆蓋成新指紋', async () => {
  const { contentFingerprint } = await import('./release.mjs');
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedDaemonBundle(dir, '0.18.123');
    syncManifest(dir, { repoRoot, quiet: true });
    const core = manifestOf(dir).core;
    const legacy = contentFingerprint(core, '', '');
    const r = syncManifest(dir, { repoRoot, quiet: true, signed: { release: '1.4.255', fingerprint: legacy, built: '2026-11-21' } });
    assert.equal(r.release, '1.4.255');
    assert.equal(r.fingerprint, legacy);
    assert.equal(manifestOf(dir).fingerprint_daemon, undefined);
    assert.throws(() => syncManifest(dir, { repoRoot, quiet: true, signed: { release: '1.4.255', fingerprint: 'x'.repeat(64), built: 'b' } }));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#353 沒有 daemon 版本時指紋與舊式子逐位元相同', async () => {
  const { contentFingerprint } = await import('./release.mjs');
  const core = [{ name: 'a', sha256: '1' }];
  assert.equal(contentFingerprint(core, 'p', ''), contentFingerprint(core, 'p'));
  assert.notEqual(contentFingerprint(core, '', '0.18.124'), contentFingerprint(core, ''));
});

// ── inkstone/Arcrun#471：只換 App（AHub 0.50→0.53，core 與 daemon 沒動）也要出新的 release 號 ─────
test('🔴 #471 core 與 daemon 一個位元都沒動、只有 App 市集目錄變 ⇒ release 必須跳號', () => {
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    writeFileSync(join(repoRoot, 'RELEASE_LINE'), '1.4\n');
    seedDaemonBundle(dir, '0.18.124');
    const r1 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true, appsFingerprint: 'apps-A' });
    const again = syncManifest(dir, { repoRoot, sharedState: true, quiet: true, appsFingerprint: 'apps-A' });
    assert.equal(again.release, r1.release, '目錄沒變就不虛增');
    const r2 = syncManifest(dir, { repoRoot, sharedState: true, quiet: true, appsFingerprint: 'apps-B' });
    assert.notEqual(r2.release, r1.release, '只換 App 卻沒跳號 ⇒ 同一個版號換了包（AHub 0.50→0.53 就是這樣靜默出貨）');
    assert.equal(manifestOf(dir).fingerprint_apps, 'apps-B');
    // 沒帶（單跑 build-bundles 之類）＝沿用上次記的，不誤跳號也不丟欄位
    const kept = syncManifest(dir, { repoRoot, sharedState: true, quiet: true });
    assert.equal(kept.release, r2.release);
    assert.equal(manifestOf(dir).fingerprint_apps, 'apps-B');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 #471 向後相容：App 指紋為空 ⇒ 與舊式子逐位元相同；簽核舊版（沒算 App）仍能重出', async () => {
  const { contentFingerprint } = await import('./release.mjs');
  const core = [{ name: 'a', sha256: 'x' }];
  assert.equal(contentFingerprint(core, 'p', '0.18.1', ''), contentFingerprint(core, 'p', '0.18.1'));
  assert.notEqual(contentFingerprint(core, 'p', '0.18.1', 'apps'), contentFingerprint(core, 'p', '0.18.1'));
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedDaemonBundle(dir, '0.18.124');
    const m0 = manifestOf(dir);
    const core0 = syncManifest(dir, { repoRoot, quiet: true }); // 這份 bundle 自洽的舊指紋（沒算 App）
    const signed = { release: '1.4.77', fingerprint: core0.fingerprint, built: '2026-11-20' };
    const r = syncManifest(dir, { repoRoot, quiet: true, signed, appsFingerprint: 'apps-NEW' });
    assert.equal(r.release, '1.4.77');
    assert.equal(r.fingerprint, signed.fingerprint, '對不上新式子就退回舊式子比對，且不把新指紋寫成簽核版的指紋');
    assert.equal(manifestOf(dir).fingerprint_apps, undefined);
    void m0;
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 #471 verifyManifest：manifest 記了 App 指紋，驗算照它', async () => {
  const { verifyManifest } = await import('./release.mjs');
  const repoRoot = tempDir('release-test-repo-');
  const dir = tempDir('release-test-stage-');
  try {
    seedDaemonBundle(dir, '0.18.124');
    syncManifest(dir, { repoRoot, quiet: true, appsFingerprint: 'apps-A' });
    assert.deepEqual(verifyManifest(dir, { repoRoot }).filter((p) => /指紋不符/.test(p)), []);
    const m = manifestOf(dir); m.fingerprint_apps = 'apps-TAMPERED';
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
    assert.ok(verifyManifest(dir, { repoRoot }).some((p) => /指紋不符/.test(p)));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
