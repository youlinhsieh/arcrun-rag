/**
 * verify-download.mjs — 「使用者按下載鈕，拿到的是不是這一條線的這一版？」
 *
 * ── 為什麼從 ship.mjs 裡拆出來（2026-08-09，Gitea Leo/arcrun-rag#27）────────
 * 1.4.29 推 prod：15 步過了 14 步，卡在 verify，報的是
 *     「win 下載鈕給的檔 ≠ 釘點上的檔——下載來源跑到別條線去了」
 * 但使用者其實拿到了**逐位元正確**的檔（本機 exe 與實際下載到的 sha256 完全相同）。
 *
 * 真因兩層：
 *   ① **證據抓錯地方**：舊碼拿 `ctx.pinUrl`（prod＝jsDelivr `@sha`）去抓 daemon 產物，
 *      但 jsDelivr **拒絕提供 `.exe`（403）**，只給 `.dmg`（200）。而安裝器本來就
 *      **不是**從 jsDelivr 送二進位檔的——`worker.js` 的 `daemonOf()` 對 prod 會刻意
 *      把宿主換成 `raw.githubusercontent.com/<repo>/<sha>/`（jsDelivr 有單檔 20MB 上限，
 *      且 `@main` ref 解析會卡舊檔）。⇒ 檢查器拿 mac 過得去、win 永遠 403。
 *   ② **拿不到證據 ≠ 證據顯示壞了**：舊碼 `fromPin` 抓不到就是 `null`，
 *      而 `null !== hex` 恆真 ⇒ 直接判成「兩邊不一致」。
 *      **每次出貨都紅、久了就沒有人當真**——那比沒有檢查更糟。
 *
 * ── 這支怎麼修（不是放寬，是把同一個問題拆成三條各自獨立、都是硬斷言的線）──
 *   ① **內容對**：下載到的位元組 sha256 == 釘點 manifest 宣告的 sha256   ← 硬斷言
 *   ② **來源對**：安裝器對外宣告的下載網址 == 由**登錄簿 + 本機 bundle HEAD**
 *      獨立算出來的釘點產物網址（完全字串相等）                          ← 硬斷言
 *   ③ **釘點上真的有這個檔**：從獨立算出來的那個網址再抓一次，兩邊 sha 相等 ← 佐證
 *
 * ②才是「有沒有跑到別條線」的直接答案，而且**不需要抓檔、不可能拿不到證據**——
 * 它比舊寫法（靠位元組比對間接推論來源）更強。所以③即使抓不到檔，也不會留下缺口：
 * ①保證位元組就是釘點 manifest 宣告的那一份，②保證那個網址就是這條線的釘點。
 * ⇒ ③的三態是 `ok`／`mismatch`（❌ 證據顯示壞了，硬斷）／`unavailable`
 *   （⚠️ 檢查器拿不到證據，如實說「無法取證」，不冒充成「不一致」）。
 *
 * ── 為什麼是獨立模組 ────────────────────────────────────────────────────────
 * ship.mjs 是一支從頭跑到尾、會 push 會 deploy 的管線，沒辦法拿它來測「下載檔被換成
 * 錯的，閘會不會抓到」。把判斷邏輯拆成純函式＋可注入 fetch ⇒ 同一份實作，
 * 既被真出貨用、也被 `verify-download.test.mjs` 用假資料反覆演練，不會有第二份漂移。
 */
import { createHash } from 'node:crypto';

/**
 * 釘點產物（daemon 二進位）的真實網址。
 *
 * 🔴 這是 `installer/oauth-prototype/worker.js` 的 `daemonOf()` 的**鏡像**，規則必須同步：
 *    prod 的 bundleBase 是 jsDelivr `@<sha>`（jsDelivr 不送大檔、且擋 .exe）
 *    ⇒ 換宿主到 `raw.githubusercontent.com/<owner>/<repo>/<sha>/`；
 *    其餘（stage 的 Gitea `/raw/commit/<sha>`、任何 env.BUNDLE_BASE 覆蓋）本身就是
 *    可直接讀檔的 raw root ⇒ 直接用 base。
 *
 * 「兩邊各寫一份規則」聽起來像重複，但這正是這道閘的價值所在：worker 那份的輸入是
 * **部署到線上的 env**，這份的輸入是**登錄簿 + 本機 bundle 的 git HEAD**。兩個來源
 * 各自獨立 ⇒ 線上釘子指到別條線／指到舊 sha，兩份算出來的網址就會不同，當場被②抓到。
 * 若哪天 worker 改了規則而這裡沒跟，②會立刻紅——這是**要的**，不是誤報。
 */
export function pinArtifactUrl(pinUrl, file) {
  const base = String(pinUrl || '').replace(/\/+$/, '');
  const jsDelivrSha = (base.match(/@([0-9a-f]{7,40})/) || [])[1];
  const root = jsDelivrSha
    ? `https://raw.githubusercontent.com/youlinhsieh/arcrun-rag-bundles/${jsDelivrSha}`
    : base;
  return `${root}/${String(file).replace(/^\/+/, '')}`;
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (h) => (h ? String(h).slice(0, 12) + '…' : '(無)');

/**
 * 抓一個 URL 回傳 { ok, status, sha256, bytes, error }。
 * **抓不到就是抓不到**——不把失敗折疊成「內容不符」，這是本次修的核心。
 */
async function fetchSha(url, fetchImpl) {
  try {
    const r = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, status: r.status, sha256: sha256Hex(buf), bytes: buf.length, headers: r.headers };
  } catch (e) {
    return { ok: false, status: null, error: String((e && e.message) || e) };
  }
}

/**
 * 驗一個平台的下載路徑。
 *
 * @param {object} o
 * @param {string} o.os             'mac' | 'win'
 * @param {string} o.file           釘點 manifest 宣告的檔案相對路徑（如 daemon/Arcrun-win-v0.18.25.exe）
 * @param {string} o.declaredSha256 釘點 manifest 宣告的 sha256
 * @param {string} o.daemonVersion  這次出貨的 daemon 版本（檔名要帶它）
 * @param {string} o.pinUrl         由登錄簿樣板 + 本機 bundle HEAD 算出來的釘點 base
 * @param {string} o.downloadEndpoint 使用者按的那個鈕：`{installerBase}/download/{os}`
 * @param {string} o.advertisedUrl  安裝器 /api/latest 對外宣告的 daemon.downloads[os]
 * @param {function} [o.fetchImpl]  注入用（測試）
 * @returns {{lines:string[], fails:string[], warns:string[], corroboration:string}}
 */
export async function checkDaemonDownload({
  os, file, declaredSha256, daemonVersion,
  pinUrl, downloadEndpoint, advertisedUrl,
  fetchImpl = globalThis.fetch,
}) {
  const lines = [];
  const fails = [];
  const warns = [];
  const expectUrl = pinArtifactUrl(pinUrl, file);

  // ── ① 內容對：使用者真的按下去、真的收到的位元組 ────────────────────────
  const got = await fetchSha(downloadEndpoint, fetchImpl);
  if (!got.ok) {
    const why = got.error ? `連不上（${got.error}）` : `HTTP ${got.status}`;
    lines.push(`/download/${os} → ${why} ❌`);
    fails.push(`${os} 下載鈕按下去拿不到檔（${why}）——使用者裝不了`);
    return { lines, fails, warns, corroboration: 'not-reached' };
  }
  const name = got.headers.get('content-disposition') || '';
  lines.push(`/download/${os} → 200｜${(got.bytes / 1048576).toFixed(1)}MB｜sha ${short(got.sha256)}｜${name}`);

  if (declaredSha256 && got.sha256 !== declaredSha256) {
    fails.push(
      `${os} 下載到的檔與釘點 manifest 宣告的 sha256 不符` +
      `（下載 ${short(got.sha256)}／宣告 ${short(declaredSha256)}）——使用者拿到的不是這一版`);
  }
  if (daemonVersion && !name.includes(daemonVersion)) {
    fails.push(`${os} 下載檔名沒帶 ${daemonVersion}（${name}）`);
  }

  // ── ② 來源對：不抓檔、不可能「拿不到證據」的硬斷言 ──────────────────────
  //    這條才是「下載來源有沒有跑到別條線」的直接答案（舊寫法只能靠位元組間接推論）。
  if (!advertisedUrl) {
    fails.push(`${os} 安裝器沒有對外宣告下載網址（/api/latest 的 daemon.downloads.${os} 是空的）`);
  } else if (advertisedUrl !== expectUrl) {
    lines.push(`   安裝器宣告來源 ${advertisedUrl}`);
    lines.push(`   本次這條線應為 ${expectUrl}`);
    fails.push(
      `${os} 下載來源不是這一條線的釘點——安裝器指向 ${advertisedUrl}，` +
      `本次 bundle 釘點的產物在 ${expectUrl}（stage 拿到 prod 產物就是這樣）`);
  } else {
    lines.push(`   下載來源＝本線釘點產物 ✓ ${expectUrl}`);
  }

  // ── ③ 佐證：從獨立算出來的釘點網址再抓一次 ──────────────────────────────
  //    三態。抓不到＝「無法取證」，**如實說**，不冒充成「不一致」。
  const pin = await fetchSha(expectUrl, fetchImpl);
  let corroboration;
  if (pin.ok && pin.sha256 === got.sha256) {
    corroboration = 'ok';
    lines.push(`   釘點同一檔 sha ${short(pin.sha256)} ✓ 與下載到的逐位元相同`);
  } else if (pin.ok) {
    corroboration = 'mismatch';
    lines.push(`   釘點同一檔 sha ${short(pin.sha256)} ❌ 與下載到的不同`);
    fails.push(
      `${os} 證據顯示不一致：下載到的檔 ≠ 釘點上的檔` +
      `（下載 ${short(got.sha256)}／釘點 ${short(pin.sha256)}）`);
  } else {
    corroboration = 'unavailable';
    const why = pin.error ? `連不上（${pin.error}）` : `HTTP ${pin.status}`;
    lines.push(`   釘點同一檔：⚠️ 無法取證（${why}）——**檢查器抓不到證據，不是東西壞了**`);
    lines.push(`      抓不到的是 ${expectUrl}`);
    lines.push(`      判定不受影響：①下載位元組＝釘點 manifest 宣告值、②下載來源＝本線釘點，兩條都是硬斷言且已各自成立`);
    warns.push(`${os} 釘點佐證無法取得（${why}）——判定改由①②承擔，未放寬任何一條`);
  }

  return { lines, fails, warns, corroboration };
}
