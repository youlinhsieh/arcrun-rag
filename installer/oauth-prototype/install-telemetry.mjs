/**
 * 安裝遙測（inkstone/arcrun-rag#342）：每次安裝／更新（成功與失敗）寫一筆「匿名」紀錄，
 * 讓 leo 的後台（arcrun-license-admin 的 /installs 分頁，之後另派）數得出雲端版有幾台、
 * 各跑哪一版、誰最近還在更新、哪一步最常失敗。
 *
 * 紅線（票上寫死，測試鎖住）：
 *  1. 匿名：只存不可逆雜湊 install_id；不存 email、accountId、subdomain、token、錯誤原文。
 *  2. 零金鑰：同帳號用 D1 binding（INSTALLS_DB）；沒有任何要 leo 或用戶設的金鑰。
 *  3. 不拖慢、不弄壞安裝：recordInstallEvent 永不丟例外，並有逾時上限；沒綁 D1 就靜默略過。
 *
 * 表（與 license-admin 同一顆 D1 共存，所以不用編號 migration、表名自帶 install 前綴）：
 *   install_events  每次安裝／更新一列（append-only；event_id 唯一 ⇒ 重送、回補都冪等）
 *   installs        每台一列（只含「已知身分」的台；first_seen／last_ok／version）
 * 建表用 CREATE TABLE IF NOT EXISTS，在第一次寫入時自動做，不依賴 wrangler migrations。
 */

/** 雜湊前綴：領域分隔，避免這個雜湊被拿去跟別處的 sha256(accountId) 對撞比對。 */
const ID_DOMAIN = 'arcrun-install-id:v1:';

/** 單次寫入的牆鐘上限（毫秒）。超過就放棄，安裝照樣完成。 */
export const TELEMETRY_TIMEOUT_MS = 2000;

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS install_events (
     event_id    TEXT PRIMARY KEY,
     install_id  TEXT NOT NULL DEFAULT '',
     kind        TEXT NOT NULL,
     outcome     TEXT NOT NULL,
     version     TEXT,
     failed_step TEXT,
     at          INTEGER NOT NULL,
     duration_ms INTEGER,
     channel     TEXT,
     source      TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_install_events_at ON install_events(at)`,
  `CREATE INDEX IF NOT EXISTS idx_install_events_install ON install_events(install_id)`,
  `CREATE TABLE IF NOT EXISTS installs (
     install_id    TEXT PRIMARY KEY,
     first_seen_at INTEGER NOT NULL,
     last_event_at INTEGER NOT NULL,
     last_ok_at    INTEGER,
     version       TEXT,
     channel       TEXT
   )`,
];

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** accountId → 不可逆的 32 hex 識別。accountId 本身是 128 bit 隨機值，加領域前綴後無法反推也無法猜。 */
export async function installIdOf(accountId) {
  if (!accountId) return '';
  return (await sha256Hex(ID_DOMAIN + String(accountId))).slice(0, 32);
}

/** 失敗步驟只留步驟代號（短、固定詞彙），不收任何自由文字。 */
function cleanStep(step) {
  if (!step) return null;
  const s = String(step).toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 40);
  return s || null;
}

function cleanVersion(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 40);
  return /^[A-Za-z0-9._+\-]+$/.test(s) ? s : null;
}

/**
 * 把一次安裝進度整理成匿名事件。純函式（除了雜湊）——不碰 env，方便離線測。
 * @param {string} sid   安裝 session id（只用來導出 event_id，不外流）
 * @param {object} progress  runInstall 的 progress 物件
 * @param {{channel?: string}} [opts]
 */
export async function buildEvent(sid, progress, opts = {}) {
  const r = (progress && progress.result) || {};
  const failed = progress && progress.state !== 'done';
  const finishedAt = progress && progress.finishedAt;
  const at = Number(finishedAt) || Date.now();
  const kind = r.mode === 'update' ? 'update' : r.mode === 'install' ? 'install' : 'unknown';
  return {
    event_id: (await sha256Hex('event:' + String(sid))).slice(0, 32),
    install_id: await installIdOf(r.accountId),
    kind,
    outcome: failed ? 'fail' : 'ok',
    version: cleanVersion(r.release),
    failed_step: failed ? cleanStep(progress.error && progress.error.step) : null,
    at,
    duration_ms: progress && progress.startedAt && finishedAt ? Math.max(0, finishedAt - progress.startedAt) : null,
    channel: opts.channel ? String(opts.channel).slice(0, 20) : null,
    source: 'live',
  };
}

let schemaReady = null; // 每個 isolate 只建一次
export function _resetSchemaCacheForTest() { schemaReady = null; }

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA_SQL.map((s) => db.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/** 組出把一個事件寫進兩張表的 statements（冪等：重跑不會重複計數）。 */
export function statementsFor(db, ev) {
  const stmts = [
    db.prepare(
      `INSERT OR IGNORE INTO install_events
         (event_id, install_id, kind, outcome, version, failed_step, at, duration_ms, channel, source)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
    ).bind(ev.event_id, ev.install_id, ev.kind, ev.outcome, ev.version, ev.failed_step, ev.at, ev.duration_ms, ev.channel, ev.source),
  ];
  if (ev.install_id) {
    // 全部是 MIN／MAX／條件覆寫 ⇒ 同一事件重放、事件亂序到達，結果都一樣。
    stmts.push(
      db.prepare(
        `INSERT INTO installs (install_id, first_seen_at, last_event_at, last_ok_at, version, channel)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5)
         ON CONFLICT(install_id) DO UPDATE SET
           first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
           last_event_at = MAX(last_event_at, excluded.last_event_at),
           version = CASE WHEN excluded.last_ok_at IS NOT NULL
                           AND (last_ok_at IS NULL OR excluded.last_ok_at >= last_ok_at)
                          THEN COALESCE(excluded.version, version) ELSE version END,
           last_ok_at = CASE WHEN excluded.last_ok_at IS NULL THEN last_ok_at
                             WHEN last_ok_at IS NULL THEN excluded.last_ok_at
                             ELSE MAX(last_ok_at, excluded.last_ok_at) END,
           channel = COALESCE(channel, excluded.channel)`
      ).bind(ev.install_id, ev.at, ev.outcome === 'ok' ? ev.at : null, ev.version, ev.channel)
    );
  }
  return stmts;
}

/**
 * 記一筆安裝事件。**永不丟例外、永不超過 TELEMETRY_TIMEOUT_MS**。
 * @returns {Promise<'recorded'|'skipped'|'failed'>}
 */
export async function recordInstallEvent(env, sid, progress) {
  try {
    const db = env && env.INSTALLS_DB;
    if (!db) return 'skipped';
    const ev = await buildEvent(sid, progress, { channel: env.DEPLOY_ENV || 'prod' });
    const work = (async () => {
      await ensureSchema(db);
      await db.batch(statementsFor(db, ev));
      return 'recorded';
    })();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('failed'), TELEMETRY_TIMEOUT_MS); });
    try { return await Promise.race([work.catch(() => 'failed'), timeout]); }
    finally { clearTimeout(timer); }
  } catch (_) {
    return 'failed';
  }
}

/**
 * 回補：把安裝器自己的 DO 裡既有紀錄匿名化後補進來，讓數字從第一天就不是 0。
 *  - `deployed:<acc>:<sub>`（365 天）＝「這台裝過」。沒有時間戳 ⇒ at＝回補當下，source='backfill-deployed'
 *    （後台算「本週新增」時要排除它，只算 source='live' 與 'backfill-log'）。
 *  - `log:<ts>-<sid6>`（90 天）＝有真實時間、成敗、失敗步驟、bundleBase。source='backfill-log'。
 * 冪等：event_id 由來源 key 導出，重跑不會重複。
 *
 * @param {{kv: {list: Function, get: Function}, db: any, releaseOf: (bundleBase: string) => Promise<string|null>, channel?: string, now?: number}} deps
 * @returns {Promise<{deployed: number, logs: number}>}
 */
export async function backfillFromKv(deps) {
  const { kv, db, releaseOf, channel = null } = deps;
  const now = deps.now || Date.now();
  await ensureSchema(db);
  const relCache = new Map();
  const releaseFor = async (base) => {
    if (!base) return null;
    if (!relCache.has(base)) relCache.set(base, await Promise.resolve(releaseOf(base)).catch(() => null));
    return relCache.get(base);
  };
  const counts = { deployed: 0, logs: 0 };
  const flush = async (evs) => {
    for (let i = 0; i < evs.length; i += 40) {
      const stmts = evs.slice(i, i + 40).flatMap((e) => statementsFor(db, e));
      await db.batch(stmts);
    }
  };

  // 1) deployed:<acc>:<sub>
  const dep = await kv.list({ prefix: 'deployed:' });
  const depEvents = [];
  const seenIds = new Set();
  for (const k of dep.keys || []) {
    const acc = String(k.name).split(':')[1];
    const id = await installIdOf(acc);
    if (!id || seenIds.has(id)) continue; // 同帳號多個 subdomain 記錄只算一台
    seenIds.add(id);
    const rec = await kv.get(k.name, 'json').catch(() => null);
    depEvents.push({
      event_id: (await sha256Hex('backfill-deployed:' + id)).slice(0, 32),
      install_id: id, kind: 'install', outcome: 'ok',
      version: cleanVersion(await releaseFor(rec && rec.bundleBase)),
      failed_step: null, at: now, duration_ms: null, channel, source: 'backfill-deployed',
    });
  }
  await flush(depEvents);
  counts.deployed = depEvents.length;

  // 2) log:<ts>-<sid6>
  const logs = await kv.list({ prefix: 'log:' });
  const logEvents = [];
  for (const k of logs.keys || []) {
    const rec = await kv.get(k.name, 'json').catch(() => null);
    if (!rec || !rec.at) continue;
    const failed = rec.state !== 'done';
    logEvents.push({
      event_id: (await sha256Hex('backfill-log:' + k.name)).slice(0, 32),
      install_id: await installIdOf(rec.accountId),
      kind: 'unknown',
      outcome: failed ? 'fail' : 'ok',
      version: cleanVersion(await releaseFor(rec.bundleBase)),
      failed_step: failed ? cleanStep(rec.failedStep) : null,
      at: Number(rec.at), duration_ms: rec.durationMs == null ? null : Number(rec.durationMs),
      channel, source: 'backfill-log',
    });
  }
  await flush(logEvents);
  counts.logs = logEvents.length;
  return counts;
}
