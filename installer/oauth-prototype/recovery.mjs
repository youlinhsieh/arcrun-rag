// recovery.mjs — 錯誤畫面的「三件事」目錄（inkstone/arcrun-rag#383）
//
// leo 2026-11-22：「用戶不知道該怎麼辦，他可能以為是 bug……不能只跳個錯誤，要告訴他應該怎麼做。」
// 規則：安裝站任何一個錯誤畫面都要同時有
//   ① 發生了什麼（白話）  ② 你的東西現在是什麼狀態  ③ 一顆接著做的按鈕
// 這份目錄是首頁（/?error=…）所有提示的唯一來源；worker.js 只負責算出「按鈕要去哪」。
// 純函式、沒有 I/O，所以 recovery.test.mjs 可以逐一觸發每一種並檢查三件事都在。

export const RECOVERY = {
  // OAuth state 找不到：放太久（state 只活一小時）、連結用過一次、或換了瀏覽器
  state: {
    tone: 'warn',
    title: '授權等太久，過期了',
    what: '你在 Cloudflare 那一頁停留太久，這次的授權連結自動作廢了。這不是壞掉，是安全機制。',
    status: '你的資料沒有被動到。',
    button: '重新開始',
  },
  // state 過期，但實例其實已是最新版——這不是錯誤
  state_done: {
    tone: 'ok',
    title: '已經更新好了',
    what: '剛才那個授權連結雖然過期了，但更新其實已經做完。',
    status: '你的 Arcrun 現在是 {version} 版，不用再做任何事。',
    button: '回到我的 Arcrun',
  },
  // 過期，且認得出這個瀏覽器剛才在做什麼：接著做，不從頭
  state_resume: {
    tone: 'warn',
    title: '授權等太久，過期了',
    what: '你在 Cloudflare 那一頁停留太久，授權連結自動作廢了。這不是壞掉。',
    status: '你的資料沒有被動到，剛才填的 Email 還記著。',
    button: '接著剛才的繼續',
  },
  denied: {
    tone: 'warn',
    title: '你取消了授權',
    what: '沒有 Cloudflare 的授權，我們沒辦法替你安裝或更新。',
    status: '什麼都沒有改變，你原本的東西都還在。',
    button: '重新授權',
  },
  token: {
    tone: 'err',
    title: '連不上 Cloudflare',
    what: 'Cloudflare 沒有回應，或回了我們看不懂的東西。通常等一下就好。',
    status: '這次什麼都沒有改變。',
    button: '再試一次',
  },
  code: {
    tone: 'warn',
    title: 'Email 或辨識碼不對',
    what: '辨識碼要和申請時的 Email 配成一組。已經裝過的人辨識碼留空就好。',
    status: '還沒有開始安裝。',
    button: '回去重填',
  },
  agree: {
    tone: 'warn',
    title: '請先勾選同意授權條款',
    what: '沒有勾選同意，我們不能開始。',
    status: '還沒有開始安裝。',
    button: '回去勾選',
  },
  code_rate: {
    tone: 'warn',
    title: '試太多次，請稍等',
    what: '為了保護你的帳號，辨識碼連續填錯會暫時鎖住幾分鐘。',
    status: '還沒有開始安裝。',
    button: '稍後再試',
  },
  code_unreachable: {
    tone: 'err',
    title: '驗證服務暫時連不上',
    what: '不是你的問題，是我們的辨識碼服務暫時沒回應。',
    status: '還沒有開始安裝，你什麼都不用改。',
    button: '再試一次',
  },
  need_code: {
    tone: 'warn',
    title: '第一次安裝要填辨識碼',
    what: '我們在你的 Cloudflare 帳號上找不到安裝紀錄，所以當成第一次安裝。',
    status: '還沒有安裝任何東西。已經裝過的請確認用的是同一個 Cloudflare 帳號。',
    button: '去填辨識碼',
  },
  // 安裝進行頁發現登入過期（session 一天就過期）
  session: {
    tone: 'warn',
    title: '登入已過期',
    what: '你離開這一頁太久，Cloudflare 的登入憑證過期了。',
    status: '已經裝好的部分都還在，不會重來。',
    button: '重新連結並接著做',
  },
};

/** 套用 {version} 這類代換；沒給值就拿掉那個詞，不留 undefined。 */
export function fill(text, vars = {}) {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

/**
 * 算出要畫的卡。ctx: { primaryHref, version, secondaryHref, secondaryLabel }
 * 回 { key, tone, title, what, status, primary:{label,href}, secondary }
 */
export function buildRecovery(key, ctx = {}) {
  const r = RECOVERY[key];
  if (!r) return null;
  return {
    key,
    tone: r.tone,
    title: r.title,
    what: fill(r.what, ctx),
    status: fill(r.status, ctx),
    primary: { label: r.button, href: ctx.primaryHref || '/' },
    secondary: ctx.secondaryHref ? { label: ctx.secondaryLabel || '回首頁', href: ctx.secondaryHref } : null,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 畫成首頁頂端的卡：三段話都「直接看得到」，不藏在 hover 裡。 */
export function renderRecoveryCard(card) {
  if (!card) return '';
  const color = card.tone === 'ok' ? '#1a7f37' : card.tone === 'err' ? 'var(--err)' : '#b26a00';
  return `<div class="card recovery" data-recovery="${esc(card.key)}" style="border-color:${color}">
  <h3 style="color:${color}">${esc(card.title)}</h3>
  <p>${esc(card.what)}</p>
  <p><b>${esc(card.status)}</b></p>
  <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
    <a class="btn" id="recovery-primary" href="${esc(card.primary.href)}">${esc(card.primary.label)}</a>${card.secondary ? `
    <a class="btn secondary" href="${esc(card.secondary.href)}">${esc(card.secondary.label)}</a>` : ''}
  </div>
</div>`;
}

/** 續做資料 → 「接著做」按鈕的網址。更新者（沒用辨識碼）直接重走授權；新裝者回首頁帶入 Email。 */
export function resumeHref(resume) {
  if (!resume || !resume.email) return '/';
  const e = encodeURIComponent(resume.email);
  if (resume.hadCode) return `/?email=${e}`; // 新裝：辨識碼要重填，不替他保管
  const app = resume.app ? `&app=${encodeURIComponent(resume.app)}` : '';
  return `/auth/start?email=${e}&agree=1${app}`;
}
