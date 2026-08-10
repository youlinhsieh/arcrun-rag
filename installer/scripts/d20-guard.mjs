/**
 * d20-guard.mjs — D20 GitHub 接觸保險，ship.mjs 自己這一端的守則
 *
 * ── 為什麼需要這支（2026-08-09，Gitea Leo/arcrun-rag#27）────────────────────
 * `.claude/hooks/github-contact-guard.sh`（Claude Code 的 PreToolUse hook）只看得到
 * **Claude Code 的 Bash 工具呼叫本身的指令字串**。ship.mjs 的 push 步驟是用
 * `node:child_process` 的 `execFileSync('git', ['push', …])` 直接 spawn 出來的子行程
 * ——那個 `git push` 從頭到尾不會產生一次新的 Bash 工具呼叫，hook 完全看不到它。
 *
 * 這不只是「log 沒寫到」而已：hook 連**擋不擋**都沒機會判斷（HIT 永遠是空的，
 * 因為它看到的指令字串是 `node …/ship.mjs --target prod --confirm`，裡面沒有
 * `git push` 或 `github.com` 字面）。8/8 23:16 那次出貨的 push，技術上完全沒被
 * D20 檢查過，唯一擋著的是 ship.mjs 自己一行 `existsSync('.github-armed')`
 * （而且那行連過期都不驗，一份三天前的舊保險檔一樣會放行）。
 *
 * ⇒ 修法不是去改 hook 的正則（不管改成什麼樣的正則，都看不見 node 子行程），
 *   是把「保險有沒有解、有沒有過期、留不留痕」搬進**真正碰 GitHub 的那一行自己身上**。
 *
 * 這支模組刻意做成純函式＋可傳入 root 路徑，方便不用真的碰網路就能單元測試。
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function armedFilePath(inkstoneRoot) {
  return join(inkstoneRoot, '.github-armed');
}

export function contactLogPath(inkstoneRoot) {
  return join(inkstoneRoot, 'system-dev', 'docs', '3-specs', 'autonomy-dispatch', 'github-contact-log.md');
}

function tsNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 檢查 `.github-armed`：存在、格式看得懂、**沒過期**（舊版只查存在，這是本次補的洞）。
 * 過不了就丟例外（訊息照 hook 的用詞，讓兩邊看起來是同一套規則）；
 * 過了回傳 { mission, expiresAt }，mission 供之後留痕用。
 */
export function checkArmed(inkstoneRoot, { now = Math.floor(Date.now() / 1000) } = {}) {
  const armed = armedFilePath(inkstoneRoot);
  if (!existsSync(armed)) {
    throw new Error(
      `需要 leo 親自解保險，但 .github-armed 不存在。\n` +
      `     請 leo 整行貼：scripts/github-arm.sh "<出貨說明>" 30\n` +
      `     （這道閘 AI 不得自造——自造就等於自己批准自己發佈）`);
  }
  const raw = readFileSync(armed, 'utf8').split('\n');
  const expiry = Number(raw[0]);
  const mission = (raw[1] || '').trim();
  if (!Number.isFinite(expiry) || expiry <= 0) {
    throw new Error(
      `.github-armed 格式看不懂（第一行應是到期時間戳，讀到 ${JSON.stringify(raw[0])}）。\n` +
      `     → 重新跑 scripts/github-arm.sh 產生一份乾淨的保險檔`);
  }
  if (now > expiry) {
    const overMin = Math.round((now - expiry) / 60);
    throw new Error(
      `.github-armed 已過期 ${overMin} 分鐘（保險早就自動回鎖了，這個檔只是還沒被清掉）。\n` +
      `     這就是 8/8 23:16 那份保險現在的狀態——舊版 ship.mjs 只查「檔案存不存在」，\n` +
      `     不查過不過期，過期的舊保險照樣會放行，這是本次一併補上的洞。\n` +
      `     請 leo 重新跑：scripts/github-arm.sh "<出貨說明>" 30`);
  }
  return { mission: mission || '(github-armed 第二行沒有任務描述)', expiresAt: expiry };
}

/**
 * 留痕：直接寫進 `github-contact-log.md`，格式與 hook 的「寫入放行」列一致，
 * 兩邊的紀錄混在同一份檔案裡讀起來才不會兩套格式。
 * 回傳寫入的那一行，方便呼叫端印出來自我驗證「真的寫了」。
 */
export function logGithubContact(inkstoneRoot, mission, detail) {
  const shortDetail = String(detail).slice(0, 500).replace(/\n/g, ' ');
  const line = `| ${tsNow()} | ${mission}（ship.mjs 自己留痕，非 hook 攔到——見 d20-guard.mjs） | \`${shortDetail}\` |\n`;
  appendFileSync(contactLogPath(inkstoneRoot), line, 'utf8');
  return line;
}
