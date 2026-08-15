/**
 * ship-arcrun.mjs — 出貨管線怎麼把活派給 Arcrun 工作流
 *
 * ── 為什麼（D70，leo 2026-08-11；執行票 `Leo/arcrun-rag#77`）────────────────
 * leo 原話：
 *   「前面你已經有出貨模組的設計，**不同動作調用不同的函式，這些函式我希望用 Arcrun 做**。」
 *   判準：「**leo 打開工作流頁，看得到這件事嗎？看不到 ⇒ 它就不在 Arcrun 上。**」
 *
 * 站表（`installer/ship.stations.yaml`）裡每一站的 `用什麼:` 若不是「本機」，
 * 就是 leo 自己 Arcrun 實例上一個工作流的名字。這支負責把那件事變成真的：
 *   · `assertWorkflowsExist()`——**出貨前確認那些工作流真的在那台實例上**
 *   · `runWorkflow()`——出貨當下真的去觸發它，拿它的判定回來
 *
 * 🔴 `assertWorkflowsExist` 這道閘是本檔存在的主要理由。沒有它，站表寫
 *   `用什麼: ship_check_live` 只是一句宣告——**工作流可以根本不存在、或被刪掉，
 *   而管線照跑照綠**。那正是這條線反覆出事的形狀（規則存在、沒有機制驗證有沒有照做）。
 *
 * ── 身分：namespace 明碼，沒有 `ak_` key ────────────────────────────────────
 * 本體系是 self-hosted，**認證＝namespace 明碼**（D21；頂層 `wiki/mistakes.md` 記過
 * 「若有人要你取 `ak_` key＝看錯狀態，那是已廢的 SaaS 遺物」）。
 * 所以這裡沒有任何金鑰，也**不需要**——不違反 D36，因為根本沒有值要保護。
 *
 * ── namespace 從哪來（2026-08-15 修，見 wiki/ops-facts.md「出貨管線問錯 namespace」）──
 * 🔴 舊版把 namespace 寫死成 `'leo'`。2026-08-13 使用者換過 namespace（見
 *   `~/.arcrun/config.yaml.bak-20260813-before-namespace` 這份備份），從那天起
 *   `'leo'` 這個 namespace 下一支工作流都沒有——**寫死值本身就是會過期的東西**，
 *   換一個新的寫死值（例如 `'bfezv28v'`）只是把同一種壞法往後遞延，使用者下次再換
 *   namespace 又會壞第二次（wiki 原話：「寫死一個會漂的座標，都要問：它漂掉的時候，
 *   誰會發現？沒有人會發現 ⇒ 那不是預設值，是一顆定時炸彈」）。
 *
 * 真相源＝使用者本機 `~/.arcrun/config.yaml` 的 `api_key` 欄位——**這就是
 * self-hosted 模式的 namespace 明碼**（`acr` 自己也是讀這個檔案取得同一個值；
 * 不是 SaaS 的 `ak_` key，那個概念在 self-hosted 模式下不存在）。
 * 所以這裡改成**每次都現讀**該檔案，不再有任何寫死的 fallback 值：
 *   1. `ARCRUN_SHIP_NS` 環境變數（覆寫，優先）
 *   2. `~/.arcrun/config.yaml` 的 `api_key`（真相源）
 *   3. 兩者都沒有 ⇒ 丟清楚的例外，不再猜一個值頂著——猜的那個值正是這次出事的原因。
 * YAML 解析法照 `ship-stations.mjs` 既有做法：python3+pyyaml（本 repo node_modules
 * 沒裝 yaml 套件，不再引第三種做法）。
 *
 * ── 實例位置可覆寫，但預設指到 leo 那台 ────────────────────────────────────
 * 預設 `https://arcrun-cypher-executor.leo21c.workers.dev`，
 * 因為 D70 的判準是「**leo** 打開工作流頁看得到嗎」——工作流要住在他自己那台，
 * 不是住在某個測試實例上（住錯地方＝他看不到＝等於沒做）。
 * 換實例走環境變數 `ARCRUN_SHIP_BASE`，不改程式碼。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ARCRUN_BASE = process.env.ARCRUN_SHIP_BASE || 'https://arcrun-cypher-executor.leo21c.workers.dev';

/**
 * namespace 從哪裡來：`ARCRUN_SHIP_NS` 環境變數 > `~/.arcrun/config.yaml` 的
 * `api_key` 欄位 > 丟例外。回傳 `{ ns, source }`，`source` 給錯誤訊息用，
 * 讓讀訊息的人知道「這個值是哪裡來的」，不必自己猜。
 *
 * 不快取：每次呼叫都現讀（含 config 檔案路徑本身——`ARCRUN_SHIP_CONFIG` 也現讀，
 * 不是 import 時就固定死，測試才能在同一個 process 裡切換不同的假設定檔）。
 * 換 namespace 不必重開 process、也不必記得清快取。檔案 I/O 很便宜，
 * 出貨管線一次執行頂多讀個位數次。
 */
export function resolveNamespace() {
  if (process.env.ARCRUN_SHIP_NS) {
    return { ns: process.env.ARCRUN_SHIP_NS, source: '環境變數 ARCRUN_SHIP_NS' };
  }
  const ARCRUN_CONFIG_PATH = process.env.ARCRUN_SHIP_CONFIG || join(homedir(), '.arcrun', 'config.yaml');
  if (!existsSync(ARCRUN_CONFIG_PATH)) {
    throw new Error(
      `不知道要問哪個 namespace：沒有設 ARCRUN_SHIP_NS，也讀不到 ${ARCRUN_CONFIG_PATH}\n` +
      `     → namespace 沒有安全的寫死預設值可以頂（上一版寫死 'leo'，使用者換過 namespace 後\n` +
      `       整條出貨管線就打不通，這正是這次要修的事故）。\n` +
      `     → 裝 acr 並登入過一次會產生這個檔案；或用 ARCRUN_SHIP_NS=<namespace> 覆寫。`);
  }
  let cfg;
  try {
    const raw = readFileSync(ARCRUN_CONFIG_PATH, 'utf8');
    const out = execFileSync('python3', ['-c', 'import sys,yaml,json; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout, ensure_ascii=False)'], {
      input: raw, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    cfg = JSON.parse(out);
  } catch (e) {
    throw new Error(`${ARCRUN_CONFIG_PATH} 讀不動：${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' / ')}`);
  }
  const ns = cfg && cfg.api_key ? String(cfg.api_key) : '';
  if (!ns) {
    throw new Error(`${ARCRUN_CONFIG_PATH} 裡沒有 api_key 這個欄位（self-hosted 模式的 namespace 就放在這裡）\n` +
      `     → 用 ARCRUN_SHIP_NS 覆寫，或重新跑一次 acr 的安裝/登入流程把它補上。`);
  }
  return { ns, source: ARCRUN_CONFIG_PATH };
}

const headers = () => ({ 'content-type': 'application/json', 'X-Arcrun-API-Key': resolveNamespace().ns });

/** 這台實例上這個 namespace 有哪些工作流（名字陣列）。 */
export async function listWorkflows({ timeoutMs = 20000 } = {}) {
  const { ns } = resolveNamespace();
  const res = await fetch(`${ARCRUN_BASE}/webhooks/named`, {
    headers: headers(), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`列工作流失敗：HTTP ${res.status}（${ARCRUN_BASE}，namespace ${ns}）`);
  const body = await res.json();
  const arr = Array.isArray(body) ? body : (body.workflows || []);
  return arr.map((w) => w.name).filter(Boolean);
}

/**
 * 硬斷言：站表宣告要用的工作流，**必須真的在那台實例上**。
 * 缺了就丟例外——訊息要直接說「這一站的活現在沒人做」，不是「找不到 workflow」。
 */
export async function assertWorkflowsExist(names) {
  if (!names || !names.length) return { checked: [], base: ARCRUN_BASE, ns: null };
  const { ns, source } = resolveNamespace();
  let live;
  try {
    live = await listWorkflows();
  } catch (e) {
    throw new Error(
      `連不上 leo 的 Arcrun 實例，無法確認站表宣告的工作流還在不在：${e.message}\n` +
      `     站表有 ${names.length} 站的活是派給工作流做的（${names.join('、')}），\n` +
      `     連不上就等於「不知道那些活有沒有人做」——不放行。\n` +
      `     → 實例位置可用 ARCRUN_SHIP_BASE 覆寫；真的要在實例掛掉時出貨，先把那幾站改回本機並寫明理由。`);
  }
  const missing = names.filter((n) => !live.includes(n));
  if (missing.length) {
    // 🔴「查無此物」與「查錯對象」長得一模一樣（2026-08-15 事故，wiki/ops-facts.md 記過）：
    //   這台實例底下一支工作流都沒有時，讀訊息的人第一反應常是「實例是空的／掛了」，
    //   但更常見的真相是 namespace 問錯了。這個 namespace 值從哪來（環境變數還是
    //   config.yaml）也印出來，讓人不必再猜一次。
    const emptyHint = live.length === 0
      ? `\n     ⚠️ 這個 namespace 下**一支工作流都沒有**——這通常代表 namespace 問錯了，\n` +
        `        不是這台實例真的是空的（「查無此物」與「查錯對象」長得一模一樣）。\n` +
        `        目前用的 namespace：${ns}（來源：${source}）。確認這是不是使用者現在真正在用的 namespace，\n` +
        `        必要時到 ~/.arcrun/config.yaml 核對 \`api_key\` 欄位，或用 ARCRUN_SHIP_NS 覆寫再試一次。`
      : '';
    throw new Error(
      `站表把這幾站的活派給 Arcrun 工作流，但那台實例上**沒有這些工作流**：${missing.join('、')}\n` +
      `       實例 ${ARCRUN_BASE}（namespace ${ns}，來源：${source}）現有：${live.join('、') || '（一個都沒有）'}\n` +
      `     ⇒ 這一站的活現在沒有任何人做，而站表宣告它有人做。這正是 D70 要擋的「宣告與現實脫節」。${emptyHint}\n` +
      `     → 把工作流部署上去，或把那一站改回 \`用什麼: 本機\` 並寫明本機理由（站表閘會要求）。`);
  }
  return { checked: names, base: ARCRUN_BASE, ns };
}

/**
 * 觸發一個工作流並拿回它的結果。
 *
 * 成功判準跟 `notify_leo` 的規矩一樣（頂層 `wiki/agent-memory.md` 記過這個坑）：
 * **外層 success 為真不代表真的成功**，要看內層 data——外層 200／內層 404 發生過。
 * 所以這裡回傳內層 `data`，並把外層失敗與內層 `success:false` 都轉成例外。
 */
export async function runWorkflow(name, input, { timeoutMs = 120000 } = {}) {
  const { ns } = resolveNamespace();
  let res;
  try {
    res = await fetch(`${ARCRUN_BASE}/webhooks/named/${ns}/${name}/trigger`, {
      method: 'POST', headers: headers(), body: JSON.stringify(input || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`工作流 ${name} 打不通（${ARCRUN_BASE}）：${e.message}`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`工作流 ${name} 回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (!res.ok || body.success === false) {
    throw new Error(`工作流 ${name} 執行失敗（HTTP ${res.status}）：${JSON.stringify(body).slice(0, 400)}`);
  }
  // 外層包一層 data；內層才是工作流自己的輸出（外層成功內層失敗發生過，見檔頭）。
  const inner = body.data && typeof body.data === 'object' && 'data' in body.data ? body.data.data : body.data;
  return inner === undefined ? body : inner;
}

/**
 * `ship_check_live` 的呼叫端包裝——「**去一個使用者會看的網址看一眼，回報它現在
 * 宣告什麼、跟期望的合不合**」。出貨管線多個地方共用它（見站表的 `也調用`）。
 *
 * 🔴 `headers` 與 `body_json` **一定要給**，即使是空的。
 *   實測（2026-08-11）：不給的話，工作流圖裡的 `{{input.headers}}` 不會被代換掉，
 *   會原封當成字串送進零件，零件回
 *   `cannot unmarshal string into Go struct field Input.headers of type map[string]string`
 *   ⇒ 抓不到內容，而每一項比對都變成「不合」＝**假紅**。
 *   假紅和假綠一樣糟（ship.mjs 的 verify 步驟為此寫過一整段）——所以這個預設值
 *   放在呼叫端，不讓每個呼叫點各自記得。
 *
 * `checks` 每一項：
 *   `{ label, path, expected }`             —— 從回應的 JSON 取 `path`，字串比對
 *   `{ label, mode:'contains', expected }`   —— 回應內文有沒有這段字（HTML 頁面用）
 *   `{ ..., negate:true }`                  —— 反過來：**不該**出現才算通過
 *
 * 回傳 `{ url, fetch_ok, fetch_error, results:[{label,expected,actual,ok}], all_ok }`。
 * 呼叫端要看的是 `fetch_ok` 與 `all_ok`——**外層 HTTP 200 什麼都不證明**。
 */
export async function checkLive({ url, method = 'GET', headers = {}, bodyJson = {}, checks = [], timeoutMs = 60000 }) {
  const out = await runWorkflow('ship_check_live', {
    url, method,
    headers: { Accept: 'application/json', ...headers },
    body_json: bodyJson,
    checks,
  }, { timeoutMs });
  if (!out || typeof out !== 'object') throw new Error(`ship_check_live 回的東西看不懂：${JSON.stringify(out).slice(0, 200)}`);
  return out;
}

/**
 * 把 `checkLive` 的結果攤成人看得懂的行（給 ship.mjs 的 detail 用）。
 *
 * 🔴 沒給 `expected` 的項目是**只問值、不比對**（例如「線上現在的釘子是什麼」）。
 *   工作流那端一律做比對，所以這種項目的 `ok` 必然是 false ——若照 `ok` 印成 ✗，
 *   報告上會出現一堆「失敗」而其實什麼都沒失敗。**看起來像壞的檢查，人很快就會學會
 *   忽略它**（ship.mjs verify 步驟為假陰性寫過同一段道理）⇒ 這裡分開呈現。
 *   同理，呼叫端要判成敗時**不要看 `all_ok`**，要看自己真正在乎的那幾項。
 */
export function describeChecks(out) {
  const lines = [`Arcrun ship_check_live → ${out.url}｜抓得到：${out.fetch_ok ? '是' : `否（${out.fetch_error}）`}`];
  for (const r of out.results || []) {
    if (r.expected === undefined || r.expected === null) {
      lines.push(`   · ${r.label}：讀到 ${r.actual === undefined ? '(沒有這個欄位)' : r.actual}`);
    } else {
      lines.push(`   ${r.ok ? '✓' : '✗'} ${r.label}：期望 ${r.expected}／實際 ${r.actual === undefined ? '(沒有這個欄位)' : r.actual}`);
    }
  }
  return lines;
}
