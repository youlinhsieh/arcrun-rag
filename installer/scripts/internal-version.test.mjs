/**
 * internal-version.test.mjs — 內部號與「內外對應」段落（inkstone/arcrun-rag#88）
 * 跑法：node --test installer/scripts/internal-version.test.mjs
 *
 * 這支釘住的判準是 leo 2026-08-18 那句：
 * 「**看到一個號碼，不必查任何東西就知道它是內是外。**」
 * 以及「對應關係記在該次發佈的 release note，**不靠號碼本身編碼**」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERNAL_VERSION_RE, MAPPING_HEADING, shortCodeFor, dateStamp,
  formatInternalVersion, nextSequence, mappingSection, withMappingSection, mappingIn,
} from './internal-version.mjs';

const ART = ['daemon/Arcrun-0.18.29.dmg'];
const D = new Date(2026, 7, 17); // 2026-08-17（月份 0 起算）

test('形狀：內部號與對外號長得完全不一樣（一眼分辨，不必查表）', () => {
  const internal = formatInternalVersion({
    repoName: 'arcrun-rag', commit: 'dcd0132abc', sequence: 2, artifacts: ART, date: D,
  });
  assert.equal(internal, 'RAG-20260817-002-dcd0132');
  assert.match(internal, INTERNAL_VERSION_RE);
  // 對外號是三個數字——兩者不可能互相誤認，這正是規約要的
  assert.ok(!INTERNAL_VERSION_RE.test('1.4.47'));
  assert.ok(!INTERNAL_VERSION_RE.test('0.18.29'));
});

test('🔴 沒有成品就算不出內部號（leo：「內部每次就要出貨 bundle 的版本」）', () => {
  assert.throws(
    () => formatInternalVersion({ repoName: 'arcrun-rag', commit: 'dcd0132', sequence: 1, artifacts: [], date: D }),
    /沒有對應任何成品/,
  );
  assert.throws(
    () => formatInternalVersion({ repoName: 'arcrun-rag', commit: 'dcd0132', sequence: 1, date: D }),
    /沒有對應任何成品/,
  );
});

test('短碼是明列的表，不自動推導（推導規則一改，同一個 repo 會有兩種短碼）', () => {
  assert.equal(shortCodeFor('arcrun-rag'), 'RAG');
  assert.equal(shortCodeFor('arcrun'), 'ARC');
  assert.throws(() => shortCodeFor('some-new-repo'), /不認得 repo/);
});

test('commit 不是 sha 就拒絕——內部號要能一路查回那顆 commit', () => {
  assert.throws(
    () => formatInternalVersion({ repoName: 'arcrun-rag', commit: 'main', sequence: 1, artifacts: ART, date: D }),
    /不是 sha/,
  );
});

test('序號從「現有 release 內文」算，不自己養一本會漂的帳', () => {
  const bodies = [
    '### 版本對應\n- **內部版本**：`RAG-20260817-001-aaaaaaa`',
    '### 版本對應\n- **內部版本**：`RAG-20260817-003-bbbbbbb`',
    '### 版本對應\n- **內部版本**：`RAG-20260816-009-ccccccc`', // 昨天的，不算
    '### 版本對應\n- **內部版本**：`ARC-20260817-007-ddddddd`', // 別的 repo，不算
  ];
  assert.equal(nextSequence(bodies, 'RAG', '20260817'), 4);
  assert.equal(nextSequence(bodies, 'ARC', '20260817'), 8);
  assert.equal(nextSequence([], 'RAG', '20260817'), 1, '今天還沒出過就是第 1 版');
  assert.equal(nextSequence(bodies, 'RAG', '20260818'), 1, '換一天重新從 1 開始');
});

test('序號不被內文裡的其他數字干擾（只認完整形狀）', () => {
  const bodies = ['隨手寫的 1.4.47 與 2026-08-17 與 RAG-2026-1，都不是內部號'];
  assert.equal(nextSequence(bodies, 'RAG', '20260817'), 1);
});

test('對應段落：內外兩個號碼＋上游＋成品都在，且由機器產生', () => {
  const s = mappingSection({
    product: '桌面小幫手', external: '0.18.29', internal: 'RAG-20260817-002-dcd0132',
    upstream: 'Arcrun@cacaa33f7d4e', artifacts: ['daemon/Arcrun-0.18.29.dmg', 'daemon/Arcrun-win-0.18.29.exe'],
  });
  assert.ok(s.startsWith(MAPPING_HEADING));
  assert.match(s, /桌面小幫手 0\.18\.29/);
  assert.match(s, /RAG-20260817-002-dcd0132/);
  assert.match(s, /Arcrun@cacaa33f7d4e/);
  assert.match(s, /Arcrun-win-0\.18\.29\.exe/);
});

test('接到 changelog 後面：內容保留，且**冪等**（同一版重跑不長出兩張表）', () => {
  const body = '- 修了搜尋\n- 修了同步\n';
  const mapping = mappingSection({
    product: '桌面小幫手', external: '0.18.29', internal: 'RAG-20260817-002-dcd0132', artifacts: ART,
  });
  const once = withMappingSection(body, mapping);
  assert.match(once, /修了搜尋/);
  assert.match(once, /RAG-20260817-002-dcd0132/);
  const twice = withMappingSection(once, mapping);
  assert.equal(twice, once, '重跑不該再追加一份');
  assert.equal(twice.match(/### 版本對應/g).length, 1);
});

test('回頭查證：一筆 release 內文有沒有帶對應（不聽上一步說它加了）', () => {
  const mapping = mappingSection({
    product: '桌面小幫手', external: '0.18.29', internal: 'RAG-20260817-002-dcd0132', artifacts: ART,
  });
  assert.deepEqual(mappingIn(withMappingSection('x', mapping)),
    { ok: true, internal: 'RAG-20260817-002-dcd0132' });
  // 舊的、人手寫的 note：沒有對應段落 ⇒ 判為缺
  assert.deepEqual(mappingIn('- 修了搜尋'), { ok: false, internal: null });
});

test('dateStamp 補零（8 月 7 日不是 202687）', () => {
  assert.equal(dateStamp(new Date(2026, 7, 7)), '20260807');
});

test('🔴 內部號可能寫在 **tag 名字**上而不是內文裡（2026-08-17 那兩筆就是）', () => {
  // 實況：`inkstone/arcrun-rag` 上的 RAG-20260817-001-3219343／-002-dcd0132
  // 是總管手動建的，號碼在 tag_name，內文完全沒提。
  // ⇒ 呼叫端要把 tag 與內文**都餵進來**，只掃內文的話當天會從 1 重編、無聲撞號。
  const feed = [
    'RAG-20260817-002-dcd0132\n（內文沒有提到號碼）',
    'RAG-20260817-001-3219343\n（內文沒有提到號碼）',
    'v1.4.46\n一般的版本發佈',
  ];
  assert.equal(nextSequence(feed, 'RAG', '20260817'), 3, '看得到的事實有 001/002 ⇒ 下一個是 3');
  assert.equal(nextSequence(feed.map((f) => f.split('\n')[1]), 'RAG', '20260817'), 1,
    '（反證：只餵內文就會從 1 重編——這就是要餵 tag 的理由）');
});
