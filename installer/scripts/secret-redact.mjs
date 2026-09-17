/**
 * secret-redact.mjs — 出貨線印出去的每一個字，先把金鑰遮掉（D36：值不落地、不外洩）。
 *
 * 🔴 由來（inkstone/arcrun-rag#202 c7599，2026-09-17 prod 出貨）：
 *   第 21 站 `git push` 被 GitHub 拒絕，`execFileSync` 丟出的錯誤訊息是
 *   `Command failed: git -c http.<remote>.extraheader=Authorization: Basic <base64> push …`
 *   ——**整行 argv 原樣進了錯誤訊息**，出貨線再把它印到終端機、進了 `/tmp/ship-prod.out`
 *   與 Claude Code 的對話紀錄。base64 解開就是 `GITHUB_MIRROR_TOKEN`。
 *
 *   舊的遮蔽（`main-push-guard.mjs` 的 `redact`、`pushGiteaQuietly`、`line-source-repo` 的
 *   defaultRunner）只認得 `//帳號:權杖@` 這一種形狀，而且**各自散在呼叫點**：
 *   新寫一個呼叫點、或金鑰換一種帶法（header／base64），就沒有人遮。
 *
 * ⇒ 這支做兩件事：
 *   ① `redactSecrets(text)`：認**形狀**（網址內嵌帳密、Authorization 標頭）
 *      ＋認**值**（環境變數裡看起來是金鑰的那些，連同它們組成 Basic auth 的 base64）。
 *      認值那一半是為了抓「形狀認不出來、但字串就是那把鑰匙」的情況。
 *   ② `installConsoleRedaction()`：把 `console.log／error／warn` 包起來，
 *      出貨線自己印的任何東西都先過一次 ①——**遮蔽長在出口，不長在每個呼叫點**。
 */

/** 名字長得像金鑰的環境變數（值才拿來比對，名字本身不算祕密）。 */
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY)$/i;
/** 太短的值拿來做字串取代會誤傷一般文字（例如 `true`、`main`）。 */
const MIN_SECRET_LEN = 12;

const MASK = '***REDACTED***';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 從環境變數算出「要遮的字串值」：金鑰本身，以及它可能被組成 Basic auth 的 base64。
 * （出貨線組 Basic auth 用的是 `${GITHUB_ACCOUNT_NAME || 'git'}:${token}`，兩種帳號名都算。）
 */
export function secretValuesFrom(env = process.env) {
  const values = new Set();
  const accounts = new Set(['git', 'x-access-token']);
  for (const k of ['GITHUB_ACCOUNT_NAME', 'GITEA_USER', 'GITEA_LOGIN']) {
    if (env[k]) accounts.add(String(env[k]));
  }
  for (const [name, raw] of Object.entries(env)) {
    if (!SECRET_NAME_RE.test(name)) continue;
    const v = String(raw || '').trim();
    if (v.length < MIN_SECRET_LEN) continue;
    values.add(v);
    for (const a of accounts) values.add(Buffer.from(`${a}:${v}`).toString('base64'));
  }
  // 長的先換：避免短值先被換掉、把長值切成換不到的碎片
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * 遮掉一段文字裡的金鑰。冪等（遮過的再遮一次不變）。
 * @param {unknown} text
 * @param {{ env?: Record<string,string|undefined>, values?: string[] }} [opts]
 */
export function redactSecrets(text, { env = process.env, values } = {}) {
  let s = String(text ?? '');
  // ① 網址內嵌帳密：https://帳號:權杖@host
  s = s.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***:***@');
  // ② Authorization 標頭（含 git -c http.*.extraheader=Authorization: Basic xxx 這種帶法）
  s = s.replace(/(Authorization\s*[:=]\s*(?:Basic|Bearer|token)\s+)[^\s'"]+/gi, `$1${MASK}`);
  // ③ 認值：形狀認不出來、但字串就是那把鑰匙
  for (const v of values || secretValuesFrom(env)) {
    if (!v || v === MASK) continue;
    s = s.replace(new RegExp(escapeRe(v), 'g'), MASK);
  }
  return s;
}

/**
 * 把一個 Error（含 execFileSync 帶的 stdout／stderr）遮乾淨再丟回去。
 * 回傳同一個物件——呼叫端照舊 `throw redactError(e)`。
 */
export function redactError(e, opts) {
  if (!e || typeof e !== 'object') return new Error(redactSecrets(e, opts));
  try {
    if (typeof e.message === 'string') e.message = redactSecrets(e.message, opts);
    if (typeof e.stack === 'string') e.stack = redactSecrets(e.stack, opts);
    for (const k of ['stdout', 'stderr', 'cmd']) {
      if (e[k] != null) e[k] = redactSecrets(Buffer.isBuffer(e[k]) ? e[k].toString('utf8') : e[k], opts);
    }
    if (Array.isArray(e.output)) {
      e.output = e.output.map((o) => (o == null ? o : redactSecrets(Buffer.isBuffer(o) ? o.toString('utf8') : o, opts)));
    }
    if (Array.isArray(e.spawnargs)) e.spawnargs = e.spawnargs.map((a) => redactSecrets(a, opts));
  } catch { /* 遮蔽失敗不能變成原樣丟出去——下面的 console 出口還會再遮一次 */ }
  return e;
}

/**
 * 把 console 的出口包起來：之後印的每個參數都先遮。
 * 只包一次（重複呼叫不會疊）；回傳還原函式（測試用）。
 */
export function installConsoleRedaction(target = console, opts) {
  if (target.__secretRedactionInstalled) return () => {};
  const originals = {};
  for (const m of ['log', 'error', 'warn', 'info']) {
    originals[m] = target[m];
    target[m] = (...args) => originals[m].apply(target, args.map((a) => {
      if (typeof a === 'string') return redactSecrets(a, opts);
      if (a instanceof Error) return redactSecrets(a.stack || a.message, opts);
      return a;
    }));
  }
  target.__secretRedactionInstalled = true;
  return () => {
    for (const m of Object.keys(originals)) target[m] = originals[m];
    delete target.__secretRedactionInstalled;
  };
}

/**
 * 給 git 帶一個 http 標頭，但**不放進 argv**：走 `GIT_CONFIG_COUNT／KEY／VALUE`（git ≥ 2.31）。
 * argv 會出現在錯誤訊息、`ps` 與任何閘的留痕裡；環境變數不會。
 */
export function gitHeaderEnv(remote, headerValue, base = {}) {
  const n = Number(base.GIT_CONFIG_COUNT || 0);
  return {
    ...base,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${remote}.extraheader`,
    [`GIT_CONFIG_VALUE_${n}`]: headerValue,
  };
}
