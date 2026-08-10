#!/usr/bin/env node
/**
 * kb-restore.mjs —— 把本地備份還原回一台實例的知識庫（Leo/Arcrun#83 的另一半）
 *
 * ⚠️ 這支工具在 KBDB「API-as-Wall／零 SQL」鐵律的**已核可例外車道**上：
 *   **資料層災難復原／搬遷**（總管 2026-06-15 對 14-E 的裁定，KBDB 卡片
 *   「14E-blocks灌入leo21c」寫得很清楚）：
 *     · 日常單筆讀寫 → 走 KBDB API（本工具一句都不碰）
 *     · 大批應用層匯入 → 框架缺口（cypher 批次端點，未實裝）
 *     · **整包還原／跨帳號搬遷 → 使用者拿自己的 CF 權限走資料層**（本工具）
 *   為什麼不能走 API：要還原的往往正是「API 那一層還沒起來／已經接錯」的時候；
 *   而且 45.8 萬筆逐筆打 API 會燒光 Workers 每日請求配額（14-E 實錄，寫到 10.9 萬筆全 429）。
 *   ⇒ 本檔內所有直接對 D1 的語句都標 `kbdb-sql-ok` 留痕，且**只有兩種**：
 *     ① 點名筆數（唯讀，對帳用）② 把備份原樣灌回去。**不新增任何資料表。**
 *
 * 🔴 備份沒有還原過就不算備份。Arcrun#83 的驗收條件：
 *   「取回來的東西**能還原**——還原到一個空實例後查詢答得出同樣內容
 *     （不是『檔案存在』就算）」
 *   ⇒ 每次還原完都自己對帳：拿備份當時記下的逐表筆數去點名還原後的庫。
 *     對不上就 exit 1，不會回報「成功」。
 *
 * 🔴 兩種目標庫，做法不一樣（實測撞出來的，不是設計出來的）：
 *   ① **空庫** → 整包灌（含結構）。2026-08-09 stage 實測 5295 句一次過。
 *   ② **安裝器已經建好結構的庫** → 整包灌會死在「資料表已存在」。
 *      ⇒ 這種目標只灌資料，且改寫成 `INSERT OR REPLACE`
 *        （安裝器的 migration 會先種一列 template，不改寫就撞主鍵）。
 *   工具自己判斷目標是哪一種，不必使用者記。
 *
 * 🔴 走 Cloudflare D1 REST import API，不依賴 wrangler 版本
 *   ——KBDB 卡片「kbdb-d1大量灌入踩雷」踩坑 1：wrangler@4 已移除 `d1 import` 子指令。
 *   拆句子用的是**認得字串字面值的掃描器**，不是 split('\n')／split(';')
 *   ——同卡踩坑 2：多行 statement 被行邊界切斷，症狀是「部分插入、隨機 constraint 錯」。
 *
 * 用法：
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kb-restore.mjs --from <備份目錄>
 *   選項：
 *     --worker <name>   還原到哪顆 worker 正在讀的庫（預設 arcrun-kbdb）
 *     --db <uuid>       直接指定目標 D1
 *     --merge           目標庫**已經有資料**時才需要；沒給就拒絕動它（防蓋掉別人的東西）
 *     --dry-run         只做檢查與前置對帳，不寫入
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;

const has = (n) => process.argv.includes(`--${n}`);
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function die(msg, detail) {
  console.error(`\n❌ ${msg}`);
  if (detail) console.error(`   ${detail}`);
  process.exit(1);
}

async function cf(pathname, init = {}) {
  const res = await fetch(CF_API + pathname, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok || !body || body.success === false) {
    const e = new Error(`HTTP ${res.status} ${pathname} :: ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return body.result;
}

/** 認得字串字面值的語句拆解器（踩坑 2 的解：行邊界會切斷含換行的值）。 */
function splitStatements(text) {
  const out = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (text[i + 1] === "'") { buf += text[++i]; } else { inStr = false; }
      }
      continue;
    }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 問 worker 它現在**實際綁**的是哪一顆 D1（治 14-E「同名不同 id 灌錯庫」）。 */
async function discoverBoundD1(workerName) {
  let settings;
  try {
    settings = await cf(`/accounts/${ACCOUNT}/workers/scripts/${workerName}/settings`);
  } catch (e) {
    if (e.status === 404) {
      die(`這個帳號底下沒有名叫「${workerName}」的服務`,
          '→ 用 --worker 指定正確名字，或用 --db 直接給資料庫 id。');
    }
    die(`問不到服務「${workerName}」綁的是哪顆資料庫（金鑰權限或帳號不對）`,
        `${e.message}\n   → 檢查 CF_API_TOKEN 有沒有 Workers 讀取權限、CF_ACCOUNT_ID 是不是這台實例所在的帳號。`);
  }
  const d1s = (settings.bindings || []).filter((b) => b.type === 'd1' && b.id);
  if (!d1s.length) die(`服務「${workerName}」身上沒有資料庫繫結`);
  return (d1s.find((b) => b.name === 'DB') || d1s[0]).id;
}

/** 目標庫要先確認「真的在、而且我碰得到」——這一步不過就不准往下走。 */
async function requireDatabase(dbId) {
  try {
    return await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}`);
  } catch (e) {
    if (e.status === 404) {
      die(`要還原的目標資料庫不存在：${dbId}`,
          '這顆 id 在你這個 Cloudflare 帳號底下找不到。\n'
        + '   → 常見原因：抄錯 id、或那顆庫在**另一個** Cloudflare 帳號（CF_ACCOUNT_ID 指錯）。\n'
        + '   本工具在這裡停手，沒有寫入任何東西。');
    }
    die(`碰不到目標資料庫 ${dbId}（權限或連線問題）`,
        `${e.message}\n   → 這把金鑰可能沒有這個帳號的 D1 權限。本工具在這裡停手，沒有寫入任何東西。`);
  }
}

const LIST_TABLES = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name"; // kbdb-sql-ok：唯讀點名，對帳用

async function tableCounts(dbId) {
  const t = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: LIST_TABLES }),
  });
  const names = (t[0]?.results || []).map((r) => r.name);
  const counts = {};
  for (const n of names) {
    const r = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM "${n}"` }), // kbdb-sql-ok：唯讀點名，對帳用
    });
    counts[n] = r[0]?.results?.[0]?.n ?? null;
  }
  return counts;
}

async function importSql(dbId, buf) {
  const etag = createHash('md5').update(buf).digest('hex');
  const api = `/accounts/${ACCOUNT}/d1/database/${dbId}/import`;
  const init = await cf(api, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'init', etag }),
  });
  const put = await fetch(init.upload_url, { method: 'PUT', body: buf });
  if (!put.ok) die(`上傳還原檔失敗 HTTP ${put.status}`);
  let cur = await cf(api, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ingest', etag, filename: init.filename }),
  });
  const bm = cur.at_bookmark;
  for (let i = 0; i < 400 && cur.status !== 'complete'; i++) {
    if (cur.status === 'error') die('Cloudflare 匯入回報失敗', JSON.stringify(cur.messages || cur).slice(0, 600));
    await new Promise((r) => setTimeout(r, 3000));
    cur = await cf(api, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'poll', current_bookmark: bm }),
    });
  }
  return cur;
}

async function main() {
  if (!TOKEN) die('缺 CF_API_TOKEN');
  if (!ACCOUNT) die('缺 CF_ACCOUNT_ID');
  const from = arg('from');
  if (!from) die('缺 --from <備份目錄>');

  // ① 收貨檢查：沒有 manifest ＝ 那是半截備份，不收
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(from, 'manifest.json'), 'utf8'));
  } catch {
    die('這個目錄裡沒有 manifest.json，不能當備份用',
        'kb-backup.mjs 只在整份備份確認完整後才寫出 manifest——沒有它就代表那次備份沒跑完。');
  }
  const data = await readFile(path.join(from, 'data.sql'));
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== manifest.sha256) {
    die('備份檔與 manifest 對不上，已中止（檔案被截斷或改過）',
        `manifest 記的是 ${manifest.sha256}\n   實際算出來是 ${sha256}\n`
      + '   → 這正是「檔案在、內容是半截」那種失敗；本工具不會替你把它灌進去。');
  }
  console.log(`📦 備份：${manifest.database_name}（${manifest.exported_at}）`);
  console.log(`   完整性 ✅ sha256 相符／${(manifest.bytes / 1048576).toFixed(2)} MiB`);
  for (const [t, n] of Object.entries(manifest.table_counts || {})) console.log(`   基準 ${t}: ${n}`);

  // ② 目標庫
  const workerName = arg('worker', 'arcrun-kbdb');
  const dbId = arg('db') || (await discoverBoundD1(workerName));
  const meta = await requireDatabase(dbId);
  console.log(`\n🎯 還原目標：${meta.name}（${dbId}）`);
  if (!arg('db')) console.log(`   （＝服務「${workerName}」自己回報它正在讀的那一顆）`);
  if (dbId === manifest.database_id) console.log('   ⚠️  目標與來源是同一顆庫（等於原地重灌）。');

  const before = await tableCounts(dbId);
  const beforeRows = Object.values(before).reduce((a, b) => a + (b || 0), 0);
  const emptyTarget = Object.keys(before).length === 0;
  console.log(`   目前狀態：${emptyTarget ? '空庫（還沒有任何資料表）' : Object.entries(before).map(([t, n]) => `${t}=${n}`).join('、')}`);

  // ③ 決定灌什麼
  let payload;
  if (emptyTarget) {
    payload = data;
    console.log('   做法：整包灌（含結構）');
  } else {
    const stmts = splitStatements(data.toString('utf8'));
    const inserts = stmts.filter((s) => /^INSERT\s+INTO/i.test(s))
      .map((s) => s.replace(/^INSERT\s+INTO/i, 'INSERT OR REPLACE INTO'));
    if (!inserts.length) die('備份檔裡找不到任何一筆資料，不知道要還原什麼');
    payload = Buffer.from(inserts.join(';\n') + ';\n', 'utf8');
    console.log(`   做法：只灌資料 ${inserts.length} 句（目標已有結構；同 id 覆寫）`);
  }

  // ④ 目標已經有資料 ⇒ 這是會蓋東西的動作，要使用者明講
  const seedOnly = beforeRows <= (before.templates || 0); // 剛裝好的實例只有 seed template
  if (!emptyTarget && beforeRows > 0 && !seedOnly && !has('merge')) {
    die('目標庫裡已經有資料，我不會直接蓋過去',
        `目前 ${Object.entries(before).map(([t, n]) => `${t}=${n}`).join('、')}\n`
      + '   → 確定要把備份合併進去，請加 --merge 再跑一次（同 id 的會被備份版本覆寫）。');
  }

  if (has('dry-run')) {
    console.log('\n🧪 --dry-run：檢查全過，這裡停手（沒有寫入任何東西）。');
    return;
  }

  console.log('\n⬆️  灌入中…');
  const res = await importSql(dbId, payload);
  console.log(`   Cloudflare 回報：${res.status}／${(res.messages || []).slice(-2).join(' | ')}`);

  // ⑤ 對帳——這一步才是「還原成功」的定義
  console.log('\n🔢 對帳（拿備份當時的筆數點名還原後的庫）');
  const after = await tableCounts(dbId);
  let bad = 0;
  for (const [t, want] of Object.entries(manifest.table_counts || {})) {
    const got = after[t];
    const ok = got !== undefined && got !== null && got >= want;
    if (!ok) bad++;
    console.log(`   ${ok ? '✅' : '❌'} ${t}: 備份 ${want} → 現在 ${got ?? '（無此表）'}`);
  }
  if (bad) die(`${bad} 個資料表對不上，還原**沒有**成功`, '原始備份檔沒有被動過，可以直接重跑。');

  console.log('\n✅ 還原完成且逐表對得上。');
  console.log('   下一步：從產品那一面實際查一筆你知道答案的東西——筆數對不代表查得到。');
}

main().catch((e) => die('還原中止', e.stack || String(e)));
