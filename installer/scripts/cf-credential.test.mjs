/**
 * cf-credential.test.mjs — 證明「出貨線部署 Cloudflare 不吃 `~/.wrangler` 登入態」
 * 這件事的每條紅線都真的成立（inkstone/arcrun-rag#212）
 *
 * 跑法：node --test installer/scripts/cf-credential.test.mjs
 * （零依賴、全程用臨時目錄假造 .env，**不碰任何真的 .env、不碰網路、不呼叫 wrangler**）
 *
 * 三條紅線：
 *   ① 帳號沒在登錄簿宣告要用哪把鑰匙 ⇒ 當場斷，**不退回 OAuth**（那正是本票要治的病）
 *   ② 解出來的部署環境**顯式帶 CLOUDFLARE_API_TOKEN**——不是「碰巧環境裡有」，
 *      是這支主動把它塞進去，足以蓋過任何 ambient 登入態
 *   ③ D36：對外輸出（`lines`）只有名字與來源，沒有值
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployAccountsOf, credentialNameFor, cloudflareDeployEnv } from './cf-credential.mjs';

function tempEnvDir(body) {
  const root = mkdtempSync(join(tmpdir(), 'cf-credential-test-'));
  writeFileSync(join(root, '.env'), body);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('deployAccountsOf：去重蒐集 installer／docsSite／mailRelay 的 accountId', () => {
  const T = {
    installer: { accountId: 'ACC1' },
    docsSite: { accountId: 'ACC1' },
    mailRelay: { accountId: 'ACC2' },
  };
  assert.deepEqual(deployAccountsOf(T), ['ACC1', 'ACC2']);
});

test('deployAccountsOf：目標沒有某一站就跳過它，不炸', () => {
  assert.deepEqual(deployAccountsOf({ installer: { accountId: 'ACC1' } }), ['ACC1']);
  assert.deepEqual(deployAccountsOf({}), []);
});

// ── ① 沒宣告 ⇒ 當場斷，不退回 OAuth ────────────────────────────────────────
test('credentialNameFor：登錄簿沒登記這個帳號 ⇒ 丟錯，訊息不建議「退回登入態」', () => {
  assert.throws(
    () => credentialNameFor({ cloudflareCredentials: {} }, 'UNKNOWN_ACCOUNT'),
    (e) => e.message.includes('UNKNOWN_ACCOUNT') && e.message.includes('cloudflareCredentials'),
  );
});

test('credentialNameFor：支援兩種登記形狀（純字串 / {name,note}）', () => {
  assert.equal(credentialNameFor({ cloudflareCredentials: { A: 'TOK_A' } }, 'A'), 'TOK_A');
  assert.equal(credentialNameFor({ cloudflareCredentials: { A: { name: 'TOK_A', note: 'x' } } }, 'A'), 'TOK_A');
});

// ── ② 顯式帶 CLOUDFLARE_API_TOKEN，蓋過 ambient 登入態 ─────────────────────
test('cloudflareDeployEnv：解出來的 env 帶 CLOUDFLARE_ACCOUNT_ID 與 CLOUDFLARE_API_TOKEN', () => {
  const t = tempEnvDir('UNCLE6_TOK=secret-value\n');
  try {
    const cfg = { cloudflareCredentials: { ACC1: { name: 'UNCLE6_TOK' } } };
    const env = {};
    const r = cloudflareDeployEnv({ cfg, accountId: 'ACC1', startDir: t.root, env, stopAt: t.root });
    assert.deepEqual(r.env, { CLOUDFLARE_ACCOUNT_ID: 'ACC1', CLOUDFLARE_API_TOKEN: 'secret-value' });
    assert.equal(r.name, 'UNCLE6_TOK');
  } finally { t.cleanup(); }
});

test('🔴 操作者在 shell 明確給的值贏過 .env（fill() 的既有規則，這裡原樣繼承）', () => {
  const t = tempEnvDir('UNCLE6_TOK=from-env-file\n');
  try {
    const cfg = { cloudflareCredentials: { ACC1: { name: 'UNCLE6_TOK' } } };
    const env = { UNCLE6_TOK: 'from-shell' };
    const r = cloudflareDeployEnv({ cfg, accountId: 'ACC1', startDir: t.root, env, stopAt: t.root });
    assert.equal(r.env.CLOUDFLARE_API_TOKEN, 'from-shell');
  } finally { t.cleanup(); }
});

test('cloudflareDeployEnv：鑰匙哪裡都找不到 ⇒ 當場斷（不靜默退回 OAuth）', () => {
  const t = tempEnvDir('OTHER=1\n');
  try {
    const cfg = { cloudflareCredentials: { ACC1: { name: 'MISSING_TOK' } } };
    assert.throws(
      () => cloudflareDeployEnv({ cfg, accountId: 'ACC1', startDir: t.root, env: {}, stopAt: t.root }),
      (e) => e.message.includes('MISSING_TOK'),
    );
  } finally { t.cleanup(); }
});

// ── ③ D36：對外輸出只有名字與來源，沒有值 ──────────────────────────────────
test('🔴 D36：cloudflareDeployEnv 的 lines 不含金鑰真身', () => {
  const t = tempEnvDir('UNCLE6_TOK=super-secret-do-not-print\n');
  try {
    const cfg = { cloudflareCredentials: { ACC1: { name: 'UNCLE6_TOK' } } };
    const r = cloudflareDeployEnv({ cfg, accountId: 'ACC1', startDir: t.root, env: {}, stopAt: t.root });
    for (const line of r.lines) {
      assert.equal(line.includes('super-secret-do-not-print'), false, `lines 洩漏了值：${line}`);
    }
  } finally { t.cleanup(); }
});
