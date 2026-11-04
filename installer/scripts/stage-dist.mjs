/**
 * stage-dist.mjs — stage 的桌面安裝檔與「最新版」指標，改放 R2，不再進 git 歷史、不在 Gitea 網址上
 *
 * ── 為什麼有這支（inkstone/arcrun-rag#266，母票 inkstone/InkStoneCo#232）──────────
 * 舊做法：dmg／exe／msix 被當 git 檔存進 bundle repo（`arcrun-rag-bundles-staging`），
 * 下載與「最新版」指標都是 `git.uncle6.me/.../raw/...`。後果兩個：
 *   ① 本機 `.git` 已 1.5 GB，推 84 MB 經 Cloudflare 代理撞 100 秒上限連四次 524（#265）；
 *   ② Gitea 要搬家（#232）——安裝檔與指標還住在 Gitea，搬家＝stage 下載斷掉。
 *
 * 新做法（只在登錄簿宣告了 `dist` 的目標生效；prod 沒宣告，行為一字不變）：
 *   · 安裝檔照舊由 daemon-sync 搬進 bundle **工作區**（讓 daemon-check／release-record 等
 *     讀磁碟的站不必改），但 `.git/info/exclude` 把它們擋掉 ⇒ 永遠不進 commit、不進 push。
 *   · push 站在推完 git 之後，把這一版的安裝檔與 manifest.json 放進 R2：
 *       `daemon/<檔名>`   安裝檔（檔名帶版本號 ⇒ 內容不變 ⇒ 可長快取）
 *       `manifest.json`   「最新版」指標（會移動，同一份 bytes 也在 git 裡，那份是回退保險）
 *     順序固定：**安裝檔先、指標後**——指標一翻，它指到的東西必已就位。
 *   · 安裝器 worker（youlin-stage）綁 R2、自己服務 `/dist/*`，並從 R2 讀指標算下載網址
 *     ⇒ 不新增網域、不碰 DNS（見 worker.js distHandle／daemonOf）。
 *
 * ── 零件包本體也離開 Gitea（#266 的另一半，2026-11-02）────────────────────────
 * 登錄簿 `dist.bundlePrefix` 有宣告時，這一版 bundle repo 裡**版控內**的檔案（除 daemon/ 與 *.bak*）
 * 也放進 R2：`<prefix>/<sha7>/<相對路徑>`。一個 sha 目錄寫好就不再變 ⇒ 可長快取，
 * 安裝器的釘點（BUNDLE_BASE）就是 `<publicBase>/<prefix>/<sha7>`，由 worker 的 /dist 路由服務。
 * 順序：零件包 → 安裝檔 → 最新版指標（最後才翻）。
 *
 * 這支只放「純計算＋可注入的外部呼叫」，好讓 stage-dist.test.mjs 用假 wrangler／假檔案演練，
 * 與 ship.mjs 真跑的是同一份實作（同 verify-download.mjs 的做法）。
 *
 * D36：金鑰不經過這支——呼叫端把 `env`（已由 cf-credential 取得）原樣交給 `run`。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

/** manifest.daemon 底下哪幾個鍵是安裝檔（與 ship.mjs daemon-sync 的 wanted 一致）。 */
export const DAEMON_ASSET_KEYS = ['mac', 'win', 'msix'];

/** 被排除出 git 的安裝檔樣式（相對 bundle repo 根）。只擋「新增」——已追蹤的舊檔不受影響。 */
export const DAEMON_EXCLUDE_PATTERNS = ['daemon/*.dmg', 'daemon/*.exe', 'daemon/*.msix', 'daemon/*.zip'];

const CONTENT_TYPES = {
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msix': 'application/vnd.ms-appx',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
};
export function contentTypeOf(name) {
  const m = String(name).toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && CONTENT_TYPES[m[0]]) || 'application/octet-stream';
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 登錄簿 `dist` 的必填欄位；缺就丟，不猜。 */
export function assertDistDeclared(dist) {
  const lack = ['bucket', 'accountId', 'publicBase'].filter((k) => !dist || !dist[k]);
  if (lack.length) {
    throw new Error(`登錄簿 dist 缺欄位：${lack.join('、')}（installer/ship.targets.json → targets.<目標>.dist）`);
  }
  if (/git\.uncle6\.me/i.test(String(dist.publicBase))) {
    throw new Error(`dist.publicBase 指到 git.uncle6.me（${dist.publicBase}）——這張票就是要離開那裡（inkstone/arcrun-rag#266）。`);
  }
}

/** 零件包在 R2 的目錄（相對 key）：`<prefix>/<sha7>`。 */
export function bundleDir(dist, sha7) {
  const prefix = String((dist && dist.bundlePrefix) || '').replace(/^\/+|\/+$/g, '');
  if (!prefix) throw new Error('登錄簿 dist 沒有宣告 bundlePrefix，沒辦法決定零件包放哪。');
  if (!/^[0-9a-f]{7,40}$/.test(String(sha7))) throw new Error(`零件包釘點 sha 不合法：${sha7}`);
  return `${prefix}/${sha7}`;
}

/** 零件包目錄的公開網址（＝安裝器的釘點 BUNDLE_BASE）。 */
export function bundleDirUrl(dist, sha7) {
  return `${String(dist.publicBase).replace(/\/+$/, '')}/${bundleDir(dist, sha7)}`;
}

/** R2 物件 key → 使用者拿得到的網址。 */
export function distUrl(publicBase, key) {
  return `${String(publicBase).replace(/\/+$/, '')}/${String(key).replace(/^\/+/, '')}`;
}

/**
 * 這一版要放進 R2 的安裝檔清單（由 manifest.daemon 遍歷，不寫死平台）。
 * 每一個都**重算磁碟實檔的 sha256 對 manifest 宣告**——不一致就丟：
 * 放上去的必須是 manifest 說的那份，否則 verify 站會在使用者面前才發現。
 */
export function planDaemonObjects(manifest, bundlesDir) {
  const d = (manifest && manifest.daemon) || {};
  const out = [];
  for (const k of DAEMON_ASSET_KEYS) {
    const meta = d[k];
    if (!meta || !meta.file) continue;
    const rel = String(meta.file).replace(/^\/+/, '');
    if (rel.includes('..') || !rel.startsWith('daemon/')) {
      throw new Error(`manifest.daemon.${k}.file 不是 daemon/ 底下的相對路徑：${meta.file}`);
    }
    const abs = join(bundlesDir, rel);
    if (!existsSync(abs)) {
      throw new Error(`manifest.daemon.${k}.file 指向 ${rel}，但 ${bundlesDir} 裡沒有這個檔——daemon-sync 沒搬到位，不上傳半套。`);
    }
    const actual = sha256File(abs);
    if (meta.sha256 && actual !== meta.sha256) {
      throw new Error(`${rel} 的磁碟 sha256（${actual.slice(0, 12)}…）≠ manifest 宣告（${String(meta.sha256).slice(0, 12)}…），不上傳。`);
    }
    out.push({ platform: k, key: rel, path: abs, sha256: actual, contentType: contentTypeOf(basename(rel)) });
  }
  if (!out.length) {
    throw new Error('manifest.daemon 沒有任何安裝檔（mac／win／msix）可放進 R2——登錄簿宣告了 dist，卻沒有東西要發佈。');
  }
  return out;
}

/** bundle repo 裡**不**上 R2 零件包目錄的檔案：安裝檔（另有 daemon/ 的路）與備份殘檔。 */
export function isBundleObject(rel) {
  return !/^daemon\//.test(rel) && !/\.bak(-|$)/.test(basename(rel)) && !rel.includes('..') && !rel.startsWith('/');
}

function gitTrackedFiles(bundlesDir) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: bundlesDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
}

/**
 * 這一版要放進 R2 零件包目錄的檔案清單：bundle repo 的**版控內容**（＝這個 sha 的 tree）扣掉 daemon/ 與備份殘檔。
 * 只認版控內的檔：工作區裡未追蹤的東西（上一輪中止的殘檔）不會被當成這個 sha 的內容。
 */
export function planBundleObjects({ dist, sha7, bundlesDir, listFiles = gitTrackedFiles }) {
  const dir = bundleDir(dist, sha7);
  const rels = listFiles(bundlesDir).filter(isBundleObject);
  if (!rels.includes('manifest.json')) throw new Error(`版控內沒有 manifest.json，不上傳零件包（${bundlesDir}）。`);
  return rels.map((rel) => {
    const abs = join(bundlesDir, rel);
    if (!existsSync(abs)) throw new Error(`版控內的 ${rel} 在 ${bundlesDir} 工作區裡不見了，不上傳半套零件包。`);
    return { rel, key: `${dir}/${rel}`, path: abs, contentType: contentTypeOf(rel) };
  });
}

/**
 * 把安裝檔樣式寫進 bundle repo 的 `.git/info/exclude`（本機、不進 commit、冪等）。
 * 回傳這次新加的樣式（空陣列＝早就在了）。
 */
export function ensureLocalExclude(bundlesDir, patterns = DAEMON_EXCLUDE_PATTERNS) {
  const dir = join(bundlesDir, '.git', 'info');
  if (!existsSync(join(bundlesDir, '.git'))) {
    throw new Error(`${bundlesDir} 不是 git 工作區（找不到 .git），沒辦法排除安裝檔。`);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'exclude');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const add = patterns.filter((p) => !have.has(p));
  if (add.length) {
    const head = cur && !cur.endsWith('\n') ? '\n' : '';
    const note = have.has('# arcrun-rag#266: stage 安裝檔放 R2，不進 git') ? '' : '# arcrun-rag#266: stage 安裝檔放 R2，不進 git\n';
    writeFileSync(file, cur + head + note + add.join('\n') + '\n');
  }
  return add;
}

/**
 * 版本發佈頁的「下載」段：附件本體不再掛在 Gitea（它們在 R2），內文改列下載網址。
 * @param {object} dist  登錄簿 dist
 * @param {{name:string, rel:string}[]} assets  這條線的成品（rel＝daemon/<檔名>）
 */
export function downloadSection(dist, assets) {
  assertDistDeclared(dist);
  const lines = assets.map((a) => `- ${a.name}：${distUrl(dist.publicBase, a.rel)}`);
  return `\n\n## 下載\n\n安裝檔放在 stage 的 R2，不掛在這個頁面上：\n\n${lines.join('\n')}\n`;
}

/** `wrangler r2 object put` 的參數（cwd 任意；--remote 才是真的 R2，不是本機模擬）。 */
export function r2PutArgs({ bucket, key, file, contentType, cacheControl }) {
  const a = ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--remote'];
  if (contentType) a.push('--content-type', contentType);
  if (cacheControl) a.push('--cache-control', cacheControl);
  return a;
}

/**
 * 把這一版放進 R2：零件包 → 安裝檔 → manifest.json（指標）最後。
 *
 * @param {object} o
 * @param {object} o.dist       登錄簿的 dist（bucket／accountId／publicBase）
 * @param {object} o.manifest   要送出去的 manifest（與 bundle 工作區的 manifest.json 同一份）
 * @param {string} o.bundlesDir
 * @param {{sha7:string}} [o.bundle]  這一版零件包的釘點（dist.bundlePrefix 有宣告時必給）
 * @param {(dir:string)=>string[]} [o.listFiles]  測試注入：版控內檔案清單
 * @param {(args:string[], opts:{label:string})=>void} o.run  執行 `npx <args>`（呼叫端已帶好 env／cwd）
 * @returns {{objects: object[], bundleBase: string|null, pointerUrl: string, detail: string[]}}
 */
export function publishDist({ dist, manifest, bundlesDir, run, bundle, listFiles }) {
  assertDistDeclared(dist);
  const detail = [];
  let bundleBase = null;
  // ① 零件包（宣告了 bundlePrefix 才做）：整個 sha 目錄先到位，才輪得到下面的指標去翻
  if (dist.bundlePrefix) {
    if (!bundle || !bundle.sha7) throw new Error('登錄簿宣告了 dist.bundlePrefix，但呼叫端沒給這一版的釘點 sha7。');
    const bobjs = planBundleObjects({ dist, sha7: bundle.sha7, bundlesDir, listFiles });
    for (const o of bobjs) {
      run(r2PutArgs({ bucket: dist.bucket, key: o.key, file: o.path, contentType: o.contentType,
        cacheControl: 'public, max-age=31536000, immutable' }), { label: o.key });
    }
    bundleBase = bundleDirUrl(dist, bundle.sha7);
    detail.push(`R2 ← 零件包 ${bobjs.length} 個檔 → ${bundleDir(dist, bundle.sha7)}/（釘點 ${bundleBase}）`);
  }
  // ② 安裝檔
  const objects = planDaemonObjects(manifest, bundlesDir);
  for (const o of objects) {
    run(r2PutArgs({ bucket: dist.bucket, key: o.key, file: o.path, contentType: o.contentType,
      cacheControl: 'public, max-age=31536000, immutable' }), { label: o.key });
    detail.push(`R2 ← ${o.key}（${o.platform}，sha ${o.sha256.slice(0, 12)}…）`);
  }
  // ③ 最新版指標，最後才翻
  const manifestPath = join(bundlesDir, 'manifest.json');
  run(r2PutArgs({ bucket: dist.bucket, key: 'manifest.json', file: manifestPath,
    contentType: contentTypeOf('manifest.json'), cacheControl: 'no-cache' }), { label: 'manifest.json' });
  detail.push('R2 ← manifest.json（最新版指標，最後才翻）');
  return { objects, bundleBase, pointerUrl: distUrl(dist.publicBase, 'manifest.json'), detail };
}
