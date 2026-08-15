#!/usr/bin/env node
/**
 * build-ui-bundle.mjs — 把 Arcrun 編好的 portal 前端**複製**進 bundle（不再自己產生它）。
 *
 * 🔴 2026-08-15（D91／Arcrun#125）：這支以前會讀 Arcrun 的 `console-ui/public`、
 *   在**這台機器上**把它拼裝成一顆 worker。leo 2026-08-14：
 *   「今天開始出貨一律不准在 arcrun rag 或任何別的地方 build，**這就是 arcrun 的專屬工作**。」
 *
 *   內嵌器連同它的兩道閘（世代閘、前端 JS 語法閘）已原樣搬回 Arcrun
 *   （`scripts/build-ui-worker.mjs`，由 `scripts/build-worker-artifacts.mjs` 呼叫），
 *   產出固定在 `.worker-builds/arcrun-rag-ui/worker.mjs`。本檔剩下的職責只有「搬」。
 *
 * 出貨線**不再呼叫本檔**——`build-bundles.mjs` 已經把公庫（含 portal 前端）整批複製過來。
 * 留著它是給 `deploy-ui.mjs` 這種「只想單獨補一顆 UI」的手動路徑用。
 *
 * 用法：
 *   node installer/scripts/build-ui-bundle.mjs --arcrun <Arcrun repo> --out <bundles 目錄>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { layoutFor, readArtifactManifest } from './bundle-components.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ARCRUN = opt('--arcrun', join(import.meta.dirname, '..', '..', '..', '..', 'matrix', 'arcrun'));
const OUT = opt('--out', '/tmp/arcrun-rag-bundles');
const REPO_ROOT = opt('--repo-root', join(import.meta.dirname, '..', '..'));

if (/\.(js|mjs)$/.test(OUT)) {
  console.error(`✘ --out 要給 **bundles 目錄**（本腳本會寫進 <out>/tier2/ui/index.js），不是單一檔案：${OUT}`);
  process.exit(2);
}

const NAME = 'arcrun-rag-ui';
const artifactManifest = readArtifactManifest(ARCRUN);
const artifact = (artifactManifest.workers || []).find((w) => w.name === NAME);
if (!artifact) {
  console.error(
    `✘ Arcrun 的官方成品裡沒有 ${NAME}。\n` +
    `   本檔**不會**退回自己產生一份（D91：成品只有一個產地）。\n` +
    `   → 在 ${ARCRUN} 跑 \`node scripts/build-worker-artifacts.mjs\` 並把 .worker-builds/ commit 進去。`);
  process.exit(1);
}

const src = join(ARCRUN, '.worker-builds', NAME, artifact.main_module || 'worker.mjs');
if (!existsSync(src)) { console.error(`✘ 官方成品缺主檔：${src}`); process.exit(1); }

const { relDir, mainName } = layoutFor(NAME);
mkdirSync(join(OUT, relDir), { recursive: true });
const dest = join(OUT, relDir, mainName);
copyFileSync(src, dest);

const entry = {
  name: NAME,
  main_module: mainName,
  main_file: `${relDir}/${mainName}`,
  js_bytes: artifact.js_bytes,
  modules: [],
  compat_date: artifact.compat_date,
  compat_flags: artifact.compat_flags,
  requires: artifact.requires,
  source_commit: artifact.source_commit || null,
  source_content_sha256: artifact.content_sha256 || null,
};

const mPath = join(OUT, 'manifest.json');
try {
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  for (const key of ['core', 'library']) {
    if (!Array.isArray(m[key])) continue;
    const prev = m[key].find((c) => c && c.name === NAME);
    m[key] = m[key].filter((c) => !c || c.name !== NAME);
    m[key].push(prev ? { ...prev, ...entry } : entry);
  }
  writeFileSync(mPath, JSON.stringify(m, null, 2));
  // 版本號由內容指紋算出來，不靠任何人記得改（同 build-bundles.mjs 的收尾）。
  const { syncManifest } = await import('./release.mjs');
  const { release, changed } = syncManifest(OUT, { repoRoot: REPO_ROOT });
  console.log(
    `✅ portal 前端已從 Arcrun 官方成品複製：${(statSync(dest).size / 1024).toFixed(0)}KB` +
    `｜來源 Arcrun@${String(artifact.source_commit || '').slice(0, 8)}` +
    `｜版本 ${release}${changed ? '（已 bump）' : '（內容未變）'}`);
} catch (e) {
  if (e && e.code !== 'ENOENT') throw e;   // 只有「manifest 不存在」可以容忍，其餘一律炸出來
  console.log(`✅ portal 前端已複製（manifest 不存在，僅出檔）：${dest}`);
}
