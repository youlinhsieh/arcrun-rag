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
 * ── 實例位置與 namespace 同源（2026-08-20 訂正）─────────────────────────────
 * 🔴 舊寫法把 `https://arcrun-cypher-executor.leo21c.workers.dev` **寫死成預設**，
 * 理由是「D70 的判準是 leo 打開工作流頁看得到嗎，所以工作流要住他那台」。
 * **那個前提 leo 2026-08-20 推翻了**：
 *   「出貨跟 leo21c 無關，**它只是一個普通用戶**。」
 *   「leo21c 就是我這個普通用戶，**不應該讓你去操控**，我只用公開的更新。」
 *   「youlin ＝ stage，geek6688 ＝ 測試 prod ＆ 出貨機，uncle6 ＝ 中心服務⋯⋯
 *     你要實驗當然是放在 youlin。」
 * ⇒ 出貨線的輔助工作流屬於 **AI 的 stage（youlin）**，不是使用者的個人實例。
 *
 * 🔴 更根本的：**網址與 namespace 本來就該來自同一個地方。**
 * 舊寫法網址寫死、namespace 現讀 `~/.arcrun/config.yaml` ⇒ 使用者一改設定，
 * 兩個值就分家，而症狀是「這個 namespace 下一支工作流都沒有」——
 * 看起來像實例是空的，其實是**在 A 實例上問 B 的 namespace**。
 * （2026-08-20 實撞：把預設切到 youlin 後，出貨線立刻炸在這裡。）
 * ⇒ 現在兩者都現讀同一個檔，**沒有寫死的預設值可以頂**——
 *   與本檔對 namespace 已經採用的原則一致：「不再猜一個值頂著」。
 * 換實例走環境變數 `ARCRUN_SHIP_BASE`，不改程式碼。
 *
 * ── 🔴 2026-09-01：這條規則整個搬去 Arcrun 了（inkstone/Arcrun#195）────────────
 * 上面那段講的道理一個字都沒變，變的是**它住在哪裡**。
 *
 * 病：上面那個「現讀 `~/.arcrun/config.yaml`」的解法，把座標綁在**某個人的家目錄**上。
 * 家目錄不隨 clone 走 ⇒ 一台乾淨的雲端 container 出不了貨，而原因跟它的能力無關。
 * leo 2026-09-01：「**只要它的環境有能力，它就要可以做到，我不是用限制讓它變笨。**」
 * 並指定歸屬：「（`ARCRUN_SHIP_*` 住哪）**你決定，總之會在 Arcrun，而不是 Arcrun RAG。**」
 *
 * ⇒ 規則的原稿現在在 `<Arcrun>/shared/instance-coordinates/`（形態同
 *   `shared/resource-rule/`：零依賴、誰都可以 import）：
 *     · 非機敏的一半（誰是誰、網址）**隨 Arcrun repo 走** ⇒ 乾淨機器不必有人放檔案
 *     · 機敏的一半（namespace）走環境變數，目錄裡只寫變數的名字 ⇒ 值不進版控
 *     · 兩者**成對取用**——上面那段講的分家事故，現在是那支模組的硬規則
 *
 * 🔴 本檔不再自己判斷座標，只**轉接**：`ARCRUN_SHIP_BASE` / `ARCRUN_SHIP_NS` /
 *   `ARCRUN_SHIP_CONFIG` 三個環境變數的行為一字未改（上游把它們收在第一層），
 *   本機那條路（讀 `~/.arcrun/config.yaml`）也一字未改。
 *   **不准在這裡加第二套判斷**——那正是這張票要拔掉的東西。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findArcrunRoot } from './resource-rule-sync.mjs';
import { fill as fillFromEnvFiles } from './credential-store.mjs';

/**
 * 座標規則的原稿在 Arcrun repo 裡（見檔頭 2026-09-01 那段）。
 *
 * 找法**沿用既有的那一支**（`resource-rule-sync.mjs` 的 `findArcrunRoot`：
 * 環境變數 `ARCRUN_REPO_ROOT` → `ship.targets.json` 的 `source.arcrunRepo` → 並列位置）
 * ——這條線已經有一套「上游 repo 在哪」的答案了，不要再發明第二套。
 *
 * 🔴 載入失敗**不在 import 時炸**：本檔還有別的匯出（`describeChecks` 等）不需要座標，
 *   而 import 期丟例外會讓整個出貨線在「還沒決定要不要用 Arcrun」之前就死掉。
 *   ⇒ 記下失敗原因，等真的有人要座標時才丟出來。
 */
const UPSTREAM_REL = join('shared', 'instance-coordinates', 'resolve.mjs');
let upstream = null;
let upstreamError = null;
try {
  const root = findArcrunRoot();
  const file = join(root, UPSTREAM_REL);
  if (!existsSync(file)) {
    throw new Error(
      `找到 Arcrun repo（${root}），但裡面沒有 ${UPSTREAM_REL}\n` +
      `     ⇒ 那個 clone 比 inkstone/Arcrun#195 舊。到那個目錄 \`git pull\` 到最新 main 再跑一次。`);
  }
  upstream = await import(pathToFileURL(file).href);
} catch (e) {
  upstreamError = e instanceof Error ? e.message : String(e);
}

/**
 * 取座標；上游模組載不到就在**這一刻**說清楚為什麼。
 * `need` ＝這次真的需要哪幾格——問 namespace 的人不該收到「缺實例網址」。
 * @param {Array<'base'|'namespace'>} need
 */
function coordinates(need) {
  if (!upstream) {
    throw new Error(
      `讀不到 Arcrun 的實例座標規則（${UPSTREAM_REL}）：${upstreamError}\n` +
      `     → 出貨線本來就需要 Arcrun 的工作區（\`build\` 那一站的輸入就是它），\n` +
      `       設 ARCRUN_REPO_ROOT=/path/to/Arcrun 或確認 ship.targets.json 的 source.arcrunRepo 指得對。`);
  }
  return upstream.resolveInstanceCoordinates({ require: need });
}

/**
 * 實例網址：轉接上游 `<Arcrun>/shared/instance-coordinates/resolve.mjs`。
 *
 * 回傳形狀（`{ base, source }`）與呼叫端一字未改——`source` 現在由上游填，
 * 它會說出「這個值是環境變數給的、還是目錄給的、還是設定檔給的」，
 * 讀錯誤訊息的人不必自己猜（本檔原本就是為了這件事才回傳 source）。
 *
 * 不快取：上游每次現讀（含 `ARCRUN_SHIP_CONFIG` 路徑本身），
 * 測試才能在同一個 process 裡切不同的假設定檔。
 */
export function resolveArcrunBase() {
  const r = coordinates(['base']);
  return { base: r.base, source: r.sources.base };
}

/**
 * namespace（self-hosted 的身分明碼）：同上，轉接上游。
 *
 * 🔴 這裡**不再有任何自己的判斷**。舊版在本檔裡排了一套順序
 * （環境變數 → `~/.arcrun/config.yaml` → 丟例外），而那套順序漏掉了
 * 「這台機器上根本沒有那個檔」這一格——它正是雲端 container 的常態。
 * 現在那個順序住在上游，而且**網址與 namespace 是成對取的**（見上游 README §2.1）。
 */
export function resolveNamespace() {
  const r = coordinates(['namespace']);
  return { ns: r.namespace, source: r.sources.namespace };
}

/**
 * 把實例目錄宣告的 namespace 環境變數（`namespace_env`）從 `.env` 補進本行程——**只補空的**。
 *
 * ── 為什麼要有這支（2026-09-13，inkstone/arcrun-rag#27 comment 7121）───────────────
 * 實撞：`node installer/scripts/ship.mjs --target stage` 在第一站之前就 exit 2——
 * 「連不上 leo 的 Arcrun 實例：fetch failed」。
 *   · 上游解析順序是 ①環境變數覆寫 ②實例目錄＋該實例的 namespace 環境變數 ③`~/.arcrun/config.yaml`
 *   · 實例目錄早已改指 youlin 09-02 重裝後的子網域 `arcrun-yuga3bse`（inkstone/Arcrun#196 `22c314b`）
 *   · 但 `ARCRUN_NS_YOULIN` 只住在頂層 `.env`，**一般 shell 裡沒有它** ⇒ 第②層不出手
 *     ⇒ 落到第③層 ⇒ 那份家目錄設定還寫著 09-02 重裝前的舊子網域（CF API 實查：
 *     帳號子網域現為 `arcrun-yuga3bse`；那個舊主機名在本機／1.1.1.1／8.8.8.8 都查無 DNS）。
 * ⇒ **目錄是對的，只是走不到**。這不是座標判斷錯，是「值在 `.env`、管線沒去拿」——
 *   與 #102（出貨金鑰由管線自己去 `.env` 取）同一個病，所以**沿用同一支 `credential-store.fill`**，
 *   不另開一條路。
 *
 * ── 2026-09-13 同晚第二段（comment 7168）：要打哪一台由登錄簿**指名**，不再靠「環境裡剛好只有一台」──
 * leo：「**這應該是測試環境，應該用 uncle6 的帳號是主要服務**」。舊版把目錄裡**每一台**的 namespace
 * 都補進來、交給上游「環境裡只有一台就是它」去挑——目錄只有 youlin 時等於永遠挑 youlin（stage），
 * 目錄一加 uncle6 就變成兩台都有值 ⇒ 上游拒絕替你挑。⇒ 改成呼叫端傳 `instance`
 * （出貨線從 `ship.targets.json` 的 `workflowHost.instance` 讀），這支把 `ARCRUN_SHIP_INSTANCE`
 * 設成它、**只補那一台**的 namespace 變數。別台的 namespace 一個都不碰（D36：只取被點名的鍵）。
 *
 * 🔴 本檔檔頭「不准加第二套判斷」照樣成立：這裡**不讀網址、不推斷**——「用哪一台」是登錄簿的宣告，
 *   網址與 namespace 仍由上游 `resolveInstanceCoordinates` 從目錄成對取出（`ARCRUN_SHIP_INSTANCE`
 *   本來就是上游第②層認得的指名變數）。
 *
 * 不動的三條（同 #102）：
 *   ① 操作者在 shell 已給任何覆寫（網址／namespace／指名實例）⇒ **整支不出手**，他的選擇贏
 *   ② 已有值的鍵不覆蓋（`fill` 本來就只填空的）
 *   ③ D36：只取被點名的鍵，回傳值裡沒有真身
 *
 * @param {{ instance: string, startDir?: string, env?: Record<string, string|undefined>, stopAt?: string,
 *           catalog?: { path?: string, instances: Record<string, { namespace_env?: string }> } }} opts
 * @returns {{ instance: string|null, names: string[], resolved: Array<{name: string, source: string}>,
 *             missing: string[], searched: string[], skipped: string|null }}
 */
export function fillInstanceNamespaces({ instance, startDir, env = process.env, stopAt, catalog } = /** @type {any} */ ({})) {
  const empty = (skipped, names = []) => ({ instance: null, names, resolved: [], missing: [], searched: [], skipped });
  const overrideNames = [
    ...(upstream?.BASE_ENV_NAMES || ['ARCRUN_SHIP_BASE', 'ARCRUN_CYPHER_EXECUTOR_URL']),
    ...(upstream?.NAMESPACE_ENV_NAMES || ['ARCRUN_SHIP_NS', 'ARCRUN_NAMESPACE', 'NAMESPACE', 'ARCRUN_API_KEY']),
    ...(upstream?.INSTANCE_ENV_NAMES || ['ARCRUN_SHIP_INSTANCE', 'ARCRUN_INSTANCE']),
  ];
  const given = overrideNames.filter((n) => env[n] !== undefined && String(env[n]).trim() !== '');
  if (given.length) return empty(`操作者已在 shell 指定 ${given.join('、')}（不代補）`);

  if (typeof instance !== 'string' || !instance.trim()) {
    throw new Error(
      '出貨線沒有指名要打哪一台 Arcrun 實例（ship.targets.json 的 workflowHost.instance 是空的）。\n' +
      '     → 那一格填實例目錄裡的名字（leo 2026-09-13：出貨線用 uncle6，inkstone/arcrun-rag#27 c7168）。');
  }
  let cat = catalog;
  if (!cat) {
    if (!upstream) return empty(`讀不到 Arcrun 的實例目錄（${upstreamError}）`);
    cat = upstream.readCatalog();
  }
  const entry = (cat.instances || {})[instance];
  if (!entry || !entry.namespace_env) {
    throw new Error(
      `ship.targets.json 指名出貨線打「${instance}」，但 Arcrun 的實例目錄裡沒有這一台` +
      `（${cat.path || 'instances.json'} 現有：${Object.keys(cat.instances || {}).join('、') || '（空的）'}）。\n` +
      '     → 那份目錄隨 Arcrun repo 走：到 Arcrun 工作區 `git pull` 到含這一台的 main，或設 ARCRUN_REPO_ROOT 指到含它的 clone。');
  }
  env.ARCRUN_SHIP_INSTANCE = instance;
  const names = [entry.namespace_env];
  return { instance, names, ...fillFromEnvFiles(names, { startDir, env, stopAt }), skipped: null };
}

/** 日誌用：namespace 只露前兩碼與長度（出貨線的輸出會被貼進票裡）。 */
export function maskNamespace(ns) {
  const s = String(ns ?? '');
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 2))}（長度 ${s.length}）`;
}

const headers = () => ({ 'content-type': 'application/json', 'X-Arcrun-API-Key': resolveNamespace().ns });

/** 這台實例上這個 namespace 有哪些工作流（名字陣列）。 */
export async function listWorkflows({ timeoutMs = 20000 } = {}) {
  const { ns } = resolveNamespace();
  const { base: ARCRUN_BASE } = resolveArcrunBase();
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
  if (!names || !names.length) return { checked: [], base: resolveArcrunBase().base, ns: null };
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
      `       實例 ${resolveArcrunBase().base}（namespace ${ns}，來源：${source}）現有：${live.join('、') || '（一個都沒有）'}\n` +
      `     ⇒ 這一站的活現在沒有任何人做，而站表宣告它有人做。這正是 D70 要擋的「宣告與現實脫節」。${emptyHint}\n` +
      `     → 把工作流部署上去，或把那一站改回 \`用什麼: 本機\` 並寫明本機理由（站表閘會要求）。`);
  }
  return { checked: names, base: resolveArcrunBase().base, ns };
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
    const { base: ARCRUN_BASE } = resolveArcrunBase();
    res = await fetch(`${ARCRUN_BASE}/webhooks/named/${ns}/${name}/trigger`, {
      method: 'POST', headers: headers(), body: JSON.stringify(input || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`工作流 ${name} 打不通（${resolveArcrunBase().base}）：${e.message}`);
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
