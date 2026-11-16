/**
 * github-push-probe.mjs — 出貨線開跑前先驗「這台機器推得動 GitHub 那幾個 repo」（inkstone/arcrun-rag#344）
 *
 * 🔴 由來（inkstone/InkStoneCo#308 c1794753635832183，2026-11-15）：
 *   1.4.208 leo 已在 AHub 簽核，prod 出貨 1～14 站都過，第 15 站「推上 bundle repo」被
 *   雲端 git proxy 擋下：
 *     `youlinhsieh/arcrun-rag-bundles is not in this session's authorized repository set,
 *      so the proxy will not inject a credential for it.`
 *   ⇒ 那個 session 的 bundle repo 只有讀取權（session sources 有它，可推的 outcomes 沒有）。
 *   ⇒ thread 誤判成「Claude 的自動安全檢查不認 AHub 簽核」，回頭要 leo 再寫一句「准推…」。
 *      那句話對 git proxy 沒有任何作用；而 ship.mjs 本身早在 ISEP auto-mode 白名單內。
 *
 * 這支做的事：
 *   ① 在**動任何東西之前**（preflight）對每個要推的 GitHub 遠端跑一次 `git push --dry-run`。
 *      dry-run 只做認證與 ref 比對，不送任何物件、不改遠端。
 *   ② 推不動就第一站擋下，訊息直接講「是誰擋、怎麼補」：
 *      雲端 proxy ⇒ 在這個 session 呼叫 add_repo（access: push）再重跑；**不是要 leo 准許的事**。
 *   ⇒ 工人照訊息做就不會錯，不會再停在第 15 站「部分成功」、也不會回頭請 leo 寫第二次同意。
 *
 * 不做的事：不放寬任何閘、不拿環境變數裡的 token 去繞 proxy、不碰非 GitHub 的遠端（Artifacts 由 credential helper 管）。
 */
import { spawnSync } from 'node:child_process';

/** 探測用的分支名：dry-run 不會真的建它；名字講明用途。 */
export const PROBE_REF = 'refs/heads/ship-push-access-probe';

/** `github.com/owner/repo(.git)` 或 https 網址 → `owner/repo`；不是 GitHub 回 null。 */
export function githubSlugOf(remote) {
  const m = String(remote || '')
    .replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '')
    .match(/^github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 登錄簿裡的遠端（可能不帶協定）→ 可直接給 git 的 https 網址。 */
export function httpsUrlOf(remote) {
  const s = String(remote || '');
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

/**
 * 把 dry-run 失敗的輸出分類成「誰擋的、怎麼補」。純函式，測試直接餵字串。
 * @returns {{ kind: 'proxy-unauthorized'|'auth'|'not-found'|'network'|'other', remedy: string[] }}
 */
export function classifyPushFailure(output, slug) {
  const o = String(output || '');
  const [owner, repo] = String(slug || '/').split('/');
  if (/not in this session's authorized repository set|will not inject a credential/i.test(o)) {
    return {
      kind: 'proxy-unauthorized',
      remedy: [
        `擋下的是雲端 git proxy：這個 session 對 ${slug} 沒有推送權（只能讀或根本沒掛上），不是 Claude 的安全檢查、也不是 ISEP 的閘。`,
        `→ 在這個 session 呼叫 MCP 工具 add_repo（owner="${owner}", repo="${repo}", access="push"；不要 save_to_project），`,
        '  成功後重跑同一行出貨指令（管線冪等）。',
        '🔴 這不是要 leo 准許的事：AHub 簽核就是他的人閘，不要回頭請他寫「准推…」。',
        '   也不要拿環境變數裡的 GitHub token 繞過 proxy。',
        '   add_repo 被拒（GitHub App 沒裝在該 repo／帳號沒連）才需要 leo，照 add_repo 回的原因轉給他。',
      ],
    };
  }
  if (/Authentication failed|could not read Username|HTTP 401|HTTP 403|Permission to .* denied|returned error: 40[13]/i.test(o)) {
    return {
      kind: 'auth',
      remedy: [
        `${slug} 拒絕這台機器的推送認證。`,
        '→ 雲端：在這個 session 用 add_repo（access="push"）補推送權後重跑。',
        '→ 地端（leo 的 Mac）：git 的 GitHub 認證沒設好或過期，修好認證再重跑。',
      ],
    };
  }
  if (/Repository not found|HTTP 404/i.test(o)) {
    return { kind: 'not-found', remedy: [`${slug} 找不到或這個身分看不到它：先確認登錄簿 ship.targets.json 的遠端沒寫錯。`] };
  }
  if (/Could not resolve host|timed out|Connection reset|unable to access/i.test(o)) {
    return { kind: 'network', remedy: ['連不上 GitHub（網路／proxy）。查 /root/.ccr/README.md 的 git 段，或稍後重跑。'] };
  }
  return { kind: 'other', remedy: ['看上面 git 的原文判斷；修好再重跑。'] };
}

/**
 * 對一個 GitHub 遠端跑 `git push --dry-run`（不送物件、不改遠端）。
 * @param {object} o
 * @param {string} o.remote   git 看得懂的遠端（https 網址，或 cwd 裡的 remote 名）
 * @param {string} o.slug     `owner/repo`，訊息用
 * @param {string} o.cwd      從哪個 git repo 推（只用它的 HEAD 算 ref）
 * @param {object} [o.env]    要帶的環境（例：鏡像那條線用 GIT_CONFIG_* 帶 Authorization 標頭）
 * @param {Function} [o.run]  測試注入用：(args, {cwd, env}) => {status, stdout, stderr}
 */
export function probeGithubPush({ remote, slug, cwd, env = process.env, run } = {}) {
  const runner = run || ((args, opts) => spawnSync('git', args, {
    cwd: opts.cwd, env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }));
  const r = runner(['push', '--dry-run', '--porcelain', remote, `HEAD:${PROBE_REF}`], { cwd, env });
  const output = `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1***');
  if (r.status === 0) return { ok: true, slug };
  const c = classifyPushFailure(output, slug);
  return {
    ok: false, slug, kind: c.kind, remedy: c.remedy,
    detail: output.trim().split('\n').filter(Boolean).slice(-4),
  };
}

/** 把探測失敗收成一則給人（與工人）看的錯誤。 */
export function pushProbeError(failures) {
  return new Error(
    `這一趟要推 ${failures.length} 個 GitHub repo 推不動（git push --dry-run 探測）：\n`
    + failures.map((f) => [
      `       - ${f.slug}（${f.kind}）`,
      ...f.detail.map((l) => `           git：${l}`),
      ...f.remedy.map((l) => `         ${l}`),
    ].join('\n')).join('\n')
    + '\n     （第一站就擋，什麼都還沒動；以前要到第 15 站才發現，bundle 已 commit 一半）');
}
