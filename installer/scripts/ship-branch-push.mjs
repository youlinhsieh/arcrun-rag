/**
 * ship-branch-push.mjs — 出貨線「把出貨分支交到 git 家」那一步的目的地與認證（inkstone/arcrun-rag#304）
 *
 * 為什麼有這支：release-record 站原本寫死 `git push gitea HEAD:refs/heads/<分支>`。
 * Gitea 2026-10-24 退役（inkstone/InkStoneCo#234），git 住 Cloudflare Artifacts；
 * 新容器 clone 下來只有 `origin`（已經就是 Artifacts），沒有人手補的 `gitea` remote ⇒ 這一站就斷在那裡，
 * 後面的 release-check／stage-record 跟著沒跑（1.4.146，arcrun-rag#301）。
 *
 * 規則（不猜、不退回舊家）：
 *   ① 目的地 remote 名：環境變數 SHIP_PUSH_REMOTE ＞ `origin` ＞ `gitea`（舊容器手補的那個，相容用）
 *   ② 只准推 Artifacts 網址；指到退役的舊 Gitea 主機一律丟錯（紅線：不准寫入舊家）
 *   ③ 認證走既有的 credential helper（artifactsGitAuth），token 不進網址、不印
 *   ④ 推 LFS 物件指標缺的情況照 cutover 手冊設 `lfs.allowincompletepush=true`，只對這一次推送生效，不改 clone 設定
 */
import { isArtifactsRemote, artifactsGitAuth } from './line-source-repo.mjs';

const RETIRED_HOST = /(^|[/@.])git\.uncle6\.me([/:]|$)/i;

/**
 * @param {(name:string)=>string|null} remoteUrlOf  讀某個 remote 的網址（不存在回 null）
 * @param {object} [env]
 * @returns {{remote:string, url:string}}
 */
export function resolveShipPushRemote(remoteUrlOf, env = process.env) {
  const asked = String(env.SHIP_PUSH_REMOTE || '').trim();
  const candidates = asked ? [asked] : ['origin', 'gitea'];
  const seen = [];
  for (const name of candidates) {
    const url = remoteUrlOf(name);
    if (!url) { seen.push(`${name}（不存在）`); continue; }
    if (RETIRED_HOST.test(url)) {
      throw new Error(
        `remote \`${name}\` 指向已退役的舊 Gitea 主機——不准寫入（inkstone/InkStoneCo#234）。\n` +
        `     改指到 Artifacts：git remote set-url ${name} https://<帳號>.artifacts.cloudflare.net/git/InkStoneCo/arcrun-rag.git`);
    }
    if (!isArtifactsRemote(url)) { seen.push(`${name}（不是 Artifacts 網址）`); continue; }
    return { remote: name, url };
  }
  throw new Error(
    `找不到可以交出貨分支的 Artifacts remote：${seen.join('、')}。\n` +
    `     新容器 clone 下來的 origin 就是 Artifacts；若你把 origin 改去別處，用環境變數 SHIP_PUSH_REMOTE 指名。`);
}

/**
 * 組出 `git push` 的完整 argv 與環境（純函式，方便測；實際 spawn 在 ship.mjs）。
 * @returns {{remote:string, args:string[], env:object}}
 */
export function buildShipPush({ branch, remote, url, srcRoot, env = process.env, runner }) {
  const auth = artifactsGitAuth(url, { srcRoot, env, ...(runner ? { runner } : {}) });
  return {
    remote,
    args: [...auth.prefix, '-c', 'lfs.allowincompletepush=true', 'push', remote, `HEAD:refs/heads/${branch}`],
    env: { ...env, ...auth.env },
  };
}
