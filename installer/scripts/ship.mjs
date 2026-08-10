#!/usr/bin/env node
/**
 * ship.mjs — 出貨管線（**會執行**，不是印待辦）
 *
 * ── 這支為什麼被整個重寫（leo 2026-08-08）────────────────────────────────
 * leo 原話：
 *   「每次做一樣的事，結果會打錯實例，就是你的出貨閘是錯的。
 *     **寫對的應該每次都機械式的做同一件事，寫錯位置也會被它修正。**」
 *   「這個出貨閘門就是廢的，它應該要像 GitHub Actions 一樣 CI/CD。」
 *   「如果你修改過，系統應該要自動換版本，如果沒換，就有問題。」
 *
 * 舊版壞在四件事（每一件當天都真的害到人）：
 *   ① **只印待辦、不執行**——做沒做、做對沒做對，沒有任何機械檢查。
 *   ② 待辦第一條是**過期指示**（叫人改 worker.js 常數，真身是 wrangler.toml [vars]）
 *      ⇒ 08-07 照它做，白部署一次。
 *   ③ **目標用手打**（`--bundles <path>`）⇒ 打錯 repo／打錯實例沒有任何東西攔。
 *   ④ **不重打 bundle**⇒ 改了 portal 文案、版本仍 1.4.22 ⇒ 改動永遠送不出去，
 *      而安裝器判「同版整批跳過」⇒ **重裝也修不好**。
 *
 * ── 這版的三個不變式（對應 leo 的三句話）─────────────────────────────────
 *   Ⅰ **同一份輸入永遠得到同一組動作**：步驟表寫死在下面，順序固定、無分支；
 *      每一步只有「執行」或「跳過（附機械理由）」兩種結果，不因誰跑、跑第幾次而不同。
 *   Ⅱ **打錯目標打不進去**：目標只能從 `installer/ship.targets.json` 選（`--target`），
 *      不接受任何手打路徑／網址／帳號；且本機 clone 的 origin、CF 帳號都要與登錄簿相符，
 *      不符當場擋下。
 *   Ⅲ **沒送達就不算成功**：最後一步走**使用者真的會走的那條路**（安裝器 /api/latest、
 *      真的把 daemon 下載下來算 sha256、抓釘點產物驗內容），任一項不符 ⇒ 非零退出。
 *
 * 另外：**版本號由內容算出來**（release.mjs 的指紋機制），而本管線對「重打」目標
 * **每次都重打 bundle** ⇒ 「改了東西版本沒動」在結構上不可能發生；反之版本一樣就保證內容一樣。
 *
 * ── 不變式 Ⅳ（2026-08-08 加）：發佈目標「提升」，不「重打」──────────────────
 * leo 原話：「arm 推的是 uncle6 把 stage 的 bundle 推到 prod 的 bundle」「⑥ 是提升不是重打」。
 * 送上 prod 的東西必須**就是** leo 在 stage 上驗過的那份，不是「拿同一份原始碼再打一次、
 * 假設會一樣」——重打有機會產生差異，而那個差異**沒有人驗過**。
 *
 * 登錄簿裡目標若有 `promoteFrom: "<其他目標>"`，build 步驟就不重打，改成**複製**該目標已提交
 * 的 bundle 內容過來，並用 release.mjs 既有的內容指紋（`contentFingerprint`：core[] 每顆
 * name+sha256 串起來 hash）做機械核對——複製後從磁碟重算的指紋若與來源宣告的指紋不符，
 * **當場丟例外、非零退出**，不是印警告繼續。版本號直接繼承來源（同一份內容只有一個版本號，
 * 不是兩個目標各自累計 patch）。
 *
 * 「來源是不是真的驗證過」不是自稱的：來源目標成功 `--confirm` 且 verify 全過後，管線自己
 * 在檔尾蓋一張驗證章（`/tmp/.stage-verified`，內容含 sha/release/fingerprint，不只時間戳）；
 * 提升步驟核對磁碟 HEAD 與蓋章時的 HEAD 一致，來源往前移動而沒重新驗證就拒絕提升。
 * 這張章由管線自己寫，不是人手 touch、也不是 AI 自造——**AI 造不出「驗收真的跑過」這件事**。
 *
 * 提升只複製「build 步驟管的那幾顆」（見 `BUILD_MANAGED`），不是整包蓋掉：目標專屬的東西
 * （例如 prod 的 `daemon/`、`README.md`）原樣留著——08-07 就是整包蓋掉 prod 才把這些砍光。
 *
 * ── 不變式 Ⅴ（2026-08-09 加，arcrun-rag#27）：出貨包含**說明**，不只包含程式 ────
 * leo 推完 1.4.29 prod 後問：「你推完 prod 以後有去檢查上架的東西是否正確嗎？這是第一次用，
 * 應該要看有沒有漏，比如說**版本有沒有版本說明？有沒有上 docs？**」
 * 一查漏了兩件，而且是同一種病——**規約寫在註解裡，沒有任何一步在執行它**：
 *   ① `prod.docsSite` 是 null ⇒ 文件站從沒進過出貨鏈（一直靠人手動 wrangler deploy），
 *      `rag.arcrun.dev/docs/help/changelog/` 停在 v0.18.24，封測者拿到的是 v0.18.25。
 *   ② `wrangler.toml` 註解寫著「BUNDLE_BUILT＝釘點 manifest.built（D37 單一真相源）」，
 *      但 manifest 的 built 是 `m.built || 今天`＝**有值就不動** ⇒ prod 的建置日黏在 08-07。
 * ⇒ 三道機械閘取代那兩段註解：
 *   · 有 `installer` 的目標**必須**宣告 `docsSite`，漏填在任何步驟開跑前就 exit 2
 *   · docs 步驟部署完要**去線上那一頁把 release 與 daemon 版本找出來**（200 不算驗過）
 *   · built 跟 release／fingerprint 一樣**繼承來源**，且 verify 斷言
 *     「線上宣告的建置日 == 這次 manifest 的建置日」（也就是 pin 有沒有真的送達）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node installer/scripts/ship.mjs --target stage              # 預演（建＋算版本，不推不部署）
 *   node installer/scripts/ship.mjs --target stage --confirm    # 真的走完
 *   node installer/scripts/ship.mjs --target prod  --confirm    # 需 leo 先開 D20 閘
 *   node installer/scripts/ship.mjs --list                      # 有哪些目標
 *   node installer/scripts/ship.mjs --target prod --verify-only # 只驗收線上現況，什麼都不改
 * 旗標：--quick（驗收略過真下載，只驗中繼資料）／--allow-deletions（bundle 有刪檔時放行）
 *       --verify-only（只跑最後那步驗收；不建/不推/不部署/不蓋章，判定與 --confirm 一樣嚴）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { syncManifest, verifyManifest, recomputeShas, contentFingerprint } from './release.mjs';
import { notesFromChangelog, checkNotes, CHANGELOG_REL } from './daemon-notes.mjs';
import { checkArmed, logGithubContact } from './d20-guard.mjs';
import { BUNDLE_COMPONENTS, BUNDLE_COMPONENT_NAMES, diffAgainstCanonical } from './bundle-components.mjs';
import { checkDaemonDownload } from './verify-download.mjs';
import { checkDocsLive } from './verify-docs.mjs';
import { renderBundlesReadme } from './render-bundles-readme.mjs';
import { releaseSectionFor, releaseExists, createRelease } from './github-release.mjs';

const REPO_ROOT = resolve(join(import.meta.dirname, '..', '..'));
const TARGETS_FILE = join(REPO_ROOT, 'installer', 'ship.targets.json');
// InkStoneCo 頂層（.github-armed／github-contact-log.md 的真身都住在這裡，見 d20-guard.mjs 檔頭）
const INKSTONE_ROOT = resolve(REPO_ROOT, '..', '..');
// 桌面 App（daemon）打包產物落地處——`daemon-sync` 從這裡取，見該步驟檔頭。
const DAEMON_DIST_REL = join('collector', 'cmd', 'arcrun-app', 'dist');

// ── 參數 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const cfg = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
const TARGET_NAMES = Object.keys(cfg.targets);

if (flag('--list')) {
  console.log('可用目標（--target <名字>）：');
  for (const [k, t] of Object.entries(cfg.targets)) {
    console.log(`   ${k.padEnd(9)} ${t.label}${t.publish ? '  🔫 需 leo 開閘' : ''}`);
  }
  process.exit(0);
}

// 🔴 不變式 Ⅱ：目標不准用手打。舊旗標一律硬擋，不做「好心的相容」——
//    相容就等於那條會打錯的路還活著（08-08 的病根）。
for (const dead of ['--bundles', '--dry-run', '--purge']) {
  if (flag(dead)) {
    console.error(`❌ \`${dead}\` 已移除。出貨目標只能從登錄簿選，不能用手打：`);
    console.error(`   node installer/scripts/ship.mjs --target <${TARGET_NAMES.join('|')}> [--confirm]`);
    console.error(`   登錄簿：installer/ship.targets.json（改它＝改出貨會打到哪裡）`);
    process.exit(2);
  }
}

const TARGET_NAME = opt('--target');
if (!TARGET_NAME || !cfg.targets[TARGET_NAME]) {
  console.error(`❌ --target 必須是登錄簿裡的目標之一：${TARGET_NAMES.join(' / ')}`);
  console.error(`   （給了：${TARGET_NAME === null ? '(沒給)' : JSON.stringify(TARGET_NAME)}）`);
  process.exit(2);
}
const T = cfg.targets[TARGET_NAME];

// 🔴 不變式 Ⅴ：**有安裝器的目標，一定要有文件站**（2026-08-09，arcrun-rag#27）
//   leo 推完 1.4.29 prod 後問：「有沒有上 docs？版本有沒有版本說明？」
//   ——沒有。`prod.docsSite` 是 null，出貨時那一步印「本目標沒有文件站」安靜跳過，
//   於是 `rag.arcrun.dev/docs/help/changelog/` 停在 v0.18.24，而封測者拿到 v0.18.25。
//   「宣告 null 就跳過」對 selftest 是對的（它不面對任何人），
//   對**有使用者的目標**卻等於「漏了不會有人知道」⇒ 這裡把它變成宣告錯誤，
//   在任何步驟開跑之前就擋下：登錄簿漏填，不是出貨時的一行警告，是根本不准開跑。
//   （檢查全部目標，不是只檢查這次要出的那個——漏填要在最早的時刻被看見。）
for (const [name, t] of Object.entries(cfg.targets)) {
  if (t.installer && !t.docsSite) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 有安裝器（會有人拿到東西），卻沒宣告 docsSite。`);
    console.error(`   使用者更新完想知道「這版改了什麼」只有文件站可查——沒接上就是出了貨沒有說明。`);
    console.error(`   → 在 installer/ship.targets.json 的 \`${name}\` 補 docsSite（cwd／config／wranglerEnv／accountId／verifyUrl）`);
    process.exit(2);
  }
}

// 🔴 不變式 Ⅵ：**會發佈給用戶的目標，一定要有 githubRelease**（2026-08-10，總管實測發現）
//   leo：「你的出貨沒有限制你一定要在 github 產生 release？」「那為什麼不改掉？」
//   `docs-site/.../help/changelog.md` 對用戶承諾「完整發佈紀錄在 GitHub 版本發佈」，
//   但 `youlinhsieh/arcrun-rag` 的 releases 一個都沒有、公開鏡像停在數週前——
//   出貨管線從沒有任何一步碰過它。`docs-changelog` 那道閘擋得住「沒寫說明」，
//   「GitHub 上有沒有這一版」卻完全沒有對應的閘 ⇒ 一個承諾有牙齒、一個沒有，
//   於是後者每次出貨都安靜漏掉。跟 docsSite 同一種病、同一種解法：宣告成必填，
//   漏填在任何步驟開跑前就擋下，不是出貨時的一行警告（也不是等用戶點進空頁面才發現）。
for (const [name, t] of Object.entries(cfg.targets)) {
  if (t.publish && !t.githubRelease) {
    console.error(`❌ 登錄簿不完整：目標 \`${name}\` 會發佈給用戶（publish=true），卻沒宣告 githubRelease。`);
    console.error(`   說明文件對用戶承諾「完整發佈紀錄在 GitHub」，沒有這一步就是承諾沒有機械保證。`);
    console.error(`   → 在 installer/ship.targets.json 的 \`${name}\` 補 githubRelease（repoSlug／mirrorDir／mirrorRemote）`);
    process.exit(2);
  }
}

const CONFIRM = flag('--confirm');
const QUICK = flag('--quick');
const ALLOW_DELETIONS = flag('--allow-deletions');

// 🔴 --verify-only（2026-08-09，arcrun-rag#27）：**只跑最後那一步驗收，什麼都不改**。
//   為什麼要有：verify 這道閘 08-09 在 prod 誤報一次（見 verify-download.mjs 檔頭），
//   而當時**沒有任何辦法單獨重跑它來確認修好了**——要驗它就得跑完整條會 push 會 deploy
//   的管線（prod 還要 leo 開 D20 保險）。一道無法單獨演練的閘，修了也不知道修好沒有。
//   安全性：只跑 `mutates:false` 的 verify 步驟，不 build、不 push、不 deploy、不蓋驗證章；
//   而且**判定與 --confirm 同樣嚴格**（不像預演會把差距降級成「正常」），
//   ⇒ 它不可能被誤當成出貨，也不可能靠它放水。
const VERIFY_ONLY = flag('--verify-only');
if (VERIFY_ONLY && CONFIRM) {
  console.error('❌ --verify-only 與 --confirm 不能一起用：前者只驗不出貨，後者是真的出貨。');
  process.exit(2);
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const sh = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }).trim();

function shLive(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, {
    cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗（exit ${r.status}）`);
}

/** git remote 正規化：去掉協定、帳密、.git 結尾 ⇒ 只比「這是哪個 repo」。 */
const normRemote = (u) => String(u || '')
  .replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();

const cb = () => `cb=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
async function getJson(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

// ── 管線狀態（步驟之間唯一的共享處，方便追「這個值哪來的」）────────────────
const ctx = {
  target: TARGET_NAME, T,
  bundlesDir: T.bundles.dir,
  arcrunRepo: resolve(REPO_ROOT, cfg.source.arcrunRepo),
  release: null, releaseBefore: null, daemonVersion: null,
  built: null,   // manifest.built＝使用者在 /api/latest 看到的建置日（見 version／pin／verify）
  headSha: null, pinUrl: null,
  liveBefore: null,
  pinChanged: false, pushed: false,
  promote: null, // 提升路徑（見 build 步驟）用來把「來源是誰、期望的指紋/版本是什麼」帶到 version 步驟
  armMission: null, // D20 保險的任務描述（見 preflight），push 步驟留痕要用
};

// 🔴 leo 2026-08-08：「arm 推的是 uncle6 把 stage 的 bundle 推到 prod 的 bundle」
//   「⑥ 是提升不是重打」——prod 拿到的東西必須**就是** leo 在 stage 上驗過的那份，
//   不是「拿同一份原始碼再打一次、假設會一樣」。重打有機會產生差異，而那個差異
//   **沒有人驗過**。這份清單＝「build 步驟管的那幾顆」，也是「提升時要複製的那幾顆」——
//   同一份清單、兩種目標（target 沒 promoteFrom＝重打管這些；有 promoteFrom＝提升管這些），
//   保證兩條路徑管的東西永遠是同一組，不會有一邊多改一邊漏改。
//
// 🔴 2026-08-09（arcrun-rag#27）：這份清單**不再寫在這裡**。
//   原本這裡一份、`build-bundles.mjs` 的 `CORE` 一份——兩份人手維護的清單，
//   而且只有本檔（提升路徑）這一份會被套用到 prod。
//   結果：prod 5 顆、stage 24 顆，prod 卻宣告自己「複製自 stage@ab4ef01」
//   ——而 stage 的 ab4ef01 當時就是 24 顆。**「提升＝複製」這句話是假的**：
//   複製的路上被這份白名單濾掉了 19 顆，而 stage 從沒被同一把尺量過。
//   leo：「如果是複製，為什麼不一致？」
//   ⇒ 兩條路徑改讀同一份 `bundle-components.mjs`，並在 `parity` 步驟用它夾住兩邊。
const BUILD_MANAGED = BUNDLE_COMPONENTS.map((c) => ({ name: c.name, relDir: c.relDir }));

// ══════════════════════════════════════════════════════════════════════════
// 步驟表 —— 固定順序、無分支。每一步回傳 { status:'done'|'skip', detail }
//           丟例外＝這一步斷了，**後面全部不跑**（不變式：失敗即停）。
// ══════════════════════════════════════════════════════════════════════════
const STEPS = [

// ── 1. preflight：在動任何東西之前，確認「我要打的是不是我以為的那個目標」──
{ id: 'preflight', title: '對齊目標（打錯目標打不進去）', mutates: false, async run() {
  const lines = [];

  // (a) publish 目標＝會讓封測者拿到東西 ⇒ 必須 leo 親手開閘。AI 不得自造 .github-armed。
  //     🔴 2026-08-09（arcrun-rag#27）：舊版只查檔案存不存在，**不查過不過期**——
  //     一份三天前的舊保險檔一樣會放行（8/8 23:16 那份至今還在，就是這樣被發現的）。
  //     checkArmed()（d20-guard.mjs）補上過期檢查，並把 mission 帶出來給 push 步驟留痕用。
  if (T.requiresArm) {
    const { mission, expiresAt } = checkArmed(INKSTONE_ROOT);
    ctx.armMission = mission;
    lines.push(`保險已解（未過期，還剩 ${Math.max(0, Math.round((expiresAt - Date.now() / 1000) / 60))} 分鐘）：任務＝${mission}`);
  } else {
    lines.push(`目標不發佈（publish=false）⇒ 不需要 leo 開閘`);
  }

  // (b) 產物來源：**只有「重打」目標才碰 Arcrun 原始碼**。
  //     提升目標（T.promoteFrom）不重打、不讀 Arcrun repo——它的「來源」是
  //     另一個已出貨且已驗證過的目標，查核邏輯在 build 步驟本身（見下）。
  if (T.promoteFrom) {
    lines.push(`來源：提升自 ${T.promoteFrom}（不重打，不碰 Arcrun repo；見 build 步驟）`);
  } else {
    if (!existsSync(ctx.arcrunRepo)) throw new Error(`來源 repo 不存在：${ctx.arcrunRepo}`);
    // ── ARCRUN_SOURCE_WORKTREE（2026-08-10 加）────────────────────────────────
    // 病：`matrix/arcrun` 只有**一份工作區**，卻同時有好幾個 agent 在上面幹活。
    //     只要有人手上有未提交的改動（那天是 `kbdb/src/actions/entry-crud.ts`，而 kbdb
    //     **正是 bundle 裡的一顆**），下面那道 dirty 閘就會擋住所有出貨——
    //     而看起來唯一的「解法」是去 commit 或丟棄別人的半成品，那是比擋住更糟的事。
    //
    // 這個逃生門**不放寬任何判準**，只是換一個乾淨的取景窗：
    //   ① 必須是**同一個 repo 的 git worktree**（比對 `--git-common-dir`）
    //      ⇒ 擋不掉「打錯 repo」這件事，不變式 Ⅱ 完好
    //   ② 它自己**一樣要乾淨**，dirty 照樣擋
    //      ⇒「這版來自哪個 commit」照樣是真的（這才是那道閘真正在保的東西）
    // 用法：git worktree add /tmp/arcrun-ship HEAD && ARCRUN_SOURCE_WORKTREE=/tmp/arcrun-ship …
    const wt = process.env.ARCRUN_SOURCE_WORKTREE;
    if (wt) {
      const wtPath = resolve(wt);
      if (!existsSync(wtPath)) throw new Error(`ARCRUN_SOURCE_WORKTREE 不存在：${wtPath}`);
      const commonOf = (p) => resolve(p, sh('git', ['rev-parse', '--git-common-dir'], p));
      if (commonOf(wtPath) !== commonOf(ctx.arcrunRepo)) {
        throw new Error(
          `ARCRUN_SOURCE_WORKTREE 不是登錄簿宣告那個 repo 的 worktree（拒絕從別的 repo 出貨）：\n` +
          `       宣告：${ctx.arcrunRepo}\n       給的：${wtPath}`);
      }
      ctx.arcrunRepo = wtPath;
      lines.push(`來源改讀 worktree：${wtPath}（同一個 repo；乾淨度照驗，不放寬）`);
    }
    const srcDirty = sh('git', ['status', '--porcelain'], ctx.arcrunRepo);
    const srcSha = sh('git', ['rev-parse', '--short', 'HEAD'], ctx.arcrunRepo);
    if (srcDirty && !T.allowDirtySource) {
      throw new Error(
        `來源 repo 有未提交變更，發佈目標拒絕出貨（不然「這版來自哪個 commit」是假的）：\n` +
        srcDirty.split('\n').slice(0, 8).map((l) => `       ${l}`).join('\n') +
        `\n     → 先 commit，或用 --target selftest 做本機驗證`);
    }
    lines.push(`來源：Arcrun@${srcSha}${srcDirty ? ' ⚠️(工作區不乾淨，本目標允許)' : ''}`);
  }

  // (c) bundle repo：不存在就照登錄簿長出來（selftest）；存在就驗 origin 與登錄簿相符。
  //     🔴 這一條就是「打錯位置也會被它修正」的實體：本機那個資料夾指到別的 repo ⇒ 當場擋。
  if (!existsSync(join(ctx.bundlesDir, '.git'))) {
    if (T.bundles.seedFrom && existsSync(T.bundles.seedFrom)) {
      mkdirSync(ctx.bundlesDir, { recursive: true });
      cpSync(T.bundles.seedFrom, ctx.bundlesDir, { recursive: true, filter: (s) => !s.includes('/.git') });
      rmSync(join(ctx.bundlesDir, '.git'), { recursive: true, force: true });
      sh('git', ['init', '-q', '-b', T.bundles.branch], ctx.bundlesDir);
      sh('git', ['add', '-A'], ctx.bundlesDir);
      sh('git', ['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m', 'seed'], ctx.bundlesDir);
      lines.push(`bundle repo 不存在 ⇒ 依登錄簿由 ${T.bundles.seedFrom} 播種`);
    } else {
      throw new Error(`bundle repo 不存在：${ctx.bundlesDir}\n     → clone ${T.bundles.remote} 到這個路徑（路徑由登錄簿決定，別自己挑）`);
    }
  }
  if (T.bundles.remote !== 'local-selftest') {
    let origin = '';
    try { origin = sh('git', ['remote', 'get-url', 'origin'], ctx.bundlesDir); } catch { /* 無 origin */ }
    if (normRemote(origin) !== normRemote(T.bundles.remote)) {
      throw new Error(
        `bundle repo 指到**別的地方**，拒絕出貨（這正是「打錯實例」的入口）：\n` +
        `       目錄   ${ctx.bundlesDir}\n` +
        `       origin ${normRemote(origin) || '(沒有 origin)'}\n` +
        `       應為   ${normRemote(T.bundles.remote)}   ← installer/ship.targets.json`);
    }
    lines.push(`bundle repo：${ctx.bundlesDir} → ${normRemote(origin)} ✓`);
  } else {
    lines.push(`bundle repo：${ctx.bundlesDir}（本機 selftest，不推遠端）`);
  }

  // (c2) 記下「動手之前」的版本——步驟 3 要靠它誠實報告這次有沒有 bump。
  try {
    ctx.releaseBefore = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).release;
    lines.push(`動手前版本：${ctx.releaseBefore}`);
  } catch { ctx.releaseBefore = null; }

  // (d) 先記下線上現況——之後 deploy 要靠它判斷「是不是已經是這一版」（冪等的依據）。
  if (T.verify) {
    try {
      ctx.liveBefore = await getJson(`${T.verify.installerBase}/api/latest?${cb()}`);
      lines.push(`線上現況：release ${ctx.liveBefore.release}｜pin ${ctx.liveBefore.pin}`);
    } catch (e) { lines.push(`線上現況：讀不到（${e.message}）`); }
  }
  return { status: 'done', detail: lines };
}},

// ── 1.4 daemon-sync：**把 daemon 真的搬進 bundle**（下面那道 check 才有東西可過）──
//
// 🔴 leo 2026-08-09（arcrun-rag#27）：「你推 Stage 機制會複製到推 Prod 機制，
//   所以你 stage 沒帶上 daemon 這個問題如何解決？」
//
// 08-09 第一輪只加了下面的 `daemon-check`——它**擋得住**「daemon 沒跟上」，
// 但擋下來之後要人**手動**把 dmg/exe/msix 搬進 bundle、手算 sha256、手改 manifest。
// 那就是把一道機械閘變成一張待辦事項：出貨鏈照樣停在那裡，而且「怎麼搬」這件事
// 只活在人的記憶裡——正是 leo 說的「演習視同作戰」要根治的東西。
// （實錄：daemon v0.18.25 的 dmg/exe/msix 08-09 17:36 就打好躺在 dist/，
//   stage bundle 裡卻還是 v0.18.24，因為**沒有任何一步負責搬它**。）
//
// ⇒ 這一步補上那個「沒有任何一步負責」的動作，而且**兩條路徑各照各的規矩**，
//   與 BUILD_MANAGED 完全同構——這樣 stage 的機制複製到 prod 才是安全的：
//     · 重打目標（stage）＝從 `collector/cmd/arcrun-app/dist/` 取 changelog 最上面
//       那個**已發佈**版本的產物，複製進 bundle，sha256 由**磁碟實檔**算（不抄宣告值）。
//     · 提升目標（prod）＝**照抄來源（stage）驗過的那一份**，不從 dist 另外取一次。
//       理由與零件同一條：prod 拿到的必須就是 leo 在 stage 驗過的那個二進位，
//       「拿同一份原始碼再打一次、假設會一樣」不算。
//
// 只加不刪：舊版本的安裝檔留在 bundle 裡（prod 就留著 20 個），要不要回收是人的決定。
{ id: 'daemon-sync', title: T.promoteFrom
  ? `把 ${T.promoteFrom} 驗過的 daemon 產物照抄過來`
  : '把本機最新已發佈的 daemon 產物搬進 bundle', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在（首次播種前）'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const dstDir = join(ctx.bundlesDir, 'daemon');

  // ── 提升路徑：照抄來源，不重取 ──────────────────────────────────────────
  if (T.promoteFrom) {
    const S = cfg.targets[T.promoteFrom];
    const srcM = JSON.parse(readFileSync(join(S.bundles.dir, 'manifest.json'), 'utf8'));
    if (!srcM.daemon || !srcM.daemon.version) {
      return { status: 'skip', detail: [`來源（${T.promoteFrom}）沒有 daemon 區塊，不適用`] };
    }
    if (m.daemon && m.daemon.version === srcM.daemon.version) {
      return { status: 'skip', detail: [`已與來源同版：${srcM.daemon.version}`] };
    }
    mkdirSync(dstDir, { recursive: true });
    const copied = [];
    for (const [k, v] of Object.entries(srcM.daemon)) {
      if (!v || typeof v !== 'object' || !v.file) continue;
      const from = join(S.bundles.dir, v.file);
      if (!existsSync(from)) throw new Error(`來源宣告 daemon.${k}.file=${v.file}，但檔案不在 ${S.bundles.dir}`);
      cpSync(from, join(ctx.bundlesDir, v.file));
      copied.push(`${k}→${v.file}`);
    }
    const before = m.daemon && m.daemon.version;
    m.daemon = { ...m.daemon, ...srcM.daemon };
    writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');
    return { status: 'done', detail: [
      `daemon ${before || '(無)'} → ${srcM.daemon.version}（照抄 ${T.promoteFrom}，不重取）`,
      `複製 ${copied.length} 個安裝檔：${copied.join('、')}`,
    ] };
  }

  // ── 重打路徑：從 dist/ 取 changelog 最上面那個已發佈版本 ─────────────────
  const clPath = join(REPO_ROOT, CHANGELOG_REL);
  if (!existsSync(clPath)) return { status: 'skip', detail: [`找不到 ${CHANGELOG_REL}`] };
  const top = readFileSync(clPath, 'utf8').match(/^## (v\d+\.\d+\.\d+)（/m);
  if (!top) return { status: 'skip', detail: ['changelog 裡沒有任何已發佈的 daemon 版本段'] };
  const want = top[1];
  if (m.daemon && m.daemon.version === want) {
    return { status: 'skip', detail: [`bundle 已是 changelog 最新已發佈版：${want}`] };
  }

  const distDir = join(REPO_ROOT, DAEMON_DIST_REL);
  if (!existsSync(distDir)) throw new Error(`找不到 daemon 產物目錄 ${DAEMON_DIST_REL}`);
  // 檔名規則與 collector 的打包腳本一致；缺 mac／win 就是還沒打完，不准含糊出貨。
  const wanted = [
    { key: 'mac', file: `Arcrun-${want}.dmg`, required: true },
    { key: 'win', file: `Arcrun-win-${want}.exe`, required: true },
    { key: 'msix', file: `Arcrun-${want}.msix`, required: false },
  ];
  const missing = wanted.filter((w) => w.required && !existsSync(join(distDir, w.file)));
  if (missing.length) {
    throw new Error(
      `changelog 說 ${want} 已發佈，但 ${DAEMON_DIST_REL} 裡找不到它的產物：\n` +
      missing.map((w) => `       • ${w.file}`).join('\n') + '\n' +
      `     → 先把 ${want} 的桌面 App 打包出來（Mac 與 Windows 都要），再出貨；\n` +
      `     → 若這版本來就不該出，把 changelog 最上面那段改回「下一版（未發佈）」草稿。`);
  }

  mkdirSync(dstDir, { recursive: true });
  const before = m.daemon && m.daemon.version;
  const daemon = { ...(m.daemon || {}), version: want };
  const copied = [];
  for (const w of wanted) {
    const from = join(distDir, w.file);
    if (!existsSync(from)) continue;
    cpSync(from, join(dstDir, w.file));
    // sha256 由**磁碟實檔**算——安裝器就是拿這個值驗下載完整性，抄錯等於全體裝不起來。
    const sha = createHash('sha256').update(readFileSync(join(dstDir, w.file))).digest('hex');
    daemon[w.key] = { file: `daemon/${w.file}`, sha256: sha };
    copied.push(`${w.key}→${w.file}`);
  }
  // `built` 也由產物推導（取 mac 產物的 mtime），不由人當場填。
  const stamp = statSync(join(dstDir, `Arcrun-${want}.dmg`)).mtime;
  const p2 = (n) => String(n).padStart(2, '0');
  daemon.built = `${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}`;
  m.daemon = daemon;
  writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');
  return { status: 'done', detail: [
    `daemon ${before || '(無)'} → ${want}（來源 ${DAEMON_DIST_REL}）`,
    `複製 ${copied.length} 個安裝檔並重算 sha256：${copied.join('、')}`,
    `built=${daemon.built}（由產物 mtime 推導）`,
  ] };
}},

// ── 1.5 daemon-check：bundle 裡的 daemon 版本，是不是本機（changelog）最新那版 ──
// （上一步 daemon-sync 已負責「搬」；本步是它的**後置條件驗證**——搬完仍不符就是搬錯了。）
// 🔴 leo 2026-08-09（arcrun-rag#27 C0，最優先）：
//   「你寫了 CI/CD 腳本推到 Stage，這個『演習視同作戰』，你推 Stage 機制會複製到
//     推 Prod 機制，所以你 stage 沒帶上 daemon 這個問題如何解決？」
//
// 實錄：總管打好 daemon v0.18.25，跑 ship.mjs --target stage --confirm，
// 腳本印「✅ 出貨完成｜daemon v0.18.24」——新 daemon 根本沒被搬上去，腳本卻說完成了。
//
// 根因（讀碼確認）：BUILD_MANAGED（見下）沒有 daemon 這一項——不管是「重打」（stage）
// 還是「提升」（prod）路徑，都不碰 bundlesDir/daemon/；manifest.daemon 只是**原樣留著**
// （release.mjs `syncManifest` 的 `...m` 保留邏輯，本來是為了不要把 daemon 欄位吃掉，
// 但副作用是它也絕不會自己變新）。verifyManifest（release.mjs）驗得很細——宣告版本
// ＝檔名＝二進位內版本——但驗的是「bundle 內部自洽」：舊的自己跟自己相符，一樣綠燈。
// 它從來沒有問過「這是不是我現在能打出來的最新版」。
//
// ⇒ 這裡補上唯一真正缺的比對：changelog（daemon-version.py 的單一真相源，見該檔
// 檔頭）最上面那個 `## vX.Y.Z（…）` 版本 vs 這個 bundle 現在委任的 manifest.daemon.version。
// 不符＝新打的 daemon 沒被送進來，出貨中止，不准印「✅ 出貨完成」。
//
// 為什麼不用 daemon-version.py（不 --stamp）當比對源：那支在 changelog 有「下一版
// （未發佈）」草稿段時會印**預覽的下一版號**（還沒真的出），拿來比對會誤傷「只是先
// 寫草稿、還沒打包」的正常情況。這裡改成直接讀「最上面那個已經是正式版號的段落」
// （與 daemon-version.py 的 RELEASED_RE 同一個判斷式），只認**已經真的出過的版本**。
//
// mutates:false（純讀比對，不改任何東西）⇒ 預演與 --confirm 都會跑，且跑在 build
// 之前——build 完全不碰 daemon，所以提早在這裡擋，省得白跑一輪 build 才發現。
{ id: 'daemon-check', title: '核對 bundle 的 daemon 版本＝changelog 最新已出版本（不是瞎推）', mutates: false, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在（首次播種前，下一步會種出來）'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  if (!m.daemon || !m.daemon.version) return { status: 'skip', detail: ['這個 bundle 目前沒有 daemon（登錄簿/歷史宣告如此，不適用本項核對）'] };

  const clPath = join(REPO_ROOT, CHANGELOG_REL);
  if (!existsSync(clPath)) return { status: 'skip', detail: [`找不到 ${CHANGELOG_REL}，跳過核對`] };
  const clText = readFileSync(clPath, 'utf8');
  // 只認「已發佈」段落（`## vX.Y.Z（日期）`），忽略「## 下一版（未發佈）」草稿——
  // 草稿代表還沒真的打包出東西，不該拿來當「本機有更新版」的證據。
  const top = clText.match(/^## (v\d+\.\d+\.\d+)（/m);
  if (!top) return { status: 'skip', detail: ['changelog 裡沒有任何已發佈的 daemon 版本段，跳過核對'] };

  const localVersion = top[1];             // 本機（changelog）目前最新已出版本
  const bundleVersion = m.daemon.version;  // 這個 bundle 現在委任的版本

  if (localVersion !== bundleVersion) {
    throw new Error(
      `daemon 版本對不上——本機（changelog 最新已出版本）是 ${localVersion}，這個 bundle 裡還是 ${bundleVersion}。\n` +
      `     這代表新打的 daemon 沒有被搬進 bundle（dist/ → ${ctx.bundlesDir}/daemon/ ＋ manifest.daemon 三個子欄位），\n` +
      `     照舊出貨的話腳本會照常印「✅ 出貨完成」，但使用者按「檢查更新」永遠拿到 ${bundleVersion}，\n` +
      `     而封測者的自我更新目前是壞的——拿不到就是永遠拿不到。\n` +
      `     → 把 ${localVersion} 的 dmg/exe（連同 sha256）搬進 ${ctx.bundlesDir}/daemon/、更新 manifest.daemon，再重跑；\n` +
      `     → 若這次真的不打算出新 daemon（只改別的零件），確認 changelog 最上面本來就該是 ${bundleVersion}（別的東西被誤標成已發佈）。`);
  }
  return { status: 'done', detail: [`本機（changelog）／bundle 版本一致：${bundleVersion}`] };
}},

// ── 2. build：目標沒 promoteFrom＝**每次都重打**（讓版本號不可能落後內容）；
//              目標有 promoteFrom＝**提升**（複製已驗證的內容，不重打——見上方 leo 引言）。
{ id: 'build', title: T.promoteFrom
  ? `提升：把 ${T.promoteFrom} 已驗證的內容複製過來（不重打）`
  : '從來源重打 bundle（版本號由內容算，不由人宣告）', mutates: true, async run() {
  if (!T.promoteFrom) {
    shLive('node', [join(import.meta.dirname, 'build-bundles.mjs'), '--out', ctx.bundlesDir],
      REPO_ROOT, { ARCRUN_REPO_ROOT: ctx.arcrunRepo });
    shLive('node', [join(import.meta.dirname, 'build-ui-bundle.mjs'),
      '--arcrun', ctx.arcrunRepo, '--out', ctx.bundlesDir, '--repo-root', REPO_ROOT], REPO_ROOT);
    return { status: 'done', detail: ['4 顆核心 ＋ portal 前端已依來源重建'] };
  }

  // ── 提升路徑 ──────────────────────────────────────────────────────────
  const srcName = T.promoteFrom;
  const S = cfg.targets[srcName];
  if (!S) throw new Error(`登錄簿設定錯誤：${TARGET_NAME}.promoteFrom 指到不存在的目標 "${srcName}"`);
  const srcDir = S.bundles.dir;

  // (a) 來源必須是登錄簿宣告的那個 repo，不能是隨便一個湊巧放在那個路徑的資料夾——
  //     否則「提升」跟「打錯位置」只是換了個名字重犯同一種病。
  if (!existsSync(join(srcDir, '.git'))) {
    throw new Error(`來源（${srcName}）bundle repo 不存在：${srcDir}\n     → 先跑：node installer/scripts/ship.mjs --target ${srcName} --confirm`);
  }
  let srcOrigin = '';
  try { srcOrigin = sh('git', ['remote', 'get-url', 'origin'], srcDir); } catch { /* 無 origin */ }
  if (S.bundles.remote !== 'local-selftest' && normRemote(srcOrigin) !== normRemote(S.bundles.remote)) {
    throw new Error(
      `來源（${srcName}）bundle repo 指到別的地方，拒絕提升：\n` +
      `       目錄   ${srcDir}\n       origin ${normRemote(srcOrigin) || '(沒有 origin)'}\n` +
      `       應為   ${normRemote(S.bundles.remote)}   ← installer/ship.targets.json`);
  }

  // (b) 來源工作區必須乾淨——「這就是驗證過的那份」這句話只有在磁碟==HEAD 時才成立。
  const srcDirty = sh('git', ['status', '--porcelain'], srcDir);
  if (srcDirty) {
    throw new Error(
      `來源（${srcName}）bundle repo 工作區不乾淨，說不清「這就是驗證過的那份」，拒絕提升：\n` +
      srcDirty.split('\n').slice(0, 8).map((l) => `       ${l}`).join('\n'));
  }
  const srcSha = sh('git', ['rev-parse', 'HEAD'], srcDir);

  // (c) 機械證明：這個 sha **真的**跑完 ${srcName} 的完整驗收，不是隨便躺在磁碟上的檔案。
  //     驗證章由 ship.mjs 自己在 --confirm 且 verify 全過後蓋（見檔尾），不是人手 touch、
  //     也不是 AI 自造的閘——AI 造不出「驗收真的跑過」這件事，只有管線自己知道。
  const receiptPath = '/tmp/.stage-verified';
  if (!existsSync(receiptPath)) {
    throw new Error(
      `找不到驗證章 ${receiptPath}——${srcName} 從沒有 --confirm 通過完整驗收過，不能提升。\n` +
      `     → 先跑：node installer/scripts/ship.mjs --target ${srcName} --confirm`);
  }
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch { throw new Error(`${receiptPath} 格式壞掉（不是本管線寫的 JSON）——重跑 ${srcName} --confirm 讓管線重新蓋章`); }
  if (receipt.target !== srcName) {
    throw new Error(`驗證章是給 "${receipt.target}" 蓋的，不是 "${srcName}"——重跑：node installer/scripts/ship.mjs --target ${srcName} --confirm`);
  }
  if (receipt.sha !== srcSha) {
    throw new Error(
      `來源（${srcName}）已經往前移動，驗證章對不上這個 HEAD，拒絕提升\n` +
      `     （這正是要擋的事：不能把「還沒重新驗證過的內容」冒充成「驗證過的」）：\n` +
      `       磁碟 HEAD  ${srcSha}\n       驗證章 sha ${receipt.sha}（驗於 ${new Date(receipt.ts * 1000).toISOString()}）\n` +
      `     → 重跑：node installer/scripts/ship.mjs --target ${srcName} --confirm 重新驗收這個新 HEAD`);
  }

  const srcManifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'));
  if (!srcManifest.fingerprint || !srcManifest.release) {
    throw new Error(`來源（${srcName}）manifest 沒有 fingerprint／release——${srcName} 的 version 步驟沒跑過？`);
  }

  // (d) 只複製「build 步驟管的那幾顆」（BUILD_MANAGED）——不是整包蓋掉。
  //     08-07 就是整包蓋掉 prod bundle repo，把 prod 才有的 daemon/（20 個安裝檔）與
  //     README 砍光。prod 有 stage 沒有的東西是正常的，這裡結構上就不會去動它們。
  const promotedCore = [];
  for (const { name, relDir } of BUILD_MANAGED) {
    const entry = srcManifest.core.find((c) => c && c.name === name);
    const srcPath = join(srcDir, relDir);
    if (!entry || !existsSync(srcPath)) {
      throw new Error(`來源（${srcName}）缺少 ${name}（${relDir}）——bundle 不完整，拒絕提升`);
    }
    const dstPath = join(ctx.bundlesDir, relDir);
    rmSync(dstPath, { recursive: true, force: true });
    mkdirSync(dstPath, { recursive: true });
    cpSync(srcPath, dstPath, { recursive: true });
    promotedCore.push(JSON.parse(JSON.stringify(entry))); // 深拷貝宣告值；下一步用磁碟實檔覆核，不信任這裡
  }

  const mPath = join(ctx.bundlesDir, 'manifest.json');
  let prodManifest = { schema: 1, core: [] };
  try { prodManifest = JSON.parse(readFileSync(mPath, 'utf8')); } catch { /* 首次提升，尚無 manifest */ }
  const managedNames = new Set(BUILD_MANAGED.map((m) => m.name));
  // 保留本目標既有、但不屬於「提升管理」的條目——只認「檔案還在磁碟上」的，不假裝有東西。
  // 🔴 2026-08-09（#27）：這裡與 build-bundles.mjs 是**同一條棘輪**（只加不減），
  //   所以同步收斂到唯一真相源：清單外的一律不留。BUILD_MANAGED 現在就是整份清單，
  //   因此 `inherited` 正常情況下必為空；留著這條是為了「將來真的有目標專屬零件」時
  //   仍走同一套檢查——但它再也不能無聲地把不該有的東西抬進 manifest。
  const canonicalNames = new Set(BUNDLE_COMPONENT_NAMES);
  const inherited = (prodManifest.core || []).filter(
    (c) => c && c.name && !managedNames.has(c.name) && canonicalNames.has(c.name)
      && c.main_file && existsSync(join(ctx.bundlesDir, c.main_file)));
  const droppedHere = (prodManifest.core || []).filter((c) => c && c.name && !canonicalNames.has(c.name));
  prodManifest.core = [...promotedCore, ...inherited];
  prodManifest.source = srcManifest.source; // 誠實標示這版來自哪個 Arcrun commit（沿用 stage 算好的，不是自己再猜）
  // 🔴 built 也是「複製過來的內容的一部分」（2026-08-09，arcrun-rag#27）
  //   1.4.29 推 prod 後 `install.arcrun.dev/api/latest` 的 `built` 是 **2026-08-07**，
  //   而那份內容就是 08-09 在 stage 打的（stage 的 manifest.built＝2026-08-09）。
  //   真兇不是 pin 步驟忘了寫 BUNDLE_BUILT——它每次都寫，只是寫的是
  //   `m.built = m.built || 今天` 留下的**上一次全量重建的日期**：有值就不動 ⇒ 永遠黏在原地。
  //   同一份內容不可能有兩個建置日 ⇒ built 跟 release／fingerprint 一樣**繼承來源**，
  //   下一步（version）會再核對一次，對不上當場失敗。
  prodManifest.built = srcManifest.built;
  prodManifest.promoted_from = { target: srcName, sha: srcSha, release: srcManifest.release, promoted_at: new Date().toISOString() };
  writeFileSync(mPath, JSON.stringify(prodManifest, null, 1) + '\n');

  ctx.promote = {
    srcName, srcSha,
    expectFingerprint: srcManifest.fingerprint,
    expectRelease: srcManifest.release,
    expectBuilt: srcManifest.built,   // 同一份內容＝同一個建置日，見上面 prodManifest.built
    // 下一步（version）核對用：比對範圍＝本次實際複製的管理項，
    // 以及來源那份的完整 core（讓它自己挑出同名的來比）。
    // （2026-08-08 9a4de69 立這個範圍：不能比「兩邊各自的完整 core」，那次 stage 24 顆、
    //   prod 5 顆，逐顆 sha256 明明相同卻被判不符。
    //   2026-08-09 #27 補記：那個 24 vs 5 **本身就是病**，已由 bundle-components.mjs
    //   ＋ parity 步驟根治；本範圍限定仍然保留——它讓「目標專屬、非提升管理」的條目
    //   不會被誤入比對，是對的抽象，只是從此不會再有 19 顆的落差要它扛。）
    copied: BUILD_MANAGED.map((m) => m.name),
    srcCore: srcManifest.core,
  };
  return { status: 'done', detail: [
    `來源：${srcName}@${srcSha.slice(0, 7)}（release ${srcManifest.release}，驗證於 ${new Date(receipt.ts * 1000).toISOString()}）`,
    `複製 ${BUILD_MANAGED.length} 顆管理項：${BUILD_MANAGED.map((m) => m.name).join('、')}`,
    inherited.length ? `沿用 ${inherited.length} 顆非提升管理項：${inherited.map((c) => c.name).join('、')}` : '（本目標無其餘沿用項）',
    droppedHere.length ? `🧹 清單外的 ${droppedHere.length} 顆已從 manifest 移除：${droppedHere.map((c) => c.name).join('、')}` : null,
  ].filter(Boolean) };
}},

// ── 2.2 parity：**這個 bundle 有哪幾顆，必須恰好等於唯一真相源**───────────────
//
// 🔴 leo 2026-08-09（arcrun-rag#27），這一步就是為了他那句話存在的：
//   「我的現實是 prod 已經有人在用了，在你還沒進行任何修改前，stage = prod，
//     至少一一對應。結果你重做，那你重做過程可能有問題，就造成 prod 新問題。」
//   「如果都相同，我測試一次安裝，就發現 5 顆變 24 顆。**如果是複製，為什麼不一致？**」
//
// 08-09 實測：prod core = 5 顆、stage core = 24 顆，而 prod 宣告自己複製自
// stage@ab4ef01——那個 commit 當時就是 24 顆。兩邊各有一份人維護的清單
// （本檔 BUILD_MANAGED ／ build-bundles.mjs CORE），只有 prod 那條會被套用，
// 於是「提升＝複製」是假的，而 leo 在 stage 驗的東西不是封測者會拿到的東西。
//
// ⇒ 兩條路徑現在共用 `bundle-components.mjs`，這一步再用**同一份清單**夾住結果：
//   `manifest.core` 的名字集合必須恰好等於它——多一顆（棘輪殘留）、少一顆（打包失敗
//   被靜默吞掉）都當場失敗。**一一對應從此不靠人記得，而是每次出貨都被機械重新證明一次。**
//
// mutates:false ⇒ 預演也會跑，不必真的出貨就能看出兩邊對不對得上。
{ id: 'parity', title: '核對 bundle 內容＝唯一真相源（stage 與 prod 因此必然一一對應）', mutates: false, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const { missing, extra, ok } = diffAgainstCanonical(m.core);
  if (!ok) {
    throw new Error(
      `bundle 內容與唯一真相源（installer/scripts/bundle-components.mjs）對不上，拒絕出貨：\n` +
      (missing.length ? `       少了 ${missing.length} 顆：${missing.join('、')}\n` +
        `         → 這幾顆沒被打出來（build 失敗被吞掉？），裝出來的實例會缺零件\n` : '') +
      (extra.length ? `       多了 ${extra.length} 顆：${extra.join('、')}\n` +
        `         → 清單外的東西混進 bundle。這正是 stage 變成 24 顆的病：\n` +
        `           「檔案還在就沿用」的棘輪只加不減，一邊有一邊沒有，只會越差越多\n` : '') +
      `     → 要增減 bundle 內容，改 bundle-components.mjs（一個地方改，兩條路徑同時生效），\n` +
      `       不要在這裡放行例外——放行一次，stage 與 prod 就再也不是同一個東西。`);
  }
  // 每顆的產物都要真的在磁碟上：manifest 說有、檔案卻不在＝安裝時 404。
  const ghosts = BUNDLE_COMPONENTS.filter((c) => !existsSync(join(ctx.bundlesDir, c.relDir)));
  if (ghosts.length) {
    throw new Error(
      `manifest 宣告有這幾顆，但產物資料夾不存在（安裝器會抓到 404）：\n` +
      ghosts.map((c) => `       • ${c.name}（${c.relDir}）`).join('\n'));
  }
  return { status: 'done', detail: [
    `${BUNDLE_COMPONENT_NAMES.length} 顆，逐項相符：${BUNDLE_COMPONENT_NAMES.join('、')}`,
    `（同一份清單也夾著另一個目標 ⇒ stage 與 prod 結構上不可能再分岔）`,
  ] };
}},

// ── 2.5 notes：使用者更新畫面上那一行，由 changelog 導出，不由人當場捏 ────────
{ id: 'notes', title: '產生更新畫面那一行（來源＝changelog）', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  if (!m.daemon || !m.daemon.version) return { status: 'skip', detail: ['這個 bundle 沒有 daemon'] };
  const line = notesFromChangelog(REPO_ROOT, m.daemon.version);
  if (!line) {
    throw new Error(
      `changelog 沒有 ${m.daemon.version} 這一版（${CHANGELOG_REL}）。\n` +
      `     使用者按「檢查更新」會看不到這版改了什麼 ⇒ 先寫 changelog 再出貨。`);
  }
  const problems = checkNotes(line);
  if (problems.length) throw new Error('更新畫面那一行過不了閘：\n' + problems.map((p) => `       • ${p}`).join('\n'));
  if (m.daemon.notes === line) return { status: 'skip', detail: [`已是最新：${line}`] };
  const before = m.daemon.notes;
  m.daemon = { ...m.daemon, notes: line };
  writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');
  return { status: 'done', detail: [
    `舊：${before ? before.slice(0, 60) + (before.length > 60 ? `…（共 ${before.length} 字）` : '') : '(無)'}`,
    `新：${line}（${line.length} 字）`,
  ] };
}},

// ── 3. version：目標沒 promoteFrom＝算版本＋機械閘（內容變了版本一定變；沒變就一定不變）；
//              目標有 promoteFrom＝**核對指紋**，不是算版本——同一份內容必須得到同一個版本號，
//              不是兩個目標各自獨立累計 patch。有出入＝當場失敗，不印警告繼續。────────────
{ id: 'version', title: T.promoteFrom ? '核對提升內容與來源指紋一致（不重算版本）' : '算版本並過機械閘', mutates: true, async run() {
  if (T.promoteFrom) {
    const mPath = join(ctx.bundlesDir, 'manifest.json');
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    // 指紋＝這個系統本來就有的「內容算出來的東西」（release.mjs contentFingerprint：
    // core[] 每顆的 name+sha256 串起來 hash）。sha256 一律以**磁碟實檔**重算，不信任
    // 上一步剛寫進去的宣告值——這是「機械跑出來的證明」，不是人肉比對或口頭宣稱。
    const core = recomputeShas(ctx.bundlesDir, m.core);

    // 🔴 2026-08-08 首次真實出貨當場撞到：**指紋要比同一組東西，不能比整份 core**。
    //
    //   stage bundle  core = 24 顆（棘輪殘留：19 顆舊世代 tier1／tier2）
    //   prod  bundle  core =  5 顆（一直只出核心 4 顆 ＋ portal 前端）
    //
    // 兩邊規模本來就不同，拿「24 顆的指紋」比「5 顆的指紋」＝拿蘋果比橘子，
    // **內容一模一樣也永遠不符**（實測那 5 顆的 sha256 逐一相同）。
    // ⇒ 提升要保證的是「**我複製過來的那些，就是 stage 驗過的那些**」，
    //   範圍＝本次實際複製的管理項，不是各自的完整 core。
    //
    // 🔴 2026-08-09（#27）補記——**當時我把病當成了地形**：
    //   上面那句「兩邊規模本來就不同」被我當成事實接受，沒問一句「為什麼不同」。
    //   leo 隔天就問了：「如果是複製，為什麼不一致？」——而且他是**裝了一次 stage**
    //   才撞到的：他驗的東西根本不是封測者會拿到的東西。
    //   那 19 顆不是設計，是 1.4.17 播種帶進來、再被「檔案還在就沿用」的棘輪
    //   一路抬到今天的殘留。已由 `bundle-components.mjs` ＋ `parity` 步驟根治。
    //   ⇒ 本範圍限定**保留**（它讓「目標專屬、非提升管理」的條目不被誤入比對，
    //     是對的抽象），但它從此不該再扛任何 19 顆等級的落差；真有落差＝parity 先炸。
    //
    // ⚠️ 這道閘**沒有被放寬**：範圍內任一顆對不上仍然停，而且現在會印出是哪一顆差在哪，
    //    不必再自己去 diff（原版只說「不符」，我當場得手動比對 24 顆才找得到真因）。
    const managed = new Set(ctx.promote.copied || core.map((c) => c.name));
    const pick = (list) => list.filter((c) => managed.has(c.name));
    const fingerprint = contentFingerprint(pick(core));
    const expect = contentFingerprint(pick(ctx.promote.srcCore || []));
    if (fingerprint !== expect) {
      const srcMap = new Map((ctx.promote.srcCore || []).map((c) => [c.name, c.sha256]));
      const diff = pick(core)
        .filter((c) => srcMap.get(c.name) !== c.sha256)
        .map((c) => `       • ${c.name}\n         stage ${srcMap.get(c.name) || '(來源沒有這顆)'}\n         prod  ${c.sha256}`);
      throw new Error(
        `提升後內容與來源（${ctx.promote.srcName}@${ctx.promote.srcSha.slice(0, 7)}）不符，拒絕出貨：\n` +
        `       比對範圍   本次複製的 ${managed.size} 個管理項\n` +
        `       來源指紋   ${expect}\n       複製後指紋 ${fingerprint}\n` +
        (diff.length ? `     逐顆差異：\n${diff.join('\n')}\n` : '') +
        `     → 這不是版本問題，是複製沒有忠實再現 stage 驗過的內容——查上一步（build）的複製邏輯，不要放行`);
    }
    m.core = core;
    m.fingerprint = fingerprint;
    m.release = ctx.promote.expectRelease; // 同一份內容＝同一個版本號，直接繼承來源，不是重算
    // 🔴 built 同理（2026-08-09 #27）。舊寫法是 `m.built = m.built || 今天`：
    //   **有值就不動** ⇒ prod 的建置日永遠停在最後一次全量重建那天（實測黏在 2026-08-07，
    //   而內容是 08-09 打的）。它會被 pin 步驟原封不動寫進 BUNDLE_BUILT、再送到
    //   `/api/latest` 給每一個使用者看 ⇒ 使用者看到的建置日是假的。
    //   ⇒ 繼承來源，並在這裡硬斷言——來源沒有 built 就是來源的 manifest 有問題，不許猜一個。
    if (!ctx.promote.expectBuilt) {
      throw new Error(
        `來源（${ctx.promote.srcName}）的 manifest 沒有 built——不許在這裡填一個猜的日期。\n` +
        `     先重跑 ${ctx.promote.srcName} 的出貨（syncManifest 會寫 built），再來提升。`);
    }
    m.built = ctx.promote.expectBuilt;
    writeFileSync(mPath, JSON.stringify(m, null, 1) + '\n');

    const problems = verifyManifest(ctx.bundlesDir, { repoRoot: REPO_ROOT });
    if (problems.length) throw new Error('manifest 機械閘不過：\n' + problems.map((p) => `       • ${p}`).join('\n'));

    ctx.release = m.release;
    ctx.daemonVersion = m.daemon && m.daemon.version;
    ctx.built = m.built;
    return { status: 'done', detail: [
      `指紋核對通過：與 ${ctx.promote.srcName}@${ctx.promote.srcSha.slice(0, 7)} 完全相同（${fingerprint}）`,
      `built ${m.built}（繼承 ${ctx.promote.srcName}；同一份內容不會有兩個建置日）`,
      `版本 ${ctx.release}（直接繼承 ${ctx.promote.srcName}，不是重算；${core.length} 顆｜source ${m.source}｜daemon ${ctx.daemonVersion}）`,
    ] };
  }

  const { release } = syncManifest(ctx.bundlesDir, { repoRoot: REPO_ROOT, quiet: true });
  const problems = verifyManifest(ctx.bundlesDir, { repoRoot: REPO_ROOT });
  if (problems.length) throw new Error('manifest 機械閘不過：\n' + problems.map((p) => `       • ${p}`).join('\n'));
  const m = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8'));
  ctx.release = release;
  ctx.daemonVersion = m.daemon && m.daemon.version;
  ctx.built = m.built;   // 使用者在 /api/latest 看到的建置日；verify 會拿它跟線上對
  const bumped = ctx.releaseBefore && ctx.releaseBefore !== release;
  return { status: 'done', detail: [
    bumped ? `版本 ${ctx.releaseBefore} → ${release}（內容有變 ⇒ patch +1）`
           : `版本 ${release}（內容與上一版一致 ⇒ 不動）`,
    `${m.core.length} 顆｜built ${m.built}｜source ${m.source}｜daemon ${ctx.daemonVersion}`,
  ] };
}},

// ── 3.5 docs-changelog：這一版的更新說明必須已經寫進 docs，不然就中止 ─────────
// 🔴 leo 2026-08-09（總管轉交）：「佈建腳本還要包含文件，新版推出要有文件寫到 docs
//   說明這一版的更新，你不列入就沒寫，兩邊脫鉤。」「刻意不寫更新說明時，佈建要
//   中止或明確報出來，不能安靜跳過。」
// 沿用既有的 daemon changelog 機制（`headlinesFor`／`notesFromChangelog`，
// daemon-notes.mjs）——那支本來就是「用版本號當 key 去 changelog.md 找一段」，
// 換成拿 bundle 的 release 版本號去問一樣的問題，不必另建一套格式或另一個檔案。
// 提升目標（prod）不重算版本、沿用 stage 的 release——這道閘已經在 stage 那次跑過，
// 不必也不能重跑（prod 的來源就是 stage 已驗證的內容，見不變式 Ⅳ）。
{ id: 'docs-changelog', title: '確認這版已經寫進說明文件（缺了就中止，不安靜跳過）', mutates: false, async run() {
  if (T.promoteFrom) {
    return { status: 'skip', detail: [`提升目標不重算版本，沿用 ${T.promoteFrom} 已經過這道閘的版本`] };
  }
  const line = notesFromChangelog(REPO_ROOT, ctx.release);
  if (!line) {
    throw new Error(
      `說明文件裡沒有 ${ctx.release} 這一版（${CHANGELOG_REL}）。\n` +
      `     這版內容已經打包完成，但文件沒有跟上——先在 changelog 加一段\n` +
      `     \`## ${ctx.release}（${new Date().toISOString().slice(0, 10)}）\`，` +
      `用一兩句使用者看得懂的話描述這版改了什麼，再重跑本指令。\n` +
      `     （leo 2026-08-09：「你不列入就沒寫，兩邊脫鉤」——這道閘就是不准兩邊脫鉤）`);
  }
  return { status: 'done', detail: [`${CHANGELOG_REL} 有 ${ctx.release} 這一版：${line}`] };
}},

// ── 3.7 readme：bundle repo 的 README 由零件清單算出來，不留會過期的手寫數字 ──
//
// 🔴 leo 2026-08-10（總管實測發現）：`youlinhsieh/arcrun-rag-bundles` 的 README
//   還寫著「25 workers: tier1 components + tier2 engines」，而**同一個 repo 的
//   manifest.json** 老實宣告 5 顆（release 1.4.30）。兩份數字互相矛盾，而且已經
//   矛盾超過一版都沒人發現——因為出貨管線從沒有任何一步碰過 README.md，
//   它是很久以前手打的、之後再也沒有機制核對它還準不準。
//
//   這跟 `bundle-components.mjs` 檔頭記的那次「兩份人維護的零件清單」是同一種病，
//   差別是這次沒有任何機械閘夾住它，連「漂移了」這件事本身都不會被發現。
//   ⇒ 解法跟那次一樣：README 由 BUNDLE_COMPONENTS（唯一真相源）算出來，
//     出貨管線每次都重寫這份檔案——內容跟零件清單不同步，在結構上不再可能發生。
{ id: 'readme', title: 'bundle repo 的 README 由零件清單算出來（不留會過期的手寫數字）', mutates: true, async run() {
  const mPath = join(ctx.bundlesDir, 'manifest.json');
  if (!existsSync(mPath)) return { status: 'skip', detail: ['manifest.json 還不存在（首次播種前）'] };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const text = renderBundlesReadme({
    release: m.release, source: m.source, built: m.built,
    hasDaemon: !!(m.daemon && m.daemon.version),
  });
  const rPath = join(ctx.bundlesDir, 'README.md');
  const before = existsSync(rPath) ? readFileSync(rPath, 'utf8') : null;
  if (before === text) return { status: 'skip', detail: ['README 已是最新（零件清單與版本都沒變）'] };
  writeFileSync(rPath, text);
  return { status: 'done', detail: [
    `README 重寫：${BUNDLE_COMPONENTS.length} 顆零件｜release ${m.release}`,
    before === null ? '（這個 bundle repo 原本沒有 README，首次產生）' : '（取代舊版手寫內容）',
  ] };
}},

// ── 4. commit ────────────────────────────────────────────────────────────
{ id: 'commit', title: '把產物寫進 bundle repo 的版控', mutates: true, async run() {
  if (!sh('git', ['status', '--porcelain'], ctx.bundlesDir)) {
    return { status: 'skip', detail: ['工作區乾淨——這一版的產物已經在版控裡了'] };
  }
  sh('git', ['add', '-A'], ctx.bundlesDir);
  // 🔴 08-07 實撞：整包蓋掉 prod bundle repo，把 prod 才有的 daemon/（20 個安裝檔）
  //    與 README 砍光，封測者下載不到 daemon。刪檔要人明確放行。
  const deleted = sh('git', ['diff', '--cached', '--diff-filter=D', '--name-only'], ctx.bundlesDir);
  if (deleted && !ALLOW_DELETIONS) {
    throw new Error(
      `這次會**刪掉** bundle repo 裡的檔案，拒絕出貨（08-07 就是這樣砍掉 prod 的 daemon/）：\n` +
      deleted.split('\n').slice(0, 15).map((l) => `       - ${l}`).join('\n') +
      `\n     → 真的要刪就加 --allow-deletions，並在 commit 說明理由`);
  }
  sh('git', ['-c', 'user.email=ship@local', '-c', 'user.name=ship', 'commit', '-q', '-m',
    `ship ${ctx.release}：${JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).source || 'unknown source'}`],
    ctx.bundlesDir);
  return { status: 'done', detail: [`commit ${sh('git', ['rev-parse', '--short', 'HEAD'], ctx.bundlesDir)}`] };
}},

// ── 5. push ──────────────────────────────────────────────────────────────
{ id: 'push', title: '推上 bundle repo', mutates: true, async run() {
  ctx.headSha = sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  if (T.bundles.remote === 'local-selftest') {
    return { status: 'skip', detail: ['selftest 目標不推遠端（登錄簿宣告）'] };
  }
  const ahead = sh('git', ['rev-list', '--count', `origin/${T.bundles.branch}..HEAD`], ctx.bundlesDir);
  if (Number(ahead) === 0) return { status: 'skip', detail: ['已與遠端同步，沒有要推的'] };
  // 大 zip 推 GitHub 會 remote hung up（wiki agent-memory:805）⇒ 一律帶 postBuffer
  sh('git', ['-c', 'http.postBuffer=157286400', 'push', 'origin', T.bundles.branch], ctx.bundlesDir);
  ctx.pushed = true;
  const detail = [`推了 ${ahead} 個 commit → ${normRemote(T.bundles.remote)}（HEAD ${ctx.headSha.slice(0, 7)}）`];

  // 🔴 2026-08-09（arcrun-rag#27）留痕：這一行 `git push` 是 execFileSync 開的子行程，
  //   Claude Code 的 github-contact-guard.sh 只看得到「Bash 工具呼叫本身的指令字串」
  //   （這次是 `node ship.mjs --target prod --confirm`），完全看不到這個子行程——
  //   所以 hook 那份 log 永遠不會有這一筆，不管 hook 的正則怎麼改都一樣。
  //   只有在**真的碰 GitHub 的這一行自己**留痕，才補得起來。
  if (T.bundles.remote && /github\.com/i.test(T.bundles.remote)) {
    try {
      logGithubContact(INKSTONE_ROOT, ctx.armMission || '(mission 未知)',
        `git push origin ${T.bundles.branch}（${ctx.bundlesDir} → ${normRemote(T.bundles.remote)}）` +
        `推了 ${ahead} 個 commit，HEAD→${ctx.headSha.slice(0, 7)}`);
      detail.push('✅ 已寫入 github-contact-log.md（ship.mjs 自己留痕）');
    } catch (e) {
      // push 已經發生、不可逆——留痕失敗不回頭撤銷，但要吵到讓人看見，不能安靜吞掉。
      console.error(`❌❌❌ push 成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
      detail.push(`❌ 留痕失敗（push 已發生，稽核缺口仍在）：${e.message}`);
    }
  }
  return { status: 'done', detail };
}},

// ── 6. pin：換釘子。**寫進所有真身**，不靠人記得改哪幾處 ────────────────────
{ id: 'pin', title: '換安裝器釘子（真身是 wrangler.toml 的 vars）', mutates: true, async run() {
  if (!T.pin || !T.installer) return { status: 'skip', detail: ['本目標沒有安裝器（登錄簿宣告）'] };
  ctx.headSha = ctx.headSha || sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  const sha = T.pin.shaLen === 40 ? ctx.headSha : ctx.headSha.slice(0, T.pin.shaLen);
  ctx.pinUrl = T.pin.template.replace('{sha7}', ctx.headSha.slice(0, 7)).replace('{sha40}', ctx.headSha);
  const built = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).built;

  const tomlPath = join(REPO_ROOT, T.installer.cwd, T.installer.config);
  let toml = readFileSync(tomlPath, 'utf8');
  const before = toml;
  toml = setTomlVar(toml, T.installer.varsSection, 'BUNDLE_BASE', ctx.pinUrl);
  toml = setTomlVar(toml, T.installer.varsSection, 'BUNDLE_BUILT', built);

  // 🔴 08-07 白部署一次的病：釘子有**兩份手抄本**（wrangler.toml [vars] 與 worker.js 常數），
  //    只改一份就是「改了但沒生效」。這裡兩份一起寫 ⇒ 結構上不可能只改一半。
  const jsPath = join(REPO_ROOT, T.installer.cwd, 'worker.js');
  let js = readFileSync(jsPath, 'utf8');
  const jsBefore = js;
  if (T.installer.mirrorConstants) {
    js = js.replace(/(const DEFAULT_BUNDLE_BASE = ')[^']*(')/, `$1${ctx.pinUrl}$2`);
    js = js.replace(/(const BUNDLE_BUILT = ')[^']*(')/, `$1${built}$2`);
  }

  if (toml === before && js === jsBefore) {
    return { status: 'skip', detail: [`釘子已是 ${sha.slice(0, 7)}（built ${built}），不需要動`] };
  }
  writeFileSync(tomlPath, toml);
  if (js !== jsBefore) writeFileSync(jsPath, js);
  ctx.pinChanged = true;
  return { status: 'done', detail: [
    `[${T.installer.varsSection}] BUNDLE_BASE = ${ctx.pinUrl}`,
    `[${T.installer.varsSection}] BUNDLE_BUILT = ${built}`,
    T.installer.mirrorConstants ? 'worker.js 的兩個常數同步寫入（不留第二份手抄本）' : 'worker.js 常數不鏡射（本目標靠 vars 覆蓋）',
  ] };
}},

// ── 7. deploy：帳號來自登錄簿，不吃環境裡飄來的 CLOUDFLARE_ACCOUNT_ID ────────
{ id: 'deploy', title: '部署安裝器（帳號由登錄簿釘死）', mutates: true, async run() {
  if (!T.installer) return { status: 'skip', detail: ['本目標沒有安裝器（登錄簿宣告）'] };
  const liveOk = ctx.liveBefore
    && ctx.liveBefore.release === ctx.release
    && ctx.headSha && String(ctx.liveBefore.pin || '').startsWith(ctx.headSha.slice(0, 7));
  if (!ctx.pinChanged && liveOk) {
    return { status: 'skip', detail: [`線上已是 ${ctx.release}／pin ${ctx.liveBefore.pin}，且釘子沒動 ⇒ 不重複部署`] };
  }
  const args = ['wrangler', 'deploy', '--config', T.installer.config];
  if (T.installer.wranglerEnv) args.push('--env', T.installer.wranglerEnv);
  // 🔴 「打錯實例」的第二個入口：ambient CLOUDFLARE_ACCOUNT_ID。這裡一律用登錄簿的值覆蓋。
  shLive('npx', args, join(REPO_ROOT, T.installer.cwd), { CLOUDFLARE_ACCOUNT_ID: T.installer.accountId });
  return { status: 'done', detail: [`帳號 ${T.installer.accountId}（${T.installer.accountNote}）`,
    `env ${T.installer.wranglerEnv || '(prod 預設環境)'}`] };
}},

// ── 7.5 docsSite：文件站 stage 版（s2，2026-08-09）。目標沒宣告 docsSite 就跳過 ──
// 🔴 為什麼要收進這支腳本：docs-site 之前完全沒有自動化部署路徑（連 prod 都是人手動
// `wrangler deploy`），跟這支腳本本來要解決的病是同一種——「要記得手動做」＝會漏。
// 查過 `git log --all -- installer/scripts/ship.mjs` 與 `-S"docsSite"`：docs-site
// 從未被接進這支管線過，這是新增能力，不是重修一個已經被哪個分支修過的舊 bug。
//
// 🔴 2026-08-09（arcrun-rag#27）這一步被改嚴了三處，因為 08-09 的 prod 三處全中：
//   ① 它只有 stage 走得到（prod 的 docsSite 是 null ⇒ 安靜跳過）→ 已由不變式 Ⅴ 根治
//   ② 它只問 `GET /docs/ → 200`——**一個內容停在三天前的站也是 200**。
//      leo 當天看到的正是這個：版本說明最新 v0.18.24，封測者拿到的是 v0.18.25。
//   ③ 它假設每個目標都有 `--env`（prod 走預設環境，沒有 env 名）
{ id: 'docs', title: '建＋部署說明文件站，並驗「使用者查得到這一版」', mutates: true, async run() {
  // 走到這裡還沒有 docsSite 的，只剩沒有安裝器的目標（selftest）——不面對任何人。
  if (!T.docsSite) return { status: 'skip', detail: ['本目標沒有安裝器也沒有文件站（登錄簿宣告）'] };
  const D = T.docsSite;
  const cwd = join(REPO_ROOT, D.cwd);

  // ── ① 先問「這一版寫了嗎」，再花時間建站 ──────────────────────────────
  // 使用者手上有兩個號碼：portal 版本卡的 release、小幫手更新畫面的 daemon 版本。
  // 他拿哪一個來查都要查得到 ⇒ 兩個都要在 changelog 裡有自己的一段。
  // （3.5 那道閘只擋非提升目標且只看 release；提升目標＝prod 完全不跑它，
  //   而 changelog 是本 repo 的可變檔案，stage 驗過之後還是可能被改。）
  const want = [ctx.release, ctx.daemonVersion].filter(Boolean);
  const missingLocal = want.filter((v) => !notesFromChangelog(REPO_ROOT, v));
  if (missingLocal.length) {
    throw new Error(
      `說明文件裡沒有 ${missingLocal.join('／')} 這一版（${CHANGELOG_REL}），拒絕出貨。\n` +
      `     這版的東西已經打包好了，但使用者更新完會查不到它改了什麼。\n` +
      `     → 先補一段 \`## ${missingLocal[0]}（${new Date().toISOString().slice(0, 10)}）\`，` +
      `用使用者看得懂的話寫，再重跑本指令。`);
  }

  // ── ② 建 → 鏡射 → 部署 ────────────────────────────────────────────────
  shLive('npm', ['run', 'build'], cwd);
  // dist/ 是 astro 的建置輸出；wrangler.toml 的 [assets] directory 指 ./deploy（含 docs/
  // 子目錄，對齊 astro base:'/docs'）——用 rsync --delete 鏡射，不留舊檔殘骸。
  shLive('rsync', ['-a', '--delete', join(cwd, 'dist') + '/', join(cwd, 'deploy', 'docs') + '/'], cwd);
  const args = ['wrangler', 'deploy', '--config', D.config];
  if (D.wranglerEnv) args.push('--env', D.wranglerEnv);   // prod 走預設環境，沒有 env 名
  shLive('npx', args, cwd, { CLOUDFLARE_ACCOUNT_ID: D.accountId });

  // ── ③ 部署完不等於使用者查得到 ⇒ 去線上那一頁把版本號找出來 ──────────
  if (!D.verifyUrl) {
    throw new Error(
      `登錄簿的 ${TARGET_NAME}.docsSite 沒給 verifyUrl ⇒ 沒辦法證明使用者查得到這一版。\n` +
      `     「部署指令沒報錯」不是驗收（CRITICAL-PATH 使用規則 6）。`);
  }
  const r = await checkDocsLive({ docsBase: D.verifyUrl, versions: want });
  if (r.fails.length) {
    throw new Error('文件站部署了，但使用者查不到這一版：\n'
      + r.fails.map((f) => `       • ${f}`).join('\n')
      + '\n' + r.lines.map((l) => `       ｜${l}`).join('\n'));
  }
  return { status: 'done', detail: [`帳號 ${D.accountId}｜env ${D.wranglerEnv || '(預設環境)'}`, ...r.lines] };
}},

// ── 8. purge（只有 prod 需要：jsDelivr @main 邊緣快取）──────────────────────
{ id: 'purge', title: 'purge jsDelivr @main 並驗到收斂', mutates: true, async run() {
  if (!T.verify || !T.verify.fullChain) return { status: 'skip', detail: ['本目標不走 jsDelivr（登錄簿宣告）'] };
  const { purgeJsdelivrMain } = await import('./purge-jsdelivr.mjs');
  await purgeJsdelivrMain({ expectRelease: ctx.release, expectDaemon: ctx.daemonVersion });
  return { status: 'done', detail: ['CDN 已收斂'] };
}},

// ── 9. verify：**走使用者真的會走的那條路**。沒送達就不算成功 ────────────────
{ id: 'verify', title: '驗收（用戶端視角，不是部署訊息）', mutates: false, async run() {
  if (!T.verify) return { status: 'skip', detail: ['本目標沒有對外端點可驗（登錄簿宣告）'] };
  const base = T.verify.installerBase;
  const lines = [];
  const fails = [];
  // `--verify-only` 沒跑前面的 build/version 步驟 ⇒ 期望值改由**磁碟上那份 bundle** 提供。
  // 那正是上次出貨送出去的內容，不是另一個手抄的數字。
  if (ctx.release === null || ctx.daemonVersion === null) {
    const m = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8'));
    ctx.release = ctx.release || m.release;
    ctx.daemonVersion = ctx.daemonVersion || (m.daemon && m.daemon.version);
    lines.push(`期望值取自磁碟 bundle：release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
  }
  // built 同理：期望值一律取磁碟上那份 manifest——**pin 步驟寫進 BUNDLE_BUILT 的就是它**，
  // 所以「線上宣告的建置日 == 磁碟 manifest 的建置日」問的正是「這次的 pin 有沒有真的送達」。
  if (ctx.built === null) {
    ctx.built = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8')).built || null;
  }
  // 釘點網址要能獨立算出來——預演時 pin 步驟沒跑，不能靠它留下的值（會是 null）。
  ctx.headSha = ctx.headSha || sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir);
  ctx.pinUrl = ctx.pinUrl
    || T.pin.template.replace('{sha7}', ctx.headSha.slice(0, 7)).replace('{sha40}', ctx.headSha);

  // ① 安裝器對外宣告的版本＝新用戶會裝到的版本
  //
  // 🔴 2026-08-08 實撞：deploy 回報成功後**立刻**讀 /api/latest，拿到的還是舊釘子
  //    （fc3c3ca，新的是 e0b3592），4 秒後再讀就對了 ⇒ 純粹是佈署傳播延遲。
  //    但這道閘當時判了 ❌ ⇒ **假陰性**。假陰性和假綠一樣糟：
  //    一道會亂叫的閘，人很快就會學會忽略它——那它就等於不存在了。
  //    ⇒ 這一項要**輪詢到收斂**，不是讀一次就定生死；真的沒收斂才算斷。
  const want = ctx.headSha ? ctx.headSha.slice(0, 7) : null;
  let latest = null;
  for (let n = 1; n <= 12; n++) {
    latest = await getJson(`${base}/api/latest?${cb()}`).catch(() => null);
    const relOk = latest && latest.release === ctx.release;
    const pinOk = !want || (latest && String(latest.pin || '').startsWith(want));
    if (relOk && pinOk) break;
    if (n === 1) lines.push(`/api/latest 還沒收斂（release ${latest && latest.release}｜pin ${latest && latest.pin}）→ 等佈署傳播…`);
    if (n < 12) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!latest) { fails.push('/api/latest 讀不到'); }
  else {
    lines.push(`/api/latest → release ${latest.release}｜pin ${latest.pin}｜daemon ${latest.daemon && latest.daemon.version}`);
    if (latest.release !== ctx.release) fails.push(`安裝器宣告 ${latest.release}，本次是 ${ctx.release}（等了 60 秒仍沒收斂）`);
    if (want && !String(latest.pin || '').startsWith(want)) {
      fails.push(`安裝器釘子 ${latest.pin}，本次 bundle HEAD 是 ${want}（等了 60 秒仍沒收斂）`);
    }
    // 🔴 建置日也要送達（2026-08-09，arcrun-rag#27）
    //   08-09 實測：prod 出的是 08-09 打的內容，`/api/latest` 卻宣告 `built 2026-08-07`。
    //   那個值是 `wrangler.toml` 的 `BUNDLE_BUILT`，由 pin 步驟從 manifest 抄過去
    //   ⇒ 這一條同時夾住三件事：manifest 的 built 對不對、pin 有沒有寫進去、有沒有真的部署。
    //   （D37 單一真相源＝manifest；以前這條規約只寫在 wrangler.toml 的註解裡，沒有人在執行它。）
    lines.push(`/api/latest → built ${latest.built}（本次 manifest.built ${ctx.built}）`);
    if (ctx.built && latest.built !== ctx.built) {
      fails.push(`安裝器宣告建置日 ${latest.built}，本次內容的建置日是 ${ctx.built}`
        + `——使用者看到的日期不是他手上這一版的（BUNDLE_BUILT 沒跟著換，或沒部署）`);
    }
    // 使用者在「版本與更新」看到的那一行，也要真的送到了（不是只在本機 manifest 裡對）
    const shipped = latest.daemon && latest.daemon.notes;
    if (shipped) lines.push(`使用者會看到的那一行（${String(shipped).length} 字）：${shipped}`);
  }

  // ② 釘點上的產物真的是這一版（釘子對，不代表釘到的東西對）
  const pinned = await getJson(`${ctx.pinUrl}/manifest.json?${cb()}`);
  lines.push(`釘點 manifest → release ${pinned.release}｜built ${pinned.built}｜daemon ${pinned.daemon && pinned.daemon.version}`);
  if (pinned.release !== ctx.release) fails.push(`釘點內容是 ${pinned.release}，不是 ${ctx.release}`);
  if (ctx.built && pinned.built !== ctx.built) {
    fails.push(`釘點內容的建置日是 ${pinned.built}，本機 manifest 是 ${ctx.built}——推上去的不是這一份`);
  }

  // ③ portal 前端內容回歸——版本號對不代表內容對（08-03 實撞：CIS 視覺整個退版）
  const ui = await getText(`${ctx.pinUrl}/tier2/ui/index.js?${cb()}`);
  const uiMust = [["/__version 路由", "p === '/__version'"], ['版本注入', 'ARCRUN_BUNDLE_VERSION']];
  const uiMissing = uiMust.filter(([, s]) => !ui.includes(s)).map(([n]) => n);
  lines.push(`釘點 portal 前端 ${(ui.length / 1024).toFixed(0)}KB｜特徵 ${uiMissing.length ? '缺：' + uiMissing.join('／') : '齊全'}`);
  if (uiMissing.length) fails.push(`portal 前端少了：${uiMissing.join('／')}`);

  // ④ 真的把 daemon 下載下來算 sha256——**這是使用者按下載鈕走的那條路**
  //
  // 🔴 leo 2026-08-08：「**包括下載都在 stage 版**」——下載鈕不能混用另一條線的產物。
  //    由來：`daemonOf()` 曾無條件把 prod 的 GitHub raw 當下載宿主，staging 的 sha
  //    在 prod repo 根本不存在 ⇒ 封測者在 stage 按下載 100% 502。
  //
  // 🔴 2026-08-09（arcrun-rag#27）：這一段的判斷邏輯搬到 `verify-download.mjs`，原因見該檔頭。
  //    一句話：1.4.29 推 prod 時它報「win 下載鈕給的檔 ≠ 釘點上的檔」，但使用者拿到的檔
  //    **逐位元正確**——真兇是拿 jsDelivr 釘點去抓 `.exe`（jsDelivr 403 擋執行檔），
  //    抓不到就 `null !== hex` ⇒ 把「**我無法比對**」報成「**它們不一致**」。
  //    每次出貨都紅、久了就沒有人當真，那比沒有檢查更糟（leo 08-08 已為假陰性說過同一句話）。
  //    修法不是放寬：改成三條各自獨立的線（內容／來源／佐證），其中「來源」是**不需抓檔**的
  //    字串硬斷言，比舊的間接位元推論更強；只有第三條佐證才有「無法取證」這一態。
  const warns = [];
  if (QUICK) {
    lines.push('daemon 下載：--quick 略過（未驗證使用者真的下載得到）');
  } else {
    for (const os of ['mac', 'win']) {
      const meta = pinned.daemon && pinned.daemon[os];
      if (!meta) continue;
      const r = await checkDaemonDownload({
        os,
        file: meta.file,
        declaredSha256: meta.sha256,
        daemonVersion: ctx.daemonVersion,
        pinUrl: ctx.pinUrl,
        downloadEndpoint: `${base}/download/${os}?${cb()}`,
        // 安裝器**自己對外宣告**的下載網址（來自線上 env）——與我們由登錄簿＋本機 HEAD
        // 算出來的那個是兩個獨立來源，不相等就是釘子/宿主跑到別條線去了。
        advertisedUrl: latest && latest.daemon && latest.daemon.downloads && latest.daemon.downloads[os],
      });
      lines.push(...r.lines);
      fails.push(...r.fails);
      warns.push(...r.warns);
    }
  }
  if (warns.length) {
    lines.push('⚠️ 有項目「無法取證」（≠ 證據顯示壞了）：');
    for (const w of warns) lines.push(`   · ${w}`);
  }

  // ⑤ 說明文件站上真的有這一版——**使用者更新完唯一能查「這版改了什麼」的地方**
  //    （2026-08-09 arcrun-rag#27：leo「有沒有上 docs？版本有沒有版本說明？」）
  //    放在 verify 而不是只放在 docs 步驟裡，是為了讓 `--verify-only` 也問得到這一條：
  //    文件站會不會過期，跟「這次有沒有部署」是兩件事——它可能昨天就掉隊了。
  if (T.docsSite && T.docsSite.verifyUrl) {
    const d = await checkDocsLive({ docsBase: T.docsSite.verifyUrl, versions: [ctx.release, ctx.daemonVersion].filter(Boolean) });
    lines.push(...d.lines);
    fails.push(...d.fails);
  }

  if (fails.length) {
    // 預演時「線上還不是這一版」是**預期中的事實**，不是管線壞掉——如實報差距就好。
    // 真的出貨（--confirm）時同一件事就是斷：宣稱出貨卻沒送達，等同沒交付。
    // `--verify-only` 是「對著已經上線的東西問它到底通不通」⇒ 與 --confirm 同樣嚴格。
    if (!CONFIRM && !VERIFY_ONLY) {
      return { status: 'skip', detail: [
        ...lines,
        `⚠️ 線上還不是這一版（預演不出貨，這是正常的）：`,
        ...fails.map((f) => `   · ${f}`),
      ] };
    }
    throw new Error('驗收未過——**用戶此刻拿不到這一版**：\n' + fails.map((f) => `       • ${f}`).join('\n')
      + '\n' + lines.map((l) => `       ｜${l}`).join('\n'));
  }
  return { status: 'done', detail: lines };
}},

// ── 10. github-release：讓「完整發佈紀錄在 GitHub」這句話變成真的 ──────────────
//
// 🔴 leo 2026-08-10：「你的出貨沒有限制你一定要在 github 產生 release？」「那為什麼不改掉？」
//   放在 verify **之後**（最後一步）：只有全部驗收通過、用戶真的拿得到這一版，
//   才在 GitHub 上留一筆紀錄——不然等於對用戶宣告一個沒送達的版本。
//
// 冪等：同一版重跑 --confirm 不該報錯或建出兩筆——先查 tag 是否已存在，存在就跳過。
// D20：這裡的 push／API 呼叫是 fetch/execFileSync 開出去的，Bash hook 看不到，
//   保險檢查與留痕跟 `push` 步驟一樣自己做（checkArmed + logGithubContact）。
{ id: 'github-release', title: '在 GitHub 公開鏡像留一份使用者點得到的發佈紀錄', mutates: true, async run() {
  if (!T.githubRelease) return { status: 'skip', detail: ['本目標沒有 githubRelease（登錄簿宣告，非發佈目標屬正常）'] };
  const G = T.githubRelease;
  const tag = `v${ctx.release}`;

  const existing = await releaseExists(G.repoSlug, tag).catch((e) => {
    throw new Error(`查詢 ${G.repoSlug} 是否已有 release ${tag} 失敗（不放行，寧可手動確認也不要建出重複的）：${e.message}`);
  });
  if (existing) {
    return { status: 'skip', detail: [`GitHub 已有 ${tag}：${existing.html_url}`] };
  }

  const body = releaseSectionFor(REPO_ROOT, ctx.release);
  if (!body) {
    throw new Error(
      `說明文件裡沒有 ${ctx.release} 這一版可以當作 release 內容（${CHANGELOG_REL}）。\n` +
      `     這不是「先跳過、之後再補」——少了這一步，使用者點「完整發佈紀錄」永遠是空白。\n` +
      `     （理論上 docs 步驟已經擋過這個情況，走到這裡還缺，代表 changelog 在兩步之間被改動過）`);
  }

  // ① 先把公開鏡像（.github-public/）更新到目前 HEAD——scripts/publish-github.sh 本來就有
  //   這個機制，只是出貨管線從沒呼叫過它，鏡像因此停在最後一次有人手動跑的那天。
  shLive('bash', [join(REPO_ROOT, 'scripts', 'publish-github.sh')], REPO_ROOT);
  const mirrorDir = join(REPO_ROOT, G.mirrorDir);
  const mirrorSha = sh('git', ['rev-parse', 'HEAD'], mirrorDir);

  // ② 保險（未過期）＋ push 鏡像＋自己留痕——與 `push` 步驟同一套規矩，理由同它的註解。
  const { mission } = checkArmed(INKSTONE_ROOT);
  const token = process.env.GITHUB_MIRROR_TOKEN || '';
  if (!token) {
    throw new Error(
      `缺 GITHUB_MIRROR_TOKEN（環境變數）。D36 金鑰鐵律：本步驟只讀名字，不落地、不印真身，\n` +
      `     真身要在啟動這支管線的 shell 裡先 export——查 system-dev/wiki/credentials-map.md 找這把鑰匙在哪。`);
  }
  const authB64 = Buffer.from(`${process.env.GITHUB_ACCOUNT_NAME || 'git'}:${token}`).toString('base64');
  sh('git', ['-c', `http.${G.mirrorRemote}.extraheader=Authorization: Basic ${authB64}`,
    'push', G.mirrorRemote, 'HEAD:refs/heads/main'], mirrorDir);
  try {
    logGithubContact(INKSTONE_ROOT, mission, `push 公開鏡像 → ${G.repoSlug}（HEAD ${mirrorSha.slice(0, 7)}）`);
  } catch (e) {
    console.error(`❌❌❌ push 成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
  }

  // ③ 建 release（target_commitish 指到剛推上去的那個 sha，tag 不存在時 GitHub 會自動建出來）
  const rel = await createRelease({
    repoSlug: G.repoSlug, tag, name: ctx.release, body, targetCommitish: mirrorSha, token,
  });
  try {
    logGithubContact(INKSTONE_ROOT, mission, `建立 release ${tag} → ${rel.html_url}`);
  } catch (e) {
    console.error(`❌❌❌ release 建立成功了，但寫入 github-contact-log.md 失敗：${e.message}`);
  }

  return { status: 'done', detail: [`release：${rel.html_url}`, `鏡像 HEAD：${mirrorSha.slice(0, 7)}`] };
}},
];

// ── wrangler.toml 的分段變數寫入（只在指定的 section 內動，不誤傷別段）──────
function setTomlVar(toml, section, key, value) {
  const header = section === 'vars' ? '[vars]' : `[${section}]`;
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) throw new Error(`wrangler.toml 找不到 ${header} 段——登錄簿的 varsSection 與實際設定對不上`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i])) { lines[i] = `${key} = "${value}"`; return lines.join('\n'); }
  }
  lines.splice(end, 0, `${key} = "${value}"`);
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// 執行：固定順序、失敗即停
// ══════════════════════════════════════════════════════════════════════════
// --verify-only：把步驟表濾成**只剩驗收那一步**（它本來就是 mutates:false）。
// 不動步驟表本身 ⇒ 出貨路徑的順序與內容完全沒被這個模式碰到。
const RUN_STEPS = VERIFY_ONLY ? STEPS.filter((s) => s.id === 'verify') : STEPS;

console.log(VERIFY_ONLY ? '━━━ Arcrun RAG 出貨驗收（只驗，不出貨）━━━' : '━━━ Arcrun RAG 出貨管線 ━━━');
console.log(`目標　${TARGET_NAME}｜${T.label}`);
console.log(`模式　${VERIFY_ONLY
  ? '🔬 只驗收（--verify-only）：不建、不推、不部署、不蓋章；判定與 --confirm 同樣嚴格'
  : CONFIRM ? '⚡ 執行（--confirm）' : '🔎 預演（只做不改變外界的步驟；要真的走完加 --confirm）'}`);
console.log(`步驟　${RUN_STEPS.map((s) => s.id).join(' → ')}\n`);

let failedAt = null;
const results = [];
for (const [i, step] of RUN_STEPS.entries()) {
  const n = `${i + 1}/${RUN_STEPS.length}`;
  if (failedAt) { results.push({ id: step.id, status: 'not-run' }); continue; }
  if (step.mutates && !CONFIRM) {
    // 預演：build/version 會寫本機工作目錄，但不推不部署 ⇒ 允許；其餘改變外界的一律不做。
    const localOnly = step.id === 'build' || step.id === 'version';
    if (!localOnly) {
      console.log(`⏸  ${n} ${step.id}｜${step.title}`);
      console.log(`     預演不執行（加 --confirm 才會做）`);
      results.push({ id: step.id, status: 'planned' });
      continue;
    }
  }
  console.log(`▶  ${n} ${step.id}｜${step.title}`);
  try {
    const r = await step.run();
    const mark = r.status === 'skip' ? '⏭ 跳過' : '✅ 完成';
    console.log(`   ${mark}`);
    for (const d of [].concat(r.detail || [])) console.log(`     ${d}`);
    results.push({ id: step.id, status: r.status });
  } catch (e) {
    console.log(`   ❌ 斷在這一步`);
    console.log(String(e.message).split('\n').map((l) => `     ${l}`).join('\n'));
    results.push({ id: step.id, status: 'failed' });
    failedAt = step.id;
  }
  console.log('');
}

console.log('━━━ 結果 ━━━');
for (const r of results) {
  const icon = { done: '✅', skip: '⏭', planned: '⏸', failed: '❌', 'not-run': '⛔' }[r.status];
  const note = { planned: '（預演未執行）', 'not-run': '（前面斷了，沒跑）', skip: '（不需要做）' }[r.status] || '';
  console.log(`   ${icon} ${r.id}${note ? '　' + note : ''}`);
}

if (failedAt) {
  if (VERIFY_ONLY) {
    console.log(`\n❌ 驗收未過：**${TARGET_NAME} 線上此刻不成立**（沒有出貨、沒有改任何東西）。`);
    process.exit(1);
  }
  console.log(`\n❌ 出貨中止：卡在 **${failedAt}**，後面的步驟一步都沒跑。`);
  console.log(`   修好上面那條，重跑同一個指令即可（管線是冪等的，已做完的會自動跳過）。`);
  process.exit(1);
}

if (VERIFY_ONLY) {
  console.log(`\n✅ 驗收全過｜${TARGET_NAME} 線上是 release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
  console.log(`   （只驗收，未出貨；要出貨是 --confirm，且 publish 目標需 leo 先開 D20 保險）`);
  process.exit(0);
}

if (!CONFIRM) {
  console.log(`\n🔎 預演結束｜這次會出的版本是 **${ctx.release}**`);
  console.log(`   真的要走完：node installer/scripts/ship.mjs --target ${TARGET_NAME} --confirm`);
  process.exit(0);
}

console.log(`\n✅ 出貨完成｜release ${ctx.release}｜daemon ${ctx.daemonVersion}`);
if (T.verify) {
  console.log(`   用戶端入口：${T.verify.installerBase}`);
  console.log(`   🔴 最後一關是機器驗不了的：**用瀏覽器真的載一次** portal／安裝頁，`);
  console.log(`      看有沒有紅色錯誤橫幅、console 有沒有紅字（curl | grep 不算，08-08 就是這樣漏掉的）。`);
}
// 驗過的憑據由**管線自己蓋章**，不是人手 touch——手蓋的章證明不了任何事。
// 任何被別的目標宣告為 promoteFrom 來源的目標，成功走完 --confirm（含 verify 全過）
// 後都要蓋章——這是「提升」路徑唯一承認的輸入：沒蓋章＝沒人驗證過，不准提升。
// 章裡帶 sha／release／fingerprint（不只時間戳）：提升時要核對「磁碟 HEAD == 蓋章時的
// HEAD」，才擋得住「stage 蓋章後又往前移動、還沒重新驗證」這種事。
const isPromotionSource = Object.values(cfg.targets).some((t) => t.promoteFrom === TARGET_NAME);
if (isPromotionSource) {
  const receiptPath = '/tmp/.stage-verified';
  const finalManifest = JSON.parse(readFileSync(join(ctx.bundlesDir, 'manifest.json'), 'utf8'));
  const receipt = {
    target: TARGET_NAME,
    sha: ctx.headSha || sh('git', ['rev-parse', 'HEAD'], ctx.bundlesDir),
    release: ctx.release,
    fingerprint: finalManifest.fingerprint,
    ts: Math.floor(Date.now() / 1000),
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 1) + '\n');
  console.log(`   🎫 已蓋驗證章（${receiptPath}）——下游 promoteFrom="${TARGET_NAME}" 目標的前置條件`);
}
