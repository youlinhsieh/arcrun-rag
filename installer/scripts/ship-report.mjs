/**
 * ship-report.mjs — 出貨報告：一張「stage │ prod」左右對照表，出貨當下由管線自己產生。
 *
 * ── 為什麼要有這支（2026-08-11，D65 二次補述，Leo/arcrun-rag#73）───────────────
 * leo 原話：「按照出貨單，每次完成出貨就會看到一張表，左邊是 stage 10 站打勾，
 *   右邊是 prod 10 站打勾，就是一個出貨報告是立刻有的。」「你也可以看到有幾站，
 *   如果要修正，也看到增減站。」
 *
 * 這張表**就是**「一張清單、兩邊都跑滿」那條規則的執行機制，不是附加的美化：
 *   · 不對稱會自己現形——某一項在 prod 被跳過，表上是一格空白，不是藏在
 *     `⏭ 不需要做` 這種安撫用語裡；件數不一樣，表就對不齊。
 *   · 清單本身變了（加一項、拿掉一項）也會現形——報告開頭印「共 N 站
 *     （上次 M 站　＋新增　−拿掉）」，防的是「有人為了讓管線變綠悄悄拿掉一站」。
 *   · 🔴「立刻有的」＝出貨當下由管線自動產生（`ship.mjs` 在 `--confirm` 跑完後
 *     呼叫本模組寫檔），不是事後由 AI 手寫報告——AI 手寫會挑好聽的講，
 *     機器產的表沒得挑。
 *
 * ── 資料存哪裡 ────────────────────────────────────────────────────────────
 * `installer/ship-report.json`：以 release 版本號為 key 的小型 ledger，每個目標
 * 記一次「這次跑過哪些 id、各自什麼狀態、來源 commit、時間」。是主 repo（不是
 * bundle repo）裡的一份小檔案，跟著 git 走——所以「上一次幾站」有據可查，
 * 不必去讀程式碼，也不必去問哪一輪聊天記錄。
 * `installer/ship-report.md`：同一份資料算出來的人類可讀表格，每次出貨覆寫。
 *
 * ── 為什麼是獨立模組 ────────────────────────────────────────────────────────
 * 純函式＋檔案路徑注入 ⇒ 可以用假資料完整測過所有分支（第一次出貨無上一輪可比、
 * 清單增減、某目標整個沒出過…），不必真的跑一次 `--confirm` 才能驗這支對不對。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function ledgerPath(repoRoot) {
  return join(repoRoot, 'installer', 'ship-report.json');
}

export function reportPath(repoRoot) {
  return join(repoRoot, 'installer', 'ship-report.md');
}

/** 讀 ledger；不存在或壞掉就當作空的（第一次出貨沒有歷史可比，不是錯誤）。 */
export function readLedger(repoRoot) {
  const p = ledgerPath(repoRoot);
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function writeLedger(repoRoot, ledger) {
  const p = ledgerPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 1) + '\n');
}

/**
 * 硬斷言：同一個 release，兩個理貨員（目標）記錄的來源 commit 必須一致。
 *
 * ── 為什麼要有這個（2026-08-11，D65 二次補述，arcrun-rag#73 缺②）──────────────
 * leo 的比喻：「兩個理貨員拿著都是 10 件的清單」——不只件數要一樣，**貨從哪來**也要
 * 一樣。這張表原本已經把 `sourceCommit` 印在報告表頭（見 `renderComparisonTable`），
 * 但那只是**看得到**：兩欄印出不同的 commit，人眼要自己盯著去發現。
 * 「promoteFrom 拆掉、改成 git 分支模型」（見 `source-pin.mjs`）之後，prod 不再靠
 * 複製 stage 的 manifest.source 天然保證一致——那個保證消失了，這裡要補一道
 * **結構性擋下**，不是多印一行字讓人自己比對。
 *
 * 判準：只比對**同一個 release**、且雙方 sourceCommit 都不是 null/未知的情況——
 * 只出過一邊（另一邊還沒出）不是不一致，是「還沒到比對的時候」，不能誤傷。
 */
export function assertSourceParity(ledger, { release, target, sourceCommit }) {
  if (!sourceCommit) return; // 這次沒有來源可比（理論上不該發生，但不在本函式的職責內擋）
  const entry = ledger[release];
  if (!entry) return;
  for (const [otherTarget, otherEntry] of Object.entries(entry)) {
    if (otherTarget === target) continue;
    if (!otherEntry || !otherEntry.sourceCommit) continue; // 對方還沒出過這一版，不算不一致
    if (otherEntry.sourceCommit !== sourceCommit) {
      throw new Error(
        `出貨中止：release ${release} 的來源 commit 對不上——兩個理貨員拿的不是同一張訂單\n` +
        `       ${target}　　　＝ ${sourceCommit}\n` +
        `       ${otherTarget}　　＝ ${otherEntry.sourceCommit}\n` +
        `     這代表同一個版本號被兩顆不同的 Arcrun commit 各自生產過一次——內容不保證一樣。\n` +
        `     → 查是不是有人在兩次出貨之間動過來源、或版本號被錯誤沿用；不要放行，放行就是讓\n` +
        `       「兩個理貨員拿不同訂單也沒人擋」這個破口重新打開（arcrun-rag#73 缺②）。`);
    }
  }
}

/**
 * 記一次出貨。`results` 是 `[{id, title, status}]`——跟 ship.mjs 步驟表的執行結果
 * 一一對應，`status` 是 `done|skip|failed|not-run|planned` 之一。
 * 同一個 release 重跑同一個 target 會**覆蓋**（不是累積列表）——ledger 記的是
 * 「這個目標這個版本最近一次跑到哪」，不是逐次歷史（逐次歷史交給 git log 這份檔案本身）。
 *
 * 寫入前先跑 `assertSourceParity`——**不一致就丟例外，不寫入、不放行**（arcrun-rag#73 缺②）。
 */
export function recordRun(repoRoot, { release, target, results, sourceCommit = null, ts = Date.now() }) {
  if (!release || !target) throw new Error('recordRun 需要 release 與 target');
  const ledger = readLedger(repoRoot);
  assertSourceParity(ledger, { release, target, sourceCommit });
  if (!ledger[release]) ledger[release] = {};
  ledger[release][target] = { results: results || [], sourceCommit, ts };
  writeLedger(repoRoot, ledger);
  return ledger;
}

const ICON = { done: '✅', skip: '⬜', failed: '❌', 'not-run': '⛔', planned: '⏸' };

/** ledger 是一般 JS 物件，鍵序＝寫入序（JSON.parse 保留原始物件的鍵序）——
 * 拿「這次以前最後一個」當上一輪，不用字串排序猜版本號大小（1.4.9 vs 1.4.10 那種坑）。 */
function previousReleaseKey(ledger, currentRelease) {
  const keys = Object.keys(ledger).filter((k) => k !== currentRelease);
  return keys.length ? keys[keys.length - 1] : null;
}

function idsOf(entry, targets) {
  const ids = [];
  const seen = new Set();
  for (const t of targets) {
    for (const r of (entry[t] && entry[t].results) || []) {
      if (!seen.has(r.id)) { seen.add(r.id); ids.push(r.id); }
    }
  }
  return ids;
}

/**
 * 產生左右對照表（markdown）。
 *
 * 欄位固定是 `targets`（預設 `['stage','prod']`）——兩個理貨員各一欄，不因為
 * 這次只跑了一個目標就變窄；沒出過的目標整欄印「（未出）」，一樣是顯形，不是隱藏。
 * 行＝兩個目標**跑過的 id 的聯集**（不是取其中一個當基準）——這樣「某一邊多一項、
 * 另一邊少一項」都會各自現出一列，不會被拿來當基準的那邊悄悄吃掉。
 */
export function renderComparisonTable(repoRoot, release, { targets = ['stage', 'prod'] } = {}) {
  const ledger = readLedger(repoRoot);
  const entry = ledger[release] || {};
  const order = idsOf(entry, targets);

  const prevKey = previousReleaseKey(ledger, release);
  const prevOrder = prevKey ? idsOf(ledger[prevKey], targets) : [];
  const added = order.filter((id) => !prevOrder.includes(id));
  const removed = prevOrder.filter((id) => !order.includes(id));

  const deltaBits = [];
  if (prevKey) {
    deltaBits.push(`上次（${prevKey}）${prevOrder.length} 站`);
    deltaBits.push(added.length ? `＋${added.join('、')}` : null);
    deltaBits.push(removed.length ? `−${removed.join('、')}` : null);
    if (!added.length && !removed.length) deltaBits.push('無增減');
  } else {
    deltaBits.push('（沒有上一次可比對——這是第一筆紀錄）');
  }

  const titleOf = (id) => {
    for (const t of targets) {
      const r = (entry[t] && entry[t].results || []).find((x) => x.id === id);
      if (r && r.title) return r.title;
    }
    return id;
  };
  const statusCell = (t, id) => {
    if (!entry[t]) return '（未出）';
    const r = (entry[t].results || []).find((x) => x.id === id);
    if (!r) return '（未出）'; // 這個目標跑了，但這個 id 不在它那次的清單裡——本身就是不對稱
    return ICON[r.status] || r.status;
  };

  const lines = [];
  lines.push(`出貨報告　release ${release}　共 ${order.length} 站（${deltaBits.filter(Boolean).join('　')}）`);
  lines.push(targets.map((t) => (entry[t] ? `來源（${t}）＝${entry[t].sourceCommit || '(未知)'}` : `來源（${t}）＝（未出）`)).join('　｜　'));
  lines.push('');
  lines.push(`| 件次 | 項目 | ${targets.join(' | ')} |`);
  lines.push(`| --- | --- | ${targets.map(() => '---').join(' | ')} |`);
  order.forEach((id, i) => {
    const label = added.includes(id) ? `${titleOf(id)}（🆕 本次新增）` : titleOf(id);
    lines.push(`| ${i + 1} | ${label} | ${targets.map((t) => statusCell(t, id)).join(' | ')} |`);
  });
  if (removed.length) {
    lines.push('');
    lines.push(`🗑 上次有、這次清單已經沒有的站：${removed.join('、')}——如果不是刻意拿掉，這就是漏了`);
  }
  return lines.join('\n');
}
