/**
 * main-push-guard.mjs — 「推 main」的人閘，長在**真的在推的那一行**身上
 *
 * ── 為什麼需要這支（inkstone/InkStoneCo#56，脈絡 inkstone/ISEP#30）──────────────
 * `.claude/hooks/main-and-prod-push-guard.sh` 是 Claude Code 的 `PreToolUse:Bash` hook，
 * 它只看得到**Bash 工具呼叫本身的指令字串**。出貨線的 push 全部是
 * `spawnSync('git', ['push', …])` / `execFileSync('git', ['push', …])` 開出來的子行程
 * ——那些 push 從頭到尾不會產生一次新的 Bash 工具呼叫，殼層那道閘**連判斷的機會都沒有**。
 *
 * 這不是「log 少一筆」，是**推 main 這個動作在出貨線上完全沒有閘**。
 * 實害（2026-08-18，票上記著）：出貨線的同步步驟把 `a35421e` 直接推上
 * `inkstone/arcrun-collector` 的 `main`，**沒有任何閘反應**。那一筆：
 *   · 刪掉 `cmd/collector/main.go`
 *   · 把 22 行的 `.gitignore`（626 MB 產物的排除清單）洗成 1 行
 *   ⇒ 下一趟同步就會把編譯產物整包搬進那個剛清乾淨的 repo。
 *
 * 🔴 **這支不是新發明，是照 `d20-guard.mjs` 的思路做第二遍**：那支解的是同一個形狀
 * （D20 GitHub 接觸的保險，殼層 hook 同樣看不見子行程），修法一樣是
 * **把判斷搬進真正碰外部世界的那一行自己身上**，而不是去改 hook 的正則
 * （不管正則改成什麼樣，都看不見 node 子行程）。
 *
 * ── 判準：判動作，不判字面 ────────────────────────────────────────────────
 * leo 2026-08-17：「自然語言的變體是無限的，blacklist 永遠追不完⋯⋯封路哲學封的是**動作**。」
 * 殼層那道閘要從一整條指令字串裡猜「這是不是在推、推去哪」，所以兩種錯一起犯
 * （提到它的句子被擋、藏在子行程裡的真推送漏掉）。
 * **這一層沒有那個問題**：我們手上是 `git` 的 argv 陣列本身，
 * 「推到哪個分支」是解析出來的事實，不是字串比對的猜測。
 * ⇒ 一段只是**提到** `git push origin main` 的文字（commit message、檔案內容）
 *   永遠不會走到這裡，因為它根本不是一次 push 的 argv。
 *
 * ── 放行的唯一憑證：那枚戳記（與殼層閘同一個檔、同一組性質）────────────────
 * `/tmp/.main-push-ok`，一行一個「目的地」。三條性質一條都不准鬆
 * （每一條都是被穿透過才長出來的，見殼層閘 2026-08-11／08-12 的註解）：
 *   ① **綁目的地**：替 A repo 開的門，B repo 不准走
 *   ② **單次用完即丟**：一次確認只放行一次推送（並行的 subagent 讓「時間窗」本身就是漏洞）
 *   ③ **15 分鐘失效**：過期的舊保險不放行（d20-guard 補過同款的洞）
 *
 * 目的地寫法有兩種，都認：
 *   · **正規化後的 remote**（`git.uncle6.me/inkstone/arcrun-collector`）
 *     ——出貨線用這種：那是「**我准你覆寫哪個 repo 的 main**」，對人有意義；
 *       而本機工作區（`~/.arcrun-ship/…`）只是快取目錄，對人沒有意義。
 *   · **本機 repo 的 toplevel 路徑**——殼層那道閘教人寫的就是這個
 *     （`git rev-parse --show-toplevel > /tmp/.main-push-ok`）⇒ 照樣認，兩邊是同一道閘。
 *
 * ── 留痕（InkStoneCo#48：36 支閘只有 2 支記錄自己做了什麼）───────────────────
 * **擋下與放行都記**一行到 `installer/main-push-gate-log.md`；只記擋下的話分母未知，
 * 回答不了「這道閘到底有沒有在運作」。擋下時另外把**原始請求**寫進
 * `.claude/pending-main-push/`（總管本來就在讀那個目錄，殼層閘擋下時寫的也是那裡）。
 *
 * 全部做成純函式＋可注入（戳記路徑／留痕路徑／時間／git 執行器），
 * `main-push-guard.test.mjs` 才能餵它該擋與不該擋的輸入各數種，不必真的推任何 main。
 */
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 殼層那道閘用的同一個檔——兩邊是同一道人閘，不是兩套規矩。 */
export const STAMP_PATH = '/tmp/.main-push-ok';
/** 與殼層閘同樣的 15 分鐘（`stamp_ok()` 裡的 900）。 */
export const STAMP_TTL_SEC = 900;
/** 受保護的分支名。只有這兩個——`fix/custom-domain` 這種含字不算（殼層閘誤攔過）。 */
export const PROTECTED_BRANCHES = new Set(['main', 'master']);

const REPO_ROOT = resolve(join(import.meta.dirname, '..', '..'));
const INKSTONE_ROOT = resolve(REPO_ROOT, '..', '..');
export const GATE_LOG_REL = join('installer', 'main-push-gate-log.md');
export const DEFAULT_LOG_PATH = join(REPO_ROOT, GATE_LOG_REL);
/** 總管在讀的那個目錄（殼層閘擋下時也寫這裡）。 */
export const DEFAULT_PENDING_DIR = join(INKSTONE_ROOT, '.claude', 'pending-main-push');

/** 被這道閘擋下時丟的例外——呼叫端要分得出「閘擋的」和「git 壞了」。 */
export class MainPushBlocked extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MainPushBlocked';
    Object.assign(this, detail);
  }
}

/** git remote 正規化：去掉協定、帳密、`.git` 結尾 ⇒ 只比「這是哪個 repo」。 */
export function normRemote(u) {
  return String(u || '')
    .replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '')
    .replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * 解析一次 `git` 呼叫的 argv：這是不是 push、推去哪個 remote、目標分支是哪幾條。
 *
 * 🔴 這裡是本閘與殼層閘的分水嶺：**輸入是 argv 陣列，不是一整條指令字串**。
 *   所以「有沒有在推」是結構事實，不必猜；而「只是提到它的句子」根本不會進到這裡。
 */
export function parsePush(args) {
  const a = (args || []).map(String);
  const NONE = { isPush: false, remote: null, branches: [], dryRun: false, allRefs: false, sawRefspec: false };

  // ① 先跳過 `git` 自己的全域旗標（`-c http.postBuffer=…` 這種，出貨線真的在用）
  const GLOBAL_TAKES_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  let i = 0;
  while (i < a.length) {
    if (GLOBAL_TAKES_VALUE.has(a[i])) { i += 2; continue; }
    if (a[i].startsWith('-')) { i += 1; continue; }
    break;
  }
  if (a[i] !== 'push') return NONE;
  i += 1;

  // ② push 自己的旗標與參數
  const SUB_TAKES_VALUE = new Set(['--repo', '--exec', '--receive-pack', '-o', '--push-option']);
  let remote = null; let dryRun = false; let allRefs = false; let sawRefspec = false;
  const branches = [];
  for (; i < a.length; i++) {
    const t = a[i];
    if (t === '--') continue;
    if (t.startsWith('-')) {
      if (t === '--dry-run' || t === '-n') dryRun = true;
      // `--mirror`／`--all` 不指名分支，卻會一次覆寫（含 main）⇒ 當成「會動到 main」
      else if (t === '--mirror' || t === '--all') allRefs = true;
      else if (SUB_TAKES_VALUE.has(t)) i += 1;
      continue;
    }
    if (remote === null) { remote = t; continue; }
    sawRefspec = true;
    // refspec：`+src:dst`／`:dst`（刪除）／`dst`。目的地永遠是最後一段。
    const dst = t.replace(/^\+/, '').split(':').pop();
    if (/^refs\/tags\//.test(dst)) continue;          // 推 tag 不是推分支
    const b = dst.replace(/^refs\/heads\//, '');
    if (b) branches.push(b);
  }
  return { isPush: true, remote, branches, dryRun, allRefs, sawRefspec };
}

/** 目標裡有沒有 main／master。整名比對——含 `main` 的字不算。 */
export function targetsProtectedBranch(branches) {
  return (branches || []).some((b) => PROTECTED_BRANCHES.has(String(b)));
}

/** 戳記與目的地都走同一套正規化，才比得起來。 */
function idOf(x) { return normRemote(x); }

/**
 * 這一次推送可以用哪些「身分」去對戳記。
 * ① 正規化後的 remote（對人有意義：我准你覆寫哪個 repo 的 main）
 * ② 本機 repo 的 toplevel（殼層那道閘教人寫的形式 ⇒ 照樣認）
 */
export function identitiesOf({ remoteUrl, cwd, toplevel = null }) {
  const out = [];
  if (remoteUrl) out.push(idOf(remoteUrl));
  const top = toplevel || resolve(cwd || '.');
  if (top) out.push(idOf(top));
  return [...new Set(out.filter(Boolean))];
}

/** 讀戳記：回傳裡面有哪些目的地、新不新鮮。 */
export function readStamp(stampPath = STAMP_PATH, { now = Date.now() } = {}) {
  if (!existsSync(stampPath)) return { ids: [], fresh: false, ageSec: null, why: '沒有戳記' };
  let ageSec = null;
  try { ageSec = Math.floor((now - statSync(stampPath).mtimeMs) / 1000); } catch { ageSec = null; }
  const ids = readFileSync(stampPath, 'utf8').split('\n').map((s) => idOf(s.trim())).filter(Boolean);
  if (ageSec === null) return { ids, fresh: false, ageSec, why: '讀不出戳記的時間' };
  if (ageSec > STAMP_TTL_SEC) {
    return { ids, fresh: false, ageSec, why: `戳記是 ${Math.round(ageSec / 60)} 分鐘前寫的，已經過期（${STAMP_TTL_SEC / 60} 分鐘失效）` };
  }
  return { ids, fresh: true, ageSec, why: null };
}

/** 用掉一枚：把那一行拿掉（空了就刪檔）。單次用完即丟。 */
export function consumeStamp(stampPath, id) {
  if (!existsSync(stampPath)) return false;
  const rest = readFileSync(stampPath, 'utf8').split('\n')
    .filter((l) => l.trim() && idOf(l.trim()) !== id);
  if (rest.length) writeFileSync(stampPath, rest.join('\n') + '\n', 'utf8');
  else { try { unlinkSync(stampPath); } catch { /* 刪不掉不影響判定 */ } }
  return true;
}

/** 這批目的地裡，現在還沒被授權的有哪些（給 preflight 一次講完用，不消耗戳記）。 */
export function unarmed(ids, { stampPath = STAMP_PATH, now = Date.now() } = {}) {
  const s = readStamp(stampPath, { now });
  if (!s.fresh) return [...ids];
  return ids.filter((id) => !s.ids.includes(idOf(id)));
}

/**
 * 開跑前**一次把這一趟要用到的授權領出來**（照 `d20-guard.mjs` 的 `checkArmed()` 形狀：
 * 人的決定在 preflight 確認一次，之後由管線帶著走——`ctx.armMission` 就是這樣傳的）。
 *
 * 🔴 為什麼不讓每個 push 各自去讀戳記：一趟出貨動輒十幾分鐘（重打 bundle、部 29 顆 worker），
 *   而戳記 15 分鐘就失效 ⇒ 會在**管線中段**才斷，那時候 bundle 已經推出去了
 *   ——「部分成功」正是這條管線的站表第一行明講不接受的東西。
 *
 * 性質一條都沒鬆：**綁目的地**（一個目的地一格）、**單次用完即丟**（用掉就從 Map 扣掉）、
 * **15 分鐘失效**（領的當下就要新鮮）。變的只是「什麼時候領」。
 *
 * @returns {Map<string, number>} 目的地 → 還剩幾次
 */
export function claimGrants(dests, { stampPath = STAMP_PATH, now = Date.now() } = {}) {
  const grants = new Map();
  for (const d of dests || []) {
    const id = idOf(d);
    const s = readStamp(stampPath, { now });
    if (s.fresh && s.ids.includes(id)) {
      consumeStamp(stampPath, id);
      grants.set(id, (grants.get(id) || 0) + 1);
    }
  }
  return grants;
}

/** 閘自己給得出總管要貼的那一行（不必去翻文件）。 */
export function armCommand(ids, stampPath = STAMP_PATH) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((i) => `'${i}'`).join(' ');
  return `printf '%s\\n' ${list} > ${stampPath}`;
}

const GATE_LOG_HEADER = `# main-push 閘執行紀錄（in-process，InkStoneCo#56）

> 每一次執行都記一行——**擋下與放行都記**。只記擋下的話分母是未知的，
> 回答不了「這道閘到底有沒有在運作」（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）。
>
> 這道閘住在 node 行程裡：出貨線的 push 是 \`spawnSync('git', …)\` 開的子行程，
> 殼層的 \`PreToolUse:Bash\` hook 看不到它（2026-08-18 就是這樣推壞了 arcrun-collector 的 main）。

| 時間 | 目的地 | 分支 | 結果 | 說明 |
|---|---|---|---|---|
`;

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function appendGateLog(logPath, { ts, dest, branches, result, note }) {
  const row = redact(`| ${ts} | ${dest || '(不明)'} | ${(branches || []).join('、') || '—'} | ${result} | ${String(note || '—').replace(/\n/g, ' ')} |`);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(logPath)) appendFileSync(logPath, GATE_LOG_HEADER, 'utf8');
    appendFileSync(logPath, row + '\n', 'utf8');
  } catch { /* 留痕失敗不准變成放行，也不准把出貨炸掉——判定在別處 */ }
  return row;
}

/**
 * D36：出貨線的 remote 網址**內嵌帳密**（credentials-map.md 記載的既有做法）。
 * 這道閘會把 argv 寫進請求檔與留痕 ⇒ **寫出去之前先把 `//帳號:權杖@` 遮掉**。
 * （2026-08-16 實撞過一次：git 自己一句好心提示就把整條網址印進出貨輸出裡。）
 */
export function redact(s) {
  return String(s || '').replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
}

/** 檔名只用 ASCII（中文會被打成一排 dash，看不出是誰）。 */
function slug(s) {
  const out = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'unnamed';
}

/**
 * 擋下時留一份**原始請求**給總管：repo／分支／它想跑的 argv／還沒推上去的 commit。
 * 總管看的是原始資料，不是散文轉述（殼層閘擋下時寫的也是這個目錄）。
 */
export function writePendingRequest(pendingDir, { who, dest, branches, args, cwd, git }) {
  try {
    mkdirSync(pendingDir, { recursive: true });
    const fence = '```';
    const log = git(['log', '--oneline', '-20'], cwd);
    const stat = git(['diff', '--stat', 'HEAD~1..HEAD'], cwd);
    const body = [
      `# 推 main 的請求：${who}`,
      '',
      `- 目的地：${dest}`,
      `- 分支：${(branches || []).join('、')}`,
      `- 工作區：${cwd}`,
      `- 時間：${localStamp()}`,
      '',
      '- 它想跑的指令（argv 原文，不是轉述）：',
      fence,
      redact(`git ${(args || []).join(' ')}`),
      fence,
      '',
      '## 這個工作區最近的 commit（原始資料）',
      fence,
      log || '(列不出來)',
      fence,
      '',
      '## 最後一筆動了哪些檔',
      fence,
      stat || '(列不出來)',
      fence,
      '',
      '---',
      '總管裁完請刪掉這個檔——留著代表「還沒裁」。',
      '',
    ].join('\n');
    const file = join(pendingDir, `${slug(who)}--${slug(dest)}.md`);
    writeFileSync(file, body, 'utf8');
    return file;
  } catch { return null; }
}

/** 預設的 git 讀取器（只讀，不寫）。分出來只為了讓測試注入假的。 */
function defaultGit(args, cwd) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  } catch { return ''; }
}

function blockedMessage({ dest, branches, why, stampPath, cwd, pendingFile }) {
  return [
    `🚫 推 ${branches.join('、')} 要先有「總管決定了」的戳記——這一次沒有（${why}）。`,
    '',
    `     目的地：${dest}`,
    `     工作區：${cwd}`,
    '',
    '     ━━━ 你是 subagent／自動出貨線 ━━━',
    '     **不要自己造那枚戳記。** 把改動留在自己的分支上，交回總管，說清楚',
    '     這幾筆各是什麼、各自驗過了沒有、建議合併還是先擱著。',
    pendingFile ? `     📮 這次的請求已經留在 ${pendingFile}（原始資料，總管會直接讀）。` : '',
    '',
    '     ━━━ 你是總管 ━━━',
    '     逐筆看過那些 commit（`git log --oneline`、`git diff --stat`），確定它們該進 main，再：',
    '',
    `         ${armCommand([dest], stampPath)}`,
    '',
    `     戳記**綁這個目的地、只能用一次、${STAMP_TTL_SEC / 60} 分鐘失效**——它代表`,
    '     「這一次、這個 repo，我看過了」。（多個目的地就一次寫多行，出貨的 preflight 會列給你。）',
    '',
    '     【為什麼不是形式主義】2026-08-18 真的發生過：出貨線的同步步驟把一筆 commit',
    '     直接推上 inkstone/arcrun-collector 的 main，刪掉了 cmd/collector/main.go、',
    '     把 22 行的 .gitignore 洗成 1 行，**沒有任何閘反應**——因為殼層那道閘',
    '     看不見 node 子行程裡的 git push（InkStoneCo#56）。',
  ].filter((l) => l !== '').join('\n');
}

/**
 * 🔴 出貨線每一次 `git push` 之前都要先過這裡。
 *
 * @param {object} o
 * @param {string[]} o.args        要交給 git 的 argv（`['push', 'origin', 'main']`…）
 * @param {string}   o.cwd         這次 push 會在哪個目錄執行
 * @param {string}   [o.remoteUrl] 目的地網址（含權杖也沒關係，正規化會把它洗掉、不留痕）
 * @param {string}   [o.who]       誰在推（寫進請求檔的署名）
 * @param {string}   [o.currentBranch] 沒給 refspec 時的當前分支（不給就問 git）
 * @returns {{allowed:true, reason:string, dest:string, branches:string[], stampId?:string}}
 * @throws {MainPushBlocked} 目標是 main／master 而沒有可用的戳記
 */
export function assertPushAllowed({
  args, cwd, remoteUrl = null, who = 'ship 出貨線', currentBranch = null,
  stampPath = STAMP_PATH, logPath = DEFAULT_LOG_PATH, pendingDir = DEFAULT_PENDING_DIR,
  now = Date.now(), git = defaultGit, grants = null,
}) {
  const p = parsePush(args);
  // 不是 push ⇒ 這道閘不管它，連留痕都不記（灌水會讓真正的紀錄讀不出來）
  if (!p.isPush) return { allowed: true, reason: '不是 push', dest: null, branches: [] };

  // 目的地：呼叫端給的網址優先；只給了 remote 名字（`origin`／`gitea`）就問 git 那個名字是誰
  let url = remoteUrl;
  if (!url && p.remote) url = /[/:]/.test(p.remote) ? p.remote : (git(['remote', 'get-url', p.remote], cwd) || p.remote);
  const dest = idOf(url) || '(不明)';

  let branches = p.branches;
  if (p.allRefs) branches = ['(--mirror/--all：所有分支)'];
  else if (!p.sawRefspec) branches = [currentBranch || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '(不明)'];

  const ts = localStamp(new Date(now));
  const logRow = (result, note) => appendGateLog(logPath, { ts, dest, branches, result, note });

  if (p.dryRun) {
    logRow('✅ 放行', '--dry-run：演練不會改到任何東西');
    return { allowed: true, reason: 'dry-run', dest, branches };
  }
  if (!p.allRefs && !targetsProtectedBranch(branches)) {
    // 推 tag 的 refspec 解析完不會留下任何分支 ⇒ 說清楚是哪一種放行，log 才讀得懂
    logRow('✅ 放行', p.sawRefspec && branches.length === 0 ? '推的是 tag，不是分支' : '目標不是 main／master');
    return { allowed: true, reason: '不是 main', dest, branches };
  }

  const ids = identitiesOf({ remoteUrl: url, cwd, toplevel: git(['rev-parse', '--show-toplevel'], cwd) || null });

  // ① preflight 領走的授權（`claimGrants`）——一格用一次，用掉就扣
  if (grants && typeof grants.get === 'function') {
    const g = ids.find((id) => (grants.get(id) || 0) > 0);
    if (g) {
      grants.set(g, grants.get(g) - 1);
      logRow('✅ 放行', `preflight 已按閘（${g}，這一趟剩 ${grants.get(g)} 次）`);
      return { allowed: true, reason: 'preflight 授權', dest, branches, stampId: g };
    }
  }

  // ② 沒有 preflight 授權就當場問戳記（單獨跑某一站、或呼叫端沒帶 grants 時走這條）
  const s = readStamp(stampPath, { now });
  const hit = s.fresh ? ids.find((id) => s.ids.includes(id)) : null;
  if (hit) {
    consumeStamp(stampPath, hit);
    logRow('✅ 放行', `戳記對上 ${hit}（用完即丟）`);
    return { allowed: true, reason: '戳記', dest, branches, stampId: hit };
  }

  const why = s.fresh ? `戳記裡沒有這個目的地（裡面是：${s.ids.join('、') || '空的'}）` : s.why;
  const pendingFile = writePendingRequest(pendingDir, { who, dest, branches, args, cwd, git });
  logRow('⛔ 擋下', `${why}｜請求留在 ${pendingFile || '(寫不進去)'}`);
  throw new MainPushBlocked(blockedMessage({ dest, branches, why, stampPath, cwd, pendingFile }),
    { dest, branches, pendingFile });
}
