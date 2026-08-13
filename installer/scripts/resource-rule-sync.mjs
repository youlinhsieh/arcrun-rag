#!/usr/bin/env node
/**
 * resource-rule-sync.mjs — 把上游 `Leo/Arcrun` 的 `shared/resource-rule/` 原封搬到
 * 安裝器 import 得到的位置（`installer/oauth-prototype/shared/resource-rule/`），
 * 並記下「這份是從哪顆 commit 的哪些位元組來的」。
 *
 * ── 為什麼需要這一步（而不是「安裝器直接 import 上游檔案」）─────────────────
 * 上游 README §4 說「安裝器不需要副本，本來就會下載 repo archive」——那句話對
 * `acr deploy` 那條路成立（它在本機有 Arcrun 工作區），但**對這顆安裝器不成立**：
 *
 *   · `installer/oauth-prototype/worker.js` 是一顆**裸 Worker**，`wrangler deploy` 時
 *     由 esbuild 把 `import` 的東西打進同一份 bundle。import 的路徑必須在**部署當下**
 *     的檔案系統上存在，而且是相對於這個 repo——不能指到機器上另一個 clone
 *     （`ship.targets.json` 的 `source.arcrunRepo` 是**那台機器**的路徑，換台機器就不成立）。
 *   · 安裝器**執行期**下載的 `arcrun-rag-bundles` 是**已編譯好的 worker 產物**，
 *     不含 `shared/`；而且 Workers runtime 沒有動態 import 遠端模組這回事。
 *
 * ⇒ 所以形態是「**建置期鏡射**」：跟上游自己給 `acr` 用的那份
 *   （`cli/src/lib/resource-rule/` ＋ `scripts/sync-resource-rule.mjs --check`）
 *   **完全同一個慣例**，理由也同一個（打包邊界跨不過去）。
 *
 * 🔴 這**不是**「抄一份邏輯」：
 *   · 逐位元組複製，人不准手改——改了 `--check` 就紅（`resource-rule-gate.mjs` 在出貨閘上跑）
 *   · 沒有任何一行是這裡寫的判斷；規則要改，改上游、重跑本腳本
 *   · 安裝器自己**不准**再有「照名字 ensure 資源」的實作——同一道閘會擋（offender 掃描）
 *
 * 用法：
 *   ARCRUN_REPO_ROOT=/path/to/Arcrun node installer/scripts/resource-rule-sync.mjs
 *   node installer/scripts/resource-rule-sync.mjs --check      # 只核對，不寫（出貨閘用）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');
/** 鏡射落點——worker.js 用相對路徑 `./shared/resource-rule/…` import 它。 */
export const MIRROR_DIR = join(REPO_ROOT, 'installer', 'oauth-prototype', 'shared', 'resource-rule');
/** 指紋清單：鏡射了哪顆 commit、每個檔的 sha256。`--check` 與出貨閘都讀它。 */
export const MANIFEST_PATH = join(MIRROR_DIR, 'MIRROR.json');
/** 上游那個目錄在 Arcrun repo 裡的位置。 */
export const UPSTREAM_REL = join('shared', 'resource-rule');

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 遞迴列出目錄下所有檔案（相對路徑，排序過）。MIRROR.json 自己不算在內。 */
export function listFiles(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else if (rel !== 'MIRROR.json') out.push(rel);
  }
  return out;
}

/** 找上游 Arcrun repo。順序：環境變數 → ship.targets.json 的 source.arcrunRepo → 常見並列位置。 */
export function findArcrunRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.ARCRUN_REPO_ROOT) candidates.push(process.env.ARCRUN_REPO_ROOT);
  try {
    const targets = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
    const declared = targets?.source?.arcrunRepo;
    if (declared) candidates.push(join(REPO_ROOT, declared));
  } catch { /* 登錄簿讀不到就只靠其他候選 */ }
  candidates.push(join(REPO_ROOT, '..', 'Arcrun'), join(REPO_ROOT, '..', '..', 'Arcrun'));
  for (const c of candidates) {
    if (existsSync(join(c, UPSTREAM_REL, 'rule.mjs'))) return c;
  }
  throw new Error(
    '找不到 Arcrun repo（要有 shared/resource-rule/rule.mjs）。\n' +
    `     找過：${candidates.join('、')}\n` +
    '     → 設 ARCRUN_REPO_ROOT=/path/to/Arcrun 再跑一次',
  );
}

function gitHead(repo) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 讀鏡射現況：`{ manifest, files: Map<rel, Buffer>, digests: Map<rel, sha256> }`。 */
export function readMirror(mirrorDir = MIRROR_DIR) {
  const files = new Map();
  const digests = new Map();
  for (const rel of listFiles(mirrorDir)) {
    const buf = readFileSync(join(mirrorDir, rel));
    files.set(rel, buf);
    digests.set(rel, sha256(buf));
  }
  let manifest = null;
  const mp = join(mirrorDir, 'MIRROR.json');
  if (existsSync(mp)) manifest = JSON.parse(readFileSync(mp, 'utf8'));
  return { manifest, files, digests };
}

/**
 * 核對鏡射與**指紋清單**是否相符（不需要 Arcrun repo 在場——出貨機以外的地方也驗得了）。
 * 回 `{ ok, problems[] }`，不丟例外：呼叫端決定要不要變成硬斷言（同 source-pin.mjs 慣例）。
 */
export function checkAgainstManifest(mirrorDir = MIRROR_DIR) {
  const problems = [];
  const { manifest, digests } = readMirror(mirrorDir);
  if (!manifest) {
    return { ok: false, problems: [`鏡射缺 MIRROR.json（${relative(REPO_ROOT, join(mirrorDir, 'MIRROR.json'))}）——沒有指紋就沒有閘。`] };
  }
  const expected = new Map(Object.entries(manifest.files || {}));
  for (const [rel, want] of expected) {
    const got = digests.get(rel);
    if (!got) problems.push(`鏡射少了檔案：${rel}（MIRROR.json 說它該在）`);
    else if (got !== want) {
      problems.push(
        `鏡射被改過：${rel}\n` +
        `       期望 sha256 ${want}\n` +
        `       實際 sha256 ${got}\n` +
        '       → 這個目錄是**上游 Arcrun shared/resource-rule/ 的逐位元組鏡射**，不准手改。\n' +
        '         要改規則就改上游，然後重跑 node installer/scripts/resource-rule-sync.mjs',
      );
    }
  }
  for (const rel of digests.keys()) {
    if (!expected.has(rel)) problems.push(`鏡射多了檔案：${rel}（MIRROR.json 沒有它——自己加檔進共用層＝第二份實作的入口）`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/**
 * 核對鏡射與**上游原始檔**是否逐位元組相同（要 Arcrun repo 在場；出貨機上跑）。
 * 回 `{ ok, problems[], head }`。
 */
export function checkAgainstUpstream(arcrunRoot, mirrorDir = MIRROR_DIR) {
  const problems = [];
  const srcDir = join(arcrunRoot, UPSTREAM_REL);
  const srcFiles = listFiles(srcDir);
  const { digests } = readMirror(mirrorDir);
  if (srcFiles.length === 0) problems.push(`上游 ${srcDir} 是空的——來源不對，拒絕比對。`);
  for (const rel of srcFiles) {
    const want = sha256(readFileSync(join(srcDir, rel)));
    const got = digests.get(rel);
    if (!got) problems.push(`鏡射少了上游的檔案：${rel} → 重跑 resource-rule-sync.mjs`);
    else if (got !== want) problems.push(`鏡射與上游不同：${rel}（上游 ${want.slice(0, 12)}… vs 鏡射 ${got.slice(0, 12)}…）→ 重跑 resource-rule-sync.mjs`);
  }
  for (const rel of digests.keys()) {
    if (!srcFiles.includes(rel)) problems.push(`鏡射多了上游沒有的檔案：${rel}`);
  }
  return { ok: problems.length === 0, problems, head: gitHead(arcrunRoot) };
}

/** 真的搬：整個目錄砍掉重建（多出來的檔案不會被留下），並寫 MIRROR.json。 */
export function syncMirror(arcrunRoot, mirrorDir = MIRROR_DIR) {
  const srcDir = join(arcrunRoot, UPSTREAM_REL);
  const srcFiles = listFiles(srcDir);
  if (srcFiles.length === 0) throw new Error(`上游 ${srcDir} 是空的，拒絕同步`);
  if (existsSync(mirrorDir)) rmSync(mirrorDir, { recursive: true });
  const files = {};
  for (const rel of srcFiles) {
    const buf = readFileSync(join(srcDir, rel));
    const dst = join(mirrorDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
    files[rel] = sha256(buf);
  }
  const manifest = {
    _: [
      '這個目錄是 Leo/Arcrun 的 shared/resource-rule/ 的逐位元組鏡射，由',
      'installer/scripts/resource-rule-sync.mjs 產生。**不准手改**。',
      '規則要改就改上游（Arcrun repo），然後重跑同步腳本；',
      'installer/scripts/resource-rule-gate.mjs 會在每次出貨的 preflight 核對這些指紋，對不上就拒絕出貨。',
    ],
    upstream: 'Leo/Arcrun',
    upstream_dir: 'shared/resource-rule',
    upstream_commit: gitHead(arcrunRoot),
    files,
  };
  writeFileSync(join(mirrorDir, 'MIRROR.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const fromIdx = process.argv.indexOf('--from');
  const explicitRoot = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
  if (check) {
    const r = checkAgainstManifest();
    if (!r.ok) {
      console.error('❌ resource-rule 鏡射核對失敗：');
      for (const p of r.problems) console.error(`   - ${p}`);
      process.exit(1);
    }
    console.log(`✅ resource-rule 鏡射與 MIRROR.json 相符（${Object.keys(r.manifest.files).length} 檔，上游 Arcrun@${String(r.manifest.upstream_commit).slice(0, 7)}）`);
    // Arcrun repo 在場的話，順便對上游再驗一次（出貨機會走到這條）
    try {
      const root = findArcrunRoot(explicitRoot);
      const u = checkAgainstUpstream(root);
      if (!u.ok) {
        console.error('❌ 鏡射與上游原始檔不同：');
        for (const p of u.problems) console.error(`   - ${p}`);
        process.exit(1);
      }
      console.log(`✅ 鏡射與上游 ${root} 逐位元組相同（HEAD ${String(u.head).slice(0, 7)}）`);
    } catch (e) {
      console.log(`ℹ️  本機沒有 Arcrun repo，只核對了指紋清單（${e instanceof Error ? e.message.split('\n')[0] : e}）`);
    }
    process.exit(0);
  }
  const root = findArcrunRoot(explicitRoot);
  const m = syncMirror(root);
  console.log(`✅ 已鏡射 ${Object.keys(m.files).length} 個檔案 ← ${root}/${UPSTREAM_REL}（Arcrun@${String(m.upstream_commit).slice(0, 7)}）`);
  for (const rel of Object.keys(m.files)) console.log(`   · ${rel}`);
}
