#!/usr/bin/env node
/**
 * kb-backup-workflows.mjs —— 把一台實例上「部署著的工作流」整批取回本地
 *
 * 知識庫（D1）用 kb-backup.mjs；這支管的是另一半：**工作流的定義**。
 * 兩者都屬 Leo/Arcrun#83「我的全部知識都在雲端，我沒有一份自己的備份」。
 *
 * 🔴 為什麼一定要先留底再升級（leo 2026-08-09 對 17 支舊 workflow 的裁定）：
 *   「**重做 workflow 就好**，你可以**先下載現有的 workflow**」
 *   ⇒ 舊的不必想辦法讓它活下來，但**不能連長什麼樣都不知道**。
 *     留底＝把「之後要照著重做什麼」變成手上有的檔案，而不是記憶。
 *   ⇒ 因為用途是「照著重做」，本工具**同時產出 INDEX.md**：一頁看完每支在做什麼、
 *     幾個節點、接到哪、吃什麼參數。只有一堆 JSON ＝ 留了但看不懂 ＝ 沒達成目的。
 *
 * ── 兩條車道，挑哪條不是偏好問題，是那台實例的版本決定的 ─────────────────
 *
 * ① `--base <url>`（預設）：走實例自己的定義端點 `GET /webhooks/named/:name/definition`。
 *    乾淨、不需要 CF 帳號權限，**但那支端點是 t158（commit 9c9aff0）才有的**。
 *
 * ② `--from-kv`：直接讀 `WEBHOOKS` KV。給**端點還沒有的舊實例**用。
 *    🔴 2026-08-09 leo21c 實測：17 支全部 `/definition` → 404
 *       （那台 cypher 部署於 07-22，早於 t158）⇒ ① 這條路在舊實例上**根本不存在**。
 *       這正是「工具在 stage 驗過 9/9」也不能推論「在 prod 會通」的那種差別：
 *       stage 是新版、leo21c 是舊版，**同一支工具走的是兩條不同的路**。
 *    KV 值就是 cypher 自己寫進去的可攜定義（`{api_key}:wf:{name}`，
 *    見 `cypher-executor/src/routes/webhooks-named.ts:51`），不是二手翻譯。
 *
 * ── 三件「別再犯」的事（都是踩過才寫的） ─────────────────────────────
 *
 * 🔴 **不靠名字猜資源**（同 kb-backup.mjs 的 14-E 教訓）：KV 也去問 worker
 *    「你綁的 WEBHOOKS 是哪一顆」（`GET /workers/scripts/<name>/settings`），
 *    不用 `title === 'WEBHOOKS'` 去列表裡撈。
 *
 * 🔴 **KV 的鍵名前綴就是 API 金鑰真身**（`{api_key}:wf:{name}`）。
 *    ⇒ 租戶識別**不得原樣寫進備份或版控**：本工具把非明碼租戶名（`ak_…` 這種）
 *      換成 `tenant-<sha256 前 8 碼>`，並在 manifest 標明「已遮蔽」。
 *      要還原時去線上 KV 的鍵名對照，備份檔裡永遠沒有那把金鑰。
 *
 * 🔴 **定義裡若混進金鑰真身就地遮蔽**：掃 Telegram bot token／`Bearer …`／`sk-`／
 *    `AIza…`／`ghp_…`／`ak_…` 等形狀，命中就換成 `«REDACTED:<種類>»`，
 *    並列進 manifest 的 `redactions`——**看得到「這裡本來有一把金鑰」，但拿不到值**（D36）。
 *
 * 🔴 **半截備份要看得出來**：任何一支抓不到、任何一支不像可還原的定義（沒有 graph），
 *    就 exit 1 且**不寫 manifest**。沒有 manifest 的目錄＝半截備份，別拿它當「我有備份了」。
 *
 * 用法：
 *   # ① 新世代實例（有 /definition 端點）
 *   ARCRUN_API_KEY=<租戶名> node scripts/kb-backup-workflows.mjs \
 *     --base https://arcrun-cypher-executor.<subdomain>.workers.dev --out ./backups
 *
 *   # ② 舊世代實例（端點 404）——走資料層，一次撈完該實例上**所有租戶**的定義
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/kb-backup-workflows.mjs \
 *     --from-kv --worker arcrun-cypher-executor --out ./backups
 *
 * 產出：<out>/workflows-<時間戳>/{[<租戶>/]<name>.json ×N, INDEX.md, manifest.json}
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CF_API = 'https://api.cloudflare.com/client/v4';
const KEY = process.env.ARCRUN_API_KEY;
const TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function die(msg, detail) {
  console.error(`\n❌ ${msg}`);
  if (detail) console.error(`   ${detail}`);
  process.exit(1);
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');

// ── 金鑰形狀掃描（只認形狀，不需要知道值） ────────────────────────────
const SECRET_PATTERNS = [
  { kind: 'telegram_bot_token', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: 'arcrun_api_key', re: /\bak_[0-9a-f]{24,}\b/g },
  { kind: 'openai_like_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'github_token', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'gitea_token', re: /\bhttps?:\/\/[^\s:@/]+:[A-Za-z0-9]{30,}@/g },
];

/** 就地遮蔽：回 { text, hits:[{kind,count}] }。永遠不回傳被遮掉的值。 */
function redact(text) {
  let out = text;
  const hits = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    const found = out.match(re);
    if (found && found.length) {
      hits.push({ kind, count: found.length });
      out = out.replace(re, `«REDACTED:${kind}»`);
    }
  }
  return { text: out, hits };
}

/** 租戶識別：明碼分區標籤（如 `leo`）照原樣；金鑰形狀的換成雜湊短碼。 */
function tenantLabel(raw) {
  const looksSecret = /^ak_/.test(raw) || raw.length > 24;
  if (!looksSecret) return { label: raw, redacted: false };
  return { label: `tenant-${sha(raw).slice(0, 8)}`, redacted: true };
}

// ── HTTP ────────────────────────────────────────────────────────────
async function getArcrun(url) {
  const res = await fetch(url, { headers: { 'X-Arcrun-API-Key': KEY } });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  try { return JSON.parse(text); } catch { throw new Error(`回傳不是 JSON：${text.slice(0, 200)}`); }
}

async function cf(pathname) {
  const res = await fetch(CF_API + pathname, { headers: { authorization: `Bearer ${TOKEN}` } });
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

/** KV 的值端點回的是原始值（非 JSON 包裝），要單獨處理。 */
async function cfKvValue(nsId, key) {
  const url = `${CF_API}/accounts/${ACCOUNT}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} 讀 KV 值失敗 :: ${text.slice(0, 200)}`);
  return text;
}

// ── 可讀性：把 graph 講成人話 ─────────────────────────────────────────
function describeNode(n) {
  const bits = [];
  if (n.componentId && n.componentId !== n.type) bits.push(`零件 \`${n.componentId}\``);
  const data = n.data || n.config || {};
  const params = Object.keys(data).filter((k) => k !== 'component');
  if (params.length) bits.push(`參數：${params.slice(0, 8).map((k) => `\`${k}\``).join('、')}${params.length > 8 ? ` …共 ${params.length} 個` : ''}`);
  return bits.join('／');
}

function indexEntry(wf) {
  const g = wf.def.graph || {};
  const nodes = g.nodes || [];
  const edges = g.edges || [];
  const lines = [];
  lines.push(`- ## \`${wf.name}\`${wf.tenantLabel ? `（租戶 ${wf.tenantLabel}）` : ''}`);
  const desc = (wf.def.description || '（這支沒有寫 description）').trim();
  lines.push(`\t- **在做什麼**`);
  for (const l of desc.split('\n')) lines.push(`\t\t- ${l.trim()}`);
  lines.push(`\t- **建立於** ${wf.def.created_at || '未知'}　**節點** ${nodes.length}　**連線** ${edges.length}`);
  lines.push(`\t- **檔案** \`${wf.file}\``);
  if (nodes.length) {
    lines.push(`\t- **步驟**`);
    for (const n of nodes) {
      const d = describeNode(n);
      lines.push(`\t\t- \`${n.id}\`（${n.type || '?'}）${d ? ` — ${d}` : ''}`);
    }
  }
  if (edges.length) {
    lines.push(`\t- **接法**`);
    for (const e of edges) lines.push(`\t\t- \`${e.from}\` → \`${e.to}\`${e.type && e.type !== 'ON_SUCCESS' ? `（${e.type}）` : ''}`);
  }
  if (wf.redactions.length) {
    lines.push(`\t- 🔴 **這支定義裡有金鑰真身，已遮蔽**：${wf.redactions.map((r) => `${r.kind}×${r.count}`).join('、')}`);
  }
  return lines.join('\n');
}

async function writeOutputs({ dir, source, workflows, extras, note }) {
  const stampNow = new Date().toISOString();
  const head = [
    `# 工作流留底 — ${source.instance}`,
    '',
    `- 取回時間：${stampNow}`,
    `- 取回方式：${source.how}`,
    `- 共 ${workflows.length} 支${source.per_tenant ? `（${source.per_tenant}）` : ''}`,
    ...(extras.length ? [`- 這個 KV 裡另有 ${extras.length} 個非工作流的鍵：${extras.map((k) => `\`${k}\``).join('、')}`] : []),
    ...(note ? [`- ${note}`] : []),
    '- 🔴 **這份是「重做時的依據」，不是可以原封不動塞回去的還原包**——',
    '\t- 舊實例的定義依賴 13 個 `SVC_*` service binding，新版打包時 `stripServices: true` 會拿掉它們；',
    '\t- 照著 INDEX 用新版零件重做（`acr push <yaml>`），別直接把 JSON POST 回新實例。',
    '',
  ].join('\n');
  const body = workflows.map(indexEntry).join('\n');
  await writeFile(path.join(dir, 'INDEX.md'), `${head}${body}\n`);

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    tool: 'kb-backup-workflows.mjs', version: 2,
    exported_at: stampNow,
    source,
    workflow_count: workflows.length,
    non_workflow_keys: extras,
    workflows: workflows.map((w) => ({
      name: w.name,
      tenant: w.tenantLabel,
      tenant_redacted: w.tenantRedacted,
      file: w.file,
      bytes: w.bytes,
      sha256: w.sha256,
      nodes: (w.def.graph?.nodes || []).length,
      edges: (w.def.graph?.edges || []).length,
      redactions: w.redactions,
    })),
    redaction_policy: '金鑰真身以 «REDACTED:<種類>» 就地取代；租戶識別若為金鑰形狀改記 tenant-<sha256前8>。備份檔內無任何金鑰值。',
  }, null, 2) + '\n');
}

// ── 車道 ①：走實例的 /definition 端點 ────────────────────────────────
async function fromApi(outRoot) {
  const base = (arg('base') || '').replace(/\/$/, '');
  if (!KEY) die('缺 ARCRUN_API_KEY', 'self-hosted 實例的租戶名（D21：明碼租戶識別，不是密碼）。');

  let list;
  try {
    list = await getArcrun(`${base}/webhooks/named`);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      die('這台實例不認這個租戶名，列不出工作流', `${e.message}\n   → 檢查 ARCRUN_API_KEY 是不是這台實例的租戶名。`);
    }
    die('連不上這台實例的工作流清單', e.message);
  }
  const names = (list.workflows || []).map((w) => w.name);
  if (!names.length) {
    // ⚠️ 實測（2026-08-09 stage）：租戶名給錯**不會**回 401，會回 200＋空清單。
    //    「空的」與「你問錯人」長得一模一樣 ⇒ 這裡必須把兩種可能都講出來。
    die('列不出任何工作流——但這**不代表**這台實例上沒有',
        `租戶名給錯時這支端點會回「200 + 空清單」，跟真的沒有長得一樣。\n`
      + `   → 先確認 ARCRUN_API_KEY（現在給的是「${KEY}」）是這台實例的租戶名，再確認 --base 指對實例。`);
  }
  console.log(`🧩 這台實例上有 ${names.length} 支工作流：${names.join('、')}`);

  const dir = path.join(outRoot, `workflows-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });

  const workflows = [];
  const failed = [];
  let all404 = true;
  for (const name of names) {
    try {
      const def = await getArcrun(`${base}/webhooks/named/${encodeURIComponent(name)}/definition`);
      all404 = false;
      if (!def || !def.graph) throw new Error('回來的定義裡沒有 graph（＝拿到的不是可還原的東西）');
      const { text, hits } = redact(JSON.stringify(def, null, 2) + '\n');
      const file = `${safe(name)}.json`;
      await writeFile(path.join(dir, file), text);
      workflows.push({ name, def, file, bytes: Buffer.byteLength(text), sha256: sha(text), redactions: hits, tenantLabel: KEY, tenantRedacted: false });
      console.log(`   ✅ ${name}${hits.length ? `（遮蔽 ${hits.map((h) => h.kind).join('、')}）` : ''}`);
    } catch (e) {
      if (e.status !== 404) all404 = false;
      failed.push({ name, error: e.message });
      console.log(`   ❌ ${name}：${e.message}`);
    }
  }

  if (failed.length) {
    const hint = all404
      ? `\n   🔴 **全部 404 ＝ 這台實例還沒有 /definition 端點**（它是 t158／commit 9c9aff0 才加的）。\n`
        + `      → 改走資料層：CF_API_TOKEN=… CF_ACCOUNT_ID=… node ${path.basename(process.argv[1])} --from-kv`
      : '';
    die(`${failed.length}/${names.length} 支沒抓下來，這次備份不算數`,
        `已抓到的檔案留在 ${dir}，但**沒有寫 manifest**——別拿它當完整備份。\n`
      + `   失敗清單：${failed.map((f) => f.name).join('、')}${hint}`);
  }

  await writeOutputs({
    dir,
    source: { instance: base, how: `實例端點 GET /webhooks/named/:name/definition（租戶 ${KEY}）` },
    workflows, extras: [], note: null,
  });
  return { dir, count: workflows.length, workflows };
}

// ── 車道 ②：走 WEBHOOKS KV（舊實例；一次撈完所有租戶） ──────────────────
async function fromKv(outRoot) {
  if (!TOKEN) die('缺 CF_API_TOKEN', '要能讀這個帳號的 Workers 設定與 KV。');
  if (!ACCOUNT) die('缺 CF_ACCOUNT_ID', '這台實例所在的 Cloudflare 帳號 id。');
  const worker = arg('worker', 'arcrun-cypher-executor');
  const binding = arg('kv-binding', 'WEBHOOKS');

  let nsId = arg('kv-id');
  if (!nsId) {
    // 🔴 不照名字撈——問 worker 它自己綁的是哪一顆（14-E 教訓）
    let settings;
    try {
      settings = await cf(`/accounts/${ACCOUNT}/workers/scripts/${worker}/settings`);
    } catch (e) {
      if (e.status === 404) die(`這個帳號底下沒有名叫「${worker}」的服務`, '→ 用 --worker 指定正確名字，或 --kv-id 直接給 KV namespace id。');
      die(`問不到服務「${worker}」綁的是哪些 KV（金鑰權限或帳號不對）`, `${e.message}\n   → 檢查 CF_API_TOKEN 的 Workers 讀取權限與 CF_ACCOUNT_ID。`);
    }
    const kv = (settings.bindings || []).filter((b) => b.type === 'kv_namespace');
    const hit = kv.find((b) => b.name === binding);
    if (!hit) {
      die(`服務「${worker}」沒有名叫「${binding}」的 KV binding`,
          `它綁的是：${kv.map((b) => b.name).join('、') || '（一個都沒有）'}\n   → 用 --kv-binding 換一個，或 --kv-id 直接指定。`);
    }
    nsId = hit.namespace_id;
    console.log(`🔎 要備份的工作流住在 KV「${binding}」（${nsId}）`);
    console.log(`   （來源＝服務「${worker}」自己回報它綁的是這一顆——不是照名字猜的）`);
  }

  // 列鍵（分頁要走完；沒走完就不算數）
  const keys = [];
  let cursor = '';
  for (let page = 0; page < 200; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(`${CF_API}/accounts/${ACCOUNT}/storage/kv/namespaces/${nsId}/keys${q}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.success === false) die('列不出 KV 的鍵', JSON.stringify(body?.errors || res.status));
    keys.push(...body.result.map((k) => k.name));
    cursor = body.result_info?.cursor || '';
    if (!cursor) break;
    if (page === 199) die('KV 鍵太多，分頁沒走完', '這次不算數——不寫 manifest。');
  }

  const wfKeys = keys.filter((k) => k.includes(':wf:'));
  const extras = keys.filter((k) => !k.includes(':wf:'));
  if (!wfKeys.length) die('這顆 KV 裡沒有任何 `*:wf:*` 鍵', `共 ${keys.length} 個鍵：${keys.slice(0, 20).join('、')}`);

  const tenants = new Map();
  for (const k of wfKeys) {
    const raw = k.slice(0, k.indexOf(':wf:'));
    if (!tenants.has(raw)) tenants.set(raw, tenantLabel(raw));
  }
  console.log(`🧩 KV 裡有 ${wfKeys.length} 支工作流定義，分屬 ${tenants.size} 個租戶：`);
  for (const [, t] of tenants) console.log(`   • ${t.label}${t.redacted ? '（原識別是 API 金鑰真身，已遮蔽）' : ''}`);

  const dir = path.join(outRoot, `workflows-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });

  // 排序：**明碼租戶（＝實例主人自己用的那些）排前面**，遮蔽掉的舊金鑰租戶排後面。
  //   理由：這份東西的用途是「照著重做」，主人天天在用的那批要先被看到。
  const ordered = wfKeys.slice().sort((a, b) => {
    const ta = tenants.get(a.slice(0, a.indexOf(':wf:')));
    const tb = tenants.get(b.slice(0, b.indexOf(':wf:')));
    if (ta.redacted !== tb.redacted) return ta.redacted ? 1 : -1;
    if (ta.label !== tb.label) return ta.label < tb.label ? -1 : 1;
    return a < b ? -1 : 1;
  });

  const workflows = [];
  const failed = [];
  for (const key of ordered) {
    const rawTenant = key.slice(0, key.indexOf(':wf:'));
    const name = key.slice(key.indexOf(':wf:') + 4);
    const t = tenants.get(rawTenant);
    try {
      const value = await cfKvValue(nsId, key);
      let def;
      try { def = JSON.parse(value); } catch { throw new Error('KV 裡的值不是 JSON（＝拿到的不是可還原的定義）'); }
      if (!def.graph) throw new Error('定義裡沒有 graph（＝拿到的不是可還原的東西）');
      const { text, hits } = redact(JSON.stringify(def, null, 2) + '\n');
      await mkdir(path.join(dir, safe(t.label)), { recursive: true });
      const file = path.join(safe(t.label), `${safe(name)}.json`);
      await writeFile(path.join(dir, file), text);
      workflows.push({ name, def, file, bytes: Buffer.byteLength(text), sha256: sha(text), redactions: hits, tenantLabel: t.label, tenantRedacted: t.redacted });
      console.log(`   ✅ ${t.label}/${name}${hits.length ? `（遮蔽 ${hits.map((h) => h.kind).join('、')}）` : ''}`);
    } catch (e) {
      failed.push({ name: `${t.label}/${name}`, error: e.message });
      console.log(`   ❌ ${t.label}/${name}：${e.message}`);
    }
  }

  if (failed.length) {
    die(`${failed.length}/${wfKeys.length} 支沒抓下來，這次備份不算數`,
        `已抓到的檔案留在 ${dir}，但**沒有寫 manifest**——別拿它當完整備份。\n`
      + `   失敗清單：${failed.map((f) => f.name).join('、')}`);
  }

  await writeOutputs({
    dir,
    source: {
      instance: `Cloudflare 帳號 ${ACCOUNT} 的服務「${worker}」`,
      how: `資料層 KV「${binding}」（${nsId}）——這台實例還沒有 /definition 端點`,
      per_tenant: [...tenants.values()]
        .map((t) => `${t.label} ${workflows.filter((w) => w.tenantLabel === t.label).length} 支`)
        .join('／'),
      kv_namespace_id: nsId,
      tenants: [...tenants.values()].map((t) => ({ label: t.label, redacted: t.redacted })),
    },
    workflows, extras,
    note: '租戶識別若是 API 金鑰真身已改記雜湊短碼；要對回線上，看 KV 鍵名前綴。',
  });
  return { dir, count: workflows.length, workflows };
}

async function main() {
  const outRoot = arg('out', './backups');
  const useKv = flag('from-kv');
  if (!useKv && !arg('base')) die('缺 --base <實例的 cypher-executor 網址>', '舊實例（沒有 /definition 端點）請改用 --from-kv。');

  const { dir, count } = useKv ? await fromKv(outRoot) : await fromApi(outRoot);

  console.log(`\n✅ ${count} 支全部留底：${dir}`);
  console.log('   目錄裡有 INDEX.md（一頁看完每支在做什麼）與 manifest.json（清單＋雜湊＋遮蔽紀錄）。');
  console.log('   還原不是自動的：照 INDEX 用新版零件重做（`acr push <yaml>`），不是把 JSON 塞回去。');
}

main().catch((e) => die('工作流備份中止', e.stack || String(e)));
