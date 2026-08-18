/**
 * arcrun-landing — Arcrun RAG landing page + 辨識碼中央服務
 *
 * 2026-07-27（leo）：「把 rag.arcrun.dev 的有關 demo 的介紹拿掉，直接叫他安裝」
 *   移除＝① hero 的「先動手玩 Demo」按鈕 ②「動手玩：一分鐘看懂它厲害在哪」整區
 *          ③ 該區專用的 .demo-points/.demo-point/.demo-cta CSS（不留孤兒樣式）
 *   保留＝專業人員區（GitHub 自訂安裝），它原本包在 demo section 裡，非 demo 內容。
 *   ⚠️ 2026-08-08 補記：那個共用示範站已退場，repo 內任何文件/腳本都不再導向它
 *      （判準見 repo CLAUDE.md「範例在哪、測試在哪」）。要不要真的把站關掉＝leo 的閘。
 *   ⚠️ 說明寫在這裡而非 HTML/CSS 註解——那兩種都會送到瀏覽器，view-source 仍看得到
 *      demo 字樣（第一次就是這樣被自己的驗證抓到）。要復原＝git revert 該 commit。
 *
 * 端點：
 *   GET  /                        → 單頁 landing（內嵌 HTML，v2：用戶的指南針）
 *   POST /api/request-code        → {email, subscribe} 登記並發辨識碼（冪等）
 *   POST /api/verify-code         → {email, code} 驗證辨識碼
 *   POST /api/send-password-reset → {email, api_origin, ticket} 代寄「修改密碼」連結（D62，
 *                                    arcrun-rag#38/#69）——我們是郵差，回頭打 api_origin 的
 *                                    /portal/password/relay-verify 確認票是真的才寄，見該函式註解
 *   GET  /api/health              → {ok:true}
 *   *    未知路徑（catch-all）      → 瀏覽器導覽（Accept 帶 text/html）給人看的 404 頁；
 *                                    其他呼叫方（API/curl）維持 {ok:false,error:"not found"}（arcrun-rag#74）
 *
 * 綁定：
 *   KV: SIGNUPS
 *   env.EMAIL_ENABLED ("true" 時走寄信路徑，需 send_email binding SEND_EMAIL)
 */

// 辨識碼字元集：大寫去混淆字元（去 0/O/1/I）
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const RATE_LIMIT_PER_MINUTE = 10;

/** 同一 email 冪等重寄的冷卻窗：窗內重複請求不再寄信（防連點灌信，§3 Bug B） */
const RESEND_COOLDOWN_MS = 60_000;

// 🔴 arcrun-rag#29 驗收帶出的坑（2026-08-09）：landing-staging 上的「前往安裝」按鈕、
// 辨識碼信、版本查詢 API 全部寫死 install.arcrun.dev／rag.arcrun.dev（prod）。
// 查過 `git log -S"INSTALL_BASE"／-S"installBase"`＋t185（07d97ac，2026-08-04）：
// 那次是「nav bar 從 0 加到有」，從沒人做過環境感知，是新坑不是舊坑重犯。
// 跟 installer/oauth-prototype/worker.js 同一批坑、同一天在那邊修過
// （siteBase／docsBase 同款模式，這裡沿用不重新發明）。
// 最重要的一個：landing-staging 的 /api/latest 查詢以前打的是 prod 的安裝器，
// 導致 stage 頁面顯示 prod 的版本號，不是 stage 自己剛出的那個版本。
const DEFAULT_INSTALL_BASE = 'https://install.arcrun.dev';
function installBase(env) {
  return (env && env.INSTALL_BASE ? String(env.INSTALL_BASE) : DEFAULT_INSTALL_BASE).replace(/\/+$/, '');
}
const DEFAULT_DOCS_BASE = 'https://rag.arcrun.dev/docs';
function docsBase(env) {
  return (env && env.DOCS_BASE ? String(env.DOCS_BASE) : DEFAULT_DOCS_BASE).replace(/\/+$/, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlPage(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// arcrun-rag#74（2026-08-11 leo）：「點了信裡的連結，畫面吐一串機器語言——一般人到這裡就放棄了。」
// 真兇：這台（郵差）的 catch-all 404 一律回 JSON，但**信裡的連結是給人點的**，不是給程式呼叫的。
// 判準：瀏覽器「點連結」導覽一定會帶 `Accept: text/html,...`；API 呼叫（fetch/curl）不會刻意加這個
// ⇒ 用這個信號分流，不改變任何既有 API 呼叫方的行為（它們原本就不會送這個 Accept）。
function wantsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

/** 極簡防灌：同 IP 每分鐘 RATE_LIMIT_PER_MINUTE 次（KV TTL 計數，非嚴格原子，夠用即可） */
async function rateLimited(env, request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${ip}:${minute}`;
  const current = parseInt((await env.SIGNUPS.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_MINUTE) return true;
  // KV 最小 TTL 60 秒
  await env.SIGNUPS.put(key, String(current + 1), { expirationTtl: 120 });
  return false;
}

/** UTF-8 字串 → base64（供 email header / body 用；worker 無 Buffer） */
function b64utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/** base64 body 每 76 字元斷行（RFC 2045） */
function wrap76(b64) {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** 辨識碼信的正體中文 HTML（乾淨簡單、辨識碼大字） */
function codeEmailHtml(code, env) {
  // 郵件用 inline hex（email client 不吃 CSS 變數），值照抄 CIS token：
  // Ink #17181A（強調字）／Paper #FDFCFB／Canvas #F2F1ED（信底）／Relation #B04A2F（CTA）。
  const installUrl = `${installBase(env)}/`;
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F2F1ED;">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,'PingFang TC','Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif;color:#17181A;">
  <div style="font-family:-apple-system,'PingFang TC',system-ui,sans-serif;font-weight:600;font-size:26px;letter-spacing:.06em;color:#17181A;text-align:center;">Arcrun RAG</div>
  <p style="margin:28px 0 10px;font-size:16px;line-height:1.7;">你好！這是你的 Arcrun RAG 辨識碼：</p>
  <div style="margin:8px 0 20px;text-align:center;">
    <div style="display:inline-block;padding:18px 30px;border-radius:12px;background:#FDFCFB;border:1px solid rgba(176,74,47,.35);font-family:'Courier New',monospace;font-size:38px;font-weight:700;letter-spacing:.18em;color:#B04A2F;">${code}</div>
  </div>
  <p style="margin:20px 0 0;font-size:15px;line-height:1.75;">接著到安裝頁，填入你的 Email 和這組辨識碼，就會開始安裝。</p>
  <div style="margin:22px 0 6px;text-align:center;">
    <a href="${installUrl}" style="display:inline-block;padding:14px 28px;border-radius:10px;background:#B04A2F;color:#FDFCFB;font-size:16px;font-weight:700;text-decoration:none;">前往安裝</a>
  </div>
  <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:rgba(23,24,26,.55);text-align:center;">或直接開啟：${installUrl}</p>
  <p style="margin:16px 0 0;font-size:13.5px;line-height:1.7;color:rgba(23,24,26,.6);">這封信只用來寄辨識碼給你，不會用你的 email 做別的事。</p>
  <hr style="margin:26px 0 0;border:none;border-top:1px solid rgba(154,151,143,.35);">
  <p style="margin:14px 0 0;font-size:12px;color:rgba(23,24,26,.45);text-align:center;">Arcrun RAG 封測中 · 你的知識庫，永遠是你的</p>
</div>
</body></html>`;
}

/**
 * 品牌圖示（2026-07-31 換成 leo 的 CIS 正式 mark；此前是琥珀金圓圈的暫代圖）。
 *
 * 幾何抄自 CIS 的 `mark-square-ink.svg`（512 格），這裡改成 256 格：
 * 墨底（Ink #17181A）＋ paper 色雙 chevron，**單色、不加第二個顏色**——
 * CIS 明訂 mark 永遠單色（「彩色 chevron 在產品裡代表『這條關係是活的』，
 * 所以 logo 用彩色 chevron 會是一句謊話」）。
 *
 * 為什麼是 chevron 而不是完整的方形字符：這顆同時當**分頁 favicon**（16px），
 * CIS 規定 26px 以下降級成 chevron，完整字符在那尺寸會糊掉。
 *
 * 一顆 SVG 同時服務三個位置：瀏覽器分頁 favicon、CF OAuth 授權頁品牌圖示（logo_uri）、
 * 以及 apple-touch-icon。要換品牌就改這裡＋`InkStoneCo/arcrun-cis/`。
 */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Arcrun RAG">
  <rect width="256" height="256" fill="#17181A"/>
  <g fill="none" stroke="#FDFCFB" stroke-width="30" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M48 53 L123 128 L48 203"/>
    <path d="M123 53 L198 128 L123 203"/>
  </g>
</svg>`;

/**
 * favicon.ico 真身（16/32/48 三尺寸 ICO，base64 內嵌）。
 *
 * 為什麼要有這顆、不能只靠 SVG：舊版把 `/favicon.ico` 也回 `LOGO_SVG`、
 * content-type 標 `image/svg+xml`——**副檔名說 .ico、內容卻是 SVG**，
 * 老瀏覽器與部分抓圖服務（Slack/Teams 預覽、Windows 釘選）會直接畫不出來。
 * 現在 `.ico` 回真 ICO、`.svg` 回 SVG，各自名實相符。
 *
 * 內容與 LOGO_SVG 同一個 mark（墨底＋paper 雙 chevron），由 CIS 產出；
 * 要換品牌就改 `InkStoneCo/arcrun-cis/` 再重產（見 collector/cmd/arcrun-app/assets/store/）。
 */
const FAVICON_ICO_B64 = [
  "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",
].join("");

/**
 * apple-touch-icon（180×180 PNG，base64 內嵌）。
 *
 * 同樣是「名實相符」問題：iOS 加到主畫面時抓的是 `apple-touch-icon.png`，
 * **只吃 PNG，不吃 SVG**——回 SVG 會變成一顆空白圓角方塊。
 * 180 是 iPhone Retina 的建議尺寸，iOS 會自己往下縮。
 */
const APPLE_ICON_B64 = [
  "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",
  "AElFTkSuQmCC",
].join("");

/** base64 → Uint8Array（Workers 沒有 Buffer） */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

/** 寄辨識碼信（僅在 EMAIL_ENABLED=true 且綁好 send_email binding SEND_EMAIL 時實際執行） */
async function sendCodeEmail(env, email, code) {
  // Cloudflare Email Service：需要 wrangler.toml 的 send_email binding（名為 SEND_EMAIL）
  // 以及帳號上已 onboard 的寄件網域（arcrun.dev，DKIM/return-path 自動配）。
  const { EmailMessage } = await import("cloudflare:email");
  const from = env.EMAIL_FROM || "noreply@arcrun.dev";
  const subject = `你的 Arcrun RAG 辨識碼：${code}`;
  const html = codeEmailHtml(code, env);
  // 07-27 真兇：原本缺 Message-ID / Date 兩個 RFC 5322 必要表頭。
  // 走 CF REST API 直寄時服務端會自動補（故 test1 實測 Delivered）；
  // 走 send_email binding（EmailMessage）則**必須自己給**，缺了就被判 spam 拒收
  // ——Activity Log 的 Subject/Sender 全空即症狀（CF 解析不出表頭）。
  // 另補 MIME 結尾 CRLF（RFC 5322 §2.1；wrap76 的 trimEnd 會吃掉）。
  const domain = from.split("@")[1] || "arcrun.dev";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const raw = [
    `From: Arcrun RAG <${from}>`,
    `To: ${email}`,
    `Subject: =?utf-8?B?${b64utf8(subject)}?=`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap76(b64utf8(html)),
    ``,
  ].join("\r\n");
  const message = new EmailMessage(from, email, raw);
  await env.SEND_EMAIL.send(message);
}

// ═══════════ D62：代寄「修改密碼」連結（我們是郵差，不是認證系統）═══════════
//
// leo 2026-08-10：「其實這應該是 youlin 的實例告訴 arcrun.dev 說『我實例的重設密碼網址
//   是 abc.recover，你幫我寄信給用戶讓他來修改密碼』，由 arcrun.dev 幫它寄出這封信。」
//
// 為什麼非得由我們寄：**用戶自己的實例沒有寄信能力**——安裝器部署 cypher 的 binding 只有
// ai/d1/kv_namespace/plain_text/secret_text/service/vectorize，**沒有 send_email**。
// 能寄的只有這裡（CF Email Service，寄件網域 arcrun.dev 在 uncle6 帳號 onboard）。
// ⚠️ 「由中央代寄」是依 leo「寄給你」推導的**假設**，他尚未正式表態（D62 未裁前置）。
//
// 🔴 **本支絕不接受呼叫方給的完整 URL**（總管 2026-08-10 紅線）：
//   寄件網域帶 DKIM。若肯收「任意 URL ＋ 任意 email」就寄，任何人裝一台實例就能用
//   `arcrun.dev` 的名義、**通過 DKIM 驗證**把任意連結寄給任意人 ⇒ 一台開放的釣魚中繼。
//   最壞情況是**燒掉整個網域的信譽、波及所有用戶、不可逆**——比「某台實例的某個帳號
//   被改掉」（可逆）嚴重得多。
//
// 🔑 **主機屬於呼叫方這件事由郵差自己確認**，不是相信呼叫方的宣稱：
//   呼叫方只給 `{email, api_origin, ticket}`。我們**回頭打 `api_origin`** 問
//   `POST /portal/password/relay-verify {ticket}`：
//     - 真的是那台發的 → 它答得出 `{ok:true, email_sha256, link}` → 我們寄
//     - 有人冒用別人的網域 → 被冒用的那台**根本沒有這張票** → 答不出來 → 拒寄
//   而且我們只寄**它自己回給我們的那條 link**，並再驗一次那條 link 的主機就是 `api_origin`
//   ⇒ 「郵差確認過的主機」與「信裡的主機」永遠是同一個。
//   收件人也核對：`sha256(email)` 要對得上，免得拿 A 的票去寄給 B。
const RELAY_MAX_PER_INSTANCE_PER_HOUR = 20;
const RELAY_MAX_PER_EMAIL_PER_HOUR = 5;

/** 只收「https:// + 純主機名」的 origin：不准帶埠、路徑、query、使用者資訊。 */
function validRelayOrigin(raw) {
  const s = String(raw || "").trim();
  if (!/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
    if (u.pathname !== "/" || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 每台實例／每個信箱的時段上限（KV 計數，非嚴格原子，夠用即可）。 */
async function relayQuotaExceeded(env, bucket, limit) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `pwrl:${bucket}:${hour}`;
  const current = parseInt((await env.SIGNUPS.get(key)) || "0", 10);
  if (current >= limit) return true;
  await env.SIGNUPS.put(key, String(current + 1), { expirationTtl: 7200 });
  return false;
}

/** 「修改密碼」信的正體中文 HTML。**刻意把主機寫在信裡**——收信的人要看得出這封是哪台實例請求的。 */
function resetEmailHtml(link, host) {
  return `<!doctype html><html lang="zh-Hant"><body style="margin:0;padding:24px;background:#F7F5F1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2B2B2B">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:20px;margin:0 0 16px">修改你的 Arcrun 密碼</h1>
<p style="font-size:15px;line-height:1.7;margin:0 0 20px">有人在 <strong>${host}</strong> 這台 Arcrun 實例上按了「忘記密碼」。點下面的按鈕就可以直接設定新密碼——<strong>不需要輸入現在的密碼</strong>。</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#2B2B2B;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px">設定新密碼</a></p>
<p style="font-size:13px;line-height:1.7;color:#6B6B6B;margin:0 0 8px">這條連結<strong>只能用一次</strong>，而且<strong>30 分鐘後就會失效</strong>。</p>
<p style="font-size:13px;line-height:1.7;color:#6B6B6B;margin:0">如果你沒有在 ${host} 上按過「忘記密碼」，請直接忽略這封信——你的密碼不會有任何變化。</p>
</div></body></html>`;
}

async function sendResetEmail(env, email, link, host) {
  const { EmailMessage } = await import("cloudflare:email");
  const from = env.EMAIL_FROM || "noreply@arcrun.dev";
  const subject = "修改你的 Arcrun 密碼";
  const domain = from.split("@")[1] || "arcrun.dev";
  // Message-ID / Date 是 send_email binding 的必要表頭（07-27 真兇，見 sendCodeEmail 註解）
  const raw = [
    `From: Arcrun <${from}>`,
    `To: ${email}`,
    `Subject: =?utf-8?B?${b64utf8(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap76(b64utf8(resetEmailHtml(link, host))),
    ``,
  ].join("\r\n");
  await env.SEND_EMAIL.send(new EmailMessage(from, email, raw));
}

async function handleSendPasswordReset(env, request) {
  if (await rateLimited(env, request)) {
    return json({ ok: false, error: "請求太頻繁，請一分鐘後再試。" }, 429);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "請用 JSON 格式送出。" }, 400);
  }

  const email = normalizeEmail(payload.email);
  const ticket = String(payload.ticket || "").trim();
  const apiOrigin = validRelayOrigin(payload.api_origin);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "email 格式不正確。" }, 400);
  if (!/^[0-9a-f]{8,64}$/i.test(ticket)) return json({ ok: false, error: "ticket 格式不正確。" }, 400);
  // 🔴 這裡**不接受 URL**，只接受一個純 origin；連結要由那台實例自己交出來（下面回呼）
  if (!apiOrigin) return json({ ok: false, error: "api_origin 必須是 https:// 開頭的純主機名。" }, 400);

  const host = new URL(apiOrigin).host;
  if (await relayQuotaExceeded(env, `i:${host}`, RELAY_MAX_PER_INSTANCE_PER_HOUR)) {
    return json({ ok: false, error: "這台實例的代寄次數已達上限，請稍後再試。" }, 429);
  }
  if (await relayQuotaExceeded(env, `e:${await sha256Hex(email)}`, RELAY_MAX_PER_EMAIL_PER_HOUR)) {
    return json({ ok: false, error: "這個信箱的代寄次數已達上限，請稍後再試。" }, 429);
  }

  // ── 回呼確認：這張票真的是 apiOrigin 那台發的嗎？──
  let verified;
  try {
    const res = await fetch(`${apiOrigin}/portal/password/relay-verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) return json({ ok: false, error: "來源實例不認得這張票，拒絕代寄。" }, 403);
    verified = await res.json();
  } catch {
    return json({ ok: false, error: "連不上來源實例，無法確認這封信該不該寄。" }, 502);
  }
  if (!verified || verified.ok !== true) {
    return json({ ok: false, error: "來源實例不認得這張票，拒絕代寄。" }, 403);
  }
  // 收件人要對得上（不准拿 A 的票寄給 B）
  if (verified.email_sha256 !== (await sha256Hex(email))) {
    return json({ ok: false, error: "收件人與來源實例記錄的不一致，拒絕代寄。" }, 403);
  }
  // 信裡的連結**必須**落在剛剛確認過的那台主機上（紅線的最後一道）
  const link = String(verified.link || "");
  let linkOrigin = "";
  try {
    linkOrigin = new URL(link).origin;
  } catch {
    return json({ ok: false, error: "來源實例給的連結不是合法網址。" }, 403);
  }
  if (linkOrigin !== apiOrigin) {
    return json({ ok: false, error: "連結的主機與確認過的實例不一致，拒絕代寄。" }, 403);
  }

  if (env.EMAIL_ENABLED !== "true") {
    // 不假綠：沒開寄信就明講，不要回 ok:true 讓對方以為信在路上
    return json({ ok: false, error: "這台 landing 沒有啟用寄信（EMAIL_ENABLED != true）。", code: "email_disabled" }, 503);
  }
  try {
    await sendResetEmail(env, email, link, host);
  } catch (e) {
    return json({ ok: false, error: `寄信失敗：${e && e.message ? e.message : String(e)}` }, 502);
  }
  return json({ ok: true });
}

async function handleRequestCode(env, request) {
  if (await rateLimited(env, request)) {
    return json({ ok: false, error: "請求太頻繁，請一分鐘後再試。" }, 429);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "請用 JSON 格式送出。" }, 400);
  }
  const email = normalizeEmail(payload.email);
  const subscribe = payload.subscribe === true;
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "email 格式看起來不太對，請再檢查一下。" }, 400);
  }

  const emailKey = `email:${email}`;
  const existing = await env.SIGNUPS.get(emailKey, "json");
  const isNew = !(existing && existing.code);
  // 以現有記錄為底維持冪等（同 email → 同碼），只更新 subscribe 意願
  const record = isNew
    ? {
        code: generateCode(),
        subscribe,
        created_at: new Date().toISOString(),
        activated: false,
        last_sent_at: null,
      }
    : { ...existing, subscribe };
  if (isNew) {
    // 反向索引（碼→email）只在首次建碼時寫
    await env.SIGNUPS.put(`code:${record.code}`, email);
  }
  // 記錄若為新建或意願有變，先落庫（後續分支只覆寫 last_sent_at）
  const stateChanged = isNew || existing.subscribe !== subscribe;

  // 絕不在回應中直接吐 code（防略過 email 驗證）
  if (env.EMAIL_ENABLED !== "true") {
    if (stateChanged) await env.SIGNUPS.put(emailKey, JSON.stringify(record));
    return json({
      ok: true,
      message: "已登記！封測期間辨識碼由邀請你的人提供（寄信功能開通中）",
    });
  }

  // §3 Bug B：冷卻窗內（同 email 剛寄過）不重寄，避免連點灌信
  const lastSent = record.last_sent_at ? Date.parse(record.last_sent_at) : 0;
  if (lastSent && Date.now() - lastSent < RESEND_COOLDOWN_MS) {
    if (stateChanged) await env.SIGNUPS.put(emailKey, JSON.stringify(record));
    return json({ ok: true, message: "辨識碼剛剛已寄出，請查收信箱（也看一下垃圾信匣）。" });
  }

  // §3 Bug A：寄信失敗時誠實回報，不再假裝 ok:true（避免用戶空等）
  try {
    await sendCodeEmail(env, email, record.code);
  } catch (err) {
    console.error("send email failed:", err);
    // 記錄已建立（碼有效）但明確告知未寄達
    if (stateChanged) await env.SIGNUPS.put(emailKey, JSON.stringify(record));
    return json(
      {
        ok: false,
        email_sent: false,
        error: "辨識碼寄送失敗了，請稍後再試一次；封測期間也可向邀請你的人索取辨識碼。",
      },
      502
    );
  }

  // 寄出成功 → 記錄本次寄送時間（供冷卻窗判斷），落庫
  record.last_sent_at = new Date().toISOString();
  await env.SIGNUPS.put(emailKey, JSON.stringify(record));
  return json({
    ok: true,
    email_sent: true,
    message: "辨識碼已寄到你的信箱，請查收（也看一下垃圾信匣）。",
  });
}

async function handleVerifyCode(env, request) {
  if (await rateLimited(env, request)) {
    return json({ ok: false, error: "請求太頻繁，請一分鐘後再試。" }, 429);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "請用 JSON 格式送出。" }, 400);
  }
  const email = normalizeEmail(payload.email);
  const code = String(payload.code || "").trim().toUpperCase();
  if (!email || !code) return json({ ok: false }, 400);

  const record = await env.SIGNUPS.get(`email:${email}`, "json");
  if (!record || record.code !== code) {
    return json({ ok: false });
  }
  if (!record.activated) {
    await env.SIGNUPS.put(
      `email:${email}`,
      JSON.stringify({
        ...record,
        activated: true,
        activated_at: new Date().toISOString(),
      })
    );
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health") return json({ ok: true });

    // 07-27：OAuth client 升 public 需要 logo_uri（CF 錯誤 70739），且原本連 favicon 都 404。
    // 這顆 logo 同時當授權頁品牌圖示與瀏覽器分頁圖示——小白在 CF 授權頁看到的就是它。
    // 07-31：換成 CIS 正式 mark，且 `.ico` 改回**真的 ICO**（先前 .ico 回的是 SVG 位元組，
    // 副檔名與內容不符，老瀏覽器/抓圖服務畫不出來）。
    if (pathname === "/logo.svg" || pathname === "/favicon.svg") {
      return new Response(LOGO_SVG, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }
    if (pathname === "/favicon.ico") {
      return new Response(b64ToBytes(FAVICON_ICO_B64), {
        headers: {
          "content-type": "image/x-icon",
          "cache-control": "public, max-age=86400",
        },
      });
    }
    if (pathname === "/apple-touch-icon.png" ||
        pathname === "/apple-touch-icon-precomposed.png") {
      return new Response(b64ToBytes(APPLE_ICON_B64), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (pathname === "/api/request-code") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      return handleRequestCode(env, request);
    }

    if (pathname === "/api/verify-code") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      return handleVerifyCode(env, request);
    }

    // D62：幫用戶自己的實例代寄「修改密碼」連結（我們只是郵差，見 handleSendPasswordReset）
    if (pathname === "/api/send-password-reset") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      return handleSendPasswordReset(env, request);
    }

    // Microsoft Store 上架必備兩頁（政策 10.5.1：Win32 產品「一律」要有隱私政策網址，
    // 不是「有蒐集個資才要」）。送審時貼的就是這兩個網址。詳 docs/store-submission.md。
    if (pathname === "/privacy" && (request.method === "GET" || request.method === "HEAD")) {
      return htmlPage(PRIVACY_HTML);
    }
    if (pathname === "/support" && (request.method === "GET" || request.method === "HEAD")) {
      return htmlPage(SUPPORT_HTML);
    }

    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      // t133：請求時把版本佔位符換成實值（LANDING_HTML 是模組層常數拿不到 env）
      // 🔴 2026-08-05：原本讀 wrangler.toml 的 SITE_BUNDLE_VERSION＝**手抄本**
      //    ⇒ 出貨換了兩代它都沒跟著改，landing 顯示「2026-07-29+919ed39」而
      //    install 頁顯示 1.4.12 ⇒ **同一個產品兩個版本號**，用戶不知道信哪個。
      //    這正是 D39 明令禁止的「一個事實抄成 N 份必然漂移」。
      //    ⇒ 改成向**真相源** /api/latest 取號（installer 讀 manifest.release）。
      //    取不到就顯示「（查詢中）」，**不退回手抄值**——寧可誠實說查不到，
      //    也不要顯示一個過期兩代的數字讓人以為那是現況。
      let ver = '（查詢中）';
      // 🔴 2026-08-06：同步器（daemon）是**另一條版本線**，以前這頁一個字都沒提
      //    ⇒ leo：「連我都沒辦法確認，所以用戶到底是否最新版他自己也不知道」。
      //    同上原則：只讀真相源、取不到就誠實說查不到，**不留手抄本、不編一個數字**。
      let dver = '（查詢中）';
      // 下載連結取不到時退回安裝說明頁——寧可多一步，也不要給一個會 404 的按鈕。
      let dlWin = `${docsBase(env)}/start/install-windows/`;
      let dlMac = `${docsBase(env)}/start/install-mac/`;
      try {
        // 🔴 arcrun-rag#29：以前這裡打死 prod 的安裝器，landing-staging 顯示的
        // 版本號因此永遠是 prod 的，不是 stage 自己剛出的版本——改讀 installBase(env)。
        const r = await fetch(`${installBase(env)}/api/latest`, {
          cf: { cacheTtl: 300, cacheEverything: true },
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
          const j = await r.json();
          if (j && j.release) ver = String(j.release);
          if (j && j.daemon && j.daemon.version) {
            dver = String(j.daemon.version);
            const d = j.daemon.downloads || {};
            if (d.win) dlWin = String(d.win);
            if (d.mac) dlMac = String(d.mac);
          }
        }
      } catch { /* 取不到就維持「（查詢中）」與說明頁連結 */ }
      const page = LANDING_HTML
        .split('__BUNDLE_VERSION__').join(ver)
        .split('__DAEMON_VERSION__').join(dver)
        .split('__DAEMON_DL_WIN__').join(dlWin)
        .split('__DAEMON_DL_MAC__').join(dlMac)
        .split('__INSTALL_BASE__').join(installBase(env))
        .split('__DOCS_BASE__').join(docsBase(env));
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // arcrun-rag#74：這裡是「打錯地方」的最後一站——JSON 是給程式看的，
    // 但會走到這裡的多半是人（點了一條指錯主機的連結，例如密碼重設信寄丟了主機）。
    // 瀏覽器導覽會帶 Accept: text/html；API 呼叫不會，行為不變。
    if (wantsHtml(request)) {
      return new Response(NOT_FOUND_HTML, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// Landing page v2（內嵌單頁，全 inline）
// 原則：landing＝用戶的指南針。非技術用戶照著走就裝得起來，
// 全程儘量不離開這個畫面（頂多跳 Gmail 收碼再跳回）。
// 視覺：對齊 demo portal 的紙感設計語言（宣紙紙紋＋墨字＋琥珀金＋Songti 襯線）。
// ---------------------------------------------------------------------------

const LANDING_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arcrun RAG — 你的 AI 知識庫總編輯</title>
<meta name="description" content="Arcrun RAG：AI 當你知識庫的總編輯，把你的檔案編成定稿知識卡，存進你自己的 Cloudflare 私雲。找得到、信得過、完全屬於你，啟動完全免費。">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  :root {
    /* Arcrun CIS token（arcrun-cis/README.md 唯一真相源，不自調色） */
    --cis-ink: #17181A; --cis-paper: #FDFCFB; --cis-canvas: #F2F1ED;
    --cis-muted: #9A978F; --cis-relation: #B04A2F; --cis-relation-dark: #D9784F;
    --paper-a: var(--cis-paper); --paper-b: var(--cis-canvas);
    --ink: var(--cis-ink); --ink-rgb: 23,24,26;
    --amber: var(--cis-relation); --amber-rgb: 176,74,47;
    --ok: #1d7a48; --ok-rgb: 29,122,72;
    --err: #b03a26;
    --btn-grad: linear-gradient(90deg,var(--cis-relation),var(--cis-relation-dark));
    --btn-ink: var(--cis-paper);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper-a: var(--cis-ink); --paper-b: #1c1d20;
      --ink: var(--cis-paper); --ink-rgb: 253,252,251;
      --amber: var(--cis-relation-dark); --amber-rgb: 217,120,79;
      --ok: #7fe0a8; --ok-rgb: 63,190,120;
      --err: #e58575;
      --btn-grad: linear-gradient(90deg,var(--cis-relation),var(--cis-relation-dark));
      --btn-ink: var(--cis-ink);
    }
  }
  body {
    background: repeating-linear-gradient(0deg,var(--paper-a) 0px,var(--paper-a) 3px,var(--paper-b) 3px,var(--paper-b) 4px);
    color: var(--ink);
    font-family: -apple-system, "IBM Plex Sans", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
    font-size: 16px; line-height: 1.75; -webkit-font-smoothing: antialiased;
  }
  .serif { font-family: -apple-system, "IBM Plex Sans", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; font-weight: 600; }
  a { color: var(--amber); }
  .wrap { max-width: 880px; margin: 0 auto; padding: 0 20px; }

  /* ── hero ── */
  header.hero { padding: 56px 0 20px; text-align: center; }
  /* CIS 橫式 lockup（arcrun-cis/README.md 之 Construction 段）：
     inner gap=0（雙 chevron 相接讀成一格記號）、side gap=.11em、tracking=-.04em、
     chevron 高＝x-height、單色（color: var(--ink)，NEVER 兩色）。
     寬版面（≥40px）用它當預設；favicon／app icon 才用左重的方形 icon 變體（見 LOGO_SVG）。 */
  .lockup { display: inline-flex; align-items: center; font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: 40px; letter-spacing: -.04em; color: var(--ink); }
  .lockup .chev { display: inline-flex; margin: 0 .11em; }
  .lockup .chev svg { width: .58em; height: .58em; }
  .beta { display: inline-block; margin-top: 10px; padding: 3px 14px; border-radius: 999px; border: 1px solid rgba(var(--amber-rgb),.5); background: rgba(var(--amber-rgb),.08); color: var(--amber); font-size: 13px; letter-spacing: .1em; }
  .hero h1 { margin-top: 26px; font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: clamp(1.55rem, 4.6vw, 2.35rem); line-height: 1.45; letter-spacing: .02em; color: var(--ink); }
  .hero .sub { margin: 16px auto 0; max-width: 620px; font-size: 1.03rem; color: rgba(var(--ink-rgb),.68); }
  .cta-row { margin-top: 28px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn {
    display: inline-block; padding: 13px 26px; font-size: 16px; font-weight: 600;
    border-radius: 10px; border: none; background: var(--btn-grad); color: var(--btn-ink);
    cursor: pointer; text-decoration: none; text-align: center;
  }
  /* t133 三修（leo 07-29：「現在的按鈕很小，這個按鈕居中放寬」）：
     首頁主 CTA 加大置中——它是整頁唯一要人按下去的東西。 */
  .btn-hero {
    display: block; margin: 0 auto; max-width: 420px; width: 90%;
    padding: 18px 32px; font-size: 18px; border-radius: 12px;
  }
  .btn:disabled { opacity: .45; cursor: wait; }
  .btn-ghost {
    display: inline-block; padding: 12px 22px; font-size: 15px;
    border-radius: 10px; border: 1px solid rgba(var(--ink-rgb),.25); background: none;
    color: rgba(var(--ink-rgb),.7); text-decoration: none; cursor: pointer;
  }

  /* ── 被瀏覽器擋下時的自救說明（關 8 止血）── */
  .blocked-help {
    margin-top: 14px; padding: 15px 17px; border-radius: 11px;
    background: rgba(var(--amber-rgb),.09); border: 1px solid rgba(var(--amber-rgb),.28);
    font-size: 14.5px; line-height: 1.75;
  }
  .blocked-help strong { color: var(--amber); font-size: 15px; }
  .blocked-help p { margin-top: 6px; }
  .blocked-help ol { margin: 8px 0 0 20px; }
  .blocked-help li { margin-top: 5px; }
  .blocked-help .soft { color: rgba(var(--ink-rgb),.55); font-size: 13.5px; }

  /* ── 賣點五條 ── */
  .sells { margin: 44px auto 0; max-width: 820px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; text-align: left; list-style: none; }
  @media (max-width: 700px) { .sells { grid-template-columns: 1fr; } }
  .sells li { padding: 20px 20px 18px; border-radius: 13px; background: rgba(var(--ink-rgb),.045); border: 1px solid rgba(var(--ink-rgb),.1); }
  .sells li:first-child { grid-column: 1 / -1; }
  .sells h3 { font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: 18.5px; color: var(--ink); letter-spacing: .02em; line-height: 1.5; }
  .sells .sell-body { margin-top: 7px; font-size: 15.5px; line-height: 1.75; }
  .sells .pain { margin-top: 7px; font-size: 13.5px; color: rgba(var(--ink-rgb),.55); }
  .fn { font-size: 12px; text-decoration: none; vertical-align: super; margin-left: 3px; }

  /* ── 區塊通用 ── */
  section { padding: 52px 0 8px; }
  .sechead { text-align: center; font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: 24px; letter-spacing: .06em; color: var(--ink); }
  .sechead-sub { text-align: center; margin-top: 8px; font-size: 15px; color: rgba(var(--ink-rgb),.55); }
  .sec-underline { width: 64px; height: 2px; margin: 14px auto 0; background: rgba(var(--amber-rgb),.4); }

  /* ── 安裝四步 ── */
  .steps { margin-top: 30px; display: flex; flex-direction: column; gap: 16px; }
  .step { display: flex; gap: 18px; padding: 24px 22px; border-radius: 13px; background: rgba(var(--ink-rgb),.045); border: 1px solid rgba(var(--ink-rgb),.1); }
  .step .num { flex: none; font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-size: 44px; line-height: 1; font-weight: 600; color: rgba(var(--amber-rgb),.55); min-width: 44px; text-align: center; }
  .step .body { flex: 1; min-width: 0; }
  .step h3 { font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: 19px; letter-spacing: .02em; line-height: 1.5; color: var(--ink); }
  .step p { margin-top: 8px; font-size: 15.5px; color: rgba(var(--ink-rgb),.75); }
  @media (max-width: 560px) { .step { flex-direction: column; gap: 8px; } .step .num { text-align: left; } }

  /* ── 表單（step 1 內嵌）── */
  .code-form { margin-top: 16px; max-width: 460px; }
  .code-form input[type=email] {
    width: 100%; padding: 13px 15px; font-size: 16px; border-radius: 10px;
    border: 1px solid rgba(var(--ink-rgb),.2); background: rgba(var(--ink-rgb),.05); color: var(--ink);
  }
  .code-form input:focus { outline: 2px solid rgba(var(--amber-rgb),.5); outline-offset: 1px; }
  ::placeholder { color: rgba(var(--ink-rgb),.35); }
  .check-row { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 14px; font-size: 14.5px; color: rgba(var(--ink-rgb),.6); }
  .check-row input { margin-top: 5px; accent-color: var(--amber); }
  .code-form .btn { width: 100%; }
  #form-result { margin-top: 12px; font-size: 15px; display: none; }
  #form-result.ok { color: var(--ok); display: block; }
  #form-result.err { color: var(--err); display: block; }

  /* ── deploy 按鈕（step 2）── */
  .deploy-row { margin-top: 14px; }
  .deploy-row img { max-width: 100%; height: auto; display: inline-block; }

  /* ── 專業人員區 ── */
  .pro { margin-top: 26px; padding: 20px 22px; border-radius: 13px; border: 1px dashed rgba(var(--amber-rgb),.4); background: rgba(var(--amber-rgb),.06); text-align: center; font-size: 14.5px; color: rgba(var(--ink-rgb),.65); }
  .pro a { word-break: break-all; }

  /* ── 頁尾註解 ── */
  footer { margin-top: 56px; border-top: 2px solid rgba(var(--amber-rgb),.35); padding: 36px 0 56px; }
  .note { max-width: 760px; margin: 0 auto 26px; }
  .note h4 { font-family: -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif; font-weight: 600; font-size: 17px; color: var(--ink); letter-spacing: .02em; }
  .note p { margin-top: 8px; font-size: 14.5px; color: rgba(var(--ink-rgb),.65); }
  .foot-line { text-align: center; margin-top: 8px; font-size: 13.5px; color: rgba(var(--ink-rgb),.45); }
    .foot-links { margin-top: 10px; }
    .foot-links a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
    .foot-links a:hover { color: var(--amber, #b04a2f); }
    .foot-links span { margin: 0 8px; opacity: .45; }
</style>
</head>
<body>

<style>
.xnav{position:sticky;top:0;z-index:99999;background:#17181A;border-bottom:1px solid rgba(253,252,251,.14)}
.xnav .xwrap{max-width:1100px;margin:0 auto;padding:.55rem 1.2rem;display:flex;gap:.4rem;align-items:center}
.xnav a{color:#FDFCFB;text-decoration:none;font-size:.95rem;font-weight:500;padding:.35rem .85rem;border-radius:.4rem;line-height:1.2;opacity:.78}
.xnav a:hover{opacity:1;background:rgba(253,252,251,.10)}
.xnav a.on{opacity:1;color:#FDFCFB;background:#B04A2F;font-weight:700}
body{margin-top:0 !important}
</style>
<nav class="xnav">
  <div class="xwrap">
    <a href="/" class="on">首頁</a>
    <a href="__INSTALL_BASE__/">安裝</a>
    <a href="__DOCS_BASE__/">📖 說明文件</a>
  </div>
</nav>

<!-- ═══ 1. Hero：跟一般 RAG 的差異（痛點語言） ═══ -->
<header class="hero">
  <div class="wrap">
    <div class="lockup" role="img" aria-label="Arcrun RAG"><span>arc</span><span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="butt" stroke-linejoin="miter"><path d="M5 5 L12 12 L5 19"></path><path d="M12 5 L19 12 L12 19"></path></svg></span><span>run</span></div>
    <div><span class="beta">封測中 Beta</span></div>
    <h1>別再讓 AI 從碎紙堆裡掰答案</h1>
    <p class="sub">Arcrun RAG 請 AI 當你知識庫的總編輯：讀完你的檔案、編成定稿知識卡、存進你自己的雲端。找得到、信得過、完全屬於你。</p>
    <div class="cta-row">
      <!-- t133 二修（leo 07-29：「把版本顯示直接寫在按鈕裡面『版本：xxxxxx』，
           我看不懂『這次會裝到』是什麼意思」）：版本號寫進按鈕，不另起一行講內部邏輯。
           值由 wrangler.toml [vars] SITE_BUNDLE_VERSION 帶入（推 bundle 時要跟著改）。 -->
      <a class="btn btn-hero" href="#install">馬上開始安裝<span style="opacity:.7;font-size:12px;font-weight:400;margin-left:8px">版本：__BUNDLE_VERSION__</span></a>
    </div>
    <ul class="sells">
      <li>
        <h3>你的資料，永遠是你的</h3>
        <p class="sell-body">簡單同步你勾選的資料夾，存進你自己 Cloudflare 私雲的總庫，完全掌握。</p>
        <p class="pain">怕資料外洩？它從頭到尾都放在你家，不經過別人的手。</p>
      </li>
      <li>
        <h3>大神 Karpathy 的 LLM Wiki 概念<a class="fn" href="#note-1">①</a></h3>
        <p class="sell-body">AI 就是你知識庫的總編輯，每個問題都拿到總編級的回答。</p>
        <p class="pain">傳統向量 RAG 像從碎紙機裡拉資料掰答案——沒有編修能力，資料越堆越大（見頁尾註①）。</p>
      </li>
      <li>
        <h3>操作簡易如 Google Drive<a class="fn" href="#note-2">②</a></h3>
        <p class="sell-body">打開網頁就能用 3 種方式跨庫查，再也不怕找不到。</p>
        <p class="pain">存了一堆卻找不回來？這裡的重點就是「找得到」（見頁尾註②）。</p>
      </li>
      <li>
        <h3>啟動完全免費</h3>
        <p class="sell-body">完全開源，Cloudflare 免費額度高，速度甚至比本機還快。</p>
        <p class="pain">怕花錢？免費額度就跑得動，跑起來再說。</p>
      </li>
      <li>
        <h3>你的 AI 會謝謝你</h3>
        <p class="sell-body">自動幫你裝好 AI 友善的雲端 MCP Server，你的 AI 直接接上你的知識庫。</p>
        <p class="pain">全自動、零手工——便利的不只是你，還有你的 AI。</p>
      </li>
    </ul>
  </div>
</header>

<!-- ═══ 2. 安裝步驟（主推區） ═══ -->
<section id="install">
  <div class="wrap">
    <h2 class="sechead">四步裝好，照著走就行</h2>
    <p class="sechead-sub">不用懂技術，全程留在這個畫面（頂多跳去信箱收個碼再回來）。</p>
    <div class="sec-underline"></div>
    <div class="steps">

      <div class="step">
        <div class="num">1</div>
        <div class="body">
          <h3>填 Email，領取「辨識碼」</h3>
          <p>留 email 不是要你的個資，是為了把辨識碼發給你：從安裝完成到你輸入帳密之間，這組辨識碼幫你保護你的帳號。</p>
          <form class="code-form" id="code-form">
            <input type="email" id="email" name="email" required placeholder="you@example.com" autocomplete="email" aria-label="Email">
            <div class="check-row">
              <input type="checkbox" id="subscribe" name="subscribe">
              <label for="subscribe">訂閱產品更新（可不勾，不勾也完全不影響）</label>
            </div>
            <button type="submit" class="btn" id="submit-btn">送出，領取辨識碼</button>
            <p id="form-result"></p>
          </form>
        </div>
      </div>

      <div class="step">
        <div class="num">2</div>
        <div class="body">
          <h3>連結你的 Cloudflare 帳號，一鍵安裝</h3>
          <p>按下方按鈕前往安裝器，用剛才收到的辨識碼連結你自己的 Cloudflare 帳號，按一次「授權」就自動裝好——全程不碰 GitHub、不用終端機。Cloudflare（NYSE：NET）——本服務建立在這家美國上市公司的網路基礎上，你的總庫從第一天就開在自己名下。</p>
          <div class="deploy-row">
            <a class="btn" href="__INSTALL_BASE__/">前往安裝，連結我的 Cloudflare 帳號</a>
          </div>
        </div>
      </div>

      <div class="step">
        <div class="num">3</div>
        <div class="body">
          <h3>輸入辨識碼，開始使用</h3>
          <p>看到安裝完成畫面後，輸入信箱收到的辨識碼，即可開始使用。</p>
        </div>
      </div>

      <div class="step">
        <div class="num">4</div>
        <div class="body">
          <h3>下載『同步器』，資料夾自動變知識庫</h3>
          <p>依照畫面指示下載『同步器』——免設定，把你電腦裡的資料夾變成知識庫，自動同步到總庫，給你的 AI 查。</p>
          <p style="margin:10px 0 0">
            <a class="btn" href="__DAEMON_DL_WIN__" style="margin-right:8px">🪟 下載 Windows 版同步器</a>
            <a class="btn" href="__DAEMON_DL_MAC__">🍎 下載 Mac 版同步器</a>
          </p>
          <p class="soft" style="margin:6px 0 0">
            同步器版本：<b>__DAEMON_VERSION__</b>　·
            <a href="https://github.com/youlinhsieh/arcrun-rag/releases" target="_blank" rel="noopener" style="color:#241804;font-weight:600">這一版改了什麼</a>
          </p>
          <p style="margin:8px 0 0">
            <a href="__DOCS_BASE__/start/install-mac/" style="color:#241804;font-weight:600">🍎 Mac 安裝步驟</a>
            <span style="color:rgba(23,24,26,.35);margin:0 .5rem">·</span>
            <a href="__DOCS_BASE__/start/install-windows/" style="color:#241804;font-weight:600">🪟 Windows 安裝步驟</a>
            <span style="color:rgba(23,24,26,.35);margin:0 .5rem">·</span>
            <a href="__DOCS_BASE__/" style="color:#241804;font-weight:600">完整說明文件</a>
          </p>
          <!-- 關 8 止血：Chrome 會擋下未簽章的新程式（信譽不足），Windows 用戶常卡在這裡拿不到檔案。
               Store 上架前這段是唯一解；上架後也還要留（不是每個人都從 Store 裝）。 -->
          <div class="blocked-help">
            <strong>Windows 用戶：如果瀏覽器說「無法安全地下載」</strong>
            <p>這是因為我們的程式還很新、下載次數不夠多，<b>不是因為檔案有問題</b>。Windows 對所有還沒累積知名度的新程式都會這樣。兩步就能繼續：</p>
            <ol>
              <li>下載列（或右上角下載圖示）那一列的右邊，點 <b>⋮</b> → 選 <b>保留</b>（英文是 Keep）</li>
              <li>打開檔案時如果再跳出藍色視窗，點 <b>詳細資訊</b> → <b>仍要執行</b></li>
            </ol>
            <p class="soft">我們正在上架 Microsoft Store，之後就能直接從商店安裝、不會再有這個警告。</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</section>

<!-- ═══ 3. 專業人員區 ═══ -->
<section id="pro-install">
  <div class="wrap">
    <div class="pro">
      如果你對 Cloudflare 與各種 IT 技術很熟，歡迎從 GitHub 自訂安裝：<a href="https://github.com/youlinhsieh/arcrun-rag" target="_blank" rel="noopener">github.com/youlinhsieh/arcrun-rag</a>
    </div>
  </div>
</section>

<!-- ═══ 5. 頁尾註解 ═══ -->
<footer>
  <div class="wrap">
    <div class="note" id="note-1">
      <h4>註① 傳統向量 RAG 與 LLM Wiki，比一比</h4>
      <p>傳統向量 RAG 把文件切碎存起來，回答時像從碎紙機裡撈碎片、現場掰一個答案——沒有編修能力，資料只會越堆越大。LLM Wiki（Karpathy 提出的概念）反過來：先讓 AI 總編輯把資料讀完、寫成定稿知識卡，之後才拿卡回答；卡片有編修、有下架，知識庫不會無限膨脹。</p>
    </div>
    <div class="note" id="note-2">
      <h4>註② 三種方式查詢</h4>
      <p>關鍵字查詢——像搜尋引擎，照字面找。語意查詢——用意思找，講不出精確關鍵字也找得到。知識圖譜查詢——順著知識之間的關聯找；Graph DB 會跨庫產生連結，你的 AI 因此知道知識與知識之間的關係。</p>
    </div>
    <p class="foot-line">Arcrun RAG 目前封測中，歡迎試用、更歡迎吐槽。</p>
    <!-- 🔴 2026-08-06 leo：「為什麼沒有顯示在網站上？」
         /privacy 與 /support 早就做好且回 200，但**網站上沒有任何連結指向它們**
         ⇒ 只有直接打網址才進得去，等於藏起來。
         這不只是使用者找不到——Microsoft Store 的審查員也會找隱私政策連結（政策 10.5.1）。
         「頁面存在」不等於「找得到」。 -->
    <p class="foot-line foot-links">
      <a href="/privacy">隱私政策</a>
      <span aria-hidden="true">·</span>
      <a href="/support">技術支援</a>
      <span aria-hidden="true">·</span>
      <a href="__DOCS_BASE__/">使用說明</a>
    </p>
  </div>
</footer>

<script>
  var form = document.getElementById("code-form");
  var btn = document.getElementById("submit-btn");
  var result = document.getElementById("form-result");
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    result.className = "";
    result.textContent = "";
    btn.disabled = true;
    try {
      var res = await fetch("/api/request-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("email").value,
          subscribe: document.getElementById("subscribe").checked,
        }),
      });
      var data = await res.json();
      if (data.ok) {
        result.className = "ok";
        result.textContent = data.message || "已登記！";
      } else {
        result.className = "err";
        result.textContent = data.error || "出了點狀況，請稍後再試。";
      }
    } catch (err) {
      result.className = "err";
      result.textContent = "連線失敗，請稍後再試。";
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Microsoft Store 上架必備兩頁（隱私政策 / 支援）
//
// 為什麼一定要有：Store 政策 10.5.1 明訂 Win32 桌面產品「一律」要有隱私政策網址
// （原文：Product types that inherently have access to Personal Information must
//  always have privacy policies. These include ... Desktop Bridge and Win32 products.）
// ⇒ 沒有這頁就送不出審。詳 docs/store-submission.md §4。
//
// 👤 leo 只要改下面這一個常數（決定支援信箱要用哪個地址）：
//    noreply@arcrun.dev 不行——那是單向寄件用的，收不到信。
// ---------------------------------------------------------------------------
// ⚠️ 狀態（07-31）：arcrun.dev **有** Cloudflare Email Routing 的 MX 記錄（收得到信），
//    但 support@ 這個位址**是否已設路由規則尚未驗證**。leo 確認後把下面這行改掉即可（改一行、重部署）。
//    若確認沒設，去 Cloudflare → Email → Email Routing 加一條 support@arcrun.dev → leo 的信箱。
const SUPPORT_EMAIL = "support@arcrun.dev"; // ← leo 確認/更換這行

const DOC_CSS = `
  :root { --ink-rgb: 23,24,26; --amber: #B04A2F; --amber-rgb: 176,74,47; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #F2F1ED; color: rgb(var(--ink-rgb));
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
    line-height: 1.85; padding: 40px 20px 80px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-family: -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; font-weight: 600; font-size: 27px; color: var(--amber); letter-spacing: .04em; }
  h2 { font-size: 18px; margin-top: 32px; color: var(--amber); }
  p, li { margin-top: 11px; font-size: 15.5px; }
  ul { margin-left: 20px; }
  .lead { margin-top: 16px; padding: 15px 18px; border-radius: 11px;
    background: rgba(var(--amber-rgb),.1); border: 1px solid rgba(var(--amber-rgb),.28); font-size: 16.5px; }
  .updated { margin-top: 8px; font-size: 13.5px; color: rgba(var(--ink-rgb),.55); }
  a { color: var(--amber); }
  .back { display: inline-block; margin-top: 40px; font-size: 14.5px; }
`;

const PRIVACY_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隱私政策 — Arcrun RAG</title>
<style>${DOC_CSS}</style>
</head>
<body><div class="wrap">
  <h1>Arcrun RAG 隱私政策</h1>
  <p class="updated">最後更新：2026-07-31</p>

  <div class="lead"><b>簡單講：你的檔案不會傳給我們。</b><br>
  Arcrun RAG 把資料存進<b>你自己的</b> Cloudflare 帳號，中間沒有經過我們的伺服器。</div>

  <h2>我們不會蒐集你的檔案內容</h2>
  <p>Arcrun RAG 讀取的是<b>你自己指定</b>的資料夾。讀完後整理成知識卡，直接存進你自己的 Cloudflare 帳號。整條路徑上沒有我們的伺服器，我們看不到你的檔案。</p>

  <h2>我們不會蒐集你的個人資料</h2>
  <p>這個程式不需要註冊我們的帳號，不會回傳使用紀錄，不做行為分析，沒有廣告，也沒有任何第三方追蹤工具。</p>

  <h2>網路連線用在哪裡</h2>
  <ul>
    <li>把整理好的知識卡同步到<b>你自己的</b> Cloudflare 帳號</li>
    <li>檢查有沒有新版本可以更新</li>
  </ul>
  <p>只有這兩件事。</p>

  <h2>你的金鑰存在哪裡</h2>
  <p>你的 Cloudflare 金鑰只存在<b>你自己電腦</b>的設定檔裡，不會傳送給我們，我們也沒有地方存放它。</p>

  <h2>本程式存取哪些權限、為什麼</h2>
  <ul>
    <li><b>檔案存取</b>——讀取你自己挑選的那個資料夾，這是本程式的核心功能。</li>
    <li><b>網路連線</b>——上面說的那兩件事。</li>
  </ul>
  <p>本程式<b>不會</b>開機自動啟動，是否常駐在工作列由你自己決定。</p>

  <h2>想刪除資料怎麼辦</h2>
  <p>資料都在你自己手上：移除本程式，並刪掉你 Cloudflare 帳號裡的資料即可。我們這邊沒有你的資料可以刪。</p>

  <h2>聯絡我們</h2>
  <p>對隱私有任何疑問，來信：<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

  <a class="back" href="/">← 回首頁</a>
</div></body>
</html>`;

const SUPPORT_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技術支援 — Arcrun RAG</title>
<style>${DOC_CSS}</style>
</head>
<body><div class="wrap">
  <h1>Arcrun RAG 技術支援</h1>

  <div class="lead">遇到問題、有建議、想吐槽，來信：
  <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><br>
  <span style="font-size:13.5px;color:rgba(34,28,20,.6)">封測期間如果來信沒收到回覆，請直接用你原本聯絡我們的管道（當初拿到封測邀請的那條線）。</span></div>

  <h2>下載時被瀏覽器擋住？</h2>
  <p>如果 Chrome 或 Edge 說「無法安全地下載」，這是因為我們的程式還很新、下載次數不夠多，<b>不是因為檔案有問題</b>。</p>
  <ul>
    <li>下載列那一行的右邊，點 <b>⋮</b> → 選 <b>保留</b>（英文是 Keep）</li>
    <li>打開檔案時如果再跳出藍色視窗，點 <b>詳細資訊</b> → <b>仍要執行</b></li>
  </ul>

  <h2>需要準備什麼</h2>
  <ul>
    <li>Windows 10（1809 版）以上，或 macOS</li>
    <li>一個 Cloudflare 帳號（免費方案就夠用）</li>
  </ul>

  <h2>常見問題</h2>
  <p><b>我的檔案會被傳到你們那裡嗎？</b><br>不會。檔案留在你自己電腦，整理出的知識卡存進你自己的 Cloudflare 帳號。詳見<a href="/privacy">隱私政策</a>。</p>
  <p><b>要付費嗎？</b><br>目前封測中，免費使用。</p>
  <p><b>怎麼移除？</b><br>從 Windows「設定 → 應用程式」解除安裝即可；從 Microsoft Store 安裝的版本會一併清除乾淨。</p>

  <a class="back" href="/">← 回首頁</a>
</div></body>
</html>`;

// arcrun-rag#74：給「點連結進來卻打不開」的人看的頁面（不是給程式看的 JSON）。
// 刻意提到「設定新密碼」情境——這正是本票撞到的那個真實案例：連結指到了不對的主機。
const NOT_FOUND_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>找不到這個頁面 — Arcrun RAG</title>
<style>${DOC_CSS}</style>
</head>
<body><div class="wrap">
  <h1>找不到這個頁面</h1>

  <div class="lead">你點的這個網址在這裡打不開。<br>
  如果你是從信裡「設定新密碼」的連結點進來的——<b>這封信寄錯了地方，不是你的問題</b>。</div>

  <h2>下一步該怎麼做</h2>
  <p>請回到你原本要登入的網站，重新登入頁面後再按一次<b>「忘記密碼」</b>，系統會重新寄一封連結給你。</p>
  <p>如果重試後還是打不開，來信：<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

  <a class="back" href="/">← 回首頁</a>
</div></body>
</html>`;
