/**
 * ship-stations.mjs — 讀站表（`installer/ship.stations.yaml`）並在出貨前把它執行掉
 *
 * ── 為什麼要有這支（`Leo/arcrun-rag#77`，leo 2026-08-11）────────────────────
 * leo 原話：
 *   「**站表是一份人看得懂的清單**；每一站實際做事的那段，
 *     要是 **Arcrun 的零件／工作流**，不是出貨器自己的 JS 函式。」
 *   （談 D70 時）「判斷不該用工作流**要寫明理由**，不准默默寫成腳本。」
 *
 * 站表本來只可能是兩種東西之一：
 *   ① 一份**說明文件**——寫得再好也會漂，因為沒有任何東西在執行它
 *   ② 一份**會被執行的清單**——對不上就當場停下
 * 這支讓它是 ②。三道閘，全部在任何動作發生**之前**跑（fail-fast）：
 *
 *   閘 A｜**站表 ≡ 步驟表**：站表的 id 要跟 ship.mjs 的步驟表逐項一一對應，順序也一樣。
 *        ⇒ 悄悄拿掉一站（為了讓管線變綠）、或加了一站卻沒寫進站表，都在開跑前現形。
 *        ⇒ 這是 `ship-report.mjs` 那張「增減站」表的**上游**：那張表是事後看得到，
 *          這道閘是事前擋下來。
 *
 *   閘 B｜**產出物都有人處理**：站表宣告了「這個產品有哪些會被使用者碰到的東西」，
 *        每一項都必須被某一站處理到。
 *        ⇒ 2026-08-11 的教訓：`landing`（代寄信那台）不在站表裡 ⇒ **從沒被出貨過**，
 *          而報告全綠；leo 按「忘記密碼」才發現沒有寄信服務。
 *
 *   閘 C｜**留在本機的要寫明理由（D70）**：任何宣告 `用什麼: 本機` 的站，
 *        必須有非空的 `本機理由`。
 *        ⇒ D70 白紙黑字寫著「要寫明理由，不准默默寫成腳本」——這道閘讓那句話有牙齒。
 *          沒有它，「這件事本機做就好」會是一個永遠不必解釋、也永遠沒人複查的預設。
 *
 * ── 為什麼用 python3 讀 YAML ────────────────────────────────────────────────
 * 本 repo 的 node 環境沒有 yaml 套件（node_modules 只有 esbuild），而站表是要給**人**
 * 改的東西 ⇒ 用 JSON 會逼人寫跳脫字元、也放不下這些成段的理由。
 * `compile-workflows.mjs` 早就用 python3+pyyaml 讀 YAML（同 repo 既有做法），照它走，
 * 不引第三個做法（「先 grep 同類寫法，照既有的走」——頂層 CLAUDE.md 金鑰鐵律那段的通則）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STATIONS_REL = join('installer', 'ship.stations.yaml');

/** 讀站表。回傳 parse 過的物件；檔案不見或 YAML 壞掉都直接丟例外（站表不是選配）。 */
export function loadStations(repoRoot, { file = null } = {}) {
  const p = file || join(repoRoot, STATIONS_REL);
  if (!existsSync(p)) {
    throw new Error(
      `站表不存在：${p}\n` +
      `     出貨管線在開跑前要拿它比對步驟表（Leo/arcrun-rag#77）。沒有站表就沒有「這次走了哪幾站」的真相源。`);
  }
  const raw = readFileSync(p, 'utf8');
  let out;
  try {
    out = execFileSync('python3', ['-c', 'import sys,yaml,json; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout, ensure_ascii=False)'], {
      input: raw, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`站表 YAML 讀不動（${p}）：${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' / ')}`);
  }
  const doc = JSON.parse(out);
  if (!doc || !Array.isArray(doc['站'])) throw new Error(`站表格式不對：${p} 缺「站」這個清單`);
  return doc;
}

/** 這一站的活是不是交給 Arcrun 工作流做的（`用什麼` 不是「本機」就是工作流名）。 */
export function isArcrunStation(st) {
  const w = String(st['用什麼'] || '').trim();
  return w !== '' && w !== '本機';
}

/** 這張站表總共動用了哪些 Arcrun 工作流（含 `也調用`），去重後排序。 */
export function arcrunWorkflows(doc) {
  const names = new Set();
  for (const st of doc['站'] || []) {
    if (isArcrunStation(st)) names.add(String(st['用什麼']).trim());
    for (const extra of st['也調用'] || []) {
      const n = String(extra).trim();
      if (n && n !== '本機') names.add(n);
    }
  }
  return [...names].sort();
}

/**
 * 三道閘。回傳 `{ ok, problems, doc }`——**不自己 exit**，讓呼叫端決定怎麼死
 * （純函式才測得動所有分支，同 ship-report.mjs 檔頭的理由）。
 *
 * `stepIds` ＝ ship.mjs 步驟表的 id 陣列，順序即執行順序。
 */
export function checkStations(doc, stepIds) {
  const problems = [];
  const stations = doc['站'] || [];
  const ids = stations.map((s) => String(s.id || '').trim());

  // ── 閘 A：站表 ≡ 步驟表（含順序）──────────────────────────────────────
  const missing = stepIds.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !stepIds.includes(id));
  if (missing.length) {
    problems.push(
      `步驟表有、站表沒有：${missing.join('、')}\n` +
      `       ⇒ 有一站在做事，但站表上沒有它 ⇒ 沒人宣告它是誰的活、也沒有驗法。\n` +
      `         把它補進 ${STATIONS_REL}（含「用什麼」與「驗法」），不要把步驟表的那一站刪掉。`);
  }
  if (extra.length) {
    problems.push(
      `站表有、步驟表沒有：${extra.join('、')}\n` +
      `       ⇒ 站表上寫著這一站，但出貨時沒有任何東西會執行它 ⇒ 這正是「宣告了卻沒人做」。`);
  }
  if (!missing.length && !extra.length) {
    const wrong = [];
    for (let i = 0; i < stepIds.length; i++) if (ids[i] !== stepIds[i]) wrong.push(`第 ${i + 1} 站：站表寫 ${ids[i]}，實際跑 ${stepIds[i]}`);
    if (wrong.length) {
      problems.push(
        `站表與步驟表順序對不上：\n` + wrong.map((w) => `       ${w}`).join('\n') +
        `\n       ⇒ 順序會影響「撞到就停、後面不跑」時哪些站沒跑到，不能只求集合相同。`);
    }
  }

  // ── 閘 C：留在本機的要說清楚「為什麼不搬」，而且只有三種答案（D70＋D73）──
  //
  // 🔴 2026-08-11 收緊。第一版只要求「寫理由」，結果我自己寫出來的理由**多數是描述現況、
  //   不是描述限制**——例如 build 站寫「Worker 碰不到本機的 .worker-builds/」，
  //   但那個目錄**早就 commit 進 Leo/Arcrun 的 main**（匿名讀 200，實測過，Arcrun 也真的讀到了）。
  //   ⇒「東西放在本機」根本不是限制，它只是**還沒交貨**。
  //
  // D73（leo 2026-08-11）：「Gitea 是我們的內部開發環境⋯⋯任何人在他本機進行開發，
  //   最後交貨都要送到 Gitea。所以 Arcrun 可以去做中間的工作，**完全不用碰到本地**。」
  //   判準：「這一站碰的東西，只有某一台機器看得到嗎？是 → 那不是限制，是**還沒交貨**。」
  //
  // ⇒ 自由作文改成**三選一**。要主張「搬不動」，就得挑一個會被檢驗的標籤：
  //   · 物理限制 —— 人的同意、簽章、硬體。原理上不可能自動化，不必寫怎麼搬。
  //   · 還沒交貨 —— 材料只有某台機器看得到。要寫**把什麼交到 Gitea** 就能搬。
  //   · 缺零件   —— 材料已在 Gitea，缺的是 Arcrun 的能力。要寫**缺哪顆零件／recipe**。
  //   後兩種都**必須**寫 `要搬需要` ⇒ 每個沒搬的站都自帶一張待辦，賴不掉。
  const WHY = ['物理限制', '還沒交貨', '缺零件'];
  for (const st of stations) {
    if (isArcrunStation(st)) continue;
    const why = String(st['為什麼不搬'] || '').trim();
    if (!WHY.includes(why)) {
      problems.push(
        `站「${st.id}」宣告留在本機，但「為什麼不搬」不是三選一（現在寫的是：${why || '(空白)'}）\n` +
        `       只准填：${WHY.join('／')}\n` +
        `       ⇒ D73 判準：「這一站碰的東西，**只有某一台機器看得到嗎？**\n` +
        `         是 → 那不是限制，是**還沒交貨**」。「東西放在本機」不是理由，是待辦。`);
    }
    if (!String(st['理由'] || '').trim()) {
      problems.push(`站「${st.id}」沒寫「理由」⇒ D70 明文要求寫明理由，不准默默寫成腳本`);
    }
    if (why && why !== '物理限制' && !String(st['要搬需要'] || '').trim()) {
      problems.push(
        `站「${st.id}」標成「${why}」卻沒寫「要搬需要」\n` +
        `       ⇒ 不是物理限制，就代表它**搬得動、只是還沒搬**。那就要寫清楚少了什麼：\n` +
        `         「還沒交貨」寫要把什麼交到 Gitea；「缺零件」寫缺哪顆零件／recipe。\n` +
        `         沒有這一欄，這一站就會永遠停在「以後再說」——而那正是 D73 要拆掉的東西。`);
    }
  }
  for (const st of stations) {
    if (!String(st['驗法'] || '').trim()) {
      problems.push(`站「${st.id}」沒有「驗法」⇒ 沒有驗法的站＝沒人知道它有沒有用（站表第一條規則）`);
    }
  }

  // ── 閘 B：產出物都有人處理 ──────────────────────────────────────────
  const idSet = new Set(ids);
  for (const art of doc['產出物'] || []) {
    const handlers = art['由誰處理'] || [];
    if (!handlers.length) {
      problems.push(
        `產出物「${art.id}」沒有任何一站處理它\n` +
        `       ⇒ 這就是 2026-08-11 那次的形狀：landing（代寄信那台）沒被任何一站碰過，\n` +
        `         從沒被出貨過，而報告全綠。宣告了會被使用者碰到，就要有人送它。`);
      continue;
    }
    const bad = handlers.filter((h) => !idSet.has(String(h)));
    if (bad.length) {
      problems.push(`產出物「${art.id}」指到不存在的站：${bad.join('、')}（站表上沒有這些 id）`);
    }
  }

  return { ok: problems.length === 0, problems, doc };
}

/**
 * ship.mjs 的入口：讀站表 → 跑三道閘 → 有問題就丟例外（訊息是人話，直接可讀）。
 * 回傳站表本體，讓呼叫端可以拿 `用什麼` 去派活給 Arcrun。
 */
export function requireStations(repoRoot, stepIds, { file = null } = {}) {
  const doc = loadStations(repoRoot, { file });
  const { ok, problems } = checkStations(doc, stepIds);
  if (!ok) {
    throw new Error(
      `站表對不上，出貨拒絕開跑（${STATIONS_REL}）——這是設計，不是故障：\n\n` +
      problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n\n') +
      `\n\n     站表是「這次出貨要走哪幾站」的唯一真相源。它與實際步驟不一致時，\n` +
      `     報告上的每一個打勾都失去意義——所以在任何東西被改動之前就停。`);
  }
  return doc;
}
