/**
 * cf-credential.mjs — 出貨線部署 Cloudflare 用哪一把鑰匙：**登錄簿寫名字，管線自己拿值**
 *
 * ── 為什麼有這支（inkstone/arcrun-rag#212 comment 10953，2026-09-25）──────────────
 * leo：「如果不用這個狀態你可以碰到嗎？你要測試的是這個，不可以地端有的雲端沒有，
 *       你在你自己環境改的任何一件事都造成使用雲端的困擾」
 *
 * 出貨線的三個部署站（deploy／docs／mail-relay）本來只給 wrangler 一個
 * `CLOUDFLARE_ACCOUNT_ID`，**認證完全靠 leo 家目錄裡的 wrangler OAuth 登入態**
 * （`~/.wrangler/config/default.toml`）。那個檔不隨 repo clone 走 ⇒ 雲端 container
 * 永遠部署不了——而那不是物理限制，是「認證沒有名字」。
 *
 * 兩個順帶治掉的洞：
 *   ① 同一條線在不同機器上**用不同身分部署**（本機 OAuth、雲端 token）＝違反
 *      ship.mjs 不變式 Ⅰ「同一份輸入永遠得到同一組動作」。現在兩邊都用登錄簿指名的那一把，
 *      地端與雲端走同一條路——這正是本票要驗的事（地端 `wrangler logout` 之後出貨仍要成功）。
 *   ② 環境裡飄著一個**沒有名字的** `CLOUDFLARE_API_TOKEN`（例如別條產品線留下的）時，
 *      wrangler 會拿它去打登錄簿宣告的帳號，打錯實例。這裡一律用指名的那把覆蓋掉。
 *
 * ── D36 怎麼守 ───────────────────────────────────────────────────────────
 *   · 登錄簿（ship.targets.json 的 `cloudflareCredentials`）只寫**名字**
 *   · 值由 `credential-store.mjs` 從 shell／`.env` 鏈取得，只放進**那一個 wrangler 子行程**
 *     的環境，不寫檔、不進 argv、不印出（說明文字只有名字與來源檔路徑）
 *
 * 本 repo 目前只有一個帳號在用（uncle6，`58309bb9…`）——deploy／docs／mail-relay 三站
 * 全部打它，所以只登記這一筆；哪天出貨線要打第二個帳號，登錄簿加一筆、這支不必改。
 */

import { fill, describeSources, missingCredentialError } from './credential-store.mjs';

/** 這個目標會用 wrangler 部署到哪些帳號（登錄簿宣告，去重）。 */
export function deployAccountsOf(T) {
  const out = [];
  for (const key of ['installer', 'docsSite', 'mailRelay']) {
    const s = T && T[key];
    if (s && s.accountId && !out.includes(s.accountId)) out.push(s.accountId);
  }
  return out;
}

/** 登錄簿裡「這個帳號用哪把鑰匙」——缺宣告就丟（不猜、不退回 OAuth）。 */
export function credentialNameFor(cfg, accountId) {
  const table = (cfg && cfg.cloudflareCredentials) || {};
  const entry = table[accountId];
  const name = entry && (typeof entry === 'string' ? entry : entry.name);
  if (!name) {
    throw new Error(
      `登錄簿沒宣告帳號 ${accountId} 部署要用哪一把 Cloudflare 鑰匙（installer/ship.targets.json → cloudflareCredentials）。\n`
      + '     不退回「本機 wrangler 登入態」：那個檔不隨 clone 走，換一台機器（雲端）就部署不了，\n'
      + '     而且同一條線在不同機器上會用不同身分部署（inkstone/arcrun-rag#212）。');
  }
  return name;
}

/**
 * 取得「部署到 accountId」需要的子行程環境。
 * @returns {{ name: string, env: {CLOUDFLARE_ACCOUNT_ID: string, CLOUDFLARE_API_TOKEN: string}, lines: string[] }}
 */
export function cloudflareDeployEnv({ cfg, accountId, startDir, env = process.env, stopAt, override }) {
  const name = credentialNameFor(cfg, accountId);
  const r = fill([name], { startDir, env, stopAt, override });
  if (!env[name]) {
    throw missingCredentialError(r, { need: `wrangler 部署到 Cloudflare 帳號 ${accountId} 要用它` });
  }
  return {
    name,
    env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: env[name] },
    lines: describeSources(r),
  };
}
