#!/usr/bin/env node
/**
 * ship-portal.mjs — Portal 畫面軟更新出貨線（inkstone/arcrun-rag#398）。只出「Portal 畫面包」，不碰主程式。
 *
 * 用法（在 repo 根目錄）：
 *   node installer/scripts/ship-portal.mjs --target stage              預演：印出這次畫面包版號、floor、和線上差在哪
 *   node installer/scripts/ship-portal.mjs --target stage --confirm    上架（stage 班車，不查簽核）
 *   node installer/scripts/ship-portal.mjs --target prod --confirm --ticket <owner/repo#N>
 *                                                                       prod：同市集線，先問 AHub 這個畫面包版號有沒有被簽核人放行
 *   --source <Arcrun repo>   畫面原稿來源（預設 ship.targets.json 的 source.arcrunRepo 或 ARCRUN_SOURCE）；要是 main 最新
 *   --floor <x.y.z>          這份畫面要求的最低主程式版本（預設＝installer/release-state.json 的 release，保守）
 *
 * 不做的事（刻意）：不重打零件包、不重推 UI worker、不動主程式版號與 /health、不要用戶按「立即更新」。
 * 怎麼判斷「這次變更走這條線」：node installer/scripts/change-class.mjs ——只有 console-ui/public 變＝軟（via portal）。
 * 實例端：UI worker 看 PORTAL_PACK_BASE（安裝器注入的安裝站網址）的 /portal/current.json（Arcrun scripts/build-ui-worker.mjs）。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMarketDeclared, appendMarketLedger, readMarketLedger } from './market-line.mjs';
import { packVersionOf, samePortal, planPortalPack, publishPortalPack, readLivePortal, verifyLivePortal } from './portal-pack-line.mjs';
import { cloudflareDeployEnv } from './cf-credential.mjs';
import { checkTicketArmed, resolveArmTicket } from './ticket-arm-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name) => process.argv.includes(name);

async function main() {
  const targetName = arg('--target');
  const confirm = flag('--confirm');
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
  const T = cfg.targets && cfg.targets[targetName];
  if (!T) { console.error('用法：--target <stage|prod>（登錄簿 installer/ship.targets.json 的目標）'); return 2; }
  if (!T.market) { console.error(`目標 ${targetName} 還沒宣告 market（市集的家）——畫面包與市集同一個家，先建家。`); return 2; }
  assertMarketDeclared(T.market);

  const source = resolve(arg('--source') || process.env.ARCRUN_SOURCE || resolve(REPO_ROOT, cfg.source.arcrunRepo));
  const packScript = join(source, 'scripts', 'build-portal-pack.mjs');
  if (!existsSync(packScript)) { console.error(`來源沒有 scripts/build-portal-pack.mjs：${packScript}（Arcrun 要先含 inkstone/arcrun-rag#398 的那一版）`); return 2; }

  // ① 在 Arcrun 打包（同一個 buildUiWorker、同三道閘；本 repo 不 build）
  const dir = mkdtempSync(join(tmpdir(), 'portal-pack-'));
  const packPath = join(dir, 'pack.json');
  const out = execFileSync('node', [realpathSync(packScript), '--out', packPath], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const info = JSON.parse(out.trim().split('\n').pop());

  // ② 跟線上比
  const live = await readLivePortal({ installerBase: T.market.installerBase });
  const version = packVersionOf(info.ui_fingerprint);
  const floor = arg('--floor') || JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'release-state.json'), 'utf8')).release;
  console.log(`Portal 畫面包｜目標 ${targetName}｜${T.market.installerBase}/portal`);
  console.log(`線上現在：${live ? `${live.version}（floor ${live.floor_bundle_version}）` : '（還沒有畫面包，用戶用 worker 內嵌的畫面）'}`);
  console.log(`這一包：${version}｜${info.file_count} 個檔｜${(info.bytes / 1024).toFixed(0)} KB｜floor ${floor}`);
  if (samePortal(live, info.ui_fingerprint)) { console.log('\n畫面內容與線上相同，不上架。'); return 0; }

  // ③ 簽核（prod）：簽的是畫面包版號；沒簽不翻指標
  const needSign = targetName === 'prod' || T.market.requiresSignoff === true;
  let ticket = null;
  if (needSign) {
    const t = resolveArmTicket({ armTicket: T.armTicket, shipTicket: arg('--ticket') });
    if (!t) { console.error('\nprod 畫面包上架需要簽核單：--ticket owner/repo#N（簽核版號填上面的包版號）。'); return 2; }
    ticket = `${t.repo}#${t.issue}`;
    if (confirm) console.log(`簽核：${(await checkTicketArmed({ version, repo: t.repo, issue: t.issue })).mission}`);
  }
  if (!confirm) { console.log(`\n（預演，沒有放任何東西。${needSign ? `請在簽核單 ${ticket || '<票>'} 為版本 ${version} 請簽。` : '加 --confirm 上架。'}）`); return 0; }

  // ④ 放上去：包 → 指標最後
  const cred = cloudflareDeployEnv({ cfg, accountId: T.market.accountId, startDir: REPO_ROOT });
  const plan = planPortalPack({ packPath, uiFingerprint: info.ui_fingerprint, fileCount: info.file_count, version, floor, ticket, previous: live ? live.version : null });
  const run = (args, { label }) => {
    for (let i = 1; i <= 8; i++) {
      try { execFileSync('npx', args, { cwd: tmpdir(), env: { ...process.env, ...cred.env }, stdio: 'pipe' }); return; }
      catch (e) { if (i === 8) throw new Error(`上傳 ${label} 失敗：${String(e.stderr || e.message).slice(0, 300)}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000); }
    }
  };
  const r = publishPortalPack({ plan, market: T.market, run, writePointer: (j) => { const p = join(dir, 'current.json'); writeFileSync(p, JSON.stringify(j, null, 2)); return p; } });
  console.log(`已放 ${r.packKey}＋指標 ${r.pointerKey}`);

  // ⑤ 從用戶實例會走的那條路讀回來
  await verifyLivePortal({ installerBase: T.market.installerBase, expect: plan.pointer });
  console.log(`✔ 從 ${T.market.installerBase}/portal 讀回：畫面包 ${version}`);

  // ⑥ 落帳（與市集同一本帳，kind=portal）
  const ledgerPath = join(REPO_ROOT, 'installer', 'market-ledger.json');
  const ledger = appendMarketLedger(readMarketLedger(REPO_ROOT), {
    kind: 'portal', version, target: targetName, at: plan.pointer.published_at, ticket, previous: plan.pointer.previous,
    floor_bundle_version: floor, ui_fingerprint: info.ui_fingerprint,
  });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  console.log('落帳：installer/market-ledger.json（記得 commit；主程式版號沒動、worker 沒重推）');
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error('✖ ' + e.message); process.exit(1); });
