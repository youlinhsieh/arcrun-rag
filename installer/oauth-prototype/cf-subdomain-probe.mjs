/**
 * cf-subdomain-probe.mjs — 對真的 Cloudflare 重量一次子網域端點的契約（inkstone/Arcrun#190）
 *
 * 跑法：
 *   CLOUDFLARE_API_TOKEN=<token> CF_ACCOUNT_ID=<id> node installer/oauth-prototype/cf-subdomain-probe.mjs
 *
 * 為什麼要有這支：`worker.test.mjs` 的替身是**我們寫的**，它只證明程式碼符合我們的想像。
 * 2026-08-31 那版把「名字被占用」猜成 HTTP 409，真身是 403——而 403 在我們程式裡
 * 是「授權不夠」⇒ 測試全綠，真用戶撞名就裝不起來。**替身跟真身的差距只有真身能告訴你。**
 *
 * 🔴 這支**只做唯讀與冪等**的呼叫，不會改到任何帳號的設定：
 *    - GET 現有子網域
 *    - GET 幾個名字的可用性（純查詢）
 *    - PUT **帳號現有的那個名字**——已經有子網域的帳號一定回 409/10036，不可能改名。
 *      帳號**還沒有**子網域時會跳過 PUT（那一打就是不可逆的，不准在探針裡做）。
 *
 * 量到的結果請寫回 cf-subdomain-contract.md，測試的替身照那份改。
 */

const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN_YOULIN_CC_USE;
const account = process.env.CF_ACCOUNT_ID;
if (!token || !account) {
  console.error('需要 CLOUDFLARE_API_TOKEN 與 CF_ACCOUNT_ID');
  process.exit(2);
}

const API = 'https://api.cloudflare.com/client/v4';

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  const err = (json && json.errors && json.errors[0]) || null;
  return {
    status: res.status,
    code: err ? err.code : null,
    message: err ? err.message : null,
    result: json ? json.result : null,
  };
}

const rows = [];
const record = (what, r) => {
  rows.push({ what, status: r.status, code: r.code, note: r.message || JSON.stringify(r.result) });
  return r;
};

const existing = record('GET /workers/subdomain', await call('GET', `/accounts/${account}/workers/subdomain`));
const mine = existing.result && existing.result.subdomain;

// 一個幾乎不可能被註冊的隨機名字 → 期待「可以註冊」
const freeName = 'arcrun-probe-' + Math.random().toString(36).slice(2, 10);
record(`GET /workers/subdomains/${freeName}（沒人要的）`, await call('GET', `/accounts/${account}/workers/subdomains/${freeName}`));

// 幾個一定被註冊掉的短名字 → 期待「已被占用」
for (const taken of ['test', 'demo', 'cloudflare']) {
  record(`GET /workers/subdomains/${taken}（別人的）`, await call('GET', `/accounts/${account}/workers/subdomains/${taken}`));
}

if (mine) {
  record(`GET /workers/subdomains/${mine}（自己的）`, await call('GET', `/accounts/${account}/workers/subdomains/${mine}`));
  // 冪等：對已經有子網域的帳號 PUT 同一個名字，CF 只會拒絕，不會改名。
  record(`PUT /workers/subdomain {${mine}}（冪等）`, await call('PUT', `/accounts/${account}/workers/subdomain`, { subdomain: mine }));
} else {
  rows.push({ what: 'PUT /workers/subdomain', status: '-', code: '-', note: '跳過：這個帳號還沒有子網域，PUT 是不可逆的，探針不做' });
}

const after = await call('GET', `/accounts/${account}/workers/subdomain`);
const unchanged = (after.result && after.result.subdomain) === mine;

for (const r of rows) console.log(`${String(r.status).padEnd(4)} code=${String(r.code ?? '-').padEnd(6)} ${r.what}\n       ${r.note}`);
console.log(`\n子網域量測前後一致：${unchanged ? '是' : '🔴 否——立刻停下來看發生什麼事'}（${mine} → ${after.result && after.result.subdomain}）`);
process.exit(unchanged ? 0 : 1);
