/**
 * ship-delivery.mjs — 「送達收斂」這一站的判斷邏輯（站表 id：`purge`）
 *
 * ── 這一站在問什麼 ────────────────────────────────────────────────────────
 * **使用者／桌面小幫手真的會去讀的那個「會移動的指標」，現在指到這一版了嗎？**
 *
 * 釘死 commit 的網址（`verify` 那站驗的東西）永遠是對的——它不會移動，所以也證明
 * 不了「新版送到了」。真正會讓使用者拿不到新版的，是那個**會移動**的指標：
 * prod 是 jsDelivr 的 `@main`（桌面小幫手檢查更新走這條），stage 是 Gitea 的
 * `raw/branch/main`。這一站就是去踢它一下、等一下、再讀一次，比對版本。
 *
 * ── 為什麼要有這支獨立模組（`Leo/arcrun-rag#79` 第一個驗收條件）───────────
 * 🔴 這一站以前**只有 prod 會執行**：`if (!T.verify.fullChain) return skip`，
 *   而 `fullChain` 只有 prod 有 ⇒ stage 永遠印「本目標不走 jsDelivr」跳過。
 *   結果 2026-08-11 leo 解保險出 1.4.37 時，這一站**史上第一次真的被執行**，
 *   當場炸兩次：① `runWorkflow` 沒被 import（commit 4ce1420）
 *              ② 工作流內建 FOREACH 重試撞 Cloudflare subrequest 上限（commit a6cb84b）
 *   ⇒ **「只在單邊執行的站」是測試與 stage 的共同盲區**：它在 stage 那欄是合法的
 *     「登錄簿宣告沒這東西」，連 D65 的左右對照表都看不出來。
 *   治法不是把這一站拿掉（那是假綠），是讓 stage 也有一個**真的會執行、會判成敗**
 *   的送達收斂查證——stage 因此變成這一站的第一個試驗場，壞了先在這裡壞。
 *
 * 邏輯搬出 `ship.mjs` 的理由跟 `ship-report.mjs`／`ship-stations.mjs` 一樣：
 * **純函式才測得動所有分支**。ship.mjs 是一支會 push 會 deploy 的腳本，
 * 它裡面的判斷沒有任何測試碰得到——而這一站的每一個壞法都是「判斷沒被執行過」。
 *
 * ── D70：網路動作全部在 Arcrun 上做 ───────────────────────────────────────
 * 本檔**不打任何網路**。踢指標／等待／重讀／比對四件事都在工作流 `ship_refresh_cdn`
 * 裡（leo 打開工作流頁看得到）。留在這裡的只有「要不要再打一次」這個決定——
 * Arcrun 沒有 loop-until 邊，跨嘗試的提早停只有呼叫端做得到（#79 的結論）。
 */

/** 工作流輸出必須帶的契約版本。實例上還是舊版（讀 `purge_urls` 那版）就認得出來。 */
export const DELIVERY_CONTRACT = 'v2';

/** 演練開關：設了它，這一站會拿一個**不可能達成**的期望值去問，強迫它判失敗。 */
export const DRILL_ENV = 'SHIP_DELIVERY_DRILL';

/**
 * 這個目標的送貨管道**前面有沒有邊緣快取可以作廢**，只有兩種答案：
 *   · `作廢端點` —— 有 purge API 可以打（prod 的 jsDelivr）
 *   · `強制重讀` —— 沒有 purge API，能做的是帶 no-cache 去強制走一次那條路
 *                    （stage 的 Gitea raw；這不是假動作，它同時證明那個路徑真的抓得到）
 */
export const REFRESH_KINDS = ['作廢端點', '強制重讀'];

/**
 * 登錄簿完整性（不變式 Ⅷ）：**有安裝器的目標，一定要宣告 delivery**。
 *
 * 跟 docsSite／githubRelease／mailRelay 同一種病、同一種解法：漏填不是出貨時的
 * 一行警告，是根本不准開跑。差別在這支回傳問題清單（可測），由 ship.mjs 決定怎麼死。
 *
 * @param {Record<string, any>} targets 登錄簿的 `targets` 區塊
 * @returns {string[]} 問題描述；空陣列＝過關
 */
export function deliveryInvariantProblems(targets) {
  const problems = [];
  for (const [name, t] of Object.entries(targets || {})) {
    if (!t || !t.installer) continue;               // 沒有安裝器＝沒有人會拿到東西（selftest）
    if (!t.delivery) {
      problems.push(
        `目標 \`${name}\` 有安裝器（會有人拿到東西），卻沒宣告 delivery。\n` +
        `   ⇒ 那就沒有任何一步在問「使用者去讀的那個會移動的指標，指到這一版了嗎」。\n` +
        `   這正是 #79 的病：stage 宣告「本目標不走 jsDelivr」⇒ 這一站只有 prod 會跑\n` +
        `   ⇒ 它壞掉永遠只能在 prod 第一次發現（2026-08-11 就是這樣炸的）。\n` +
        `   → 在 installer/ship.targets.json 的 \`${name}\` 補 delivery（movingPointer／refreshUrl／refreshKind）`);
      continue;
    }
    for (const k of ['movingPointer', 'refreshUrl', 'refreshKind']) {
      if (!String(t.delivery[k] || '').trim()) {
        problems.push(`目標 \`${name}\` 的 delivery 缺 \`${k}\`（三個都是必填，沒有預設值可以猜）`);
      }
    }
    if (t.delivery.refreshKind && !REFRESH_KINDS.includes(t.delivery.refreshKind)) {
      problems.push(
        `目標 \`${name}\` 的 delivery.refreshKind 不是二選一（現在寫的是：${t.delivery.refreshKind}）\n` +
        `   只准填：${REFRESH_KINDS.join('／')}——同站表「為什麼不搬」的三選一，\n` +
        `   自由作文會變成「描述現況」而不是「描述這個管道的性質」。`);
    }
  }
  return problems;
}

/**
 * 算出這次要怎麼查證送達。
 *
 * @returns {null|object} `null` ＝這個目標不推任何送貨管道（只有沒安裝器的目標可以，如 selftest）
 * @throws 目標有安裝器卻沒宣告 delivery（防禦性重複不變式 Ⅷ：這支單測得動，ship.mjs 那道閘測不動）
 */
export function deliveryPlan(target, targetName, { drill = false } = {}) {
  if (!target) throw new Error(`登錄簿裡沒有目標 ${targetName}`);
  if (!target.delivery) {
    if (target.installer) {
      throw new Error(
        `目標 ${targetName} 有安裝器卻沒宣告 delivery ⇒ 沒有人在問「新版送到了嗎」（不變式 Ⅷ）。`);
    }
    return null;
  }
  if (drill && target.publish) {
    throw new Error(
      `${DRILL_ENV} 是**反向演練**開關（強迫這一站判失敗），不准用在會發佈給用戶的目標（${targetName}）。\n` +
      `     要演練請用非 publish 的目標（stage）——演習視同作戰，但演習不在正式環境上做。`);
  }
  const d = target.delivery;
  return {
    targetName,
    movingPointer: d.movingPointer,
    refreshUrl: d.refreshUrl,
    refreshKind: d.refreshKind,
    // 等待時間：有邊緣快取的要等它散開；沒有的等一下就好（stage 不必陪 prod 等 20 秒）
    waitMs: Number.isFinite(d.waitMs) ? d.waitMs : 20000,
    maxTries: Number.isFinite(d.maxTries) ? d.maxTries : 4,
    drill,
  };
}

/**
 * 這次要拿什麼期望值去問。
 *
 * 🔴 演練模式只可能讓這一站**更容易失敗**，不可能讓它更容易通過——期望值被換成一個
 *   內容指紋算不出來的字串，CDN 上永遠不會有這個版本。一個「只能往嚴格方向動」的
 *   開關才不會變成放水的後門。
 */
export function expectationsFor({ release, daemonVersion, drill = false }) {
  if (!drill) return { release: release || null, daemon: daemonVersion || null, drill: false };
  return {
    release: `${release || '0.0.0'}-drill-不可能達成`,
    daemon: `${daemonVersion || 'v0.0.0'}-drill-不可能達成`,
    drill: true,
  };
}

/**
 * 真的去問：重複觸發 `ship_refresh_cdn`，收斂就提早停。
 *
 * `runWorkflow` 由呼叫端注入（測試不打網路；ship.mjs 傳真的那支）。
 * `nonce` 同理——快取破壞用的字串要可預期，測試才比對得了送出去的 payload。
 *
 * @returns {{converged:boolean, convergedAt:number|null, attempts:object[], last:object|null, lines:string[]}}
 */
export async function confirmDelivery({ plan, release, daemonVersion, runWorkflow, nonce = () => String(Date.now()) }) {
  if (!plan) throw new Error('confirmDelivery 要 plan（deliveryPlan 回 null 代表這個目標沒有送貨管道，呼叫端該自己跳過）');
  const expect = expectationsFor({ release, daemonVersion, drill: plan.drill });
  const attempts = [];
  let last = null;
  let convergedAt = null;

  for (let attempt = 1; attempt <= plan.maxTries; attempt++) {
    const cb = `${attempt}_${nonce()}`;
    last = await runWorkflow('ship_refresh_cdn', {
      attempt,
      wait_ms: plan.waitMs,
      // 沒有作廢端點的管道：帶著快取破壞參數強制重讀一次（工作流那邊還會帶 no-cache 標頭）
      refresh_url: plan.refreshKind === '作廢端點' ? plan.refreshUrl : withCacheBust(plan.refreshUrl, cb),
      refresh_kind: plan.refreshKind,
      manifest_url: withCacheBust(plan.movingPointer, cb),
      expect_release: expect.release,
      expect_daemon: expect.daemon,
    }, { timeoutMs: Math.max(60000, plan.waitMs + 40000) });

    assertContract(last, plan);
    attempts.push({
      attempt,
      actual_release: last.actual_release ?? null,
      actual_daemon: last.actual_daemon ?? null,
      refresh_ok: last.refresh_ok === true,
      fetch_ok: last.fetch_ok === true,
      converged: last.converged === true,
    });
    if (last.converged === true) { convergedAt = attempt; break; }
  }

  return { converged: convergedAt !== null, convergedAt, attempts, last, lines: describeDelivery(plan, expect, attempts, convergedAt) };
}

/** 加上快取破壞參數（保留原本已有的 query）。 */
export function withCacheBust(url, cb) {
  return `${url}${url.includes('?') ? '&' : '?'}cb=${cb}`;
}

/**
 * 🔴 實例上的工作流可能還是舊版。
 *
 * 舊版 `ship_refresh_cdn` 讀的是 `purge_urls.0/1/2`（三個固定槽），新版讀 `refresh_url`。
 * 舊版收到新版的 payload ⇒ `{{input.purge_urls.0}}` 代換不掉、原樣被當網址送出去 ⇒
 * 節點失敗、訊息看起來像網路問題。那種錯訊息會讓人往錯的方向修一整晚
 * （同 `ship-arcrun.mjs` 檔頭記的 headers 代換坑：**代換不掉會變成假紅**）。
 * ⇒ 工作流輸出帶 `contract`，對不上就直接說「去部署 workflows/ship_refresh_cdn.json」。
 */
function assertContract(out, plan) {
  if (out && out.contract === DELIVERY_CONTRACT) return;
  throw new Error(
    `Arcrun 上的 \`ship_refresh_cdn\` 不是這支腳本要的版本（期望 contract=${DELIVERY_CONTRACT}，拿到 ${out && out.contract ? out.contract : '(沒有這個欄位)'}）。\n` +
    `     多半是實例上還是舊版工作流（讀 purge_urls 三個固定槽的那版）。\n` +
    `     → 把 repo 裡的 workflows/ship_refresh_cdn.json 部署到 ship.mjs 呼叫的那台實例上，再重跑。\n` +
    `     （目標 ${plan.targetName}；工作流實際回了：${JSON.stringify(out).slice(0, 200)}）`);
}

/** 攤成人看得懂的行（給出貨報告的 detail 用）。 */
export function describeDelivery(plan, expect, attempts, convergedAt) {
  const lines = [
    `送貨管道　${plan.movingPointer}`,
    `踢一下　　${plan.refreshKind}｜${plan.refreshUrl}`,
    `期望　　　release ${expect.release}／daemon ${expect.daemon}` + (expect.drill ? `　🔬 反向演練（${DRILL_ENV}）：這個期望值不可能達成，這一站**應該**判失敗` : ''),
  ];
  for (const a of attempts) {
    lines.push(`第 ${a.attempt} 次：讀到 release=${a.actual_release}／daemon=${a.actual_daemon}` +
      `｜踢得動＝${a.refresh_ok ? '是' : '否'}｜讀得到＝${a.fetch_ok ? '是' : '否'}｜收斂＝${a.converged ? '是' : '否'}`);
  }
  if (convergedAt) lines.push(`✓ 第 ${convergedAt} 次就收斂了（試了 ${attempts.length} 次）`);
  return lines;
}

/**
 * 沒收斂時的錯誤訊息。語氣刻意不軟化——這句話在 `purge-jsdelivr.mjs` 就是這樣寫的：
 * CDN 沒收斂＝**用戶此刻拿不到新版**，那就不是「出貨完成」。
 */
export function notConvergedError(plan, result) {
  return new Error(
    `踢過之後，送貨管道仍未收斂到這一版——**用戶此刻拿不到新版**，不准宣稱出貨完成\n` +
    result.lines.map((l) => `     ${l}`).join('\n') + '\n' +
    `     試了 ${result.attempts.length} 次都沒收斂。可能是：push 沒真的到那個分支／管道還在散快取／\n` +
    `     那個網址根本不是使用者會走的那條（登錄簿 ${plan.targetName}.delivery 寫錯）。`);
}
