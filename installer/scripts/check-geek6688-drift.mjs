#!/usr/bin/env node
/**
 * check-geek6688-drift.mjs — geek6688（出貨機/第一個顧客）落後 stage 時，讓它自己叫
 *
 * ── 為什麼要有這支（inkstone/arcrun-rag#112，2026-08-16）────────────────────
 * leo 定的角色（2026-08-12）：youlin＝測試場／geek6688＝出貨機、第一個顧客／
 * leo21c＝一般實例。出貨機的職務不是「換個地方跑」，是當每一版的**第一個顧客**——
 * 更新過程會不會壞、引擎對不對，都要在它身上先發生，在任何用戶碰到之前。
 *
 * 🔴 同一道防線四天內第二次躺下：08-12 落後 12 版、08-16 落後 6 版。
 * 兩次的根因都不是「忘記更新」，是**沒有任何東西會在它落後時出聲**——落後這件事
 * 只有「總管剛好手動去 curl /health 比對」才會被看見。只修一次版本號，
 * 不修「沒人會發現」這件事，四天後一定有第三次。
 *
 * ── 這支做什麼 ──────────────────────────────────────────────────────────────
 * 打兩台的 `/health`，比對 `bundle_version`。不一致就：
 *   ① 印出顯眼的 🚨 警報（不是安靜記一筆log，是讓跑它的人躲不掉）
 *   ② exit 1（可接進任何流程，讓流程本身失敗，不必額外去讀報告）
 *   ③ 帶 `--notify` 時，另外打現成的 `notify_leo` 工作流（頂層 `wiki/agent-memory.md`
 *      §1 記載的正式通道）把警報送進 leo 的 Telegram——這是本體系既有的「出聲」機制，
 *      不重新發明一條新的通知路
 *
 * ── 為什麼不是排程輪詢（頂層鐵律：觸發走人/本機發起的 refresh，禁排程輪詢）─────
 * 本檔**不含任何 cron / setInterval / 常駐迴圈**。它只在被呼叫的當下跑一次就結束。
 * 觸發時機交給呼叫端決定，建議兩個既有的人類動作順便帶上它：
 *   · 每次 `ship.mjs --target stage --confirm` 出完貨後，人手動跑一次本檔
 *     （`wiki/ops-facts.md`「怎麼手動更新 geek6688」段已加註）
 *   · 總管 session 開場核對現況時（`wiki/status.md` 接關）順手跑一次
 * 兩者都是「人已經在動作」的附掛檢查，不是新開一個會自己醒來的排程器。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node installer/scripts/check-geek6688-drift.mjs                # 只印報告，不通知
 *   node installer/scripts/check-geek6688-drift.mjs --notify        # 落後時另外打 notify_leo
 *   node installer/scripts/check-geek6688-drift.mjs --stage <url> --target <url>   # 覆寫預設兩台
 *
 * 🔴 **2026-08-16 實測發現**：`notify_leo` 這支工作流**目前在 leo21c 上不存在**
 * （`GET /webhooks/named` 現有 6 支：`graph_neighbors`／`rag_chat`／`rag_ingest_card`／
 * `rag_takedown_direct`／`ship_check_live`／`ship_refresh_cdn`，沒有 `notify_leo`）。
 * 這是一個**獨立於本票的既有缺陷**（agent-memory.md 記過它 08-10 斷過一次、已修回，
 * 但看起來後續某次重裝/換 namespace 又斷了）——不在 #112 範圍內，本檔不負責修它，
 * 只負責：`--notify` 打不到時**不要假裝成功**，把真實錯誤印出來讓人知道兩件事各自的狀態
 * （① 版本有沒有落後 ② 通知channel通不通），不要混成一句話。
 *
 * namespace 不寫死（同 `ship-arcrun.mjs` 的教訓：寫死一個會漂的座標，漂掉時沒人發現）：
 * 優先序＝`NOTIFY_LEO_NS` 環境變數 > 全域 `~/.arcrun/config.yaml` 的 `api_key`。
 * leo21c 是**總管全域設定預設指向的那台**，所以這裡用全域設定、不是 `ARCRUN_SHIP_NS`
 * （那支是出貨目標的 namespace，可能被 env 覆寫成 geek6688，兩者不是同一件事）。
 *
 * ── 設計取捨：為什麼獨立成純函式（同 verify-mail-relay.mjs／ship-report.mjs 的理由）───
 * `checkParity()` 與 `fetchVersion()` 接受注入的 `fetchImpl`，讓
 * check-geek6688-drift.test.mjs 能在不打任何真實網路的情況下，
 * 演練「落後 → 判定不一致 → ok:false」與「同版 → ok:true」兩條分支。
 * CLI 進入點只做「用真 fetch 呼叫純函式＋印報告＋決定 exit code／要不要通知」。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_STAGE_BASE = 'https://arcrun-cypher-executor.youlin-hsieh-dev.workers.dev';
const DEFAULT_TARGET_BASE = 'https://arcrun-cypher-executor.arcrun-fc9490d5.workers.dev';
// notify_leo 正式通道（頂層 wiki/agent-memory.md §1）住在 leo21c：
// POST /webhooks/named/<namespace>/notify_leo/trigger，body {"text": "..."}。
const NOTIFY_LEO_BASE = 'https://arcrun-cypher-executor.leo21c.workers.dev';

/** leo21c 的 namespace——同 ship-arcrun.mjs 的 resolveNamespace，不寫死、現讀全域設定。 */
export function resolveLeo21cNamespace() {
  if (process.env.NOTIFY_LEO_NS) return { ns: process.env.NOTIFY_LEO_NS, source: '環境變數 NOTIFY_LEO_NS' };
  const p = process.env.ARCRUN_GLOBAL_CONFIG || join(homedir(), '.arcrun', 'config.yaml');
  if (!existsSync(p)) {
    throw new Error(`不知道 leo21c 的 namespace：沒有設 NOTIFY_LEO_NS，也讀不到 ${p}`);
  }
  const raw = readFileSync(p, 'utf8');
  const out = execFileSync('python3', ['-c', 'import sys,yaml,json; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout, ensure_ascii=False)'], {
    input: raw, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const cfg = JSON.parse(out);
  const ns = cfg && cfg.api_key ? String(cfg.api_key) : '';
  if (!ns) throw new Error(`${p} 沒有 api_key 欄位`);
  return { ns, source: p };
}

/** 打一台實例的 /health，取出 bundle_version。回傳 {ok:true, version, raw} 或 {ok:false, error}。 */
export async function fetchVersion(base, fetchImpl = fetch) {
  const root = String(base).replace(/\/+$/, '');
  const bust = `cb=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  let res;
  try {
    res = await fetchImpl(`${root}/health?${bust}`, { headers: { 'cache-control': 'no-cache' } });
  } catch (e) {
    return { ok: false, error: `fetch 失敗：${e.message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, error: '回應不是 JSON' }; }
  if (!body || !body.bundle_version) return { ok: false, error: '/health 回應沒有 bundle_version 欄位' };
  return { ok: true, version: body.bundle_version, raw: body };
}

/**
 * 比對 stage 與 target 兩台的版本。純函式，不印任何東西、不 exit。
 * @returns {Promise<{ok:boolean, lines:string[], drift:null|{stageVersion:string,targetVersion:string}}>}
 */
export async function checkParity({
  stageBase = DEFAULT_STAGE_BASE,
  targetBase = DEFAULT_TARGET_BASE,
  fetchImpl = fetch,
} = {}) {
  const [stage, target] = await Promise.all([
    fetchVersion(stageBase, fetchImpl),
    fetchVersion(targetBase, fetchImpl),
  ]);
  const lines = [];
  if (!stage.ok) {
    lines.push(`❌ 讀不到 stage 版本（${stageBase}）：${stage.error}`);
    return { ok: false, lines, drift: null };
  }
  if (!target.ok) {
    lines.push(`❌ 讀不到出貨機版本（${targetBase}）：${target.error}`);
    return { ok: false, lines, drift: null };
  }
  lines.push(`stage　（${stageBase}）＝ ${stage.version}`);
  lines.push(`出貨機（${targetBase}）＝ ${target.version}`);
  const inSync = stage.version === target.version;
  if (inSync) {
    lines.push('✅ 同版——出貨機仍是「第一個顧客」。');
    return { ok: true, lines, drift: null };
  }
  lines.push(`🚨 落後：出貨機 ${target.version} ≠ stage ${stage.version}`);
  return { ok: false, lines, drift: { stageVersion: stage.version, targetVersion: target.version } };
}

/**
 * 打 notify_leo，把警報送進 Telegram。回傳 {httpOk, okInner, body}——判準同
 * agent-memory.md 記的坑：外層 200 不代表內層真的成功（曾經外層成功、內層 404）。
 * namespace 現讀（`resolveLeo21cNamespace`），不吃寫死值。
 */
export async function notifyLeo(text, { fetchImpl = fetch, base = NOTIFY_LEO_BASE, ns } = {}) {
  const namespace = ns || resolveLeo21cNamespace().ns;
  const url = `${base}/webhooks/named/${namespace}/notify_leo/trigger`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 也往下判斷 */ }
  const okInner = body?.data?.data?.ok === true || body?.data?.ok === true;
  return { httpOk: res.ok, okInner, body, url };
}

// ── CLI 進入點 ────────────────────────────────────────────────────────────
const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const stageBase = getArg('--stage', DEFAULT_STAGE_BASE);
  const targetBase = getArg('--target', DEFAULT_TARGET_BASE);
  const doNotify = args.includes('--notify');

  console.log('━━━ geek6688 版本偵測（inkstone/arcrun-rag#112）━━━\n');
  const result = await checkParity({ stageBase, targetBase });
  for (const l of result.lines) console.log(l);

  if (!result.ok) {
    console.log('\n🚨🚨🚨 ALERT：出貨機落後 stage，「第一個顧客」這道防線現在是空的 🚨🚨🚨');
    if (doNotify && result.drift) {
      const text = `[出貨偵測 #112] geek6688 落後 stage：出貨機 ${result.drift.targetVersion}，stage ${result.drift.stageVersion}。跑 wiki/ops-facts.md「怎麼手動更新 geek6688」段補上。`;
      try {
        const n = await notifyLeo(text);
        console.log(`\n通知 notify_leo（${n.url}）：httpOk=${n.httpOk} okInner=${n.okInner}`);
        console.log(JSON.stringify(n.body));
        if (!n.okInner) {
          console.log('⚠️ 通知沒有真的送出——版本偵測本身仍算數（上面的 🚨 是真的），\n' +
            '   但 notify_leo 這條通道本身現在打不通，是獨立於本票的既有缺陷，不是本次的判定錯誤。');
        }
      } catch (e) {
        console.log(`\n⚠️ notify_leo 打不通：${e.message}（偵測本身仍算數，只是這次沒送出通知）`);
      }
    } else if (!result.drift) {
      // 讀不到某一台，drift 資訊不完整，不硬送一則空白警報
      console.log('\n（有一台讀不到版本，不送 notify_leo——通知內容需要兩邊版本號才有意義）');
    } else {
      console.log('\n（未帶 --notify，只印出警報、沒有送出通知——要真的叫用 --notify）');
    }
    process.exit(1);
  }
  console.log('\n✅ 出貨機與 stage 同版。');
  process.exit(0);
}
