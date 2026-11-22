/**
 * user-path-update.mjs — 出貨線的「走使用者那條路更新」一站（inkstone/arcrun-rag#163 驗收 2）
 *
 * leo 2026-08-29：「用 acr update 來安裝跟用戶不同，也就是你每次的安裝都不能實現用戶的痛苦」。
 * 這一站**只走使用者真的會走的兩段**，不是旁路：
 *   ① 安裝頁：拿已授權帳號的 Email 去 /auth/start——使用者看到的必須是「你已經裝好了」，
 *      **不是被送去 Cloudflare 授權頁**（那就是「每次更新都要重新授權」的老毛病）。
 *   ② Portal：以管理員身分登入實例的 Portal，按「立即更新」所打的那一支（POST /portal/admin/update）。
 *      它由實例的後端轉給安裝器、用安裝器手上的長期授權做事——使用者按按鈕時走的就是這一條。
 *   ③ 讀回實例 /health：版號要等於這次出貨的版號（不聽「更新完成」那句話）。
 *
 * 🔴 不是「AI 專用旁路」：沒有測試模式、沒有隱藏參數、沒有免授權端點。登入用的是 stage 管理員帳密
 *    （出貨環境已有的 STAGE_USERNAME／STAGE_PASSWORD，D36：只讀名字、不印值），按的是同一顆按鈕背後的同一支 API。
 * 🔴 第一次授權仍然是人做的：這一站只對「已經授權過的帳號」有意義；沒授權過會在步驟①當場紅燈並說清楚。
 * 🔴 它回報「用的是背景準備好的版本（只切換）」還是「沒有準備版、直接部署」，以及從按下到換好的毫秒數——
 *    使用者按下去要等多久，是這一版有沒有變好的證據。
 *
 * 純函式＋fetch/sleep 注入，可離線演練（見 user-path-update.test.mjs）。
 */
import { sameCommit } from './instance-update.mjs';

const ALREADY_INSTALLED = '你已經裝好了';

function need(cfg, key) {
  if (!cfg || !cfg[key]) throw new Error(`登錄簿 userPathUpdate 缺 ${key}`);
  return cfg[key];
}

/** ① 安裝頁：已授權帳號不該再被送去 Cloudflare 授權頁。 */
export async function checkInstallPage({ cfg, fetchImpl }) {
  const origin = need(cfg, 'installerOrigin');
  const email = need(cfg, 'emailEnv') && process.env[cfg.emailEnv] || cfg.email;
  if (!email) throw new Error(`沒有帳號 Email（環境變數 ${cfg.emailEnv} 或登錄簿 email）`);
  const url = `${origin}/auth/start?email=${encodeURIComponent(email)}&code=&agree=1`;
  const res = await fetchImpl(url, { redirect: 'manual' });
  const loc = res.headers && res.headers.get && res.headers.get('location');
  if (res.status >= 300 && res.status < 400) {
    const toCf = /dash\.cloudflare\.com/.test(String(loc || ''));
    throw new Error(
      `安裝頁把已授權的帳號送去${toCf ? ' Cloudflare 授權頁' : '別處'}（HTTP ${res.status}）——使用者每次更新都要重新授權，就是這個毛病。\n`
      + `     可能原因：這個帳號還沒在這台安裝器授權過（第一次授權要人做一次），或授權已被撤銷／過期。`);
  }
  const body = await res.text();
  if (res.status !== 200 || !body.includes(ALREADY_INSTALLED)) {
    throw new Error(`安裝頁沒有顯示「${ALREADY_INSTALLED}」（HTTP ${res.status}）`);
  }
  return { detail: [`安裝頁：已授權帳號看到「${ALREADY_INSTALLED}」，沒有被送去 Cloudflare`] };
}

/** 授權類原因：使用者的授權沒了／沒裝過——這種「實例已是新版」也不能放行。 */
const AUTH_CLASS_REASONS = ['no_grant', 'missing', 'revoked', 'no_snapshot', 'unauthorized'];

/** 把更新鈕回的診斷欄位串成一行（只含短碼，沒有憑證）。 */
export function describeRefusal(uj) {
  const parts = [];
  if (uj && uj.reason) parts.push(`reason=${uj.reason}`);
  if (uj && uj.installer_state) parts.push(`安裝器狀態=${uj.installer_state}`);
  if (uj && uj.failed_step) parts.push(`卡在步驟=${uj.failed_step}`);
  return parts.join('、');
}

/** ② 登入 Portal、按「立即更新」背後那一支。 */
export async function pressUpdate({ cfg, fetchImpl, now = () => Date.now(), sleepMs = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = need(cfg, 'cypherUrl');
  const user = process.env[need(cfg, 'usernameEnv')];
  const pass = process.env[need(cfg, 'passwordEnv')];
  if (!user || !pass) throw new Error(`環境變數 ${cfg.usernameEnv}／${cfg.passwordEnv} 沒有值（只寫名字，值由環境給）`);
  const lr = await fetchImpl(`${base}/portal/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user, password: pass }),
  });
  const lj = await lr.json().catch(() => ({}));
  if (!lr.ok || !lj.session_token) throw new Error(`Portal 登入失敗（HTTP ${lr.status}）：${lj.error || '沒有 session_token'}`);
  const t0 = now();
  // 更新是分批的：回 busy（含「這一批做完、還有下一批」）就隔過冷卻期再按，直到 updated／up_to_date。
  // 每一次都照實記下來，報告上寫「按了幾次」，不把多按幾次說成一次。
  let ur; let uj; let presses = 0;
  for (;;) {
    presses++;
    ur = await fetchImpl(`${base}/portal/admin/update`, { method: 'POST', headers: { authorization: `Bearer ${lj.session_token}` } });
    uj = await ur.json().catch(() => ({}));
    if (!(ur.ok && uj && uj.ok && uj.state === 'busy') || presses >= (cfg.maxPresses || 8)) break;
    await sleepMs(cfg.pressGapMs || 65000);
  }
  const ms = now() - t0;
  if (uj && uj.fallback_to_installer) throw new Error('實例回「需先用安裝頁更新」——這台還沒有更新權（舊實例要用新安裝器重新授權一次）');
  if (!ur.ok || !uj.ok) {
    // #163：把引擎帶出來的 reason／installer_state／failed_step 一併印出——不再只有一句「沒辦法幫你更新」。
    const why = describeRefusal(uj);
    const err = new Error(`立即更新沒成功（HTTP ${ur.status}）：${uj.message || uj.reason || JSON.stringify(uj).slice(0, 200)}${why ? `｜${why}` : ''}`);
    // 只有「安裝器有回話、而且不是授權類失敗」才允許站去核對實例實際版本；其餘（連不上、被收回授權）照舊紅燈。
    err.pressReply = uj;
    err.softRefusal = ur.ok && !AUTH_CLASS_REASONS.includes(String(uj.reason || ''));
    throw err;
  }
  if (uj.state === 'busy') throw new Error(`按了 ${presses} 次「立即更新」還在分批更新中（state=busy）：${uj.message || ''}`);
  const switched = Number(uj.switched || 0);
  return { ms, presses, state: uj.state, switched, deployed: Number(uj.deployed || 0),
    detail: [`Portal「立即更新」：${ms} ms｜${switched > 0 ? `用背景準備好的版本，只切換了 ${switched} 個服務` : '沒有準備好的版本，走直接部署'}｜按了 ${presses} 次｜state=${uj.state}`] };
}

/** ③ 讀回實例 /health，版號要對上。有界重試（只在本站內，不是背景輪詢）。 */
export async function readBack({ cfg, expect, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 6, gapMs = 5000 }) {
  const url = `${need(cfg, 'cypherUrl')}/health`;
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
      const j = await r.json().catch(() => ({}));
      last = { version: j.bundle_version || '', commit: j.bundle_commit || '' };
      const okVer = !expect.version || last.version === expect.version;
      const okCommit = !expect.commit || !last.commit || sameCommit(last.commit, expect.commit);
      if (okVer && okCommit) return { detail: [`讀回 /health：${last.version}／${String(last.commit).slice(0, 7)}（第 ${i}/${tries} 次讀到）`] };
    } catch (e) { last = { error: String(e && e.message || e) }; }
    if (i < tries) await sleep(gapMs);
  }
  throw new Error(`按了「立即更新」之後，實例 /health 還不是這一版：期望 ${expect.version}／${expect.commit}，讀到 ${JSON.stringify(last)}`);
}

/**
 * 讀每顆 worker 的 Secret「名字」（絕不讀值：CF 這支 API 本來就只回名字）。
 * 回 { <worker>: string[] | null }；null＝這顆 worker 在帳號上不存在（HTTP 404）。
 * 其他錯誤（401／5xx／連不上）直接丟：讀不到名單＝不能確認金鑰還在，站要紅燈（#163 c1795271425526904）。
 */
export async function listWorkerSecretNames({ accountId, token, workers, fetchImpl = fetch }) {
  if (!accountId || !token) throw new Error('讀 Secret 名單缺 accountId 或鑰匙（只寫名字，值由環境給）');
  const out = {};
  for (const w of workers) {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(w)}/secrets`,
      { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 404) { out[w] = null; continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(`讀 ${w} 的 Secret 名單失敗（HTTP ${r.status}）——讀不到名單就不能確認金鑰還在`);
    out[w] = (j.result || []).map((x) => x.name).sort();
  }
  return out;
}

/** 切換前後名單比對：前有後無＝金鑰被洗掉（紅燈）；後多出來的只列出、不算錯。 */
export function compareSecretSnapshots(before, after) {
  const lost = []; const added = []; const lines = [];
  for (const w of Object.keys(before)) {
    const b = before[w]; const a = after[w];
    if (b === null || b === undefined) { lines.push(`${w}：切換前不存在，略過`); continue; }
    if (!Array.isArray(a)) { lost.push(`${w}：切換前有 ${b.length} 把，切換後讀不到這顆 worker`); continue; }
    const miss = b.filter((n) => !a.includes(n)); const plus = a.filter((n) => !b.includes(n));
    miss.forEach((n) => lost.push(`${w}：${n}`)); plus.forEach((n) => added.push(`${w}：${n}`));
    if (b.length || a.length) lines.push(`${w}：前 ${b.length} 把／後 ${a.length} 把｜${a.join('、') || '（無）'}`);
  }
  return { ok: lost.length === 0, lost, added, lines };
}

/** 整站。secretSnapshot（可選）＝ async () => ({worker: names|null})；有給就在按之前與讀回之後各取一次並比對。 */
export async function userPathUpdateStation({ cfg, expect, fetchImpl = fetch, now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), secretSnapshot }) {
  const page = await checkInstallPage({ cfg, fetchImpl });
  // 背景準備是安裝器的 cron（每 2 分鐘）做的——跟使用者的環境同一支，不另開觸發口（#163 c25）。
  // 實例還沒到這一版（＝有東西可準備）才等；等一個有界時間讓 cron 備好，再按。已是這一版就不等。
  const wait = Number(cfg.prepareWaitMs || 0);
  const waitDetail = [];
  if (wait > 0) {
    let cur = '';
    try { const r = await fetchImpl(`${need(cfg, 'cypherUrl')}/health`, { headers: { 'cache-control': 'no-cache' } }); cur = ((await r.json().catch(() => ({}))) || {}).bundle_version || ''; } catch (_) { /* 讀不到就照等 */ }
    if (!expect.version || cur !== expect.version) {
      await sleep(wait);
      waitDetail.push(`按之前等了 ${Math.round(wait / 1000)} 秒讓安裝器 cron 備好新版（實例當時 ${cur || '讀不到'}，目標 ${expect.version || '?'}）`);
    }
  }
  const before = secretSnapshot ? await secretSnapshot() : null;
  let press;
  let softNote = null;
  try {
    press = await pressUpdate({ cfg, fetchImpl, now });
  } catch (e) {
    // 「立即更新」回沒完成，但實例其實可能已經換到這一版（#163 c47：youlin 已是 1.4.274 卻回 refused）。
    // 不是加 skip：照樣讀回 /health 核對版號與 commit，對得上才綠，並把原因印進結果；對不上就帶著原因紅燈。
    if (!e || !e.softRefusal) throw e;
    const why = describeRefusal(e.pressReply) || '安裝器沒有給原因';
    try {
      const back = await readBack({ cfg, expect, fetchImpl, sleep });
      softNote = `⚠️ 「立即更新」回沒完成（${why}），但實例讀回已是目標版——這一站依實際版本放行；原因照樣要查`;
      press = { ms: 0, switched: 0, detail: [softNote], softBack: back };
    } catch (e2) {
      throw new Error(`${e.message}\n     而且實例讀回也還不是這一版：${e2.message}`);
    }
  }
  const back = press.softBack || await readBack({ cfg, expect, fetchImpl, sleep });
  let secretDetail = [];
  if (secretSnapshot) {
    const after = await secretSnapshot();
    const cmp = compareSecretSnapshots(before, after);
    secretDetail = ['切換前後各 worker 的 Secret 名單比對（只列名字，不列值）：', ...cmp.lines.map((l) => `  ${l}`),
      ...(cmp.added.length ? [`  切換後多出：${cmp.added.join('、')}`] : [])];
    if (!cmp.ok) throw new Error(`切換後 Secret 少了 ${cmp.lost.length} 把（使用者的帳號／金鑰被洗掉）：\n       ${cmp.lost.join('\n       ')}`);
  }
  return { status: 'done', detail: [...page.detail, ...waitDetail, ...press.detail, '對照：直接部署（沒備好時）同票實測 22.5～24.8 秒', ...back.detail, ...secretDetail], ms: press.ms, switched: press.switched };
}
