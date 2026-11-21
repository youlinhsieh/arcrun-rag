/**
 * apps-feed-fingerprint.mjs — App 市集目錄的內容指紋（inkstone/Arcrun#471，總監 c1795248315470213）。
 *
 * 為什麼有這支：1.4.x 的定義是「使用者實例上有什麼」。App（AHub、報社、迴圈…）由安裝站 /apps 的市集目錄送到實例，
 * 目錄一變、實例能裝到的東西就真的不一樣——但舊指紋只認 core 零件（#141 加了工作流／skill、#353 加了 daemon），
 * 不認 App ⇒ AHub 0.50→0.53 出了貨，release 還是 1.4.258，portal 對既有用戶說「已是最新版」。
 * 與 #141／#353 同一個病、同一種修法：把它算進指紋。
 *
 * 指紋材料＝每個 App 的「id@版本:包的 sha256」排序串起來。**不含 index.json 整份**（裡面有 generated_at，每次建都不同，
 * 拿它算會讓版號每次出貨都跳）。包的雜湊＝包檔去掉 exported_at 後算（宣告的 sha256 含 exported_at，每次都變，不能用）。
 * 來源沒有 app-market（或建不出目錄）⇒ 回空字串 ⇒ 指紋不加後綴，與舊式子逐位元相同（不虛增版號）。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 從已建好的市集目錄資料夾（有 index.json 與 packages/）算指紋。讀不到 index 回空字串。 */
export function appsFeedFingerprintFromDir(feedDir) {
  const indexPath = join(feedDir, 'index.json');
  if (!existsSync(indexPath)) return '';
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (!index || !Array.isArray(index.apps) || !index.apps.length) return '';
  const lines = index.apps.map((a) => {
    const pkg = a.package || {};
    // 包檔裡有 exported_at（每次建都不同），宣告的 sha256 因此每次都變——拿它算指紋版號會每次跳。
    // 所以讀包檔本體、去掉 exported_at 再雜湊；讀不到包才退回宣告的 sha256。
    const rel = String(pkg.url || '').replace(/^\.?\/+/, '');
    const abs = join(feedDir, rel);
    let sha = pkg.sha256 || 'nopackage';
    if (rel && existsSync(abs)) {
      const body = JSON.parse(readFileSync(abs, 'utf8'));
      delete body.exported_at;
      sha = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    }
    return `${a.id}@${a.version}:${sha}`;
  }).sort();
  return createHash('sha256').update(lines.join('|')).digest('hex');
}

/** 用來源 Arcrun repo 的 app-market/build-feed.mjs 建一份目錄再算指紋。來源沒有 app-market ⇒ 空字串。 */
export function appsFeedFingerprint(arcrunRepo) {
  const script = join(arcrunRepo, 'app-market', 'build-feed.mjs');
  if (!existsSync(script)) return '';
  const dir = mkdtempSync(join(tmpdir(), 'app-feed-fp-'));
  try {
    // build-feed 靠「argv[1] ＝ 自己的真實路徑」判斷是否被直接執行（來源走符號連結時要給真實路徑）
    execFileSync('node', [realpathSync(script), '--out', dir], { cwd: arcrunRepo, stdio: 'pipe' });
    return appsFeedFingerprintFromDir(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
