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
 * ── 實例位置可覆寫，但預設寫死 leo 那台 ────────────────────────────────────
 * 預設 `https://arcrun-cypher-executor.leo21c.workers.dev` ＋ namespace `leo`，
 * 因為 D70 的判準是「**leo** 打開工作流頁看得到嗎」——工作流要住在他自己那台，
 * 不是住在某個測試實例上（住錯地方＝他看不到＝等於沒做）。
 * 換實例走環境變數 `ARCRUN_SHIP_BASE` / `ARCRUN_SHIP_NS`，不改程式碼。
 */
export const ARCRUN_BASE = process.env.ARCRUN_SHIP_BASE || 'https://arcrun-cypher-executor.leo21c.workers.dev';
export const ARCRUN_NS = process.env.ARCRUN_SHIP_NS || 'leo';

const headers = () => ({ 'content-type': 'application/json', 'X-Arcrun-API-Key': ARCRUN_NS });

/** 這台實例上這個 namespace 有哪些工作流（名字陣列）。 */
export async function listWorkflows({ timeoutMs = 20000 } = {}) {
  const res = await fetch(`${ARCRUN_BASE}/webhooks/named`, {
    headers: headers(), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`列工作流失敗：HTTP ${res.status}（${ARCRUN_BASE}，namespace ${ARCRUN_NS}）`);
  const body = await res.json();
  const arr = Array.isArray(body) ? body : (body.workflows || []);
  return arr.map((w) => w.name).filter(Boolean);
}

/**
 * 硬斷言：站表宣告要用的工作流，**必須真的在那台實例上**。
 * 缺了就丟例外——訊息要直接說「這一站的活現在沒人做」，不是「找不到 workflow」。
 */
export async function assertWorkflowsExist(names) {
  if (!names || !names.length) return { checked: [], base: ARCRUN_BASE, ns: ARCRUN_NS };
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
    throw new Error(
      `站表把這幾站的活派給 Arcrun 工作流，但那台實例上**沒有這些工作流**：${missing.join('、')}\n` +
      `       實例 ${ARCRUN_BASE}（namespace ${ARCRUN_NS}）現有：${live.join('、') || '（一個都沒有）'}\n` +
      `     ⇒ 這一站的活現在沒有任何人做，而站表宣告它有人做。這正是 D70 要擋的「宣告與現實脫節」。\n` +
      `     → 把工作流部署上去，或把那一站改回 \`用什麼: 本機\` 並寫明本機理由（站表閘會要求）。`);
  }
  return { checked: names, base: ARCRUN_BASE, ns: ARCRUN_NS };
}

/**
 * 觸發一個工作流並拿回它的結果。
 *
 * 成功判準跟 `notify_leo` 的規矩一樣（頂層 `wiki/agent-memory.md` 記過這個坑）：
 * **外層 success 為真不代表真的成功**，要看內層 data——外層 200／內層 404 發生過。
 * 所以這裡回傳內層 `data`，並把外層失敗與內層 `success:false` 都轉成例外。
 */
export async function runWorkflow(name, input, { timeoutMs = 120000 } = {}) {
  let res;
  try {
    res = await fetch(`${ARCRUN_BASE}/webhooks/named/${ARCRUN_NS}/${name}/trigger`, {
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
