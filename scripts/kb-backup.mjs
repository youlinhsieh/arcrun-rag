#!/usr/bin/env node
/**
 * kb-backup.mjs —— 把整個知識庫取回本地（Leo/Arcrun#83）
 *
 * 🔴 為什麼是一支「能力」而不是一次性搬遷腳本（leo 2026-08-09）：
 *   「整個 D1 可以本地備份這件事應該做，**別人也會有這個問題**，
 *     所有數據都在上面，我一定要定期備份的。」
 *   ⇒ 一次性腳本＝先湊合，之後還要再做一次正版。這支從第一天就是正版：
 *     非互動、吃環境變數、可被排程呼叫、失敗有非零退出碼。
 *
 * 🔴 內建「14-E 同名不同 id」那個坑的解法（KBDB 卡片 14E-blocks灌入leo21c）：
 *   當年 45.8 萬筆灌錯庫的根因是——`wrangler` 照**名字**找到的 `arcrun-kbdb`，
 *   與 kbdb worker **實際綁著**的那顆 D1 是同名不同 id 的兩顆。
 *   ⇒ 本工具**預設不靠名字找庫**：直接去問那顆 worker 自己綁的是誰
 *     （`GET /workers/scripts/<name>/settings` 的 bindings，2026-08-09 對 youlin 實測驗過）。
 *     要備份的一定是「服務正在讀的那一顆」，不是「名字看起來對的那一顆」。
 *
 * 🔴 「中途失敗要看得出來」（Arcrun#83 驗收條件）：
 *   備份完成前會做三件事，任何一件不過就 exit 1、且**不寫出 manifest**
 *   （沒有 manifest 的目錄＝半截備份，還原端會拒收）：
 *     ① 下載檔的 sha256 與大小記進 manifest
 *     ② 從**線上**逐表點名筆數，記進 manifest 當還原後的對帳基準
 *     ③ 檔案裡的 INSERT 句數要 ≥ 線上總筆數（少了代表 dump 被截斷）
 *
 * 用法（全部走環境變數，好排程）：
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/kb-backup.mjs --out ./backups
 *   選項：
 *     --worker <name>   去哪顆 worker 問它綁的 D1（預設 arcrun-kbdb）
 *     --db <uuid>       直接指定 D1（跳過探測；知道自己在做什麼時才用）
 *     --out <dir>       備份根目錄（預設 ./backups）
 *
 * 產出：<out>/<ISO 時間戳>/{data.sql, manifest.json}
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;

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

/** 問 worker 它現在**實際綁**的是哪一顆 D1（治 14-E 同名不同 id）。 */
async function discoverBoundD1(workerName) {
  let settings;
  try {
    settings = await cf(`/accounts/${ACCOUNT}/workers/scripts/${workerName}/settings`);
  } catch (e) {
    if (e.status === 404) {
      die(`這個帳號底下沒有名叫「${workerName}」的服務，無法確認要備份哪一顆庫`,
          '→ 用 --worker 指定正確名字，或用 --db 直接給資料庫 id。');
    }
    die(`問不到服務「${workerName}」綁的是哪顆資料庫（金鑰權限或帳號不對）`,
        `${e.message}\n   → 檢查 CF_API_TOKEN 有沒有 Workers 讀取權限、CF_ACCOUNT_ID 是不是這台實例所在的帳號。`);
  }
  const d1s = (settings.bindings || []).filter((b) => b.type === 'd1' && b.id);
  if (d1s.length === 0) {
    die(`服務「${workerName}」身上沒有任何資料庫繫結`, '它可能還沒部署完，或這顆不是知識庫服務。');
  }
  // DB 是知識庫本體；沒有 DB 就退回第一個（例如只綁 CREDENTIALS_DB 的舊佈局）
  const hit = d1s.find((b) => b.name === 'DB') || d1s[0];
  const others = d1s.filter((b) => b.id !== hit.id);
  if (others.length) {
    console.warn(`⚠️  這顆 worker 綁了不只一顆資料庫，本次只備份 ${hit.name}=${hit.id}；`
      + ` 另有 ${others.map((o) => `${o.name}=${o.id}`).join('、')} 未備份。`);
  }
  return hit.id;
}

async function tableCounts(dbId) {
  const tables = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name" }),
  });
  const names = (tables[0]?.results || []).map((r) => r.name);
  const counts = {};
  for (const t of names) {
    const r = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM "${t}"` }),
    });
    counts[t] = r[0]?.results?.[0]?.n ?? null;
  }
  return counts;
}

async function exportDump(dbId) {
  const start = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ output_format: 'polling', dump_options: { no_schema: false } }),
  });
  let cur = start;
  for (let i = 0; i < 200 && cur.status !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    cur = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output_format: 'polling', current_bookmark: start.at_bookmark }),
    });
    if (cur.status === 'error') die('Cloudflare 匯出失敗', JSON.stringify(cur.messages || cur).slice(0, 400));
  }
  if (cur.status !== 'complete') die('匯出等太久還沒好', '請稍後重跑；已完成的部分不會留下半截檔（本工具只在全部拿到後才寫檔）。');
  const url = cur.result?.signed_url;
  if (!url) die('匯出完成但沒有下載連結', JSON.stringify(cur).slice(0, 300));
  const res = await fetch(url);
  if (!res.ok) die(`下載匯出檔失敗 HTTP ${res.status}`);
  return { sql: Buffer.from(await res.arrayBuffer()), bookmark: cur.at_bookmark || start.at_bookmark };
}

async function main() {
  if (!TOKEN) die('缺 CF_API_TOKEN', '這支工具只讀你自己的 Cloudflare 帳號；金鑰只從環境變數取，不寫進任何檔案。');
  if (!ACCOUNT) die('缺 CF_ACCOUNT_ID');

  const workerName = arg('worker', 'arcrun-kbdb');
  const dbId = arg('db') || (await discoverBoundD1(workerName));
  const outRoot = arg('out', './backups');

  const meta = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}`);
  console.log(`📚 要備份的知識庫：${meta.name}（${dbId}）`);
  if (!arg('db')) console.log(`   （來源＝服務「${workerName}」自己回報它正在讀這一顆——不是照名字猜的）`);

  console.log('🔢 先點名線上有多少東西（當作還原後的對帳基準）…');
  const counts = await tableCounts(dbId);
  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  for (const [t, n] of Object.entries(counts)) console.log(`   ${t}: ${n}`);

  console.log('⬇️  匯出中（整包走資料層，不經 API 逐筆——14-E 燒光 Workers 配額的教訓）…');
  const { sql, bookmark } = await exportDump(dbId);

  const inserts = (sql.toString('utf8').match(/^INSERT INTO/gm) || []).length;
  if (inserts < total) {
    die('匯出檔看起來是半截的，已中止（沒有寫出 manifest）',
        `線上共 ${total} 筆，檔案裡只有 ${inserts} 句 INSERT。請重跑一次；不要拿這份檔去還原。`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, stamp);
  await mkdir(dir, { recursive: true });
  const sqlPath = path.join(dir, 'data.sql');
  await writeFile(sqlPath, sql);
  const sha256 = createHash('sha256').update(sql).digest('hex');

  // manifest 最後才寫：**有 manifest ＝ 這份備份是完整的**，還原端只認這個
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    tool: 'kb-backup.mjs', version: 1,
    exported_at: new Date().toISOString(),
    account_id: ACCOUNT, database_id: dbId, database_name: meta.name,
    discovered_from_worker: arg('db') ? null : workerName,
    bookmark, bytes: sql.length, sha256,
    insert_statements: inserts,
    table_counts: counts,
  }, null, 2) + '\n');

  console.log(`\n✅ 備份完成：${dir}`);
  console.log(`   檔案 ${(sql.length / 1048576).toFixed(2)} MiB／INSERT ${inserts} 句／sha256 ${sha256.slice(0, 16)}…`);
  console.log('   還原：node scripts/kb-restore.mjs --from ' + dir + ' --worker <目標服務>');
}

main().catch((e) => die('備份中止', e.stack || String(e)));
