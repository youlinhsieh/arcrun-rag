/**
 * source-pin.mjs — 「這個目標只准出貨別的目標已經驗證過的那顆 commit」，用 git 分支釘住。
 *
 * ── 為什麼有這支（2026-08-11，取代 promoteFrom，D65 二次補述，arcrun-rag#73 缺③）───
 * leo 訂正了前一版的模型：「10 次原始碼重建完全不是問題……你要改的只有內外不同的參數」
 * ——prod 不該「提升」（複製 stage 已打包的檔案），該跟 stage 一樣**重打**，只是帳號／
 * URL 不同。真正該保證的不是「檔案一模一樣」，是「兩個理貨員照的是同一張訂單」＝
 * **同一顆 Arcrun commit**。
 *
 * 舊機制（promoteFrom）用 `/tmp/.stage-verified` 這個 JSON 檔當「驗證章」，只有本機看得到、
 * 重開機或清 /tmp 就消失，而且是自訂格式，不是 git 本來就有的東西。這支改用**真的 git 分支**
 * ——分支只在 Arcrun repo 本機移動（不推遠端），既是「驗證過」的證據，也是「該用哪顆」的
 * 唯一真相源：目標成功跑完 `--confirm`（含 verify 全過）就把分支移到那顆 commit；
 * 下游目標出貨前核對「我現在要打的這顆 == 分支釘住的那顆」，不符當場拒絕。
 *
 * ── 為什麼是獨立模組 ──────────────────────────────────────────────────────
 * 跟 verify-download.mjs／verify-docs.mjs 同一個理由：**閘本身要能被單獨演練**，
 * 不必跑一次會 push 會部署的完整管線才知道它還通不通（那正是 08-09 verify-download
 * 那次誤報學到的教訓）。純函式＋repo 路徑注入 ⇒ 可以在假的臨時 git repo 上把
 * 「缺分支」「分支指到別的 commit」「分支剛好對上」三種情況都跑過一遍。
 */
import { execFileSync } from 'node:child_process';

/** 讀分支尖端的 commit sha（40 碼全 sha）；分支不存在回傳 null（不是丟例外——
 *  「還沒有任何目標驗證過任何東西」是第一次出貨前的正常狀態，不是錯誤）。 */
export function branchTip(repo, branch) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 把分支移到（或建到）指定的 sha——只在本機這個 repo 動，不 push、不碰任何遠端。 */
export function setBranchTip(repo, branch, sha) {
  execFileSync('git', ['branch', '-f', branch, sha], { cwd: repo });
}

/**
 * 核對「這次要用的來源 commit」是不是釘子分支指的那顆。
 * 回傳 `{ ok, tip, message }`：`ok=false` 時 `message` 是給操作者看的完整說明
 * （缺分支 vs 分支指到別的 commit，是兩種不同的建議動作，訊息分開講）。
 * 不丟例外——呼叫端（ship.mjs 的 preflight）決定要不要把它變成硬斷言，
 * 這樣同一個判斷邏輯也能被測試檔直接斷言訊息內容，不必用 assert.throws 撈字串。
 */
export function checkSourcePin({ repo, branch, currentSha, currentShaShort }) {
  const tip = branchTip(repo, branch);
  const short = currentShaShort || currentSha.slice(0, 7);
  if (!tip) {
    return {
      ok: false, tip: null,
      message:
        `找不到釘子分支 \`${branch}\`（${repo}）——還沒有任何目標成功驗證過任何一顆 commit。\n` +
        `     → 先跑：node installer/scripts/ship.mjs --target stage --confirm，讓它驗收全過並移動這個分支`,
    };
  }
  if (tip !== currentSha) {
    return {
      ok: false, tip,
      message:
        `這次的來源 commit（Arcrun@${short}）不是 \`${branch}\` 釘住的那顆（${tip.slice(0, 7)}），拒絕出貨\n` +
        `     （這正是要擋的事：不能把「還沒被驗證過的內容」冒充成「驗證過的」）：\n` +
        `       → 把 Arcrun repo（${repo}）checkout 到 ${tip.slice(0, 7)}，\n` +
        `         或用 ARCRUN_SOURCE_WORKTREE 指到一個已經在那顆 commit 的 worktree；\n` +
        `       → 若 ${tip.slice(0, 7)} 已經過期（來源目標有新內容），重跑該目標的 --confirm 讓釘子移到新 HEAD，\n` +
        `         再重跑本目標。`,
    };
  }
  return { ok: true, tip, message: `釘子分支 \`${branch}\` ＝這顆 commit（Arcrun@${short}）✓ 與來源相符` };
}
