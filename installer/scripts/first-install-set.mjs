/**
 * first-install-set.mjs — **首裝要裝哪幾顆，由「產品的基本功能」推導出來，沒有人在維護清單。**
 *
 * ── leo 2026-08-14（Arcrun#125，這支腳本存在的全部理由）──────────────────────
 * > 「**懶載一定要包含 ingest，這是它的基本功能，沒有它就只是 Arcrun，有它才是 Arcrun RAG。**」
 * > 「點到才下載的模型就是來自『一切零件由 Arcrun 包好，而不是出貨時 build』，
 * >   另外，『下載就給個清單觸發下載』。」
 *
 * ── 病史：為什麼「手寫一份首裝清單」必定再犯一次 ─────────────────────────────
 * 2026-08-14 的災情長這樣：首裝清單手寫了 6 顆，解憑證用的那顆不在裡面。
 * 但**每一支**安裝器會推的產品工作流都寫著 `{{credential.…}}`
 * ⇒ cypher 每次解憑證都去 fetch 一顆不存在的 worker ⇒ `error code: 1042`
 * ⇒ **每支工作流 500，ingest 與查詢全死**。三台實測：youlin ❌／leo21c ❌／
 *   geek6688（手工維護、零件齊全）✅ ⇒ **出貨機測不出這個病。**
 *
 * 沒有人做錯事——**那份清單根本沒有辦法自己知道工作流需要什麼**。
 * 所以本檔不接受任何「再寫一份清單、這次記得寫對」的修法：
 *
 *   首裝清單 ＝ 引擎底盤（4 顆，逐顆寫明理由）
 *              ∪ **從安裝器真的會推的那幾支工作流身上推導出來的零件**
 *
 * 改工作流 ⇒ 清單自己跟著改。**沒有人需要記得。**
 *
 * ── 佔位符那張表也不手寫 ────────────────────────────────────────────────────
 * `__CODE_URL__` 會被換成哪顆 worker 的網址，真相在**安裝器自己**那份代換表
 * （出貨的那顆安裝器＝`installer/oauth-prototype/worker.js`，路徑由呼叫端傳進來）。
 * 本檔**讀那支檔案**把它取出來，不另外抄一份——抄一份就是 arcrun-rag#27／D48 的病
 * （兩份人維護的清單必然漂移）。
 *
 * ── 兩條讓它不會安靜漂掉的規則 ───────────────────────────────────────────────
 * ① 推導遇到**看不懂的東西**（安裝器沒宣告過的佔位符、不在公庫裡的零件）⇒ **丟例外**，
 *   不是跳過。安靜跳過就是 2026-08-14 那個洞的形狀：清單少一顆而沒有人會知道。
 * ② 推出來的每一顆都帶 `why`（哪一支工作流的哪一個節點要它）⇒
 *   出貨報告印得出來，人看得懂「為什麼這顆要進首裝」。
 */
import { readFileSync } from 'node:fs';

/**
 * 引擎底盤——**不是**從工作流推導得出的那幾顆，所以要逐顆寫明「為什麼它非首裝不可」。
 * 判準是 leo 的那句話：**沒有它，這台機器就不是「Arcrun RAG」。**
 */
export const ENGINE_BASELINE = [
  {
    name: 'arcrun-cypher-executor',
    why: '工作流引擎本身。沒有它，這台機器上什麼都不會執行。',
  },
  {
    name: 'arcrun-kbdb',
    why: '知識庫資料層。ingest 寫進去、查詢讀出來，都只有這一個入口（D38：一律 API）。',
  },
  {
    name: 'arcrun-rag-ui',
    why: 'portal 前端。這是使用者**唯一**看得到的畫面——沒有它，裝完等於沒有產品。',
  },
  {
    name: 'arcrun-mcp',
    why:
      'leo 2026-08-10：「今天只要清單含有 MCP 即可」。產品承諾是「把自己的 AI 接上自己的知識庫」，' +
      'MCP 就是那條線；缺它的話那句承諾從第一步就不成立（prod 1.4.30 曾整包沒有它）。',
  },
];

/**
 * 解憑證用的那顆。
 *
 * 為什麼 `{{credential.X}}` 一出現就必須把它算進首裝：
 * cypher 遇到 `{{credential.…}}` 會去 fetch 這顆 worker 把值取回來
 * （`cypher-executor/src/graph-executor.ts` 的 `resolveCredentialRefs`）。
 * 它**不是使用者會擺在工作流裡的零件**，所以任何「掃 component 欄位」的做法都看不到它
 * ——這正是 2026-08-14 漏掉它的原因。
 */
export const CREDENTIAL_RESOLVER = 'arcrun-auth-static-key';

/** `snake_case` → worker 名（`arcrun-<kebab>`）。與零件自己 wrangler.toml 的 name 同一套慣例。 */
export function canonicalToWorkerName(canonical) {
  return `arcrun-${String(canonical).replace(/_/g, '-')}`;
}

/**
 * 從安裝器原始碼讀出「佔位符各自會被換成什麼」。
 *
 * 掃 `'__佔位符__': <值>` 這種寫法，並判斷那個值是不是一顆 worker 的網址：
 *   · 值裡有 `https://<worker 名>.${…}.workers.dev`      ⇒ 指向那顆 worker
 *   · 值是個變數名，而那個變數在同一支檔案裡被指派成上面那種網址 ⇒ 同上（解一層）
 *   · 其餘                                                ⇒ 純參數（會被換成一段字串）
 *
 * 🔴 解不出來的一律當「純參數」是**不安全**的，所以呼叫端的推導遇到
 *   「某個節點把某個純參數當零件位址用」時會丟例外，而不是安靜接受。
 *
 * @returns {{ urlPlaceholders: Record<string,string>, paramPlaceholders: Set<string> }}
 */
export function loadInstallerPlaceholders(installerSrcPath) {
  const src = readFileSync(installerSrcPath, 'utf8');
  const WORKER_URL = /https:\/\/([a-z0-9-]+)\.\$\{[^}]*\}\.workers\.dev/;

  // 變數 → worker 名（解一層識別字，例如 `workerUrl` 被指派成 cypher 的網址）
  const varToWorker = {};
  for (const m of src.matchAll(/(\w+)\s*=\s*`https:\/\/([a-z0-9-]+)\.\$\{[^}]*\}\.workers\.dev/g)) {
    varToWorker[m[1]] = m[2];
  }

  const urlPlaceholders = {};
  const paramPlaceholders = new Set();
  for (const m of src.matchAll(/(['"])(__[A-Z0-9_]+__)\1\s*:\s*([^,\n]+)/g)) {
    const ph = m[2];
    const value = m[3].trim();
    const direct = value.match(WORKER_URL);
    if (direct) { urlPlaceholders[ph] = direct[1]; continue; }
    const ident = value.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident && varToWorker[ident[1]]) { urlPlaceholders[ph] = varToWorker[ident[1]]; continue; }
    paramPlaceholders.add(ph);
  }

  if (!Object.keys(urlPlaceholders).length) {
    throw new Error(
      `從 ${installerSrcPath} 讀不到任何「佔位符→worker」的對應——安裝器換寫法了？\n` +
      `  ⇒ 本檔靠讀安裝器那段來算首裝清單。讀不到就**不准猜**（猜錯的後果是裝完 1042）。`);
  }
  return { urlPlaceholders, paramPlaceholders };
}

/**
 * 讀出「哪些 canonical id 其實是 **recipe**，不是零件 worker」。
 *
 * 為什麼要分：工作流寫 `component: workers_ai_chat`，看起來跟寫 `component: set` 一模一樣，
 * 但前者是 cypher 內建的 API recipe（走 `env.AI` binding，**不需要任何 worker**），
 * 後者是一顆真的要被部署的 worker。分不出來的話，推導不是多裝一顆不存在的東西，
 * 就是把真的缺的那顆當成 recipe 放過——**後者正是 2026-08-14 那個病**。
 *
 * 真相源＝Arcrun 的 recipe 種子檔（cypher 自己啟動時 seed 進去的那份），不另抄一份。
 */
export function loadRecipeIds(arcrunRepoRoot) {
  const path = `${arcrunRepoRoot}/cypher-executor/src/lib/api-recipe-seeds.ts`;
  const src = readFileSync(path, 'utf8');
  const ids = new Set([...src.matchAll(/canonical_id\s*:\s*['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]));
  if (!ids.size) {
    throw new Error(`從 ${path} 讀不到任何 recipe canonical_id——檔案改寫法了？讀不到就不准猜。`);
  }
  return ids;
}

/** 從一個完整 worker 網址取出 worker 名（`https://arcrun-set.sub.workers.dev` → `arcrun-set`）。 */
function workerNameFromUrl(url) {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/**
 * 從「安裝器真的會推的那幾支工作流」推導出**必須首裝**的零件。
 *
 * @param {Array<object>} workflows `installer/src/workflows.json` 的內容
 * @param {{ placeholders: {urlPlaceholders: Record<string,string>, paramPlaceholders: Set<string>},
 *           library?: Set<string>|string[] }} opts
 * @returns {{ required: string[], evidence: Array<{ worker: string, why: string }>, warnings: string[] }}
 * @throws 遇到安裝器沒宣告過的佔位符／公庫沒有的零件 ⇒ 丟例外（安靜跳過就是本檔要解的那個病）
 */
export function deriveFromWorkflows(workflows, opts) {
  const { urlPlaceholders, paramPlaceholders } = opts.placeholders;
  const library = opts.library ? new Set(opts.library) : null;
  const recipes = opts.recipes ? new Set(opts.recipes) : null;
  const evidence = [];
  const warnings = [];
  const seen = new Set();
  const add = (worker, why) => {
    const key = `${worker} ${why}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ worker, why });
  };

  for (const wf of workflows || []) {
    const wfName = wf?.name || wf?.file || '(無名工作流)';
    const config = wf?.config || {};

    for (const [nodeId, node] of Object.entries(config)) {
      const component = node && node.component;
      if (typeof component !== 'string' || !component) continue;

      if (/^__[A-Z0-9_]+__$/.test(component)) {
        const worker = urlPlaceholders[component];
        if (!worker) {
          throw new Error(
            `${wfName} 的節點 ${nodeId} 把 ${component} 當成零件位址，但安裝器沒有把它換成任何 worker 網址。\n` +
            `  ⇒ 這代表「首裝要裝哪幾顆」此刻算不準，而算不準的後果是裝完 1042（Arcrun#124）。\n` +
            `  ⇒ 去安裝器的代換表把它接上，或改用零件的 canonical id。`);
        }
        add(worker, `${wfName}／${nodeId} 用 ${component}`);
        continue;
      }

      if (/^https?:\/\//.test(component)) {
        const worker = workerNameFromUrl(component);
        if (!worker) throw new Error(`${wfName} 的節點 ${nodeId} 的 component 是個解不開的網址：${component}`);
        add(worker, `${wfName}／${nodeId} 直接指向 ${worker}`);
        continue;
      }

      // 其餘＝canonical id。可能是一顆零件 worker，也可能是 cypher 內建的 recipe。
      if (recipes && recipes.has(component)) continue;   // recipe 不需要任何 worker
      add(canonicalToWorkerName(component), `${wfName}／${nodeId} 用零件 ${component}`);
    }

    // 憑證：掃整支工作流的文字，只要出現 `{{credential.…}}` 就需要解憑證的那顆。
    const raw = JSON.stringify(wf);
    const creds = [...new Set([...raw.matchAll(/\{\{credential\.([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]))];
    if (creds.length) {
      add(CREDENTIAL_RESOLVER, `${wfName} 用 {{credential.${creds.join('／')}}}，解憑證要打這顆`);
    }

    // 未知佔位符掃描：工作流全文裡任何 `__XXX__`，安裝器沒宣告過＝它會原封不動被推上去。
    //
    // 為什麼這裡**不**丟例外（與上面「零件位址用了不認得的佔位符」不同）：
    //   出現在零件位址上 ⇒ 直接決定首裝清單算不算得準 ⇒ 算不準就不准出貨。
    //   出現在別的欄位   ⇒ 是「這個參數沒被代換」的 bug，真實但**與首裝清單無關**；
    //                     在這裡擋下等於用零件的閘去卡一個參數的病，會讓兩件事互相綁架。
    // ⇒ 所以照實回報，由呼叫端印出來。**它不是被忽略，是被看見了。**
    for (const ph of new Set([...raw.matchAll(/__[A-Z0-9_]+__/g)].map((m) => m[0]))) {
      if (urlPlaceholders[ph] || paramPlaceholders.has(ph)) continue;
      warnings.push(
        `${wfName} 用了 ${ph}，但安裝器的代換表沒有它 ⇒ 這個佔位符會原封不動被推進使用者的工作流。`);
    }
  }

  const required = [...new Set(evidence.map((e) => e.worker))].sort();

  if (library) {
    const missing = required.filter((n) => !library.has(n));
    if (missing.length) {
      throw new Error(
        `工作流需要 ${missing.join('、')}，但公庫裡沒有這幾顆。\n` +
        `  ⇒ 公庫＝Arcrun 的 .worker-builds/。缺的那顆要嘛沒被編（去 Arcrun 補），\n` +
        `     要嘛被判定不出貨（看該 manifest 的 excluded 欄位說了什麼）。\n` +
        `  ⇒ **不准就這樣出貨**：這正是 2026-08-14 那台「裝完什麼都不能做」的實例的成因。`);
    }
  }

  return { required, evidence, warnings };
}

/**
 * 首裝清單＝引擎底盤 ∪ 工作流推導。
 *
 * @returns {{ names: string[], reasons: Array<{ worker: string, why: string }>, warnings: string[] }}
 */
export function firstInstallSet(workflows, opts) {
  const { evidence, warnings } = deriveFromWorkflows(workflows, opts);
  const reasons = [
    ...ENGINE_BASELINE.map((b) => ({ worker: b.name, why: b.why })),
    ...evidence,
  ];
  const names = [...new Set(reasons.map((r) => r.worker))].sort();
  return { names, reasons, warnings };
}

/**
 * 對帳：一份 `manifest.core`（＝安裝器真的會部署的那幾顆）是不是恰好等於推導結果。
 * 多一顆＝使用者白付 worker 成本；少一顆＝裝完不能用。兩種都當場失敗。
 */
export function diffFirstInstall(core, workflows, opts) {
  const { names, warnings } = firstInstallSet(workflows, opts);
  const have = new Set((core || []).map((c) => c && c.name).filter(Boolean));
  const want = new Set(names);
  const missing = names.filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  return { want: names, missing, extra, warnings, ok: missing.length === 0 && extra.length === 0 };
}
