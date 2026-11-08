/**
 * fallback-signoff.mjs — AHub 讀不到時，改問 ISEP 的「備援簽核驗證器」（inkstone/InkStoneCo#262）
 *
 * 為什麼：2026-11-04 KBDB 每日剎車擋下 AHub ⇒ 簽不了 ARM ⇒ 修復版出不去（自己的修復卡死自己）。
 * 備援簽核（passkey／Telegram）的驗證邏輯只有 ISEP 一份；這裡**不自己驗簽**，只呼叫它。
 *
 * 共同介面（本票 comment 1793948321603442）：
 *   <驗證器> <repo#N> <目標字串>
 *   成立 → exit 0，stdout 有一行 `SIGNED: …`；其他一律 exit 非 0（fail-closed）。
 *   目標字串＝呼叫端從實際動作機械推出的版本號（ticket-arm-guard 的 version），不接受外部傳入。
 *
 * 只在 AHub「讀不到」時才會被呼叫（逾時、5xx、連線失敗）。AHub 明確回答「還沒簽」→ 不走這裡。
 *
 * 找驗證器（不寫死機器路徑），依序：
 *   ① env ISEP_FALLBACK_SIGNOFF（完整指令路徑，操作者明確指定）
 *   ② env ISEP_ROOT／CLAUDE_PLUGIN_ROOT 底下 scripts/fallback-signoff-verify
 *   ③ 與本 repo 並列的 ../ISEP/scripts/fallback-signoff-verify（雲端 work/ 排法）
 *   找不到 ⇒ 備援關閉，明說，不當成通過。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERIFIER_REL = join('scripts', 'fallback-signoff-verify');

/** @returns {string|null} 驗證器路徑，找不到回 null。 */
export function findVerifier({ env = process.env, exists = existsSync, here = HERE } = {}) {
  const cands = [];
  if (env.ISEP_FALLBACK_SIGNOFF) cands.push(env.ISEP_FALLBACK_SIGNOFF);
  for (const k of ['ISEP_ROOT', 'CLAUDE_PLUGIN_ROOT']) if (env[k]) cands.push(join(env[k], VERIFIER_REL));
  // installer/scripts → repo 根 → 其上一層的 ISEP
  cands.push(resolve(here, '..', '..', '..', 'ISEP', VERIFIER_REL));
  for (const c of cands) if (c && exists(c)) return c;
  return null;
}

function defaultRun(cmd, args, opts) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 問備援驗證器。
 * @returns {Promise<{ok:true, signed:string} | {ok:false, reason:string}>}
 */
export async function verifyFallbackSignoff({ repo, issue, version, env = process.env, run = defaultRun, find = findVerifier } = {}) {
  const verifier = find({ env });
  if (!verifier) {
    return { ok: false, reason: '備援簽核驗證器找不到（ISEP 的 scripts/fallback-signoff-verify；可設 ISEP_FALLBACK_SIGNOFF）——備援關閉。' };
  }
  const target = `${repo}#${issue}`;
  const r = await run(verifier, [target, String(version)], { env });
  const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => /^SIGNED:/.test(l));
  if (r.code === 0 && line) return { ok: true, signed: line };
  const why = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ');
  return { ok: false, reason: `備援驗證器不放行（exit ${r.code}${line ? '' : '，沒有 SIGNED 行'}）${why ? `：${why}` : ''}` };
}
