/**
 * release-forge.mjs — 出貨線「版本發佈紀錄」那一站住哪一家，跟 installer/forge.conf 的 TICKET_FORGE 走
 * （inkstone/InkStoneCo#234，母票 #232；總管裁定見 c22852）
 *
 * ── 為什麼 ──────────────────────────────────────────────────────────────────
 * 出貨站 release-record 以前直接呼叫 gitea-release.mjs（Gitea 形狀的 REST）。
 * 票的正本搬去 AHub 之後，這一站也要跟著換家，否則「某條線還在寫舊的家」。
 * 這支回一組與 gitea-release.mjs 同名、同參數形狀的函式：
 *   TICKET_FORGE=gitea → 原樣轉給 gitea-release.mjs（行為一字未改，翻回去就是回退）
 *   TICKET_FORGE=ahub  → 打 AHub 的 release 路由（Arcrun AHub 0.4.0，workflows/ahub/routes.json）
 * ship.mjs 只要把 import 換成這裡，其餘邏輯不用動。
 *
 * ── AHub 那一側有三件事跟 Gitea 不同，這裡各自處理（Arcrun c22851 交件時點名的三件）──
 *  1. 逾時：AHub 建 release 冷啟動會超過 fetch-retry 預設的 8 秒。對 AHub 的呼叫一律 90 秒，
 *     而且**寫入不自動重送**（重送會撞上自己第一發建的那筆而回 409）。
 *     失敗或 409 時 ⇒ 先用 tag 回頭查：已存在且內文與這次要建的一致 ＝ 上一發其實成功了，當成功；
 *     已存在但不同 ＝ 真的撞號，丟錯，不蓋、不猜。
 *  2. 附件：AHub 沒有地方存位元組，只收指標 {name,size,sha256,url,r2_key}（multipart 會 422，故意）。
 *     所以 uploadReleaseAsset 改成「先把檔案寫進 R2，再把指標登記到 AHub」：
 *       R2 key ＝ releases/<owner>/<repo>/<tag>/<檔名>（總管裁定：leo21c bucket gitea-lfs，私有）
 *     冪等：同名附件已登記且 sha256 相同 ⇒ 直接回它，不重寫；sha256 不同 ⇒ 丟錯（AHub 沒有改附件的口）。
 *  3. deleteRelease：AHub 沒有 DELETE ⇒ ahub 模式直接丟錯說明（演練換 tag 或用隔離租戶）。
 *
 * ── commit 存在檢查 ─────────────────────────────────────────────────────────
 * AHub 沒有 git；git 本身搬去 Artifacts 歸 gitea-ops#4。ahub 模式的 commitExists 問的是
 * 「這顆 commit 有沒有被 push 到我們認得的遠端」＝本機 `git branch -r --contains <sha>`（遠端追蹤分支）。
 * 這比 Gitea 版弱（沒有向伺服器確認），但 push 成功時追蹤分支會跟著更新，足以抓到「根本沒推」。
 * ⇒ remote 換成 Artifacts 後，這一格要隨 gitea-ops#4 的新 remote 再對一次。
 *
 * ── 不做的事 ────────────────────────────────────────────────────────────────
 *   · 金鑰只從環境變數名拿，不落地、不印（D36）。
 *   · 不寫 leo21c 的 AHub 資料：本模組只在被呼叫時才寫，且寫去哪由 forge.conf／環境決定。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  giteaWriteCredentialsFromRemote,
  releaseExists as gRelExists, createRelease as gCreate, commitExists as gCommit,
  uploadReleaseAsset as gUpload, listReleaseAssets as gAssets, listReleases as gList,
  deleteRelease as gDelete,
} from './gitea-release.mjs';
import { withRetry } from './fetch-retry.mjs';
import { resolveForgeSettings, releaseForgeBase, makeAhubFetch, ticketToken, loadForgeConf } from './forge-config.mjs';

/** AHub 單次呼叫 5～20 秒、冷啟動更久（Arcrun#304 c20124、c22851）。 */
export const AHUB_TIMEOUT_MS = 90000;
const R2_TIMEOUT_MS = 600000;
const API = 'http://ahub.invalid/api/v1';

/** 寫 R2 的金鑰名（值在環境）。forge.conf 可用 RELEASE_R2_TOKEN_ENV 換成別的名字（例：stage 演練用 youlin 帳號）。 */
export const R2_TOKEN_ENV_DEFAULT = 'CLOUDFLARE_API_TOKEN_LEO21C_ARTIFACTS';

/** R2 的 key。tag 與檔名各一段，不准含 `/` 或 `..`（防止寫到別人的路徑）。 */
export function r2KeyFor(repoSlug, tag, name) {
  const parts = String(repoSlug).split('/');
  if (parts.length !== 2 || parts.some((p) => !p)) throw new Error(`repoSlug 要長 owner/repo（收到：${repoSlug}）`);
  for (const [label, v] of [['tag', tag], ['附件檔名', name]]) {
    if (!v || /[/\\]/.test(v) || v === '..' || v === '.') throw new Error(`${label}不合法：${JSON.stringify(v)}（不准空、不准含斜線）`);
  }
  return `releases/${parts[0]}/${parts[1]}/${tag}/${name}`;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** 預設的 R2 寫入（Cloudflare REST；R2 S3 金鑰換算會 403，REST 實測可用，見 gitea-ops#4 c22809）。 */
export function makeR2Rest({ account, bucket, token, fetchImpl = fetch }) {
  const f = withRetry({ fetchImpl, retries: 2, timeoutMs: R2_TIMEOUT_MS });
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`;
  const enc = (key) => key.split('/').map(encodeURIComponent).join('/');
  const headers = { authorization: `Bearer ${token}` };
  return {
    async exists(key, size) {
      const r = await f(`${base}?${new URLSearchParams({ prefix: key, per_page: '5' })}`, { headers });
      if (!r.ok) throw new Error(`查 R2 ${key} 失敗：HTTP ${r.status}`);
      const js = await r.json();
      return (js.result || []).some((o) => o.key === key && Number(o.size) === size);
    },
    async put(key, data) {
      const r = await f(`${base}/${enc(key)}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: data });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`寫 R2 ${key} 失敗：HTTP ${r.status} ${t.slice(0, 200)}`);
      }
      return true;
    },
  };
}

/**
 * 本機問「這顆 commit 有沒有被 push 出去」（遠端追蹤分支含有它）。
 * @param {string} dir  要問的 git 目錄
 */
export function localRemoteContains(dir, sha, { run = execFileSync } = {}) {
  try {
    const out = run('git', ['-C', dir, 'branch', '-r', '--contains', String(sha)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).trim().length > 0;
  } catch {
    return false; // 不認得這顆 commit ＝ 沒有
  }
}

/**
 * 回「發佈紀錄用的一組函式」。
 * @param {object} [o]
 * @param {object} [o.env]
 * @param {object} [o.conf]            forge.conf 內容（測試注入）
 * @param {typeof fetch} [o.fetchImpl] 底層 fetch（測試注入；AHub 與 Gitea 兩條路都用）
 * @param {object} [o.r2]              {exists(key,size), put(key,data)}（測試注入；預設走 Cloudflare REST）
 * @param {string} [o.repoDir]         本機 git 目錄（ahub 的 commitExists 用）
 * @param {Function} [o.gitRun]        測試注入
 */
export function releaseForgeApi({ env = process.env, conf, fetchImpl = fetch, r2, repoDir = process.cwd(), gitRun } = {}) {
  const confIn = conf ?? loadForgeConf();
  const s = resolveForgeSettings({ env, conf: confIn });

  if (s.kind === 'gitea') {
    return {
      kind: 'gitea',
      label: `Gitea ${s.releaseUrl || s.ticketUrl}`,
      writeCredentials: (dir) => giteaWriteCredentialsFromRemote(dir),
      preflightProblems: () => [],
      http: (declared) => ({ base: releaseForgeBase(declared, { env, conf: confIn }), fetchImpl }),
      releaseExists: gRelExists, createRelease: gCreate, commitExists: gCommit,
      uploadReleaseAsset: gUpload, listReleaseAssets: gAssets, listReleases: gList, deleteRelease: gDelete,
    };
  }

  // ── ahub ──
  const read = withRetry({ fetchImpl: makeAhubFetch({ cypherUrl: s.cypherUrl, ns: s.ns, fetchImpl }), retries: 1, timeoutMs: AHUB_TIMEOUT_MS });
  const write = withRetry({ fetchImpl: makeAhubFetch({ cypherUrl: s.cypherUrl, ns: s.ns, fetchImpl }), retries: 0, timeoutMs: AHUB_TIMEOUT_MS });
  const r2TokenEnv = String(confIn.RELEASE_R2_TOKEN_ENV || '').trim() || R2_TOKEN_ENV_DEFAULT;
  const envOr = (k) => (env[k] != null && String(env[k]).trim() !== '' ? String(env[k]).trim() : '');
  const r2TokenEnvName = envOr('RELEASE_R2_TOKEN_ENV') || r2TokenEnv;
  const r2Client = () => {
    if (r2) return r2;
    const token = envOr(r2TokenEnvName);
    if (!token) throw new Error(`缺寫 R2 的金鑰（環境變數 ${r2TokenEnvName}）——附件本體要先寫進 R2 才能在 AHub 登記指標。不退回別處、不丟掉附件。`);
    if (!s.r2Account) throw new Error('缺 RELEASE_R2_ACCOUNT（installer/forge.conf）——不知道附件要寫進哪個帳號的 R2。');
    return makeR2Rest({ account: s.r2Account, bucket: s.r2Bucket, token, fetchImpl });
  };
  const hdr = (token) => ({ accept: 'application/json', ...(token ? { authorization: `token ${token}` } : {}) });
  const jsonHdr = (token) => ({ ...hdr(token), 'content-type': 'application/json' });
  const slugPath = (slug) => String(slug).split('/').map(encodeURIComponent).join('/');

  const api = {
    kind: 'ahub',
    label: `AHub ${s.ns}@${s.cypherUrl}（附件 R2 ${s.r2Bucket}）`,

    writeCredentials() {
      const t = ticketToken('ahub', { env });
      return t ? { login: 'ahub', token: t } : null;
    },

    /** 在動任何東西之前就能發現的缺口（preflight 用）。 */
    preflightProblems() {
      const p = [];
      if (!ticketToken('ahub', { env })) p.push('缺 AHub 寫入權杖（環境變數 AHUB_TOKEN 或 TICKET_FORGE_TOKEN）——建 release 會 401。');
      if (!r2 && !envOr(r2TokenEnvName)) p.push(`缺寫 R2 的金鑰（環境變數 ${r2TokenEnvName}）——附件本體沒地方放。`);
      if (!r2 && !s.r2Account) p.push('缺 RELEASE_R2_ACCOUNT（installer/forge.conf）。');
      return p;
    },

    /** 給「直接 fetch(`${base}/api/v1/…`)」的舊呼叫端（repoExists、release-line-gate）用：路徑照 Gitea 形狀寫，這裡轉成 AHub。 */
    http() {
      return { base: `http://ahub.invalid`, fetchImpl: read };
    },

    async releaseExists(repoSlug, tag, { token } = {}) {
      const r = await read(`${API}/repos/${slugPath(repoSlug)}/releases/tags/${encodeURIComponent(tag)}`, { headers: hdr(token) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`查詢 ${repoSlug} 的 release ${tag} 失敗：HTTP ${r.status}`);
      return r.json();
    },

    async createRelease({ repoSlug, tag, name, body, target, token, draft = false, prerelease = false }) {
      if (!token) throw new Error('缺寫入權杖——本函式只讀呼叫端傳進來的 token，不會自己生一個（D36：只碰名字，不碰真身）');
      let failure = '';
      try {
        const r = await write(`${API}/repos/${slugPath(repoSlug)}/releases`, {
          method: 'POST', headers: jsonHdr(token),
          body: JSON.stringify({ tag_name: tag, name, body, target_commitish: target, draft, prerelease }),
        });
        if (r.ok) return r.json();
        failure = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`;
      } catch (e) {
        failure = `連線失敗或逾時（${e.message}）`;
      }
      // 撞 409／逾時／連線掉：不聽 POST 的回應，回頭用 tag 查實況（Arcrun c22851：第一發其實成功、重試撞自己）
      let existing = null;
      try { existing = await api.releaseExists(repoSlug, tag, { token }); } catch { /* 查不到就照原錯誤 */ }
      if (existing) {
        const same = String(existing.body ?? '') === String(body ?? '') && String(existing.name ?? '') === String(name || tag);
        if (same) return existing;
        throw new Error(`建立 AHub release ${tag} 失敗（${failure}），而且 ${repoSlug} 上已有同名 tag、內容與這次要建的不同——不蓋、不猜，請人確認。`);
      }
      throw new Error(`建立 AHub release ${tag} 失敗：${failure}`);
    },

    async deleteRelease() {
      throw new Error('AHub 沒有刪除 release 的口（代轉層沒有刪 record，Arcrun c22851 回饋 ③）。演練請換 tag，或用隔離租戶。');
    },

    async commitExists(repoSlug, sha, { repoDir: dir } = {}) {
      return localRemoteContains(dir || repoDir, sha, gitRun ? { run: gitRun } : undefined);
    },

    async listReleases(repoSlug, { token, limit = 50 } = {}) {
      const r = await read(`${API}/repos/${slugPath(repoSlug)}/releases?limit=${limit}`, { headers: hdr(token) });
      if (!r.ok) throw new Error(`列出 ${repoSlug} 的 release 失敗：HTTP ${r.status}`);
      return r.json();
    },

    async listReleaseAssets(repoSlug, id, { token } = {}) {
      const r = await read(`${API}/repos/${slugPath(repoSlug)}/releases/${id}/assets`, { headers: hdr(token) });
      if (!r.ok) throw new Error(`列出 release ${id} 的附件失敗：HTTP ${r.status}`);
      return r.json();
    },

    /**
     * 先寫 R2、再登記指標。冪等：同名且 sha256 相同 ⇒ 回既有；同名但不同 ⇒ 丟錯。
     * @param {object} o  {repoSlug, id, name, data, token, tag?}  tag 沒給就用 id 查
     */
    async uploadReleaseAsset({ repoSlug, id, name, data, token, tag }) {
      if (!token) throw new Error('缺寫入權杖——掛附件是寫入動作（D36：只碰名字，不碰真身）');
      if (!name) throw new Error('缺附件檔名——沒有名字的附件在頁面上是一條沒人點得下去的連結');
      let relTag = tag;
      if (!relTag) {
        const rr = await read(`${API}/repos/${slugPath(repoSlug)}/releases/${id}`, { headers: hdr(token) });
        if (!rr.ok) throw new Error(`讀 release ${id} 失敗（要它的 tag 才算得出 R2 key）：HTTP ${rr.status}`);
        relTag = (await rr.json()).tag_name;
      }
      const key = r2KeyFor(repoSlug, relTag, name);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const sha = sha256Hex(buf);

      const registered = (await api.listReleaseAssets(repoSlug, id, { token })).find((a) => a.name === name);
      if (registered) {
        if (registered.sha256 === sha) return registered;
        throw new Error(`release ${id} 上已有附件 ${name}，但 sha256 與這次要掛的不同（AHub 沒有改附件的口）——請換檔名或換版本，不蓋。`);
      }

      const store = r2Client();
      if (!(await store.exists(key, buf.length))) await store.put(key, buf);

      const pointer = { name, size: buf.length, sha256: sha, url: `r2://${s.r2Bucket}/${key}`, r2_key: key };
      const r = await write(`${API}/repos/${slugPath(repoSlug)}/releases/${id}/assets`, {
        method: 'POST', headers: jsonHdr(token), body: JSON.stringify(pointer),
      });
      if (r.ok) return r.json();
      // 撞 409／逾時：回頭看登記簿，同 sha 就是上一發成功了
      const again = (await api.listReleaseAssets(repoSlug, id, { token }).catch(() => [])).find((a) => a.name === name);
      if (again && again.sha256 === sha) return again;
      throw new Error(`在 AHub 登記附件 ${name}（release ${id}）失敗：HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}（檔案已在 R2：${key}）`);
    },
  };
  return api;
}
