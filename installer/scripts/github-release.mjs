/**
 * github-release.mjs — 讓「完整發佈紀錄在 GitHub 版本發佈」這句話變成真的
 *
 * 🔴 2026-08-17（leo「這個頁面刪除」，inkstone/arcrun-rag#41）：那句承諾**不再是承諾，是唯一出路**。
 * 文件站的版本說明頁已經刪掉——使用者要看版本紀錄只剩 GitHub 版本發佈這一個地方。
 * ⇒ 本模組從「補上一副沒人給的牙齒」變成「那條鏈唯一的一環」：`releaseSectionFor()`
 *   抽不到內文，使用者就**完全查不到這一版**（以前至少還有文件站那一頁墊底）。
 *   兩份原稿：repo 根的 `CHANGELOG.md`（雲端 `1.4.x`）與 `collector/CHANGELOG.md`（桌面 `v0.18.x`）。
 *
 * ── 病史（2026-08-10，總管實測發現；以下是當時的世界，那一頁還在）─────────────
 * `docs-site/.../help/changelog.md` 對用戶寫死一句承諾：
 *   「每一版的完整發佈紀錄在這裡：GitHub 版本發佈
 *    （https://github.com/youlinhsieh/arcrun-rag/releases）」
 * 但那個 repo 的 releases 一個都沒有，而且公開鏡像最後一筆停在 2026-07-18——
 * 出貨管線從來沒有任何一步碰過它，`scripts/publish-github.sh` 存在，但**只有人手動跑過**。
 *
 * leo：「你的出貨沒有限制你一定要在 github 產生 release？」「那為什麼不改掉？」
 *
 * 同一條出貨管線裡，`docs-changelog` 那道閘會在「沒寫說明」時擋下出貨（見 ship.mjs），
 * 但「GitHub 上有沒有這一版」完全沒有對應的閘——一個有牙齒、一個沒有，於是後者
 * 每次都安靜通過。這支模組 + ship.mjs 的 `github-release` 步驟就是補上那副牙齒。
 *
 * ── 設計 ─────────────────────────────────────────────────────────────────────
 * 純函式＋可注入 fetch，理由與 verify-docs.mjs／verify-download.mjs 相同：ship.mjs 是
 * 一支真的會寫 GitHub 的管線，沒辦法拿它來演練「release 內容抽取得對不對」。
 *
 * 寫入動作（`createRelease`）本身**不做任何 D20 判斷**——呼叫端（ship.mjs）必須自己先
 * 過 `d20-guard.mjs` 的 `checkArmed()`，理由與 push 步驟一致：這裡是 execFileSync／fetch
 * 開出去的網路呼叫，Claude Code 的 Bash hook 完全看不到，保險檢查與留痕只能由呼叫端自己做。
 *
 * D36 金鑰鐵律：本模組只從**環境變數**讀 token（呼叫端負責注入），不落地、不印出、
 * 不自己組第二套傳遞法。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG_REL, DAEMON_CHANGELOG_REL } from './daemon-notes.mjs';

/**
 * 從說明文件抽出某一版的**完整段落**（不是 daemon-notes.mjs 那種一行摘要）——
 * 這段文字會原樣變成版本發佈的內文，用戶點進去看到的就是它。
 *
 * 🔴 2026-08-18（D95 第二輪，inkstone/InkStoneCo#40）：**兩份 changelog 都要問。**
 *   本函式原本只讀 `CHANGELOG_REL`（當時＝docs-site 那一頁；2026-08-17 頁面刪除後
 *   ＝repo 根的 `CHANGELOG.md`）。D95 第一輪把桌面版那條線搬進
 *   `collector/CHANGELOG.md` 之後，這裡對 `v0.18.x` 一律回 null
 *   ⇒ `release-record` 站替 **daemon 那條線**建發佈紀錄時必然失敗
 *     （實測：`releaseSectionFor(root,'v0.18.29')` → `null`）。
 *   而「每條版本線都要有一筆發在產品頁的版本發佈」正是 `release-line-gate.mjs`
 *   （arcrun-rag#88，剛併進 main）整支存在的理由——本函式回 null 就是那條線斷在源頭。
 *   查兩處的順序與 `notesFromChangelog()` 一致：**先問 daemon 的，再問雲端的**。
 *   版號格式互斥（有沒有 `v` 前綴），不會互相撈到對方的段落。
 *
 * @returns {string|null} 該版 markdown 內文（已去頭尾空行），或 null（兩份都沒有這一版）
 */
export function releaseSectionFor(repoRoot, version) {
  for (const rel of [DAEMON_CHANGELOG_REL, CHANGELOG_REL]) {
    const body = sectionIn(join(repoRoot, rel), version);
    if (body) return body;
  }
  return null;
}

/** 在一份 changelog 裡抓 `## <version>` 到下一個 `## ` 之間的內文。找不到回 null。 */
function sectionIn(p, version) {
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n');
  const escVer = String(version).replace(/[.\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${escVer}(\\D|$)`).test(l.trim()));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // 下一版開始
    body.push(lines[i]);
  }
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.length ? body.join('\n') : null;
}

/**
 * 查詢某個 tag 的 release 是不是已經存在——**唯讀查詢，不需要 token**（公開 repo 匿名讀，
 * 按 leo 2026-08-10 的 D20 簡化：讀一律放行）。用來讓這一步冪等：同一版重跑 --confirm
 * 不該報錯、也不該建出兩筆 release。
 * @returns {Promise<object|null>} release 物件，或 null（不存在）
 */
export async function releaseExists(repoSlug, tag, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: { 'user-agent': 'arcrun-rag-ship', accept: 'application/vnd.github+json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`查詢 ${repoSlug} 的 release ${tag} 失敗：HTTP ${r.status}`);
  return r.json();
}

/**
 * 建立 GitHub release（寫入動作）。呼叫端必須自己先過 D20 checkArmed；本函式不做任何保險判斷。
 * @param {object} o
 * @param {string} o.repoSlug          例 "youlinhsieh/arcrun-rag"
 * @param {string} o.tag               例 "v1.4.30"（不存在時 GitHub 會照 targetCommitish 自動建出來）
 * @param {string} o.name              release 標題（用戶在 releases 頁看到的大標）
 * @param {string} o.body              release 內文（markdown）
 * @param {string} o.targetCommitish   tag 要指到的 commit sha（或分支名）
 * @param {string} o.token             寫入權杖，只從環境變數傳進來，本函式不落地不印出
 */
export async function createRelease({ repoSlug, tag, name, body, targetCommitish, token, fetchImpl = fetch }) {
  if (!token) {
    throw new Error('缺寫入權杖——本函式只讀呼叫端傳進來的 token，不會自己生一個（D36：只碰名字，不碰真身）');
  }
  const r = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'arcrun-rag-ship',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tag_name: tag, name, body, target_commitish: targetCommitish }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    // 錯誤內文可能回聲 request body，但不會回聲 Authorization header——不印 headers 就不會外洩 token。
    throw new Error(`建立 release ${tag} 失敗：HTTP ${r.status} ${errText.slice(0, 300)}`);
  }
  return r.json();
}
