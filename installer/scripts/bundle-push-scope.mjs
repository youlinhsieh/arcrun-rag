/**
 * bundle-push-scope.mjs — 出貨線推 bundle repo 時，只准推「manifest 指到的 daemon/ 檔」。
 *
 * 背景（inkstone/arcrun-rag#265，2026-10-11 實況）：
 *   0.18.103 那輪中止（安裝器 changelog），改出 0.18.104。stage bundle repo
 *   （~/.arcrun-ship/bundles-stage）未推的 commit 同時帶 103 和 104 的 dmg／msix／exe，
 *   約 84 MB，push 經 Cloudflare 前的 Gitea 連四次 HTTP 524（100 秒逾時）。
 *   總管手動把 103 三檔移出 commit 後 76 秒推上。
 *
 * 根因：`daemon-sync` 是「只加不刪」，commit 站 `git add -A`；一輪中止後，上一個沒出成的
 *   版號產物留在工作區（或已 commit 但沒推）⇒ 下一輪全部一起帶上去。
 *
 * 判準：待推內容裡**新增**（A／untracked）的 `daemon/` 檔，必須被 manifest.daemon 指到。
 *   已經在遠端的舊版檔（prod 留著 20 個）不在「待推」範圍，絕不碰——「只加不刪」不變。
 *   沒被指到的新增檔 ＝ 上一個沒出成的版號 ⇒ 移到 `<bundlesDir>.unshipped/`（不刪，人可撿回）。
 *
 * 零依賴；git 呼叫都走注入的 `git(args, stdin?)`，測試用真的臨時 repo。
 */
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Gitea 前面那層 Cloudflare 的上傳逾時上限（秒）——超過就回 524。 */
export const GATEWAY_TIMEOUT_SECONDS = 100;

/** manifest.daemon 裡所有指向 `daemon/…` 的路徑（不寫死 mac/win/msix，新平台自動算進來）。 */
export function manifestDaemonFiles(manifest) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith('daemon/')) out.add(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(manifest && manifest.daemon);
  return out;
}

/** 從一串「待推新增的路徑」挑出 daemon/ 底下、manifest 沒指到的。 */
export function strayDaemonPaths(addedPaths, manifest) {
  const keep = manifestDaemonFiles(manifest);
  return addedPaths.filter((p) => p.startsWith('daemon/') && !keep.has(p));
}

const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

function committedAdded(git, remoteRef) {
  return lines(git(['diff', '--name-only', '--diff-filter=A', `${remoteRef}..HEAD`]));
}

/** 待推範圍內「新增」的路徑：未推 commit 新增的 ＋ 工作區 untracked。 */
export function pendingAddedPaths(git, remoteRef) {
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
  return [...new Set([...committedAdded(git, remoteRef), ...untracked])];
}

/**
 * 把「上一個沒出成的版號產物」移出待推內容。
 * @returns {{ moved: string[], rewrote: boolean, destDir: string|null }}
 *   rewrote＝動到了未推的 commit（soft reset 後重 commit，只改未推歷史，遠端不受影響）
 */
export function pruneStrayDaemon({ git, bundlesDir, manifest, remoteRef }) {
  const committedStrays = strayDaemonPaths(committedAdded(git, remoteRef), manifest);
  const strays = strayDaemonPaths(pendingAddedPaths(git, remoteRef), manifest);
  if (strays.length === 0) return { moved: [], rewrote: false, destDir: null };

  let rewrote = false;
  if (committedStrays.length > 0) {
    const msg = git(['log', '-1', '--format=%B']).trim();
    git(['reset', '--soft', remoteRef]);
    git(['rm', '--cached', '-q', '--', ...committedStrays]);
    // 摘完若已無內容可推（待推的全是舊版號產物），就不留空 commit
    if (lines(git(['diff', '--cached', '--name-only'])).length > 0) {
      git(['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m', msg]);
    }
    rewrote = true;
  }
  const destDir = `${bundlesDir}.unshipped`;
  for (const rel of strays) {
    const from = join(bundlesDir, rel);
    if (!existsSync(from)) continue;
    const to = join(destDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  return { moved: strays, rewrote, destDir };
}

/** 待推內容的位元組數（未推 commit 帶進來的所有 object 大小加總）。 */
export function pendingPushBytes(git, remoteRef) {
  const objs = lines(git(['rev-list', '--objects', '--no-object-names', `${remoteRef}..HEAD`]));
  if (objs.length === 0) return 0;
  const sizes = lines(git(['cat-file', '--batch-check=%(objectsize)'], objs.join('\n') + '\n'));
  return sizes.reduce((a, n) => a + Number(n || 0), 0);
}

export function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** push 失敗的輸出像不像閘道逾時（Cloudflare 524／代理 5xx／傳輸被切）。 */
export function looksLikeGatewayTimeout(text) {
  return /\b52[0-9]\b|\b50[234]\b|RPC failed|timed? ?out|unexpected disconnect|hung up/i.test(String(text || ''));
}

/** 失敗訊息：把待推大小與 100 秒上限講出來，而不只是報 524。 */
export function describePushFailure({ bytes, original, remote }) {
  const size = formatMB(bytes);
  if (!looksLikeGatewayTimeout(original)) {
    return `推上 bundle repo 失敗（待推 ${size}）：\n${original}`;
  }
  return [
    `推上 bundle repo 逾時：待推 ${size}，而 ${remote || 'Gitea'} 前面的 Cloudflare 對單一請求只等 ${GATEWAY_TIMEOUT_SECONDS} 秒（超過就回 524）。`,
    `     → 先看待推內容是不是帶了不該帶的舊版產物：git -C <bundles> diff --stat origin/main..HEAD`,
    `       （出貨線已自動把「manifest 沒指到的新增 daemon/ 檔」移出待推；仍超大代表是這一版本身的量）`,
    `     → 網路慢到 ${size} 撐不過 ${GATEWAY_TIMEOUT_SECONDS} 秒時，把大檔拆成多次 push（逐 commit 推）。`,
    `     原始錯誤：${String(original).split('\n').slice(-4).join(' | ')}`,
  ].join('\n');
}
