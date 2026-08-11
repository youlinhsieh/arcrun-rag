/**
 * ship-machine.mjs — 這條出貨線跑在哪一台機器上
 *
 * ── 為什麼要有這支（`Leo/arcrun-rag#72` 揭露、`#77` 處置）─────────────────────
 * 08-10 出 1.4.33 那次，暴露了兩個沒人擋的結構性斷點：
 *   ① **build 不可跨機器重現**——雲端打出來的那份，地端重打**打不出一樣的東西**
 *      （實錄：票上寫 1.4.32，地端重打得到 1.4.33）
 *   ② **驗證章綁機器**——stage 驗過的章（來源釘子分支＋打好的 bundle 工作區）
 *      只活在跑過 stage 的那台上，換一台就等於沒驗過
 * ⇒「雲端做 stage、地端出 prod」這條路**走不通**。
 *
 * ── 本張票（#77）選的處置：認了，並且擋死 ─────────────────────────────────
 * 不去做「跨機器可重現」（那要把 esbuild 版本、node 版本、工作區狀態、憑證全部同步，
 * 等於多出四個會漂的東西，而且每一個漂掉都是安靜的）。
 * 改成**把「同一台」變成硬條件**：
 *   · 每次成功出貨都把這台機器的指紋記進出貨帳本（`installer/ship-report.json`）
 *   · 同一個 release，另一個目標（stage↔prod）記到的指紋不同 ⇒ **當場拒絕**
 * ⇒ 換機器接力不會再安靜地打出一份不一樣的貨，而是在動任何東西之前就停下，
 *   訊息直接說「回原來那台跑」。
 *
 * ── 指紋裡放什麼、不放什麼 ────────────────────────────────────────────────
 * 🔴 `installer/` **會被推上 GitHub 公開鏡像**（`scripts/github-publish-exclude.txt`
 *    沒有排除它）⇒ 帳本會公開 ⇒ **不准放機器名稱、使用者名稱、路徑這類可辨識的東西**。
 * 只放一段雜湊：主機名＋平台＋架構＋家目錄，取 sha256 前 12 碼。
 * 它能回答的只有一個問題——「**是不是同一台**」——而那正是這裡唯一需要回答的問題。
 */
import { createHash } from 'node:crypto';
import { hostname, platform, arch, homedir } from 'node:os';

/**
 * 這台機器的指紋（12 碼 hex）。同一台永遠一樣；換一台幾乎必然不一樣。
 * 刻意不含時間、不含 repo 路徑——換分支、換工作區、重開機都不該讓它變。
 */
export function machineId() {
  const raw = [hostname(), platform(), arch(), homedir()].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/**
 * 硬斷言：同一個 release，兩個目標必須在同一台機器上出。
 *
 * 判準跟 `assertSourceParity` 一致——只比對**同一個 release**、且雙方都有記錄的情況。
 * 只出過一邊（另一邊還沒跑）不算不一致，是「還沒到比對的時候」，不能誤傷。
 *
 * `ledger` ＝ `ship-report.mjs` 的帳本物件（`{ [release]: { [target]: {...} } }`）。
 */
export function assertSameMachine(ledger, { release, target, machine }) {
  if (!machine) return;
  const entry = ledger && ledger[release];
  if (!entry) return;
  for (const [otherTarget, otherEntry] of Object.entries(entry)) {
    if (otherTarget === target) continue;
    if (!otherEntry || !otherEntry.machine) continue; // 對方是這道閘之前出的，沒有指紋可比
    if (otherEntry.machine !== machine) {
      throw new Error(
        `出貨中止：release ${release} 的兩個目標**不在同一台機器上**——這條線不支援換機器接力\n` +
        `       ${target}　　　＝ 機器 ${machine}\n` +
        `       ${otherTarget}　　＝ 機器 ${otherEntry.machine}\n` +
        `     為什麼擋（Leo/arcrun-rag#72 的實錄）：build 不可跨機器重現，另一台重打會打出\n` +
        `     不一樣的內容；而 stage 驗過的章只活在跑過 stage 的那台上，換一台等於沒驗過。\n` +
        `     → 回到 ${otherTarget} 跑過的那台機器上出貨。真的要換機器，就在新機器上\n` +
        `       **從 stage 重新走一次**（重新驗、重新蓋章），不要只把 prod 搬過去。`);
    }
  }
}
