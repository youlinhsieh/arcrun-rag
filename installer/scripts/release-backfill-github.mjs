#!/usr/bin/env node
/**
 * release-backfill-github.mjs — 補建「prod 已出、GitHub 版本發佈物件沒建成」的那幾版（inkstone/InkStoneCo#252）
 *
 * ── 為什麼不直接重跑 ship.mjs ──────────────────────────────────────────────
 * 雲端 session 出 prod 時，release-record 站建 release 被 GitHub 回 403（session 類型限制）。
 * 要補這一格，現成的路都走不通：
 *   · `ship.mjs --target prod --confirm` 會重跑整條 prod——違反同機規則（stage／prod 同一台）
 *   · `ship.mjs --release-record-only` 被禁用在會發佈給用戶的目標
 *   · release-record 站本身只會補「磁碟上那一份 bundle」＝最新一版，補不了歷史上的五版
 * ⇒ 這支只做 release-record 站的「GitHub 那一半的 ③」：建 release＋掛 manifest＋回頭查證，
 *   **共用同一批函式**（內文組法、內部號、留痕、簽核核對都不另寫一套），
 *   而且**不推鏡像、不推 bundle、不動任何部署**——那些當時都已經做完了（逐格查證見下）。
 *
 * ── 每一版在動手前都要先過的查證（全部匿名唯讀，D20：讀一律放行）──────────────
 *   ① GitHub 上還沒有這個 tag（有就跳過，冪等）
 *   ② bundles repo 在釘子那顆 commit 的 manifest.json，release 欄位＝這一版（不信計畫檔）
 *   ③ 這一版帶到的桌面小幫手版號，在 arcrun-port 上已經有版本發佈（沒有就擋：那是另一條線的缺口）
 *   ④ 鏡像 repo 上 target commit 存在，且訊息是「snapshot <sourceCommit>」（指到對的那份原始碼）
 *   ⑤ CHANGELOG.md 有這一版的段落
 *   ⑥ AHub 簽核看板上這一版是 approved（簽核人在 AHub 設定，這支不自己判）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node installer/scripts/release-backfill-github.mjs                 # 預演：只讀，印出每一版的內文與要打的寫入請求數
 *   node installer/scripts/release-backfill-github.mjs --only 1.4.118  # 只看／只補一版（可重複）
 *   node installer/scripts/release-backfill-github.mjs --confirm       # 真的寫 GitHub（要 GITHUB_MIRROR_TOKEN、AHUB_TOKEN）
 * 計畫檔預設 installer/release-backfill-252.json（--plan 可換）。
 *
 * ── 桌面小幫手那條線（2026-11-01，1.4.125 帶到 0.18.118）──────────────────────
 * 計畫檔裡 `line: "daemon"` 的那一筆＝補建 arcrun-port 上的小幫手版本發佈。查證換成：
 *   ① arcrun-port 上還沒有這個 tag
 *   ② 釘子那顆 commit 的 manifest，daemon.version＝這一版
 *   ④ arcrun-port 上 target commit 存在，訊息是「…@<sourceCommit>（桌面小幫手 <版號>）」
 *      ——那是出 prod 時 release-record 站同步 collector/ 留下的那一顆（只差建 release）
 *   ⑤ collector/CHANGELOG.md 有這一版的段落
 *   ⑥ 簽核：用**帶它出去的那一版零件包**（armVersion）查——簽核簽的是那一趟出貨
 *   ⑦ 成品：從釘子那顆 commit 讀 manifest 宣告的 mac／win 檔，sha256 要等於 manifest 記的，
 *      而且要與正式站 `/download/<平台>` 現在發出去的逐位元相同（不同就擋：表示正式站已經換版，
 *      這時補上去的就不是「使用者當時拿到的那一份」）
 * 同一趟裡小幫手一定先建、零件包後建：零件包那筆的查證③認得「這一趟會先建的小幫手」。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releaseSectionFor, releaseExists, createRelease, uploadReleaseAsset, listReleases, listReleaseAssets,
} from './github-release.mjs';
import {
  formatInternalVersion, nextSequence, shortCodeFor, mappingSection, withMappingSection,
} from './internal-version.mjs';
import { LINES, linesFrom, assetsFor } from './release-lines.mjs';
import { checkTicketArmed } from './ticket-arm-guard.mjs';
import { logGithubContact } from './d20-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const INKSTONE_ROOT = process.env.INKSTONE_ROOT || join(REPO_ROOT, '..', '..');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const values = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]] : []));
const CONFIRM = flag('--confirm');
const ONLY = values('--only');
const PLAN_PATH = values('--plan')[0] || join(REPO_ROOT, 'installer', 'release-backfill-252.json');

const UA = { 'user-agent': 'arcrun-rag-backfill', accept: 'application/vnd.github+json' };

async function anonJson(url) {
  const r = await fetch(url, { headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`讀 ${url} 失敗：HTTP ${r.status}`);
  return r.json();
}

async function anonText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA['user-agent'] } });
  if (!r.ok) throw new Error(`讀 ${url} 失敗：HTTP ${r.status}`);
  return r.text();
}

async function anonBytes(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA['user-agent'] }, redirect: 'follow' });
  if (!r.ok) throw new Error(`讀 ${url} 失敗：HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 'YYYY-MM-DD' → 當地那一天的 Date（內部號的日期取出貨那天，不取補建這天）。 */
function shipDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`shipDate 要是 YYYY-MM-DD，收到 ${JSON.stringify(s)}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** 一版的全部查證。任何一格不過就回 problems——不留半套。 */
async function prepare(plan, v, existingBodies, plannedDaemonTags = new Set()) {
  const problems = [];
  const tag = v.version;
  const existing = (await releaseExists(plan.repoSlug, tag)) || (await releaseExists(plan.repoSlug, `v${tag}`));
  if (existing) return { v, existing };

  // ② 釘子那顆 commit 的 manifest
  const manifestText = await anonText(`https://raw.githubusercontent.com/${plan.bundlesSlug}/${v.bundlePin}/manifest.json`);
  const manifest = JSON.parse(manifestText);
  if (manifest.release !== v.version) {
    problems.push(`釘子 ${v.bundlePin} 的 manifest.release 是 ${manifest.release}，不是 ${v.version}`);
  }
  const lines = linesFrom(manifest, 'manifest');
  const bundleLine = lines.find((l) => l.id === 'bundle');
  if (!bundleLine) problems.push('manifest 讀不到零件包那條線');

  // ③ 其他對外的線（桌面小幫手）在它自己的 repo 上必須已經有發佈
  const daemonLine = lines.find((l) => l.id === 'daemon');
  if (daemonLine) {
    const d = (await releaseExists(plan.daemonSlug, daemonLine.tag)) || (await releaseExists(plan.daemonSlug, `v${daemonLine.tag}`));
    if (!d && plannedDaemonTags.has(daemonLine.tag)) {
      // 同一趟會先建它（main 裡小幫手一律排在前面）——它自己的查證已經過了
    } else if (!d) problems.push(`這一版帶的桌面小幫手 ${daemonLine.tag} 在 ${plan.daemonSlug} 上沒有版本發佈——那是另一條線的缺口，這支不補`);
  }

  // ④ 鏡像 target 存在且指到對的原始碼快照
  const c = await anonJson(`https://api.github.com/repos/${plan.repoSlug}/commits/${v.mirrorTarget}`);
  if (!c) problems.push(`鏡像 ${plan.repoSlug} 上找不到 commit ${v.mirrorTarget}`);
  // GitHub 建 release 的 target_commitish 只認完整 sha 或分支名，短 sha 回 422（2026-11-01 實撞）
  if (c) v.mirrorTargetFull = c.sha;
  if (c && !String(c.commit?.message || '').includes(`snapshot ${v.sourceCommit}`)) {
    problems.push(`鏡像 ${v.mirrorTarget} 的訊息不是「snapshot ${v.sourceCommit}」（實際：${String(c.commit?.message || '').split('\n')[0]}）`);
  }

  // ⑤ changelog 段落
  const changelogBody = releaseSectionFor(REPO_ROOT, v.version);
  if (!changelogBody) problems.push(`CHANGELOG.md 沒有 ${v.version} 這一段`);

  // ⑥ AHub 簽核
  let arm = null;
  try {
    arm = await checkTicketArmed({ version: v.version, repo: v.armTicket.repo, issue: v.armTicket.issue });
  } catch (e) {
    problems.push(`簽核：${e.message.split('\n')[0]}`);
  }

  if (problems.length) return { v, problems };

  const assets = assetsFor(bundleLine, manifest);   // 零件包線＝['manifest.json']
  const short = shortCodeFor('arcrun-rag');
  const day = shipDay(v.shipDate);
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const seq = nextSequence(existingBodies, short, stamp);
  const internal = formatInternalVersion({ repoName: 'arcrun-rag', commit: v.sourceCommit, sequence: seq, artifacts: assets, date: day });
  existingBodies.push(internal);   // 同一天的下一版要往後排
  const body = withMappingSection(changelogBody, mappingSection({
    product: bundleLine.product, external: bundleLine.tag, internal,
    upstream: typeof manifest.source === 'string' ? manifest.source : undefined, artifacts: assets,
  }));
  return { v, line: bundleLine, body, manifestText, assets, arm, internal };
}

/** 桌面小幫手那條線的一版（計畫檔 `line: "daemon"`）。查證項目見檔頭。 */
async function prepareDaemon(plan, v, existingBodies) {
  const problems = [];
  const slug = plan.daemonSlug;
  const existing = (await releaseExists(slug, v.version)) || (await releaseExists(slug, `v${v.version}`));
  if (existing) return { v, existing, slug };

  // ② 釘子那顆 commit 的 manifest
  const manifest = JSON.parse(await anonText(`https://raw.githubusercontent.com/${plan.bundlesSlug}/${v.bundlePin}/manifest.json`));
  const line = linesFrom(manifest, 'manifest').find((l) => l.id === 'daemon');
  if (!line) return { v, slug, problems: [`釘子 ${v.bundlePin} 的 manifest 裡沒有桌面小幫手那條線`] };
  if (line.version !== v.version) problems.push(`釘子 ${v.bundlePin} 的 manifest.daemon.version 是 ${line.version}，不是 ${v.version}`);

  // ④ arcrun-port 上的 target：出 prod 那一趟同步 collector/ 留下的那一顆
  const c = await anonJson(`https://api.github.com/repos/${slug}/commits/${v.mirrorTarget}`);
  if (!c) problems.push(`${slug} 上找不到 commit ${v.mirrorTarget}`);
  if (c) v.mirrorTargetFull = c.sha;
  const wantMsg = `@${v.sourceCommit}（桌面小幫手 ${v.version}）`;
  if (c && !String(c.commit?.message || '').includes(wantMsg)) {
    problems.push(`${slug}@${v.mirrorTarget} 的訊息不含「${wantMsg}」（實際：${String(c.commit?.message || '').split('\n')[0]}）`);
  }

  // ⑤ changelog（collector/CHANGELOG.md，releaseSectionFor 先查這一份）
  const changelogBody = releaseSectionFor(REPO_ROOT, v.version);
  if (!changelogBody) problems.push(`collector/CHANGELOG.md 沒有 ${v.version} 這一段`);

  // ⑥ 簽核：簽的是帶它出去的那一趟（零件包版號）
  let arm = null;
  try {
    arm = await checkTicketArmed({ version: v.armVersion, repo: v.armTicket.repo, issue: v.armTicket.issue });
  } catch (e) {
    problems.push(`簽核（${v.armVersion}）：${e.message.split('\n')[0]}`);
  }

  // ⑦ 成品：manifest 宣告的檔、sha256 對得上、與正式站現在發的逐位元相同
  const rels = assetsFor(line, manifest);
  if (!rels.length) problems.push('manifest 裡這條線沒有任何成品可以掛');
  const files = [];
  for (const [key, block] of Object.entries(manifest.daemon || {})) {
    if (!block || typeof block !== 'object' || !rels.includes(block.file)) continue;
    const data = await anonBytes(`https://raw.githubusercontent.com/${plan.bundlesSlug}/${v.bundlePin}/${block.file}`);
    const got = sha256(data);
    if (block.sha256 && got !== block.sha256) {
      problems.push(`${block.file} 的 sha256 是 ${got}，manifest 記的是 ${block.sha256}`);
      continue;
    }
    const prodUrl = (v.prodDownloads || {})[key];
    if (!prodUrl) { problems.push(`計畫檔沒有 ${key} 的正式站下載網址（prodDownloads.${key}），無從比對使用者拿到的那一份`); continue; }
    const prodSha = sha256(await anonBytes(prodUrl));
    if (prodSha !== got) {
      problems.push(`正式站 ${prodUrl} 發的是 ${prodSha}，跟釘子那份 ${got} 不同——正式站已經換版，不補`);
      continue;
    }
    files.push({ name: block.file.split('/').pop(), data, sha: got, prodUrl });
  }
  if (files.length !== rels.length) problems.push(`要掛 ${rels.length} 個成品，查證過的只有 ${files.length} 個`);

  if (problems.length) return { v, slug, problems };

  const assets = files.map((f) => f.name);
  const day = shipDay(v.shipDate);
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const repoName = slug.split('/').pop();
  const internal = formatInternalVersion({
    repoName, commit: v.mirrorTargetFull, sequence: nextSequence(existingBodies, shortCodeFor(repoName), stamp), artifacts: assets, date: day,
  });
  existingBodies.push(internal);
  const body = withMappingSection(changelogBody, mappingSection({
    product: line.product, external: line.tag, internal,
    upstream: typeof manifest.source === 'string' ? manifest.source : undefined, artifacts: assets,
  }));
  return { v, slug, line, body, files, assets, arm, internal };
}

async function main() {
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
  const todo = plan.versions.filter((v) => !ONLY.length || ONLY.includes(v.version));
  if (!todo.length) throw new Error(`計畫檔裡沒有要處理的版本（--only ${ONLY.join(' ')}）`);
  if (!LINES.find((l) => l.id === 'bundle')) throw new Error('release-lines.mjs 沒有零件包線');

  const bodiesOf = async (slug) => (await listReleases(slug).catch(() => []))
    .map((r) => `${r.tag_name || ''}\n${r.body || ''}`);
  const existingBodies = await bodiesOf(plan.repoSlug);
  const daemonBodies = await bodiesOf(plan.daemonSlug);

  // 小幫手一律排前面：零件包那筆的查證③要認得「這一趟會先建的小幫手」，寫入也照這個順序
  const isDaemon = (v) => v.line === 'daemon';
  const prepared = [];
  for (const v of todo.filter(isDaemon)) prepared.push(await prepareDaemon(plan, v, daemonBodies));
  const plannedDaemonTags = new Set(prepared.filter((p) => p.body).map((p) => p.line.tag));
  for (const v of todo.filter((x) => !isDaemon(x))) prepared.push(await prepare(plan, v, existingBodies, plannedDaemonTags));

  let writes = 0;
  for (const p of prepared) {
    console.log(`\n══ ${p.v.version} ═══════════════════════════════════════`);
    if (p.existing) { console.log(`⏭ 已存在：${p.existing.html_url}`); continue; }
    if (p.problems) { p.problems.forEach((x) => console.log(`❌ ${x}`)); continue; }
    writes += 1 + p.assets.length;
    const where = p.slug || plan.repoSlug;
    console.log(`✅ 查證全過｜${where}｜target ${p.v.mirrorTarget}（snapshot ${p.v.sourceCommit}）｜釘子 ${p.v.bundlePin.slice(0, 7)}｜內部號 ${p.internal}`);
    console.log(`   簽核：${p.arm.mission}`);
    if (p.files) {
      for (const f of p.files) console.log(`   要掛：${f.name}（${f.data.length} bytes，sha256 ${f.sha}；＝manifest 記的＝${f.prodUrl} 現在發的）`);
    } else {
      console.log(`   要掛：${p.assets.join('、')}（取自釘子那顆 commit，${p.manifestText.length} bytes）`);
    }
    console.log('   ── 內文 ──');
    console.log(p.body.split('\n').map((l) => `   │ ${l}`).join('\n'));
  }
  const blocked = prepared.filter((p) => p.problems);
  const ready = prepared.filter((p) => p.body);
  console.log(`\n小結：要建 ${ready.length} 筆、已存在 ${prepared.filter((p) => p.existing).length} 筆、擋下 ${blocked.length} 筆；`
    + `對 GitHub 的寫入請求共 ${writes} 個（每筆＝建 release 1＋掛它的成品數）。`);

  if (!CONFIRM) { console.log('（預演：沒有寫任何東西。真的要寫加 --confirm）'); return blocked.length ? 2 : 0; }
  if (blocked.length) throw new Error('有版本沒過查證，--confirm 不放行任何一筆（不留半套）。');

  const token = process.env.GITHUB_MIRROR_TOKEN || '';
  if (!token) throw new Error('缺 GITHUB_MIRROR_TOKEN（環境變數；D36 只讀名字）。');

  for (const p of ready) {
    const slug = p.slug || plan.repoSlug;
    const rel = await createRelease({
      repoSlug: slug, tag: p.line.tag, name: p.line.title, body: p.body,
      targetCommitish: p.v.mirrorTargetFull || p.v.mirrorTarget, token,
    });
    logGithubContact(INKSTONE_ROOT, p.arm.mission, `補建 release ${p.line.tag}（${p.line.product}，${slug}，InkStoneCo#252） → ${rel.html_url}`);
    const uploads = p.files
      ? p.files.map((f) => ({ name: f.name, data: f.data, contentType: 'application/octet-stream' }))
      : p.assets.map((name) => ({ name, data: Buffer.from(p.manifestText), contentType: 'application/json' }));
    for (const u of uploads) {
      await uploadReleaseAsset({ uploadUrl: rel.upload_url, name: u.name, data: u.data, token, contentType: u.contentType });
      logGithubContact(INKSTONE_ROOT, p.arm.mission, `掛成品 ${u.name} → release ${p.line.tag}（${slug}，InkStoneCo#252 補建）`);
    }
    const onPage = await listReleaseAssets(slug, rel.id);
    const missing = uploads.filter((u) => !onPage.some((x) => x.name === u.name && (!p.files || x.size === u.data.length))).map((u) => u.name);
    if (missing.length) throw new Error(`${rel.html_url} 建好了，但 ${missing.join('、')} 沒掛上去——停在這一筆，不往下建。`);
    console.log(`✅ ${p.line.title} → ${rel.html_url}（成品：${onPage.map((x) => x.name).join('、')}）`);
  }
  return 0;
}

main().then((code) => process.exit(code || 0)).catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
