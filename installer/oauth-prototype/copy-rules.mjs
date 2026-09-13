// copy-rules.mjs — 「叫用戶自己去開通是完全不准的」這條鐵律的可執行版本（inkstone/Arcrun#191）
//
// ── 為什麼是這個形狀 ────────────────────────────────────────────────────────
// leo 2026-08-31 定調：**安裝流程裡不存在「請你去某個地方做某件事，再回來按重新安裝」
// 這種出口。** 母票 #190 解掉了 workers.dev subdomain 那一句，並留下三條關鍵字黑名單。
// 本檔把它換成**結構閘**，理由是 leo 自己講過的那條（頂層 CLAUDE.md）：
//
//   「自然語言的變體是無限的，blacklist 永遠追不完。封路哲學之所以有效，
//     是因為它封的是**動作**——動作有限且可枚舉，文字不是。」
//
// 套到文案上，可枚舉的那一半是**出路**與**用戶的控制權**，不是壞句子：
//   - 一句錯誤訊息的合法出路只有三種（按這頁的鈕／回我們的首頁／交回我們處理）
//   - 「用戶對它沒有控制權」的東西也是可枚舉的（權限／scope 是我們寫死的）
// 壞句子的寫法無限，這兩份清單有限 ⇒ 閘寫得成。
//
// ── 這份為什麼獨立成模組 ────────────────────────────────────────────────────
// 🔴 出貨 preflight 跑的是 `copy-contract.test.mjs`，**不是** `worker.test.mjs`
//    ⇒ 規則只寫在 worker.test.mjs 裡的話，它擋不住任何一次出貨
//    （同 ship.mjs:817 記著的那個病：「規約寫在註解裡，沒有一步在執行它」）。
//    但把規則複製兩份又是 resource-rule-gate 存在的理由（同一個能力兩份實作必然漂移）。
//    ⇒ 規則只有這一份，`copy-contract.test.mjs`（出貨閘）與 `worker.test.mjs`（行為測試）
//      都 import 它。

/**
 * 從 worker.js 原始碼抽出所有會送到用戶眼前的 hint 文案。
 *
 * 涵蓋兩種寫法：`InstallError` 的 `hint:` 欄位，以及 `cfErrorHint()` 的每一條 return。
 * 整行註解會先被濾掉——那些行故意留著舊文案的原文當病史，
 * **註解裡有禁語不是違規，把它印給用戶才是**。
 */
export function extractHints(src) {
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  const out = [];
  const lit = (s) => [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]).join('');
  for (const m of code.matchAll(
    /hint:\s*([\s\S]*?)(?=\n\s*(?:detail|action|status|code)\s*:|\n\s*\}\)|\n\s*\},)/g,
  )) {
    const s = lit(m[1]);
    if (s) out.push(s);
  }
  const fn = code.match(/function cfErrorHint[\s\S]*?\n\}/);
  if (fn) {
    for (const r of fn[0].matchAll(/return\s+((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g)) {
      const s = lit(r[1]);
      if (s) out.push(s);
    }
  }
  return out;
}

/** 合法出路——可枚舉，所以閘擋得住無限多種壞寫法。 */
export const APPROVED_EXITS = [
  /重新安裝/,                                   // ① 這一頁上的鈕
  /回到首頁|回首頁|重新連結|重新點一次|重新開始/,  // ② 我們的頁面
  /回報給我們|回報我們|傳給我們|我們來處理/,        // ③ 交回我們
  /再試一次|稍等一下|稍後再試/,                   // ②的變體：用戶什麼都不必做
];

/**
 * 規則 A｜站外出路：把用戶推去第三方後台自己做設定。
 *
 * ⚠️ 刻意**不含**「授權畫面／授權屏」——那是我們 OAuth 流程的一站，由我們的按鈕送過去，
 *    而且 CF 的授權屏本來就有 Select account(s)（#45 查證過，leo 核准該講法）。
 */
export const OFFSITE_EXIT = /Cloudflare\s*(後台|官網|控制台|dashboard)|dash\.cloudflare\.com/i;

/**
 * 規則 C｜幽靈指示：叫用戶去操作一個**他手上根本沒有的東西**。
 *
 * 🔴 這是本票清查才浮出來的第三種違規，規則 A／B 都抓不到它——
 *    舊的 403 文案「請回到首頁重新授權，並在 Cloudflare 頁面上確認所有權限都有勾選」
 *    沒有站外詞（A 放行）、也給了「回到首頁」這個出路（B 放行），
 *    **但它要用戶做的那件事不存在**：scope 是我們寫死在 `OAUTH_SCOPES` 送出去的，
 *    CF 的授權屏只讓他選帳號，沒有逐項勾權限的 UI。
 *    ⇒ 用戶會在那一頁找一個找不到的東西，然後以為是自己弄錯了。
 *    **假出路比沒有出路更貴**（worker.js 自己在 D61 那段就寫過「不給假出路」）。
 */
export const PHANTOM_INSTRUCTION =
  /(確認|檢查|勾選|開啟|打開|設定|調整)[^，。；]{0,14}(權限|授權範圍|scope)/i;

/**
 * 已審核的例外：文案不住在這個 repo，在這裡改不掉。
 * 🔴 這一格是**留痕**不是豁免——它記著一筆還沒還的債。
 */
export const REVIEWED_EXCEPTIONS = [
  {
    match: /沒有建立或改動任何資源/,
    why: 'resource-rule 的 blockers 原文——`shared/resource-rule/rule.mjs` 是 Leo/Arcrun 的'
      + '逐位元組鏡射（MIRROR.json 標「不准手改」，resource-rule-gate 會擋出貨）'
      + '⇒ 要改得改上游 Leo/Arcrun 再跑同步腳本。',
  },
];

/**
 * 檢查一份 worker.js 原始碼的所有用戶文案。
 * @returns {{hints:string[], violations:{rule:string,hint:string,why:string}[]}}
 */
export function checkCopy(src) {
  const hints = extractHints(src);
  const violations = [];
  for (const h of hints) {
    if (OFFSITE_EXIT.test(h)) {
      violations.push({ rule: 'A 站外出路', hint: h,
        why: 'leo 2026-08-31「叫用戶自己去開通是完全不准的」——這句把用戶推去站外後台。' });
    }
    if (PHANTOM_INSTRUCTION.test(h)) {
      violations.push({ rule: 'C 幽靈指示', hint: h,
        why: '這句叫用戶去操作他手上沒有的東西（權限是我們寫死的，他勾不到）。' });
    }
    if (REVIEWED_EXCEPTIONS.some((e) => e.match.test(h))) continue;
    if (!APPROVED_EXITS.some((re) => re.test(h))) {
      violations.push({ rule: 'B 死路', hint: h,
        why: '說了壞消息卻沒給任何出路（按鈕／回首頁／交回我們），等於把問題丟著。' });
    }
  }
  return { hints, violations };
}

// ── 規則 D｜警告的收件人（inkstone/Arcrun#196 comment 6144，2026-09-02）────────
//
// leo 走完 stage 安裝、看到「金鑰沒有存進金鑰保管處」那張卡之後：
//   「成功了，但跳出這個警訊。**你可以默默修復，但不要跳出這段會嚇到使用者**」
//
// `installWarnings()` 的每一條現在都要標 `audience`：`'user'` 照畫、`'internal'` 不畫。
// 🔴 這條閘要擋的是**兩個方向**，不是一個：
//   ① 有人把新的一條標成 `'internal'` 卻沒經過審核 ⇒ 警告機制被一條一條掏空
//      （那就走回「寫了卻沒人畫」的老路，正是 #190／#191 兩張票在治的病）
//   ② 有人把下面這一條的 `'internal'` 拿掉 ⇒ 那句話又跳到用戶臉上
// ⇒ 判準寫成**集合相等**：實際標 internal 的那一組，必須跟審核過的這一份一字不差。
//
// ⚠️ 這裡刻意**不套規則 B（死路）**去檢查警告卡的 body。
//   警告卡跟錯誤訊息不同：它講的是「你少拿到什麼」，而多數警告的正確反應就是
//   「知道就好、其餘功能照用」——硬要它給出路會逼出假出路，而假出路比沒出路更貴。

/** 審核過的 `audience: 'internal'` 清單。加一條就要在這裡留下理由。 */
export const WARNING_AUDIENCE_ALLOWLIST = [
  {
    title: '金鑰沒有存進金鑰保管處',
    field: 'credentialSeedError',
    why: 'leo 2026-09-02（inkstone/Arcrun#196 comment 6144）：用戶什麼都不能做'
      + '——不是他的帳號、不是他的設定，按「重新安裝」也不會好；它講的是我們的出貨'
      + '（實例上還沒有 /credentials/directory 那支端點）還沒到位。'
      + '仍原樣留在 progress.result 與完成頁「技術細節（給工程師看的）」那一段。',
  },
];

/**
 * 從 worker.js 抽出 `installWarnings()` 裡每一張警告卡的 `title` 與 `audience`。
 * 抽不到（函式改名／改寫法）時回空陣列，由呼叫端當成閘壞掉處理——不是安靜放行。
 */
export function extractWarningCards(src) {
  const fn = src.match(/function installWarnings\(result\)\s*\{[\s\S]*?\n\}/);
  if (!fn) return [];
  const out = [];
  for (const chunk of fn[0].split('out.push({').slice(1)) {
    const block = chunk.split('\n    });')[0];
    const title = block.match(/title:\s*'((?:[^'\\]|\\.)*)'/);
    const audience = block.match(/audience:\s*'([a-z]+)'/);
    out.push({
      title: title ? title[1] : null,
      // 標題是拼接出來的（例如「有 N 個服務沒有對外開通」）時 title 會抓不到，
      // 那不影響本閘——本閘只認 audience，標題只是拿來對名字用的。
      audience: audience ? audience[1] : 'user',
      raw: block,
    });
  }
  return out;
}

/**
 * 檢查警告卡的收件人分流。
 * @returns {{cards:Array, violations:{rule:string,hint:string,why:string}[]}}
 */
export function checkWarningAudience(src) {
  const cards = extractWarningCards(src);
  const violations = [];
  const approved = new Set(WARNING_AUDIENCE_ALLOWLIST.map((x) => x.title));
  const actual = new Set(cards.filter((c) => c.audience === 'internal').map((c) => c.title));

  for (const c of cards) {
    if (c.audience !== 'user' && c.audience !== 'internal') {
      violations.push({ rule: 'D 收件人不明', hint: String(c.title), why:
        `audience 只能是 'user' 或 'internal'，抓到「${c.audience}」。` });
    }
  }
  for (const t of actual) {
    if (!approved.has(t)) {
      violations.push({ rule: 'D 未審核的隱藏', hint: String(t), why:
        '這條警告被標成 internal（用戶看不到），但不在 WARNING_AUDIENCE_ALLOWLIST 裡。'
        + '判準是「用戶有沒有出路」——有出路的警告不准藏，藏了就是靜默失敗。' });
    }
  }
  for (const x of WARNING_AUDIENCE_ALLOWLIST) {
    if (!actual.has(x.title)) {
      violations.push({ rule: 'D 審核過的隱藏被拿掉', hint: x.title, why:
        `這條 leo 拍板不給用戶看，但原始碼裡它現在不是 internal。理由：${x.why}` });
    }
  }
  return { cards, violations };
}
