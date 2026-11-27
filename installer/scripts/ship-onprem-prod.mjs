#!/usr/bin/env node
/**
 * ship-onprem-prod.mjs — 官方地端更新來源「一條解鎖行」（inkstone/arcrun-rag#394，母票 inkstone/InkStoneCo#325）。
 *
 * 為什麼有這支：prod 解鎖一張 AHub 簽核＝一條指令（整行雜湊、15 分鐘、用一次，ISEP hooks/lib/prod-signoff.sh）。
 * 上架 install.arcrun.dev/onprem/latest.json 要做三件事（建 bucket → 部署安裝站 → 上架更新檔），
 * 若各是一條指令就得簽三張。這支把三件收成同一行，簽核單的「解鎖：」只寫這一行。
 *
 * 用法（在 repo 根目錄；雲端跑，要 UNCLE6_CF_API_KEY 與 CLOUDFLARE_API_TOKEN_UNCLE6_CC_USE）：
 *   node installer/scripts/ship-onprem-prod.mjs --release 1.4.295 --onprem-version 1.4.295-onprem.7 --ticket inkstone/arcrun-rag#394 --confirm
 *   同一行拿掉 --confirm ＝只檢查（不建、不部署、不上架；簽核還沒簽會印出「沒簽」，那是預期的）。
 *   --target stage ＝同一條路在 stage 預演（stage 沒有 bucket／安裝站這兩步，只做第 ③ 步）。
 *
 * 順序（每一步冪等，中途失敗原行重跑）：
 *   ⓪ 簽核：這一版（--release）在票上有 AHub 簽核放行，沒簽就停，什麼都還沒動。
 *   ① R2 bucket `arcrun-onprem`（uncle6）：不存在才建。
 *   ② 安裝站 prod：線上 BUNDLE_BASE／BUNDLE_BUILT 要與 wrangler.toml 一致（不一致＝這一部署會順便換掉 prod 的零件包釘子，
 *      那是正式出貨的事，停下來）；線上已有 ONPREM binding 就跳過；否則 wrangler deploy（binding 在 wrangler.toml 已開）。
 *   ③ 更新檔：把 stage 上已驗過的那份簽好的 .tgz 原封搬到 prod（--package，不重打、不重簽），
 *      由 ship-onprem.mjs 放進 R2、從 https://install.arcrun.dev/onprem/latest.json 讀回驗位元組。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareDeployEnv } from './cf-credential.mjs';
import { checkTicketArmed, resolveArmTicket } from './ticket-arm-guard.mjs';
import { ONPREM_VERSION_RE, latestUrl, packageUrl } from './onprem-line.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(n);
const CF = 'https://api.cloudflare.com/client/v4';

/** wrangler.toml 頂層 [vars] 的一個值（只讀第一個 [vars] 段，不碰 [env.*.vars]）。 */
export function tomlVar(toml, key) {
  const m = /^\[vars\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml + '\n[end]');
  if (!m) return null;
  const k = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(m[1]);
  return k ? k[1] : null;
}
/** wrangler.toml 有沒有「沒被註解掉的」ONPREM binding。 */
export function hasOnpremBinding(toml) {
  return /^\[\[r2_buckets\]\]\s*\nbinding\s*=\s*"ONPREM"/m.test(toml);
}

async function cf(path, token, init = {}) {
  const r = await fetch(CF + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok && j.success !== false, body: j };
}

async function main() {
  const target = arg('--target') || 'prod';
  const confirm = flag('--confirm');
  const release = arg('--release');
  const version = arg('--onprem-version');
  if (!release || !version || !ONPREM_VERSION_RE.test(version)) {
    console.error('用法：--release <1.4.295> --onprem-version <1.4.295-onprem.7> --ticket <owner/repo#N> [--target stage|prod] [--confirm]');
    return 2;
  }
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer', 'ship.targets.json'), 'utf8'));
  const T = cfg.targets[target];
  if (!T || !T.onprem) { console.error(`目標 ${target} 沒有宣告 onprem。`); return 2; }
  const isProd = target === 'prod';
  const stageOnprem = cfg.targets.stage.onprem;
  console.log(`地端更新來源解鎖行｜目標 ${target}｜${version}｜${confirm ? '執行' : '只檢查（沒有 --confirm）'}`);
  let blocked = false;
  const note = (ok, msg) => { console.log(`${ok ? '✔' : '✖'} ${msg}`); if (!ok) blocked = true; };

  // ⓪ 簽核（prod 才要；先於任何動作）
  if (isProd) {
    const t = resolveArmTicket({ armTicket: T.armTicket, shipTicket: arg('--ticket') });
    if (!t) { console.error('prod 需要 --ticket owner/repo#N'); return 2; }
    try { note(true, `⓪ 簽核：${(await checkTicketArmed({ version: release, repo: t.repo, issue: t.issue })).mission}`); }
    catch (e) {
      // 雲端 session 沒有 AHUB_TOKEN（401）：改問本機 forge-bridge（127.0.0.1:8787，同一份 AHub 簽核看板）
      let via = null;
      if (/401|token/i.test(String(e.message))) {
        try {
          const j = await (await fetch(`${process.env.FORGE_BRIDGE_URL || 'http://127.0.0.1:8787'}/api/v1/repos/inkstone/${t.repo}/issues/${t.issue}/signoffs?version=${encodeURIComponent(release)}`)).json();
          via = j && j.version ? j.version : null;
        } catch { /* 橋也不通 ⇒ 照原錯誤擋 */ }
      }
      if (via && via.approved === true) note(true, `⓪ 簽核（經本機橋）：${release} 已由 ${via.by || '簽核人'} 放行`);
      else if (via) note(false, `⓪ 簽核（經本機橋）：${release} 還沒有放行（票 ${t.repo}#${t.issue} 沒有帶 version=${release} 且已同意的簽核）`);
      else note(false, `⓪ 簽核：${String(e.message).split('\n')[0]}`);
    }
  } else console.log('⓪ 簽核：stage 是班車，不查');

  // ③ 的材料先備好（stage 上已簽好、已驗過的那份）——只讀
  const lj = await (await fetch(latestUrl(stageOnprem), { cache: 'no-store' })).json().catch(() => null);
  if (!lj || lj.version !== version) { note(false, `③ stage 上沒有 ${version}（現在是 ${lj && lj.version}）——先 --target stage 上架`); }
  let pkg = null;
  if (lj && lj.version === version) {
    const buf = Buffer.from(await (await fetch(packageUrl(stageOnprem, version))).arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== lj.sha256) note(false, `③ stage 的 .tgz sha256 ${sha.slice(0, 12)}… 與 latest.json ${String(lj.sha256).slice(0, 12)}… 不符`);
    else {
      pkg = join(mkdtempSync(join(tmpdir(), 'onprem-prod-')), `${version}.tgz`);
      writeFileSync(pkg, buf);
      note(true, `③ stage 更新檔 ${version}｜sha256 ${sha.slice(0, 12)}…｜${buf.length} bytes（原封搬，不重打不重簽）`);
    }
  }

  if (isProd) {
    const cred = cloudflareDeployEnv({ cfg, accountId: T.onprem.accountId, startDir: REPO_ROOT });
    const token = cred.env.CLOUDFLARE_API_TOKEN;
    const acct = T.onprem.accountId;

    // ① bucket
    const bl = await cf(`/accounts/${acct}/r2/buckets`, token);
    const names = ((bl.body.result || {}).buckets || []).map((b) => b.name);
    const haveBucket = names.includes(T.onprem.bucket);
    note(bl.ok, `① 讀得到 uncle6 的 R2 bucket 清單（${bl.status}）`);
    console.log(`  bucket ${T.onprem.bucket}：${haveBucket ? '已存在' : '還沒有'}`);

    // ② 安裝站
    const toml = readFileSync(join(REPO_ROOT, T.installer.cwd, T.installer.config), 'utf8');
    const name = (/^name\s*=\s*"([^"]+)"/m.exec(toml) || [])[1];
    const st = await cf(`/accounts/${acct}/workers/scripts/${name}/settings`, token);
    const live = Object.fromEntries(((st.body.result || {}).bindings || []).map((b) => [b.name, b]));
    const liveBase = live.BUNDLE_BASE && live.BUNDLE_BASE.text;
    const liveBuilt = live.BUNDLE_BUILT && live.BUNDLE_BUILT.text;
    note(st.ok, `② 讀得到線上安裝站 ${name} 的設定（${st.status}）`);
    const pinSame = liveBase === tomlVar(toml, 'BUNDLE_BASE') && liveBuilt === tomlVar(toml, 'BUNDLE_BUILT');
    note(pinSame, `② 線上零件包釘子與 wrangler.toml 一致（線上 ${String(liveBase).slice(-12)}／${liveBuilt}；檔裡 ${String(tomlVar(toml, 'BUNDLE_BASE')).slice(-12)}／${tomlVar(toml, 'BUNDLE_BUILT')}）${pinSame ? '' : '——不一致時部署會順便換掉 prod 釘子，這要走正式出貨，不在這一行'}`);
    note(hasOnpremBinding(toml), '② wrangler.toml 已開 ONPREM binding');
    const liveHasBinding = !!live.ONPREM;
    console.log(`  線上 ONPREM binding：${liveHasBinding ? '已有（跳過部署）' : '還沒有（要部署）'}`);

    if (!confirm) {
      const dry = spawnSync('npx', ['--yes', 'wrangler@4', 'deploy', '--dry-run', '--config', T.installer.config], { cwd: join(REPO_ROOT, T.installer.cwd), env: { ...process.env, ...cred.env }, encoding: 'utf8', timeout: 240000 });
      note(dry.status === 0, `② wrangler deploy --dry-run（設定檔語法／binding 可編）${dry.status === 0 ? '' : '：' + String(dry.stderr || dry.stdout).split('\n').filter(Boolean).slice(-2).join(' / ')}`);
    }
    if (blocked) { console.log('\n有一格沒過，停（沒有任何東西被改）。'); return confirm ? 1 : 3; }
    if (!confirm) { console.log('\n只檢查：全部通過。加 --confirm 執行。'); return 0; }

    if (!haveBucket) {
      const c = await cf(`/accounts/${acct}/r2/buckets`, token, { method: 'POST', body: JSON.stringify({ name: T.onprem.bucket }) });
      if (!c.ok) { console.error(`✖ ① 建 bucket 失敗（${c.status}）：${JSON.stringify(c.body.errors || c.body).slice(0, 300)}——缺的權限：uncle6 帳號 R2 Edit`); return 1; }
      console.log(`✔ ① 已建 bucket ${T.onprem.bucket}`);
    } else console.log('✔ ① bucket 已在，跳過');
    if (!liveHasBinding) {
      const r = spawnSync('npx', ['--yes', 'wrangler@4', 'deploy', '--config', T.installer.config], { cwd: join(REPO_ROOT, T.installer.cwd), env: { ...process.env, ...cred.env }, stdio: 'inherit' });
      if (r.status !== 0) { console.error('✖ ② 安裝站部署失敗'); return 1; }
      console.log('✔ ② 安裝站已部署（含 ONPREM binding）');
    } else console.log('✔ ② 安裝站已有 ONPREM binding，跳過');
  } else if (blocked) { console.log('\n有一格沒過，停。'); return 1; }

  if (!pkg) { console.error('沒有可上架的更新檔，停。'); return 1; }
  // ③ 上架：交給 ship-onprem.mjs（放 R2、更新檔先 latest.json 最後、從用戶那條路讀回驗）
  if (!confirm) { console.log('\n只檢查：全部通過。加 --confirm 執行。'); return 0; }
  const a = [join(HERE, 'ship-onprem.mjs'), '--target', target, '--release', release, '--onprem-version', version, '--package', pkg, '--confirm'];
  if (isProd) a.push('--ticket', arg('--ticket'));
  const r = spawnSync('node', a, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
  return r.status === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error('✖ ' + e.message); process.exit(1); });
}
