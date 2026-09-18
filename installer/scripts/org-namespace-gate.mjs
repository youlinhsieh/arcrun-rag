/**
 * org-namespace-gate.mjs — 出貨線與安裝器**只准指 inkstone org，不准指 `Leo/` 個人 namespace**。
 *
 * ── 為什麼需要這支（inkstone/InkStoneCo#98 comment 7795／7798，leo 2026-09-18）──────
 * leo 原話：「**Leo 的東西就是我的，org 的東西就是 CC 的**⋯⋯所有碰到 leo 的都改成連到 org」
 * 「這件事上次雲端已經錯過，已經改過，你又改回 leo」。
 *
 * 實錄：stage 的 bundle repo 從 `Leo/arcrun-rag-bundles-staging` 改指 inkstone **改過兩次**
 * （`d0db0e9` 09-01 分支 `fix/bundles-staging-to-inkstone`／`360a72d` 09-10 分支
 * `fix/stage-bundles-repo-inkstone`），**兩次都停在分支沒併**——main 照舊指 Leo/，
 * 下一個照 main 出貨的人就一路推到 Leo/。改對一次不夠，**要讓「改回去」這個動作過不了**。
 *
 * ── 擋在哪兩層 ─────────────────────────────────────────────────────────────
 * ① **執行期**：`ship.mjs` 一讀進登錄簿就跑 `checkTargets()`，命中 exit 2——
 *    登錄簿指 Leo/ 的那一刻，**任何目標都出不了貨**（不是只擋 stage）。
 *    同一道檢查也掃安裝器的 `wrangler.toml`（`youlin-stage` 不在登錄簿、手部署，
 *    只靠登錄簿會漏掉它）。
 * ② **測試期**：`org-namespace-gate.test.mjs` 掃 repo 內所有被追蹤的非 md 檔，
 *    有人把 `git.uncle6.me/Leo/…` 寫回任何執行路徑，ship 相關測試就紅。
 *
 * ── 判準：只抓「真的會連過去的網址／slug」，不抓歷史票號 ─────────────────
 * `Leo/Arcrun#97`、`Leo/arcrun-rag#77` 這類是**歷史票號引用**（當時 org 還沒成立），
 * 它們不帶主機、也不會被任何程式拿去連 ⇒ 不抓。抓的是：
 *   · 帶主機的 Gitea 位址：`git.uncle6.me/Leo/…`、`git@git.uncle6.me:Leo/…`（owner 不分大小寫，
 *     Gitea 的 owner 本來就不分大小寫）
 *   · 登錄簿裡 `host: gitea` 的 `repoSlug` 是 `Leo/…`
 *   · 註解行（`#`、`//`、`*` 開頭）與登錄簿的 `_` 說明欄不算——那是在講歷史，不是在連
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 帶主機的 Gitea 個人 namespace 位址。 */
export const PERSONAL_NS_URL = /git\.uncle6\.me(?::\d+)?[/:]+leo\//i;
/** 不帶主機的 slug（只在「欄位就是 Gitea slug」時才拿來判）。 */
export const PERSONAL_NS_SLUG = /^leo\//i;

export const ORG = 'inkstone';

/**
 * 走訪登錄簿（或任何 JSON 物件），回傳所有指向 Leo/ 的字串值。
 * `_` 開頭的鍵是說明欄，整棵略過。
 * @returns {{path:string, value:string}[]}
 */
export function checkTargets(cfg) {
  const hits = [];
  const walk = (node, path, parent) => {
    if (typeof node === 'string') {
      const key = path.split('.').pop();
      const isGiteaSlug = key === 'repoSlug' && parent && parent.host === 'gitea';
      if (PERSONAL_NS_URL.test(node) || (isGiteaSlug && PERSONAL_NS_SLUG.test(node))) {
        hits.push({ path, value: node });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, parent)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('_')) continue;
        walk(v, path ? `${path}.${k}` : k, node);
      }
    }
  };
  walk(cfg, '', null);
  return hits;
}

/** 一行是不是整行註解（toml／sh／py 的 `#`、js 的 `//` 與區塊註解的 `*`）。 */
export function isCommentLine(line) {
  return /^\s*(#|\/\/|\/\*|\*)/.test(line);
}

/**
 * 掃一份文字檔的非註解行。
 * @returns {{line:number, text:string}[]}
 */
export function checkText(text) {
  const hits = [];
  String(text).split('\n').forEach((l, i) => {
    if (isCommentLine(l)) return;
    if (PERSONAL_NS_URL.test(l)) hits.push({ line: i + 1, text: l.trim() });
  });
  return hits;
}

/** ship.mjs 開跑時一定要檢查的真身（相對 repo 根）。 */
export const RUNTIME_FILES = [
  join('installer', 'oauth-prototype', 'wrangler.toml'),
  join('installer', 'oauth-prototype', 'worker.js'),
];

/**
 * 出貨線開跑前的總檢查：登錄簿＋安裝器設定。
 * @returns {string[]} 問題清單；空陣列＝通過
 */
export function runtimeProblems(repoRoot, cfg, read = (p) => readFileSync(p, 'utf8')) {
  const problems = [];
  for (const h of checkTargets(cfg)) {
    problems.push(`installer/ship.targets.json → ${h.path} = ${h.value}`);
  }
  for (const rel of RUNTIME_FILES) {
    let text;
    try { text = read(join(repoRoot, rel)); } catch { continue; }
    for (const h of checkText(text)) problems.push(`${rel}:${h.line} → ${h.text}`);
  }
  return problems;
}

/** 給人看的擋下訊息。 */
export function explain(problems) {
  return [
    `❌ 出貨線指到 Leo/ 個人 namespace，拒絕出貨（inkstone/InkStoneCo#98 c7795）：`,
    ...problems.map((p) => `     ${p}`),
    `   leo 2026-09-18：「Leo 的東西就是我的，org 的東西就是 CC 的」——一律改指 ${ORG}/。`,
    `   org 裡還沒有那個 repo ⇒ 請 leo 匯入（不是改回 Leo/）。`,
    `   閘本體：installer/scripts/org-namespace-gate.mjs`,
  ].join('\n');
}
