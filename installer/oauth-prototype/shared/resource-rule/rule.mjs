// @ts-check
/**
 * rule.mjs — 「這個實例該用哪些資源」的**唯一一份**規則。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 這份檔案為什麼在這裡（`shared/`），不在 `cli/`
 * ─────────────────────────────────────────────────────────────────────────────
 * leo 2026-08-12：「根本就不應該在 CLI，我要的是一個大家都可以用到的規則。」
 *
 * `.claude/rules/07-thin-shell.md` 的判準口訣：
 *   「這段邏輯換一個介面要不要重寫？」要重寫 → 它是能力，該在共用層。
 *
 * 「該沿用哪幾顆資源」換到安裝器就得重寫一次 ⇒ 它是**能力**，不是薄殼的事。
 * 而它原本住在 `cli/src/lib/resource-resolver.ts` ⇒ 那本身就是違規，
 * 後果也真的發生了：`acr` 那條有這條規則、安裝器那條沒有，於是安裝器照名字找、
 * 找不到就建新的空的 ⇒ Arcrun#97「我按了更新，工作流和登入全不見了」。
 *
 * ── 為什麼不是 cypher-executor 的 API 端點（薄殼原則的標準答案）────────────
 * **自舉**：這條規則要在「決定怎麼裝／怎麼更新」的當下就用得到，而那個當下
 * cypher 可能還不存在（安裝器的工作正是把它生出來），或正要被覆蓋。
 * 而且判斷的輸入是**使用者自己 Cloudflare 帳號上的綁定狀態**——
 * 把它送去一顆平台託管的 worker 換一個答案，等於①讓「能不能安裝」綁在平台是否活著，
 * ②把使用者的帳號拓撲交給第三方。兩件都不該為了形式上的漂亮而做。
 *
 * 薄殼原則要求的是「能力只實作一次」，不是「能力一定要是 HTTP」。
 * 這條規則是**純函式**（唯一的 IO 由呼叫端注入 `ResourceApi`），
 * 所以它用不著變成服務——一份零依賴的 ESM 就能讓每條路吃到同一份判斷。
 *
 * ── 怎麼讓兩條路吃到「同一份」而不是各留一份 ───────────────────────────────
 * 本檔是**唯一被人手維護的實作**，零依賴、不吃任何 node 內建、Workers runtime 可直接跑。
 *   · `acr`：`cli/src/lib/resource-rule.mjs` 是本檔的**逐位元組副本**，
 *     由 `scripts/sync-resource-rule.mjs` 產生（CLI 要能單獨 npm publish，
 *     套件目錄外的檔案打不進 tarball，故必須有這一份）。
 *     `npm run build` / `npm test` 都會跑 `--check`，內容一漂就紅。
 *     ——同 `cli/harness/`（產生物＋世代閘）的既有慣例。
 *   · 安裝器 / 任何 Worker：安裝器本來就會下載本 repo 的 archive（部署來源，
 *     見 `.claude/rules/05-deploy-convention.md`「WASM 來源」），
 *     直接 import 這一份 `shared/resource-rule/rule.mjs` 即可，**不需要再編一次、也不留副本**。
 *     用法見同目錄 README.md。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 規則本身（leo 的兩句話）
 * ─────────────────────────────────────────────────────────────────────────────
 * 「如果你沒有裝，就是新的；如果你已經有，原來叫什麼名字就繼續用下去。」
 *
 * 判準是「**這顆 worker 現在綁著誰**」，不是「有沒有叫這個名字的資源」：
 *   1. **已部署的 worker 上綁著什麼，那就是事實** → 原封不動沿用，不管那顆資源叫什麼名字。
 *   2. **只有「確定沒有任何人綁過它」才准新建**（新版本新增的 binding、或真的全新帳號）。
 *   3. **只要有一點說不準就整趟停手**（讀不到綁定／綁著的資源不見了／同一個 binding 指向兩顆／
 *      該更新的 worker 一顆都不在），**什麼都不建、什麼都不部署**，把話說清楚讓人來判斷。
 *
 * ── 為什麼拆成 plan / apply 兩段 ─────────────────────────────────────
 *   `planResources()` **完全不寫入**，只回一份「要沿用什麼、要新建什麼、有什麼不敢動的」。
 *   `applyResourcePlan()` 看到有任何 blocker 就直接拒絕執行。
 *   ⇒「被擋下的時候一顆資源都不會被建出來」是**結構上的保證**，
 *     不是靠某個人記得在對的地方寫 early return。#97 正是死在「先動手、後判斷」。
 *
 * 🔴 這份檔案沒有 import、也不准有。任何依賴都會讓某一條路吃不到它。
 */

/**
 * 這支負責的資源種類。要加新種類（R2/Queue/Hyperdrive…）就加在這裡，
 * 一律走同一道門——不准任何呼叫端自己「照名字 ensure」繞過去。
 * @typedef {'kv_namespace' | 'd1' | 'vectorize'} ResourceKind
 */

/**
 * 從已部署 worker 上讀回來的一條綁定。`value`：KV/D1 是資源 id，Vectorize 是 index 名。
 * @typedef {object} LiveBinding
 * @property {ResourceKind} kind
 * @property {string} binding
 * @property {string} value
 */

/**
 * @typedef {object} ScriptBindings
 * @property {boolean} deployed
 *   false = 這顆 worker 在帳號上還不存在（全新部署），不是「讀取失敗」。讀取失敗要 throw。
 * @property {LiveBinding[]} bindings
 * @property {Record<string, string>} [vars]
 *   這顆 worker 現在掛著的 `plain_text` var（名 → 值）。
 *
 *   🔴 Arcrun#106：#97 只把「資源類」綁定當成事實沿用（KV/D1/Vectorize），
 *     plain_text var 整批沒人管 ⇒ 重部署把它們洗成 repo toml 的預設值。
 *     最痛的一個是 `ARCRUN_BUNDLE_VERSION`（安裝器注入的版本標籤）——
 *     更新完就消失，Portal 設定頁變成「無法讀取目前版本」。
 *     **保留了櫃子，沒保留櫃子上的標籤**。這個欄位就是那些標籤。
 */

/**
 * 規則需要的 CF 能力（收窄成介面，方便離線測試餵假帳號，也讓安裝器用自己的 fetch 實作）。
 * @typedef {object} ResourceApi
 * @property {(script: string) => Promise<ScriptBindings>} getScriptBindings
 * @property {() => Promise<Map<string, string>>} listKvNamespaces  title → id
 * @property {() => Promise<Map<string, string>>} listD1Databases   name → uuid
 * @property {() => Promise<string[]>} listVectorizeIndexes
 * @property {(title: string) => Promise<string>} createKvNamespace
 * @property {(name: string) => Promise<string>} createD1Database
 * @property {(name: string) => Promise<string>} createVectorizeIndex
 */

/**
 * 「這顆 worker 需要這個 binding」。createName 只在**真的要新建**時才會被拿來當名字用。
 * @typedef {object} BindingRequirement
 * @property {ResourceKind} kind
 * @property {string} binding
 * @property {string} worker  需要它的 worker script 名（= wrangler.toml 的 `name`）。
 * @property {string} createName
 */

/**
 * @typedef {object} PlannedAdopt
 * @property {ResourceKind} kind
 * @property {string} binding
 * @property {string} value
 * @property {string} from  從哪顆已部署的 worker 上讀到的
 */

/**
 * @typedef {object} PlannedCreate
 * @property {ResourceKind} kind
 * @property {string} binding
 * @property {string} createName
 * @property {string[]} wantedBy
 * @property {string[]} alsoBind  其他也指向同一顆資源的 binding（見 shareSameResource）。建一顆，大家共用。
 */

/**
 * @typedef {object} ResourcePlan
 * @property {PlannedAdopt[]} adopt
 * @property {PlannedCreate[]} create
 * @property {string[]} blockers  非空 = 整趟停手。applyResourcePlan 會拒絕執行。
 * @property {Map<string, Record<string, string>>} liveVars
 *   每顆**已部署** worker 現在掛著的 plain_text var（script → 名/值）。未部署的不在裡面。
 *
 *   Arcrun#106：讀綁定的時候本來就把整份 `bindings[]` 拿回來了，var 就在同一份回應裡——
 *   順手帶出來，**不另外打一次 API**，也不新增一種「查不到」的失敗模式
 *   （讀不到綁定這件事已經在上面 blockers 那一關擋掉了）。
 */

/**
 * @typedef {object} ResolvedResource
 * @property {ResourceKind} kind
 * @property {string} binding
 * @property {string} value
 * @property {'adopted' | 'created'} origin
 * @property {string} [from]
 */

/**
 * @typedef {object} WranglerRequirements
 * @property {string} script  worker script 名（toml 頂層 `name`）。空字串 = 這份 toml 沒宣告 name（不該發生）。
 * @property {Array<{kind: ResourceKind, binding: string, createName: string}>} bindings
 */

/** plan 被擋下時丟這個，讓呼叫端能把每一條原因原文轉給使用者。 */
export class ResourcePlanBlocked extends Error {
  /** @param {string[]} blockers */
  constructor(blockers) {
    super(`資源解析被擋下（${blockers.length} 項）`);
    this.name = 'ResourcePlanBlocked';
    /** @type {string[]} */
    this.blockers = blockers;
  }
}

/**
 * @param {ResourceKind} kind
 * @param {string} binding
 * @returns {string}
 */
export function bindingKey(kind, binding) {
  return `${kind}:${binding}`;
}

/** @type {Record<ResourceKind, string>} */
export const KIND_LABEL = {
  kv_namespace: 'KV namespace',
  d1: 'D1 資料庫',
  vectorize: 'Vectorize index',
};

/**
 * @param {unknown} e
 * @returns {string}
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 決定每個 binding 要沿用哪顆資源／要不要新建，**不寫入任何東西**。
 *
 * @param {ResourceApi} api
 * @param {readonly BindingRequirement[]} requirements
 * @param {'update' | 'init'} mode
 *   'update' = 這台照定義已經裝過了（見下方「一顆都不在」規則）；'init' = 全新安裝，允許從零建。
 * @returns {Promise<ResourcePlan>}
 */
export async function planResources(api, requirements, mode) {
  /** @type {string[]} */
  const blockers = [];
  /** @type {PlannedAdopt[]} */
  const adopt = [];
  /** @type {PlannedCreate[]} */
  const create = [];

  // ── 1. 先讀「即將被覆蓋的每一顆 worker」現在綁著什麼 ──────────────────
  // 讀取失敗 ≠ 沒有綁。#97 的災情就是把「我查不到」當成「它不存在」。
  const scripts = [...new Set(requirements.map((r) => r.worker))].sort();
  /** @type {Map<string, LiveBinding[]>} */
  const live = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const liveVars = new Map();
  let readFailed = false;
  for (const script of scripts) {
    try {
      const res = await api.getScriptBindings(script);
      if (res.deployed) {
        live.set(script, res.bindings);
        // #106：同一份回應裡的 plain_text var 一起收下（呼叫端要拿它決定哪些 var 該沿用）。
        liveVars.set(script, res.vars ?? {});
      }
    } catch (e) {
      readFailed = true;
      blockers.push(
        `讀不到已部署的 worker「${script}」目前綁著哪些資源（${msg(e)}）。` +
          `不確定它現在用的是哪一顆，就不能重新綁——整趟更新停手，沒有動任何東西。`,
      );
    }
  }

  // 「這台照定義已經裝過了，卻一顆 worker 都找不到」= 我對不上它的實例（名字不同／token 看不到）。
  // 這種時候繼續走下去，等於把一整套資源重新生一遍再綁上去——正是 #97 的形狀，只是換一道門進來。
  if (mode === 'update' && !readFailed && live.size === 0 && scripts.length > 0) {
    blockers.push(
      `在這個 Cloudflare 帳號上找不到任何一顆要更新的 worker（找過：${scripts.join('、')}）。` +
        `acr update 的前提是「這台已經裝好了」——對不上就不猜：` +
        `可能是 API token 看得到的帳號不對，或這台實例的 worker 用了別的名字。` +
        `已停手，沒有新建任何資源。`,
    );
  }

  // ── 2. 逐個 binding 決定：沿用 / 新建 / 停手 ─────────────────────────
  /** @type {Map<string, BindingRequirement[]>} */
  const byKey = new Map();
  for (const req of requirements) {
    const key = bindingKey(req.kind, req.binding);
    const list = byKey.get(key);
    if (list) list.push(req);
    else byKey.set(key, [req]);
  }

  /** @type {Map<ResourceKind, Set<string>>} */
  const existingCache = new Map();
  /** @param {ResourceKind} kind @returns {Promise<Set<string>>} */
  const listExisting = async (kind) => {
    const hit = existingCache.get(kind);
    if (hit) return hit;
    /** @type {Set<string>} */
    let set;
    if (kind === 'kv_namespace') set = new Set((await api.listKvNamespaces()).values());
    else if (kind === 'd1') set = new Set((await api.listD1Databases()).values());
    else set = new Set(await api.listVectorizeIndexes());
    existingCache.set(kind, set);
    return set;
  };

  for (const [, reqs] of byKey) {
    const { kind, binding } = reqs[0];

    /** @type {Array<{value: string, script: string}>} */
    const found = [];
    for (const [script, bindings] of live) {
      const hit = bindings.find((b) => b.kind === kind && b.binding === binding);
      if (hit) found.push({ value: hit.value, script });
    }
    const distinct = [...new Set(found.map((f) => f.value))];

    // 2a. 同一個 binding 名在不同 worker 上指向不同資源 → 分不出哪個才是使用者要的。
    //     自己挑一個 = 有一半機率把另外那半的資料從畫面上抹掉。不猜。
    if (distinct.length > 1) {
      blockers.push(
        `綁定「${binding}」在不同 worker 上指向不同的 ${KIND_LABEL[kind]}` +
          `（${found.map((f) => `${f.script} → ${f.value}`).join('、')}）。` +
          `分不出哪一顆才是你在用的，不猜——停手。`,
      );
      continue;
    }

    // 2b. 有人綁著它 → 這就是事實，沿用。名字長什麼樣完全不看。
    if (distinct.length === 1) {
      const value = distinct[0];
      /** @type {Set<string>} */
      let existing;
      try {
        existing = await listExisting(kind);
      } catch (e) {
        blockers.push(
          `查不到帳號上的 ${KIND_LABEL[kind]} 清單，無法確認「${binding}」綁著的 ${value} 還在不在` +
            `（${msg(e)}）。不確定就不動——停手。`,
        );
        continue;
      }
      if (!existing.has(value)) {
        // 這正是 #97 的入口：舊版在這裡會安靜地新建一顆空的頂上去。
        blockers.push(
          `worker「${found[0].script}」的「${binding}」綁著 ${KIND_LABEL[kind]} ${value}，` +
            `但這顆在你的 Cloudflare 帳號上找不到了。` +
            `這裡**不會**幫你新建一顆空的頂上去（Arcrun#97 的災情就是那樣來的）——` +
            `請先確認那顆資源是被刪掉了，還是這把 API token 看不到它。`,
        );
        continue;
      }
      adopt.push({ kind, binding, value, from: found[0].script });
      continue;
    }

    // 2c. 沒有任何已部署的 worker 綁過它 → 新版本新增的 binding，或全新帳號。
    //     這種情況下新建不會弄丟任何東西（本來就沒有東西可丟）。
    create.push({
      kind,
      binding,
      createName: reqs[0].createName,
      wantedBy: [...new Set(reqs.map((r) => r.worker))],
      alsoBind: [],
    });
  }

  return { adopt, create: shareSameResource(adopt, create, byKey), blockers, liveVars };
}

/**
 * 收斂「不同 binding 其實是同一顆資源」的情況。
 *
 * 判準是 **toml 自己宣告的名字**（`database_name` / `index_name`），不是使用者那側的資源名——
 * cypher 的 `CREDENTIALS_DB` 與 kbdb 的 `DB` 都寫 `database_name = "arcrun-kbdb"`，
 * 那是**我們**在宣告「這兩個綁定指向同一顆庫」，跟 #97 那種「拿名字去猜使用者的資源」是兩回事。
 *
 * 沒有這一步會出兩種錯：
 *   ① 全新安裝時建出兩顆同名 D1，KBDB 的資料與 credential 目錄從此分家。
 *   ② 一邊已部署（沿用既有）、另一邊沒有（新建一顆空的）→ 半套資料，比全壞更難查。
 *
 * @param {PlannedAdopt[]} adopt
 * @param {PlannedCreate[]} create
 * @param {Map<string, BindingRequirement[]>} byKey
 * @returns {PlannedCreate[]}
 */
function shareSameResource(adopt, create, byKey) {
  /** @param {ResourceKind} kind @param {string} binding @returns {string | undefined} */
  const declaredName = (kind, binding) =>
    byKey.get(bindingKey(kind, binding))?.[0]?.createName;

  /** @type {PlannedCreate[]} */
  const out = [];
  /** @type {Map<string, PlannedCreate>} */
  const groups = new Map();

  for (const c of create) {
    const groupKey = `${c.kind} ${c.createName}`;

    // ① 已經有 binding 沿用到同一顆（依 toml 宣告）→ 跟著沿用，不要另外建一顆。
    const twin = adopt.find(
      (a) => a.kind === c.kind && declaredName(a.kind, a.binding) === c.createName,
    );
    if (twin) {
      adopt.push({ kind: c.kind, binding: c.binding, value: twin.value, from: twin.from });
      continue;
    }

    // ② 同一趟裡有多個 binding 要建同一顆 → 建一次，其他人共用。
    const head = groups.get(groupKey);
    if (head) {
      head.alsoBind.push(c.binding);
      head.wantedBy = [...new Set([...head.wantedBy, ...c.wantedBy])];
      continue;
    }
    groups.set(groupKey, c);
    out.push(c);
  }
  return out;
}

/**
 * 照 plan 動手：沿用的原樣帶出來，該建的才建。
 * 有任何 blocker 直接丟 ResourcePlanBlocked，**一顆都不建**。
 *
 * @param {ResourceApi} api
 * @param {ResourcePlan} plan
 * @returns {Promise<Map<string, ResolvedResource>>}
 */
export async function applyResourcePlan(api, plan) {
  if (plan.blockers.length > 0) throw new ResourcePlanBlocked(plan.blockers);

  /** @type {Map<string, ResolvedResource>} */
  const out = new Map();
  for (const a of plan.adopt) {
    out.set(bindingKey(a.kind, a.binding), {
      kind: a.kind,
      binding: a.binding,
      value: a.value,
      origin: 'adopted',
      from: a.from,
    });
  }
  /** @type {string[]} */
  const madeSoFar = [];
  for (const c of plan.create) {
    /** @type {string} */
    let value;
    try {
      if (c.kind === 'kv_namespace') value = await api.createKvNamespace(c.createName);
      else if (c.kind === 'd1') value = await api.createD1Database(c.createName);
      else value = await api.createVectorizeIndex(c.createName);
    } catch (e) {
      // 半途失敗：已經建出來的那幾顆還沒被綁到任何 worker 上。**要講出來**——
      // 不講的話它們就是帳號上一批沒人認得的孤兒，而且下次重跑會再建一批。
      const orphans = madeSoFar.length > 0
        ? `\n  已經建好但還沒綁上任何 worker 的：${madeSoFar.join('、')}（重跑前可先刪掉，或留著讓下次沿用）`
        : '';
      throw new Error(`建 ${KIND_LABEL[c.kind]}「${c.createName}」失敗：${msg(e)}${orphans}`);
    }
    madeSoFar.push(`${KIND_LABEL[c.kind]} ${c.createName}`);
    for (const binding of [c.binding, ...c.alsoBind]) {
      out.set(bindingKey(c.kind, binding), { kind: c.kind, binding, value, origin: 'created' });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// wrangler.toml → 需求清單
// ─────────────────────────────────────────────────────────────────────────────

/**
 * wrangler.toml 的 table 名 → 資源種類。需求解析與注入共用同一張表，兩邊才不會對不上。
 * @type {Record<string, ResourceKind>}
 */
export const TABLE_KIND = {
  kv_namespaces: 'kv_namespace',
  d1_databases: 'd1',
  vectorize: 'vectorize',
};

/**
 * 從 wrangler.toml 抽出「這顆 worker 需要哪些資源綁定」。
 *
 * 刻意寫成行掃描而不引 TOML parser：注入端（injectWranglerConfig）本來就是純文字操作，
 * 兩邊用同一種視角看這份檔案才不會對不上。註解掉的區塊**不算需求**
 * （kbdb 的 `[[vectorize]]` 預設是註解狀態，要開語義查詢時才會被取消註解 → 那時才成為需求）。
 *
 * 也是「零依賴」的一部分：不引 TOML parser ⇒ 安裝器 import 這支不必多裝任何東西。
 *
 * @param {string} toml
 * @returns {WranglerRequirements}
 */
export function parseWranglerRequirements(toml) {
  let script = '';
  let seenTable = false;
  /** @type {WranglerRequirements['bindings']} */
  const bindings = [];

  /** @type {ResourceKind | null} */
  let kind = null;
  let binding = '';
  let createName = '';

  const flush = () => {
    if (kind && binding) {
      bindings.push({ kind, binding, createName: createName || binding });
    }
    kind = null;
    binding = '';
    createName = '';
  };

  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const table = line.match(/^\[\[?([A-Za-z0-9_]+)\]?\]$/);
    if (table) {
      flush();
      seenTable = true;
      kind = TABLE_KIND[table[1]] ?? null;
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    const [, key, value] = kv;

    if (!seenTable && key === 'name') {
      script = value;
      continue;
    }
    if (!kind) continue;
    if (key === 'binding') binding = value;
    // 只有 D1／Vectorize 在 toml 裡帶得出「名字」；KV 沒有，退回用 binding 名（見 flush）。
    else if (key === 'database_name' || key === 'index_name') createName = value;
  }
  flush();

  return { script, bindings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare `/settings` 回應 → 事實（兩條路都要用同一種眼睛看）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CF `GET /accounts/{id}/workers/scripts/{script}/settings` 回的 binding 原始形狀
 * （同一種資源在不同 API 版本欄位名不一，故全都收）。
 *
 * @typedef {object} RawWorkerBinding
 * @property {string} [type]
 * @property {string} [name]
 * @property {string} [namespace_id]
 * @property {string} [id]
 * @property {string} [database_id]
 * @property {string} [index_name]
 * @property {string} [text]  `plain_text` 綁定的值（#106；secret_text 不會回值，本來就讀不到，也不該讀）。
 */

/**
 * 把 CF 的 binding 陣列收斂成規則認得的三種資源。不認得的型別直接略過。
 *
 * 🔴 這支**刻意放在規則裡**，不留在各自的 CF client：
 *   「什麼才算『這顆 worker 綁著某顆資源』」是規則的一部分。
 *   兩條路各自解讀 CF 回應 = 漂移會從這裡長回來（例如一邊認 `namespace_id`、
 *   另一邊只認 `id`，於是一邊看得到綁定、另一邊看不到 → 後者又去新建了）。
 *
 * @param {RawWorkerBinding[]} raw
 * @returns {LiveBinding[]}
 */
export function normalizeLiveBindings(raw) {
  /** @type {LiveBinding[]} */
  const out = [];
  for (const b of raw) {
    if (!b?.name) continue;
    if (b.type === 'kv_namespace') {
      const value = b.namespace_id ?? b.id;
      if (value) out.push({ kind: 'kv_namespace', binding: b.name, value });
    } else if (b.type === 'd1' || b.type === 'd1_database') {
      const value = b.id ?? b.database_id;
      if (value) out.push({ kind: 'd1', binding: b.name, value });
    } else if (b.type === 'vectorize') {
      if (b.index_name) out.push({ kind: 'vectorize', binding: b.name, value: b.index_name });
    }
  }
  return out;
}

/**
 * 抽出已部署 worker 上的 `plain_text` var（#106）。
 *
 * 只收 `plain_text`——**`secret_text` 一律不碰**（CF 本來就不回值，也不該被搬來搬去；
 * wrangler deploy 不會動 secret，它們自己會留著）。
 *
 * @param {RawWorkerBinding[]} raw
 * @returns {Record<string, string>}
 */
export function normalizeLiveVars(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const b of raw) {
    if (b?.type === 'plain_text' && b.name && typeof b.text === 'string') out[b.name] = b.text;
  }
  return out;
}
