#!/usr/bin/env node
/**
 * ship-market.mjs — 市集上架線（inkstone/arcrun-rag#381）。只出「市集目錄＋App 包」，不碰主程式。
 *
 * 用法（在 repo 根目錄）：
 *   node installer/scripts/ship-market.mjs --target stage                 預演：列出這次哪些 App 從幾版到幾版（簽核單要貼的內容）
 *   node installer/scripts/ship-market.mjs --target stage --confirm       上架 stage 市集（班車，不查簽核）
 *   node installer/scripts/ship-market.mjs --target prod --ticket <票>    預演（prod）
 *   node installer/scripts/ship-market.mjs --target prod --confirm --ticket <owner/repo#N>
 *                                                                          prod：先問 AHub 這個**市集版**有沒有被簽核人放行，沒簽不翻指標
 *   --source <Arcrun repo 路徑>  App 原稿來源（預設取 ship.targets.json 的 source.arcrunRepo，或環境變數 ARCRUN_SOURCE）
 *
 * 不做的事（刻意）：不重打零件包、不部署安裝器、不跑主程式出貨線、不動主程式版號與 /health。
 * 簽核對象是「市集版號」（例 2026.11.22-ab12cd3），不是主程式版號；簽核單內文用 renderDiff 的輸出。
 * 原則見 ADR 2026-11-22-market-line（InkStoneCo system-dev/docs/2-architecture/decisions/）。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  marketVersionOf, diffMarket, hasChanges, renderDiff, planMarket, publishMarket, assertMarketDeclared,
  readLiveMarket, verifyLiveMarket, appendMarketLedger, readMarketLedger,
} from './market-line.mjs';
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
  if (!T.market) {
    console.error(`目標 ${targetName} 還沒宣告 market（市集的家）——這個目標的市集仍跟著主程式釘子走。\n`
      + '  要建立：在 ship.targets.json 的該目標加 market 區塊（bucket／accountId／publicBase／installerBase），並讓它的安裝站綁同一個 bucket 或設 MARKET_BASE。');
    return 2;
  }
  assertMarketDeclared(T.market);

  const source = resolve(arg('--source') || process.env.ARCRUN_SOURCE || resolve(REPO_ROOT, cfg.source.arcrunRepo));
  const feedScript = join(source, 'app-market', 'build-feed.mjs');
  if (!existsSync(feedScript)) { console.error(`來源沒有 app-market/build-feed.mjs：${feedScript}`); return 2; }

  // ① 產出目錄與包（build-feed 靠 argv[1]＝真實路徑判斷是否直接執行，所以一律給 realpath）
  const feedDir = mkdtempSync(join(tmpdir(), 'market-feed-'));
  execFileSync('node', [realpathSync(feedScript), '--out', feedDir], { cwd: source, stdio: 'pipe' });
  const indexText = readFileSync(join(feedDir, 'index.json'), 'utf8');
  const index = JSON.parse(indexText);

  // ② 跟線上現在那份比（從用戶會走的 /apps 讀）
  const live = await readLiveMarket({ installerBase: T.market.installerBase });
  const diff = diffMarket(live ? live.index : null, index);
  const marketVersion = marketVersionOf(indexText);
  console.log(`市集上架線｜目標 ${targetName}｜${T.market.installerBase}/apps`);
  console.log(`線上現在：${live && live.pointer ? live.pointer.version : live ? '（還沒有市集指標；比較基準＝舊路目錄，即跟著零件包釘子走的那份）' : '（什麼都沒有，第一次上架）'}`);
  console.log(renderDiff(diff, marketVersion));
  const down = diff.filter((d) => d.kind === 'downgraded');
  if (down.length && !flag('--allow-downgrade')) {
    console.error(`\n✖ 這次會把線上的 ${down.map((d) => `${d.id} ${d.from}→${d.to}`).join('、')} 降版。多半是 App 原稿來源（${source}）不是最新的 main。\n  確定要降版（例如回退）才加 --allow-downgrade。`);
    return 1;
  }
  if (live && live.pointer && !hasChanges(diff)) { console.log('\n沒有 App 變動，不上架。'); return 0; }

  // ③ 簽核（prod）：簽的是市集版號；沒簽不翻指標
  const needSign = targetName === 'prod' || T.market.requiresSignoff === true;
  let ticket = null;
  if (needSign) {
    const t = resolveArmTicket({ armTicket: T.armTicket, shipTicket: arg('--ticket') });
    if (!t) { console.error('\nprod 市集上架需要簽核單：--ticket owner/repo#N（簽核版號填上面的市集版號）。'); return 2; }
    ticket = `${t.repo}#${t.issue}`;
    if (confirm) {
      const armed = await checkTicketArmed({ version: marketVersion, repo: t.repo, issue: t.issue });
      console.log(`簽核：${armed.mission}`);
    }
  }
  if (!confirm) {
    console.log(`\n（預演，沒有放任何東西。${needSign ? `請在簽核單 ${ticket || '<票>'} 用 AHub 簽核工具為版本 ${marketVersion} 請簽，貼上面的清單。` : '加 --confirm 上架。'}）`);
    return 0;
  }

  // ④ 放上去：包 → 這一版目錄 → 指標最後
  const cred = cloudflareDeployEnv({ cfg, accountId: T.market.accountId, startDir: REPO_ROOT });
  const plan = planMarket({ feedDir, marketVersion, diff, ticket, previous: live && live.pointer ? live.pointer.version : null });
  // cwd 用系統暫存目錄：r2 object put 是帳號層級指令，不需要任何 worker 設定；在 installer/ 底下跑時
  //   wrangler 會讀到 installer/wrangler.jsonc（安裝器範本，KV id 是空的）而整條設定檢查失敗（2026-11-22 實撞）。
  const run = (args, { label }) => {
    for (let i = 1; i <= 8; i++) {
      try { execFileSync('npx', args, { cwd: tmpdir(), env: { ...process.env, ...cred.env }, stdio: 'pipe' }); return; }
      catch (e) { if (i === 8) throw new Error(`上傳 ${label} 失敗：${String(e.stderr || e.message).slice(0, 300)}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000); }
    }
  };
  const r = publishMarket({ plan, market: T.market, run, writePointer: (j) => { const p = join(feedDir, 'current.json'); writeFileSync(p, JSON.stringify(j, null, 2)); return p; } });
  console.log(`已放 ${r.count} 個物件＋指標 ${r.pointerKey}`);

  // ⑤ 從用戶會走的那條路讀回來
  await verifyLiveMarket({ installerBase: T.market.installerBase, expect: plan.pointer });
  console.log(`✔ 從 ${T.market.installerBase}/apps 讀回：市集版 ${plan.pointer.version}`);

  // ⑥ 落帳（市集自己的帳，不進主程式的 release-ledger）
  const ledgerPath = join(REPO_ROOT, 'installer', 'market-ledger.json');
  const ledger = appendMarketLedger(readMarketLedger(REPO_ROOT), {
    version: marketVersion, target: targetName, at: plan.pointer.published_at, ticket, previous: plan.pointer.previous,
    changes: plan.pointer.changes,
  });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  console.log(`落帳：installer/market-ledger.json（記得 commit；主程式版號沒動）`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error('✖ ' + e.message); process.exit(1); });
