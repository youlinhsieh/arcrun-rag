#!/usr/bin/env node
/**
 * ship-onprem.mjs — 地端更新檔上架線（inkstone/arcrun-rag#394，母票 inkstone/InkStoneCo#325）。打包簽好一個地端更新檔，放到安裝站 `/onprem/`。
 *
 * 用法（在 repo 根目錄；Arcrun 來源預設取 ship.targets.json 的 source.arcrunRepo，或 ARCRUN_SOURCE／--source）：
 *   node installer/scripts/ship-onprem.mjs --target stage                      預演：算版號、看線上現在是哪版，不打包不放
 *   node installer/scripts/ship-onprem.mjs --target stage --confirm            打包（簽章端點代簽）→ 放 stage R2 → 從用戶那條路讀回驗
 *   node installer/scripts/ship-onprem.mjs --target prod --ticket <owner/repo#N> [--confirm]
 *                                                                              prod：要這一班主程式版號已被簽核人放行（AHub 簽核），沒簽不放
 *   --worker-builds <dir>   更新檔的 worker 成品（預設 <Arcrun>/.worker-builds）
 *   --kbdb-dir <dir>  --rag-workflows <json>  --notes "一行說明"（可重複）  原樣交給 build-update.mjs
 *   --onprem-version <1.4.295-onprem.7>  指定更新檔版號（預設＝登錄簿算出的下一號；要對齊已交件的安裝包版號時用）
 *   --release <1.4.299>     這一班的主程式版號（預設 installer/release-state.json 的 release）
 *   --package <檔.tgz>      已經打好簽好的更新檔（跳過打包；版號取自檔內 manifest）
 *
 * 簽章：build-update.mjs build --sign-url <登錄簿 onprem.signUrl>；呼叫憑證用環境裡的 uncle6 token（環境變數 CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE，由 build-update.mjs 放 Authorization 標頭，不印值）。
 * 私鑰不經過這裡、不落檔（在 arcrun-release-signer 的 CF Secret）。這裡也不自己部署安裝站——/onprem 路由隨安裝站出貨（ship.mjs）一起上。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOnpremDeclared, nextOnpremVersion, packageUrl, planOnprem, publishOnprem, readLiveOnprem, verifyLiveOnprem,
  appendOnpremLedger, readOnpremLedger, latestUrl, ONPREM_VERSION_RE,
} from './onprem-line.mjs';
import { cloudflareDeployEnv } from './cf-credential.mjs';
import { checkTicketArmed, resolveArmTicket } from './ticket-arm-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const args = (name) => process.argv.flatMap((v, i) => (process.argv[i - 1] === name ? [v] : []));
const flag = (name) => process.argv.includes(name);

async function main() {
  const targetName = arg('--target');
  const confirm = flag('--confirm');
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
  const T = cfg.targets && cfg.targets[targetName];
  if (!T) { console.error('用法：--target <stage|prod>（登錄簿 installer/ship.targets.json 的目標）'); return 2; }
  if (!T.onprem) { console.error(`目標 ${targetName} 還沒宣告 onprem（地端更新檔的家）。在 ship.targets.json 的該目標加 onprem 區塊（bucket／accountId／publicBase／signUrl）。`); return 2; }
  assertOnpremDeclared(T.onprem);

  const source = resolve(arg('--source') || process.env.ARCRUN_SOURCE || resolve(REPO_ROOT, cfg.source.arcrunRepo));
  const buildScript = join(source, 'docker', 'private-cloud', 'build-update.mjs');
  if (!existsSync(buildScript)) { console.error(`來源沒有 docker/private-cloud/build-update.mjs：${buildScript}`); return 2; }

  const release = arg('--release') || JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'release-state.json'), 'utf8')).release;
  const ledger = readOnpremLedger(REPO_ROOT);
  const live = await readLiveOnprem({ onprem: T.onprem });
  let version = arg('--onprem-version') || nextOnpremVersion(release, ledger);
  if (!ONPREM_VERSION_RE.test(version)) { console.error(`--onprem-version ${version} 不是 <主程式>-onprem.<N>（例：1.4.295-onprem.7）`); return 2; }
  console.log(`地端更新檔上架線｜目標 ${targetName}｜${latestUrl(T.onprem)}`);
  console.log(`線上現在：${live ? `${live.version}（sha ${String(live.sha256).slice(0, 12)}…）` : '（還沒上架過）'}｜主程式版號 ${release}｜這一班預計 ${version}`);

  // prod：簽核的對象是這一班主程式版號（同一次出貨簽過 bundle，更新檔跟著放行）；沒簽不放
  let ticket = null;
  if (targetName === 'prod' || T.onprem.requiresSignoff === true) {
    const t = resolveArmTicket({ armTicket: T.armTicket, shipTicket: arg('--ticket') });
    if (!t) { console.error('\nprod 需要簽核單：--ticket owner/repo#N（簽核版號＝主程式版號，與這次 prod 出貨同一張）。'); return 2; }
    ticket = `${t.repo}#${t.issue}`;
    if (confirm) console.log(`簽核：${(await checkTicketArmed({ version: release, repo: t.repo, issue: t.issue })).mission}`);
  }
  if (!confirm) { console.log('\n（預演，沒有打包也沒有放任何東西；加 --confirm 執行。）'); return 0; }

  // ① 打包＋簽（簽章端點代簽，回來的章 build-update 會用映像內建公鑰再驗一次）
  const work = mkdtempSync(join(tmpdir(), 'onprem-ship-'));
  let pkg = arg('--package');
  if (pkg) {
    const m = spawnSync('tar', ['-xzOf', pkg, 'manifest.json']);
    if (m.status !== 0) { console.error(`讀不到 ${pkg} 裡的 manifest.json`); return 2; }
    version = JSON.parse(m.stdout.toString('utf8')).version;
    if (!ONPREM_VERSION_RE.test(version)) { console.error(`${pkg} 的版號 ${version} 不是 <主程式>-onprem.<N>`); return 2; }
  } else {
    const wb = arg('--worker-builds') || join(source, '.worker-builds');
    if (!existsSync(wb)) { console.error(`沒有 worker 成品目錄 ${wb}（先在 Arcrun 跑 node scripts/build-worker-artifacts.mjs，或用 --worker-builds）`); return 2; }
    if (!process.env.CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE) { console.error('沒有簽章呼叫憑證：環境變數 CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE 沒設（arcrun-release-signer 認這把）。'); return 2; }
    pkg = join(work, `${version}.tgz`);
    const a = [realpath(buildScript), 'build', '--version', version, '--worker-builds', wb, '--out', pkg, '--sign-url', T.onprem.signUrl];
    for (const [f, k] of [['--kbdb-dir', '--kbdb-dir'], ['--rag-workflows', '--rag-workflows']]) if (arg(f)) a.push(k, arg(f));
    for (const n of args('--notes')) a.push('--notes', n);
    execFileSync('node', a, { cwd: source, stdio: 'inherit', env: process.env });
  }

  // ② latest.json（url 指向公開網址；sha256／size 是這個檔實際的）
  const latest = join(work, 'latest.json');
  execFileSync('node', [realpath(buildScript), 'feed', '--package', pkg, '--url', packageUrl(T.onprem, version), '--out', latest], { cwd: source, stdio: 'pipe' });
  const plan = planOnprem({ pkgPath: pkg, latestPath: latest, version });

  // ③ 放上去：更新檔 → 指標最後（cwd 用暫存目錄：r2 指令是帳號層級，不讀 installer 的 wrangler 設定）
  const cred = cloudflareDeployEnv({ cfg, accountId: T.onprem.accountId, startDir: REPO_ROOT });
  const run = (a, { label }) => {
    for (let i = 1; i <= 8; i++) {
      try { execFileSync('npx', a, { cwd: tmpdir(), env: { ...process.env, ...cred.env }, stdio: 'pipe' }); return; }
      catch (e) { if (i === 8) throw new Error(`上傳 ${label} 失敗：${String(e.stderr || e.message).slice(0, 300)}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000); }
    }
  };
  const r = publishOnprem({ plan, onprem: T.onprem, run });
  console.log(`已放：${r.keys.join('、')}`);

  // ④ 從用戶會走的那條路讀回來
  await verifyLiveOnprem({ onprem: T.onprem, expect: { version, sha256: plan.sha256 } });
  console.log(`✔ 從 ${latestUrl(T.onprem)} 讀回：${version}（sha ${plan.sha256.slice(0, 12)}…，更新檔位元組一致）`);

  // ⑤ 落帳
  const out = appendOnpremLedger(ledger, { version, target: targetName, at: new Date().toISOString(), release, ticket, sha256: plan.sha256, previous: live ? live.version : null });
  writeFileSync(join(REPO_ROOT, 'installer', 'onprem-ledger.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('落帳：installer/onprem-ledger.json（記得 commit）');
  return 0;
}
function realpath(p) { return execFileSync('realpath', [p]).toString().trim(); }

main().then((c) => process.exit(c), (e) => { console.error('✖ ' + e.message); process.exit(1); });
