/**
 * fetch-retry.mjs — 有界重試的 fetch 包裝，撐過 Gitea 的路線掉包（c10724）
 *
 * ── 為什麼需要這支（inkstone/ISEP#30 c10724，2026-09-22）────────────────────
 * leo 瀏覽器連 Gitea 正常（瀏覽器重用連線＋自己重試），但本機工具（`scripts/ticket`、
 * `ship.mjs` release-record 站、curl）在同一條路線上，連線階段（TCP connect）常態性失敗：
 * 總管實測 `GET /api/v1/version` 6 次：2 次 15 秒逾時、2 次 connect≈5s（SYN 重送）、
 * 2 次 0.1s 正常——大約一半的連線在「連上」這一步就先掛了，跟收到的回應內容無關。
 * 這支 session 自己也在建這個模組的過程中撞到同一款（`git fetch gitea main` 逾 120
 * 秒被挪去背景、`git worktree add` 之前那次 `curl -H … issues/30` 也逾時過一次）。
 *
 * 出貨線目前每個網路呼叫都是「打一次，不行就整站丟例外」，於是 22 站有接近一半機率
 * 在隨便哪一站因為一次連線失敗就整條管線判死，逼人重跑整趟。這支的用法是：
 * 只在**連線層失敗**（`fetch()` 本身丟例外，或收到已知的暫時性閘道錯誤碼）時重試，
 * **不**在收到正常回應（含 4xx／5xx 的業務錯誤，例如 404 找不到、401 沒權限）時重試——
 * 那些是真的答案，重試只會浪費時間，對非冪等的呼叫（例如建 release）甚至可能造成
 * 「其實第一次已經成功，只是回應沒收到，重試又建了一筆」的風險。
 *
 * ⇒ 呼叫端只要把預設的 `fetchImpl: fetch` 換成這支包出來的函式，其餘邏輯不用動
 *   （介面完全相容：同樣是 `(url, opts) => Promise<Response>`）。
 *
 * 冪等性仍然要靠**呼叫端自己**（例如「建 release 前先查存不存在」），這支只管
 * 「一次連線失敗」不會讓整站判死，不管「重複建立」——那件事本來就不是重試機制
 * 該解的問題，見 `github-release.mjs`／`gitea-release.mjs` 的 `releaseExists()`。
 *
 * ── 🔴 每次嘗試自己要有逾時，不能只靠「fetch() 丟例外才重試」（本次實測撞到）──
 * 寫這支的同一個 session 裡，拿它連續打 5 次真的 `git.uncle6.me/api/v1/version`：
 * 第 1～3 次分別 503ms／7859ms／354ms 都正常回來，**第 4 次直接卡死**——120 秒工具逾時
 * 都還沒等到它自然失敗。跟總管回報的「15 秒逾時」不是同一個數字：那是 curl 自己的
 * `--max-time`，**裸 fetch 沒有這個上限**，作業系統層的 TCP 重送可以掛得比 15 秒久很多。
 * ⇒ 只靠「fetch() 拋例外才重試」在這種情況下**永遠等不到重試的機會**——第一次嘗試
 * 自己就先把呼叫端卡死了。修法是**每次嘗試自己帶一個逾時**（`AbortSignal.timeout`），
 * 逾時也算「這次嘗試失敗」，一樣進重試迴圈——不再靠底層 fetch 自己願不願意放棄。
 */

/** 值得重打一次的暫時性 HTTP 狀態碼——閘道/過載類，不含任何業務語意的錯誤碼。 */
const TRANSIENT_STATUS = new Set([408, 502, 503, 504, 522, 523, 524]);

/** 純函式：算第 n 次重試前要等多久（毫秒）。指數後退＋一點點抖動，避免同時重打。 */
export function backoffMs(attempt, { baseMs = 400, maxMs = 4000 } = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.floor(raw * 0.2 * Math.random());
  return raw + jitter;
}

/**
 * 包一層有界重試的 fetch。
 * @param {object} [o]
 * @param {typeof fetch} [o.fetchImpl] 底層真正打網路的 fetch（測試可換成假的）
 * @param {number} [o.retries=2] 失敗後最多再打幾次（總嘗試數 = retries + 1）
 * @param {number} [o.timeoutMs=8000] 每次嘗試自己的逾時——逾時也算這次失敗，進重試迴圈
 *   （見檔頭：裸 fetch 沒有內建逾時，靠 OS 層自然失敗可能遠比這個久）
 * @param {(ms:number)=>Promise<void>} [o.sleepImpl] 可注入，測試不必真的等
 * @returns {typeof fetch} 一支介面相容的 fetch，供其他模組當 fetchImpl 用
 */
export function withRetry({
  fetchImpl = fetch, retries = 2, timeoutMs = 8000,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  return async function fetchWithRetry(url, opts = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      // 🔴 刻意不用 `AbortSignal.timeout()`：那支內部的計時器是 unref 的（Node 設計成
      // 「單獨一個逾時不該讓程式活著」），本次寫測試時親自撞到——一支腳本如果除了
      // 這次 fetch 沒有任何別的事在跑（例如 `scripts/ticket` 這種單一用途 CLI），
      // 事件迴圈會判定「沒事可做」而提前結束，逾時 callback **永遠不會被呼叫**，
      // 呼叫端的 promise 就這樣卡死——比原本沒有逾時保護還糟。改用手動
      // `AbortController` + `setTimeout`（預設是 ref 的，會確保逾時真的有機會觸發），
      // 攔到之後立刻 `clearTimeout`，不讓它多留一個計時器。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`逾時 ${timeoutMs}ms`)), timeoutMs);
      const onCallerAbort = () => ac.abort(opts.signal.reason);
      if (opts.signal) {
        if (opts.signal.aborted) ac.abort(opts.signal.reason);
        else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
      try {
        const res = await fetchImpl(url, { ...opts, signal: ac.signal });
        // 收到回應（不管幾號）就是「連上了」；只有已知的暫時性閘道錯誤碼才值得重打，
        // 其餘一律當真答案原樣回傳給呼叫端自己判斷（404/401/200 都不在這裡重試）。
        if (TRANSIENT_STATUS.has(res.status) && attempt <= retries) {
          lastErr = new Error(`暫時性狀態碼 ${res.status}`);
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (e) {
        // fetch() 本身丟例外（含逾時觸發的 AbortError）＝這次嘗試失敗
        // （c10724 那種 connect 逾時／SYN 重送——或久到連 OS 都還沒放棄，這裡先放棄）
        lastErr = e;
        if (attempt > retries) break;
        await sleepImpl(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
      }
    }
    throw new Error(`fetch 重試 ${retries + 1} 次都失敗（每次上限 ${timeoutMs}ms，${url}）：${lastErr && lastErr.message}`, { cause: lastErr });
  };
}

/** 給只需要「馬上可用的一支」的呼叫端——用預設參數包好的版本（retries=2、每次 8s，最壞情況約 20 秒內見分曉）。 */
export const fetchWithRetry = withRetry();
