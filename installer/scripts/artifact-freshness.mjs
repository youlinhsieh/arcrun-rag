/**
 * artifact-freshness.mjs — 「**成品比源碼舊**」就當場停下，並指名是哪幾顆、差在哪一顆 commit。
 *
 * ── 為什麼有這支（Leo/Arcrun#93，2026-08-12 一天差點出錯兩次）──────────────────
 *
 * `.worker-builds/` 是出貨與安裝**真正拿去部署的執行檔**。它的 manifest 每顆記著
 * `source_commit`＝「這批位元組是哪顆 commit 編出來的」。
 * 併完修法卻沒重編 ⇒ **送出去的是舊執行檔，而測試全綠、出貨管線也全綠**。
 * 2026-08-12 併完 `Arcrun#85`／`#88` 之後的實況：
 *
 *     arcrun-cypher-executor  成品記的 797e7f7   源碼已經是 525faaf   ⚠️
 *     arcrun-kbdb             成品記的 a7e23ba   源碼已經是 3eb8b31   ⚠️
 *
 * **是人工逐顆比對才發現的**，同一天稍晚又差點漏一次。
 *
 * ── 既有的閘為什麼沒響 ────────────────────────────────────────────────────
 * `build-bundles.mjs` 的 `assertNotBehindMain()` 比的是「`.worker-builds` **這個目錄**
 * 有沒有落後 main 的 commit」。那天**沒有人碰過那個目錄**（正是病灶本身：該重編而沒重編
 * ⇒ 目錄當然沒動）⇒ 它安靜放行。
 * 它問的是「我這個 clone 是不是拿到最新的成品」；本檔問的是**「這批成品是不是還算數」**。
 * 兩個問題不同，都要問——所以本檔是加一道，不是取代那道。
 *
 * ── 真正該比的資料，兩邊本來就都有了 ──────────────────────────────────────
 *   · 成品這邊：`.worker-builds/manifest.json` 的 `workers[].source_commit`
 *   · 源碼這邊：那顆 worker 的原始碼目錄——`bundle-components.mjs` 的 `build.dir`
 *     （`cypher-executor`／`kbdb`／`mcp`／…）就是它，本 repo 早就宣告了
 * 沒人拿來比而已。比法：`git log <source_commit>..HEAD -- <那顆的源碼目錄>`
 * ——**非空 ＝ 成品編出來之後那顆的源碼又動過 ＝ 你少做了「重編」這一步。**
 *
 * ── 紅線（Arcrun#93 明文）────────────────────────────────────────────────
 * 🔴 **不准改成「自動幫你重編」就放行。** 重編有成本、也可能失敗；要人看到
 *   「你少做了這一步」，不是被靜默補上。所以本檔只會停、只會講清楚，不會動手編。
 *
 * ── 為什麼是獨立模組 ──────────────────────────────────────────────────────
 * 跟 `source-pin.mjs`／`verify-download.mjs` 同一個理由：**閘本身要能被單獨演練**，
 * 不必跑一次會 push 會部署的完整管線才知道它還通不通。純函式＋repo 路徑注入
 * ⇒ 可以在假的臨時 git repo 上把「乾淨」「源碼又推進了」「源碼被改但沒 commit」
 * 「manifest 沒記 source_commit」四種情況都跑過一遍。
 */
import { execFileSync } from 'node:child_process';

/** 跑一個 git 指令；失敗回傳 null（呼叫端自己決定「問不出來」算不算過）。 */
function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * 這顆 worker 的原始碼在 Arcrun repo 的哪幾個目錄。
 *
 * 優先用**成品自己記的** `source_dir`／`source_dirs`（Arcrun 的建置腳本最清楚它編了什麼，
 * 也涵蓋得到共用目錄）；沒有就退回本 repo 的 `bundle-components.mjs` 宣告的 `dir`
 * ——那份清單本來就是「一個 bundle 有哪幾顆、每顆從哪編」的唯一真相源。
 * 兩邊都沒有 ⇒ 回空陣列，由呼叫端判成「無法判定」而**停**（不是放行）。
 */
export function sourceDirsOf(artifact, component) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim().replace(/\/+$/, ''));
  };
  if (artifact) {
    push(artifact.source_dir);
    for (const d of artifact.source_dirs || []) push(d);
  }
  if (!out.length && component) push(component.dir);
  return [...new Set(out)];
}

/**
 * 比一顆。回傳 `{ name, status, sourceCommit, headCommit, dirs, behind, dirty, reason }`：
 *
 *   status='ok'      成品編出來之後，那幾個目錄沒有任何 commit、也沒有未提交的改動
 *   status='stale'   🔴 那幾個目錄在成品之後**又被 commit 過** ⇒ 成品是舊的
 *   status='dirty'   🔴 那幾個目錄現在有**未提交**的改動 ⇒ 工作區比成品新
 *   status='unknown' 🔴 問不出來（沒記 source_commit／不知道源碼在哪／那顆 commit 這個
 *                    clone 裡查不到／它不是 HEAD 的祖先）——**問不出來一律停**，
 *                    因為本閘存在的理由就是「不確定的時候不要安靜放行」
 *
 * 不丟例外：純資料進、純資料出，測試才能把每一個分支都斷言到（同 source-pin.mjs 的理由）。
 */
export function checkOne({ repo, name, artifact, component }) {
  const base = { name, dirs: [], behind: [], dirty: [], sourceCommit: null, headCommit: null };
  const head = git(repo, ['rev-parse', 'HEAD']);
  base.headCommit = head;

  const sourceCommit = artifact && artifact.source_commit ? String(artifact.source_commit) : null;
  base.sourceCommit = sourceCommit;
  if (!sourceCommit) {
    return { ...base, status: 'unknown', reason: `成品沒有記 source_commit ⇒ 沒辦法回答「這批位元組是哪顆 commit 編的」` };
  }

  const dirs = sourceDirsOf(artifact, component);
  base.dirs = dirs;
  if (!dirs.length) {
    return {
      ...base, status: 'unknown',
      reason: `不知道這顆的源碼在哪個目錄（成品沒記 source_dir／source_dirs，` +
        `bundle-components.mjs 也沒有它的 build.dir）⇒ 無從比對`,
    };
  }

  if (git(repo, ['cat-file', '-e', `${sourceCommit}^{commit}`]) === null) {
    return { ...base, status: 'unknown', reason: `這個 clone 裡查不到 ${sourceCommit.slice(0, 7)} 這顆 commit（成品來自別的 clone？先 fetch）` };
  }
  // 成品的 commit 必須是 HEAD 的祖先。不是 ⇒ 兩者根本不在同一條線上（例如 checkout 到
  // 舊 commit、或成品來自還沒併進來的分支）⇒ 「差幾顆」這個問題本身沒有意義，停。
  let ancestor = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], { cwd: repo, stdio: 'ignore' });
  } catch {
    ancestor = false;
  }
  if (!ancestor) {
    return {
      ...base, status: 'unknown',
      reason: `成品的 ${sourceCommit.slice(0, 7)} 不是現在 HEAD（${(head || '').slice(0, 7)}）的祖先` +
        `⇒ 成品與工作區不在同一條線上，「新舊」無從比較`,
    };
  }

  // 🔴 這幾個目錄必須真的被 git 追蹤。沒被追蹤（不存在／被 .gitignore 掉）⇒ 底下的
  //   `git log` 與 `git status` 都會誠實地回「什麼都沒有」——而那個「沒有」看起來
  //   跟「同步」一模一樣 ⇒ **這顆就永遠不會被這道閘攔到**。那正是本檔要消滅的形狀
  //   （舊的落後閘就是這樣安靜放行的），所以寧可報 unknown 停下來問。
  const tracked = git(repo, ['ls-files', '--', ...dirs]);
  if (tracked === null || tracked === '') {
    return {
      ...base, status: 'unknown',
      reason: `${dirs.join('、')} 沒有被 git 追蹤（不存在或被 .gitignore 掉）⇒ 比對永遠會是空的，` +
        `等於這顆沒有閘。修法：把它納入版控，或在成品的 source_dir(s) 指到真正的源碼目錄`,
    };
  }

  // git 這兩個問句本身失敗（回 null）＝**問不出來**，不是「沒有差異」。
  // 兩者長得都像空字串，混為一談就會變成靜默放行——這一段是刻意分開的。
  const log = git(repo, ['log', '--format=%h %s', `${sourceCommit}..HEAD`, '--', ...dirs]);
  const st = git(repo, ['status', '--porcelain', '--', ...dirs]);
  if (log === null || st === null) {
    return { ...base, status: 'unknown', reason: `git 問不出這幾個目錄的狀態（${dirs.join('、')}）⇒ 不敢說它是新的` };
  }
  const behind = log.split('\n').filter(Boolean);
  const dirty = st.split('\n').filter(Boolean);

  if (behind.length) return { ...base, status: 'stale', behind, dirty, reason: `源碼在成品之後又被 commit ${behind.length} 次` };
  if (dirty.length) return { ...base, status: 'dirty', behind, dirty, reason: `源碼有 ${dirty.length} 項未提交的改動` };
  return { ...base, status: 'ok', behind, dirty, reason: '成品與源碼同步' };
}

/**
 * 比整批。`components` ＝ `bundle-components.mjs` 的 `CORE_COMPONENTS`
 * （只比真的會被打進 bundle 的那幾顆——不在 bundle 裡的 worker 舊不舊不影響這次出貨）。
 *
 * `allowDirty` ＝ 目標允許來源工作區不乾淨時（`ship.targets.json` 的 `allowDirtySource`，
 * 目前只有 selftest：不推、不部署、沒有任何人會拿到東西）把 `dirty` 降級成不擋。
 * **`stale` 不受這個旗標影響**——「已經 commit 進去卻沒重編」跟工作區乾不乾淨無關。
 */
export function checkArtifactFreshness({ repo, manifest, components, allowDirty = false }) {
  const byName = new Map(((manifest && manifest.workers) || []).map((w) => [w.name, w]));
  const results = [];
  for (const c of components || []) {
    results.push(checkOne({ repo, name: c.name, artifact: byName.get(c.name), component: c }));
  }
  const blocking = results.filter(
    (r) => r.status === 'stale' || r.status === 'unknown' || (r.status === 'dirty' && !allowDirty),
  );
  return { ok: blocking.length === 0, results, blocking };
}

/** 把結果寫成人話。訊息要能直接回答兩件事：**哪幾顆**、**差在哪一顆 commit**。 */
export function formatFreshnessProblem({ repo, results, blocking }) {
  const lines = [];
  lines.push(`成品比源碼舊——你少做了「重編」這一步（Leo/Arcrun#93）\n`);
  lines.push(`     來源 repo：${repo}`);
  lines.push(`     ${blocking.length} 顆對不上（共比了 ${results.length} 顆）：\n`);
  for (const r of blocking) {
    const label = { stale: '🔴 成品是舊的', dirty: '🔴 工作區比成品新', unknown: '🔴 無法判定' }[r.status] || r.status;
    lines.push(`     · ${r.name}　${label}`);
    if (r.sourceCommit) lines.push(`         成品記的 source_commit：${r.sourceCommit.slice(0, 7)}`);
    if (r.headCommit) lines.push(`         源碼現在的 HEAD       ：${r.headCommit.slice(0, 7)}`);
    if (r.dirs.length) lines.push(`         比對的源碼目錄        ：${r.dirs.join('、')}`);
    if (r.behind.length) {
      lines.push(`         成品之後這幾顆 commit 動過它（差 ${r.behind.length} 顆）：`);
      for (const c of r.behind.slice(0, 8)) lines.push(`           ${c}`);
      if (r.behind.length > 8) lines.push(`           …還有 ${r.behind.length - 8} 顆`);
    }
    if (r.dirty.length) {
      lines.push(`         未提交的改動：`);
      for (const d of r.dirty.slice(0, 8)) lines.push(`           ${d}`);
      if (r.dirty.length > 8) lines.push(`           …還有 ${r.dirty.length - 8} 項`);
    }
    if (r.status === 'unknown') lines.push(`         原因：${r.reason}`);
    lines.push('');
  }
  lines.push(`     修法：在 ${repo} 跑 \`node scripts/build-worker-artifacts.mjs\`，`);
  lines.push(`           把重編出來的 .worker-builds/ commit 進去，再重跑本管線。`);
  lines.push(`     🔴 本閘**不會自動幫你重編**——重編有成本也可能失敗，要你看到少了哪一步（Arcrun#93 紅線）。`);
  lines.push(`     明知故犯：ARTIFACT_ALLOW_STALE=1（要在 commit 說明理由）。`);
  return lines.join('\n');
}

/**
 * 呼叫端入口：對不上就丟例外（訊息是人話，直接可讀）；對得上回傳結果供列印。
 *
 * `ARTIFACT_ALLOW_STALE=1` ＝明知故犯的逃生門（同 `BUILD_ALLOW_BEHIND` 的既有慣例）：
 * 它**照樣把每一顆的差異全印出來**，只是不停——「你少做了這一步」還是看得見，
 * 這正是紅線要的（要人看到，不是被靜默補上）。
 */
export function requireFreshArtifacts({ repo, manifest, components, allowDirty = false }) {
  const r = checkArtifactFreshness({ repo, manifest, components, allowDirty });
  if (r.ok) return r;
  const msg = formatFreshnessProblem({ repo, results: r.results, blocking: r.blocking });
  if (process.env.ARTIFACT_ALLOW_STALE === '1') {
    console.warn(`\n⚠️ ARTIFACT_ALLOW_STALE=1：以下問題**被明知故犯地放行**（請在 commit 說明理由）\n`);
    console.warn(msg);
    return r;
  }
  throw new Error(msg);
}
