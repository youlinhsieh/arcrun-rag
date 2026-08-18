/**
 * gitea-release.mjs — 讓「內部 Gitea 在每次出貨前建立一個版本」變成真的
 *
 * ── 病史（`inkstone/arcrun-rag#88`，leo 2026-08-13）─────────────────────────────────
 * leo 原話：「內部 Gitea 和外部 Github 在每次提交 Stage, Prod 之前，一定要建立一個版本，
 * 目前 Gitea 沒有任何的『版本發佈』⋯⋯這樣從票、PR、Commit、version，每個都有歷史可查。」
 *
 * 總管實查（2026-08-13）：Gitea 六個 repo（Arcrun／arcrun-rag／mira／InkStoneCo／
 * kbdb-graph-plugin／system-dev-template）release／tag **全部是 0 個**。
 *
 * 這支模組補的是「內部」那一半——對照 `github-release.mjs`（外部／GitHub 那一半），
 * 兩支刻意寫成同樣的形狀（純函式＋可注入 fetch＋不做 D20 判斷），理由與它檔頭一致：
 * ship.mjs 是一支真的會寫入的管線，沒辦法拿它來演練「release 內容抽取得對不對」。
 *
 * ── Gitea 不受 D20 保護，但一樣不做保險判斷 ──────────────────────────────────
 * D20（`system-dev/docs/2-architecture/decisions/D20-github-contact-protocol.md`）
 * 只管 GitHub，Gitea 是「內部開發環境」（leo 2026-08-11，D73），寫入不需要 leo 開閘。
 * 但**這支仍然不做任何保險判斷**——寫入動作永遠只做寫入動作，呼叫端（ship.mjs 或任何
 * 人）要不要加閘、加什麼閘，是呼叫端的事，理由與 github-release.mjs 一致：這裡是
 * fetch 開出去的網路呼叫，Claude Code 的 Bash hook 看不到子行程內的 fetch。
 *
 * ── 令牌怎麼拿：跟現成寫法一致，不另開一條路 ──────────────────────────────────
 * `system-dev/wiki/credentials-map.md`：「Gitea 寫入 token：各 repo 的 git remote
 * 網址內嵌」——`GITEA_TOKEN` 環境變數只有 read:repository，開 release 這種寫入動作
 * 會 403。所以本模組的 token 解析預設走 `giteaWriteCredentialsFromRemote()`：讀
 * 呼叫端 repo 的 `gitea` remote URL，擷取內嵌的 `login:token`——跟 wiki 記載、
 * 跟這個 repo 現在的 clone 方式（`git remote -v` 就看得到）完全一致。
 * D36 金鑰鐵律：只讀，不落地、不印出（`redactToken` 供呼叫端安全記錄用）。
 */
import { execFileSync } from 'node:child_process';

export const GITEA_API_BASE_DEFAULT = 'https://git.uncle6.me';

/**
 * 從一個 repo 的 `gitea` remote URL 擷取寫入用的 owner/token。
 * 這是本 repo 既有的做法（`git remote -v` 就看得到 `https://Leo:<token>@git.uncle6.me/...`），
 * 不是新發明——credentials-map.md 白紙黑字寫著「Gitea 寫入 token：各 repo 的 git remote
 * 網址內嵌」。
 * @param {string} repoDir 要讀哪個本機 git 目錄的 remote（預設呼叫端目前目錄）
 * @param {string} remoteName 預設 'gitea'
 * @returns {{login: string, token: string}|null} 找不到 remote 或格式不含帳密就回 null
 */
export function giteaWriteCredentialsFromRemote(repoDir = process.cwd(), remoteName = 'gitea') {
  let url;
  try {
    url = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', remoteName], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  const m = url.match(/^https?:\/\/([^:@/]+):([^@/]+)@/);
  if (!m) return null;
  return { login: m[1], token: m[2] };
}

/** 供呼叫端安全記錄用——只印帳號與 token 長度，不印真身（D36）。 */
export function redactToken({ login, token } = {}) {
  return `${login || '(無帳號)'}:${token ? `***(${token.length} 碼)` : '(無 token)'}`;
}

/**
 * 查詢某個 tag 的 release 是不是已經存在——用來讓 createRelease 呼叫端做到冪等：
 * 同一版重跑不該報錯、也不該建出兩筆 release。
 * @returns {Promise<object|null>} release 物件，或 null（不存在）
 */
export async function releaseExists(repoSlug, tag, { token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `token ${token}`;
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`查詢 ${repoSlug} 的 release ${tag} 失敗：HTTP ${r.status}`);
  return r.json();
}

/**
 * 這顆 commit 在 Gitea 那一側**看得到嗎**（唯讀查詢）。
 *
 * 為什麼需要這支：一筆 release 的價值來自 leo 要的那條鏈——「票 → PR → commit → version
 * 每個都有歷史可查」。指到一顆**只有某台機器看得到**的 commit 的 release，那條鏈是斷的，
 * 而它看起來完全正常（頁面點得開、內文也對）⇒ 正是 D73 判準要抓的東西：
 * 「這一站碰的東西，只有某台機器看得到嗎？是 → 那不是限制，是**還沒交貨**。」
 * @returns {Promise<boolean>}
 */
export async function commitExists(repoSlug, sha, { token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `token ${token}`;
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/git/commits/${encodeURIComponent(sha)}`, { headers });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`查詢 ${repoSlug} 是否有 commit ${String(sha).slice(0, 7)} 失敗：HTTP ${r.status}`);
  return true;
}

/**
 * 建立 Gitea release（寫入動作）。不做任何保險判斷——呼叫端自己決定要不要加閘。
 * @param {object} o
 * @param {string} o.repoSlug        例 "inkstone/arcrun-rag"
 * @param {string} o.tag             例 "v1.4.44"（不存在時 Gitea 會照 target 自動建出來）
 * @param {string} o.name            release 標題
 * @param {string} o.body            release 內文（markdown）
 * @param {string} o.target          tag 要指到的 commit sha（或分支名）
 * @param {string} o.token           寫入權杖，只從呼叫端傳進來，本函式不落地不印出
 * @param {boolean} [o.draft]
 * @param {boolean} [o.prerelease]
 */
export async function createRelease({
  repoSlug, tag, name, body, target, token, draft = false, prerelease = false,
  baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error('缺寫入權杖——本函式只讀呼叫端傳進來的 token，不會自己生一個（D36：只碰名字，不碰真身）');
  }
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/releases`, {
    method: 'POST',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tag_name: tag, name, body, target_commitish: target, draft, prerelease }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`建立 Gitea release ${tag} 失敗：HTTP ${r.status} ${errText.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * 刪除 Gitea release（供演練/清理用；正式出貨管線不需要呼叫它）。
 * @param {object} o
 * @param {string} o.repoSlug
 * @param {number} o.id   releaseExists()／createRelease() 回傳物件裡的 `id`
 * @param {string} o.token
 */
export async function deleteRelease({ repoSlug, id, token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch }) {
  if (!token) throw new Error('缺寫入權杖——刪除一樣需要寫入權限');
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/releases/${id}`, {
    method: 'DELETE',
    headers: { authorization: `token ${token}` },
  });
  if (!r.ok && r.status !== 204) {
    const errText = await r.text().catch(() => '');
    throw new Error(`刪除 Gitea release ${id} 失敗：HTTP ${r.status} ${errText.slice(0, 300)}`);
  }
  return true;
}

/**
 * 把一個**真的檔案**掛到 release 上（inkstone/arcrun-rag#88，2026-08-18）。
 *
 * ── 為什麼這支是硬前置，不是加分項 ──────────────────────────────────────
 * leo 2026-08-18 看著 release 頁問：「**assets 都寫 source code，這兩個附檔實際是什麼？
 * 是 dmg 還是 go？**」
 * 實查：那兩個附檔是 **Gitea／GitHub 自動產生的整包 repo 快照**（`.zip`／`.tar.gz`），
 * 不是任何人裝得起來的東西。而 daemon 那條線斷更四版，補發佈的誘惑正是「先把頁面建出來」
 * ⇒ **沒有這支，補發佈只會多出幾個「看起來能下載、點下去給錯東西」的頁面。**
 * 那比沒有頁面更糟：它讓 `release-check` 那道閘變綠，而使用者拿到的是原始碼壓縮檔。
 *
 * ⇒ 一筆 release 要能被 leo 拿去測（規則三點七「交貨就是版本，因為這就是可測的」），
 *   它身上就得掛著**那一版真的打出來的成品**。
 *
 * Gitea 的附件端點吃 multipart/form-data，欄位名固定是 `attachment`，
 * 檔名走 query string 的 `name`（與 GitHub 那半刻意不同——那邊是 raw body + content-type，
 * 見 github-release.mjs 的同名函式。兩邊差異來自 API 本身，不是我們選的）。
 *
 * @param {object} o
 * @param {string} o.repoSlug   例 "inkstone/arcrun-rag"
 * @param {number} o.id         release id（createRelease／releaseExists 回傳物件裡的 `id`）
 * @param {string} o.name       附件檔名（使用者下載時看到的就是它）
 * @param {Uint8Array|Buffer} o.data 檔案內容
 * @param {string} o.token      寫入權杖
 * @returns {Promise<object>} Gitea 的 attachment 物件（含 `browser_download_url`）
 */
export async function uploadReleaseAsset({
  repoSlug, id, name, data, token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch,
}) {
  if (!token) throw new Error('缺寫入權杖——掛附件是寫入動作（D36：只碰名字，不碰真身）');
  if (!name) throw new Error('缺附件檔名——沒有名字的附件在頁面上是一條沒人點得下去的連結');
  const form = new FormData();
  form.append('attachment', new Blob([data]), name);
  const r = await fetchImpl(
    `${baseUrl}/api/v1/repos/${repoSlug}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { authorization: `token ${token}`, accept: 'application/json' }, body: form },
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`把 ${name} 掛上 release ${id} 失敗：HTTP ${r.status} ${errText.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * 列出一筆 release 身上**現在真的掛著什麼**（唯讀）。
 *
 * 用途是回頭查證，不是列表：`uploadReleaseAsset` 說它成功了不算數，
 * 要能重新問一次「那個檔在不在、下載得回來嗎」——同 `release-check` 站的形狀。
 * 🔴 Gitea 自動產生的原始碼快照**不會出現在這裡**（那是 release 物件上的
 * `zipball_url`／`tarball_url`，不是 attachment）⇒ 這支回空陣列就是字面意思：
 * **這筆 release 上沒有任何人掛過東西**，頁面上那兩個附檔全是自動快照。
 */
export async function listReleaseAssets(repoSlug, id, { token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `token ${token}`;
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/releases/${id}/assets`, { headers });
  if (!r.ok) throw new Error(`列出 release ${id} 的附件失敗：HTTP ${r.status}`);
  return r.json();
}

/**
 * 列出一個 repo 目前的 release 數（供驗收用：「現在是 0 個」→「建完是 N 個」）。
 */
export async function listReleases(repoSlug, { token, baseUrl = GITEA_API_BASE_DEFAULT, fetchImpl = fetch, limit = 50 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `token ${token}`;
  const r = await fetchImpl(`${baseUrl}/api/v1/repos/${repoSlug}/releases?limit=${limit}`, { headers });
  if (!r.ok) throw new Error(`列出 ${repoSlug} 的 release 失敗：HTTP ${r.status}`);
  return r.json();
}
