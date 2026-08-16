/**
 * credential-store.test.mjs — 證明「管線自己拿鑰匙」這件事的每條紅線都真的成立
 * （arcrun-rag#102）
 *
 * 跑法：node --test installer/scripts/credential-store.test.mjs
 * （零依賴、全程用臨時目錄假造 .env，**不碰任何真的 .env、不碰網路**）
 *
 * 這份測試的重點不是「能不能讀到值」——那是最容易對的那件事。重點是四條**紅線**：
 *   ① 操作者在 shell 明確給的值**永遠贏**，自動來源不准覆蓋
 *   ② 缺鑰匙照樣**當場斷**，而且訊息說得出缺哪個名字（沒有把閘放寬）
 *   ③ D36：**任何**對外輸出（來源說明、錯誤訊息）都不得出現金鑰的真身
 *   ④ 不寫死相對路徑：repo 放在**任何深度**都要找得到往上那份 .env
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envChain, readNames, fill, describeSources, missingCredentialError, ENV_FILES_OVERRIDE,
} from './credential-store.mjs';

/** 假造一棵目錄樹：<root>/a/b/c，並在指定層放 .env。 */
function tree(envs = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cred-store-test-'));
  const deep = join(root, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  for (const [rel, body] of Object.entries(envs)) {
    const dir = rel === '.' ? root : join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), body);
  }
  return { root, deep, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── ④ 不寫死相對路徑 ───────────────────────────────────────────────────────
test('往上逐層找 .env：repo 埋在多深都找得到（近的排前面）', () => {
  const t = tree({ '.': 'TOP=1\n', 'a/b': 'MID=1\n' });
  try {
    const chain = envChain(t.deep, { stopAt: t.root });
    assert.deepEqual(chain, [join(t.root, 'a', 'b', '.env'), join(t.root, '.env')]);
  } finally { t.cleanup(); }
});

test('🔴 同一把鑰匙在深淺兩層都有 ⇒ 近的那份贏（可預測，不看誰先被掃到）', () => {
  const t = tree({ '.': 'K=from-top\n', 'a/b': 'K=from-mid\n' });
  try {
    const env = {};
    const r = fill(['K'], { startDir: t.deep, env, stopAt: t.root });
    assert.equal(env.K, 'from-mid');
    assert.equal(r.resolved[0].source, join(t.root, 'a', 'b', '.env'));
  } finally { t.cleanup(); }
});

test('叫 .env 的**目錄**不算數（不會被當成一份憑證檔）', () => {
  const t = tree({ '.': 'K=v\n' });
  try {
    mkdirSync(join(t.deep, '.env'), { recursive: true });
    const chain = envChain(t.deep, { stopAt: t.root });
    assert.deepEqual(chain, [join(t.root, '.env')]);
  } finally { t.cleanup(); }
});

// ── 只取被點名的鍵 ─────────────────────────────────────────────────────────
test('🔒 只取被點名的鍵——整包 .env 不會被灌進來', () => {
  const t = tree({ '.': 'WANTED=yes\nOTHER_SECRET=nope\nTHIRD=nope\n' });
  try {
    const got = readNames(join(t.root, '.env'), ['WANTED']);
    assert.deepEqual([...got.keys()], ['WANTED']);
    const env = {};
    fill(['WANTED'], { startDir: t.root, env, stopAt: t.root });
    assert.deepEqual(Object.keys(env), ['WANTED']);   // 其他兩把連碰都沒碰
  } finally { t.cleanup(); }
});

test('讀得懂 export／引號／註解／空白，讀不懂的行安靜略過', () => {
  const t = tree({
    '.': [
      '# 這是註解 A=comment',
      '',
      'export B=exported',
      'C="double"',
      "D='single'",
      'E = spaced ',
      '這行不是賦值',
      'F=',                       // 空值＝當作沒有
    ].join('\n'),
  });
  try {
    const got = readNames(join(t.root, '.env'), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.equal(got.has('A'), false);
    assert.equal(got.get('B'), 'exported');
    assert.equal(got.get('C'), 'double');
    assert.equal(got.get('D'), 'single');
    assert.equal(got.get('E'), 'spaced');
    assert.equal(got.has('F'), false);
  } finally { t.cleanup(); }
});

// ── ① 操作者永遠贏 ─────────────────────────────────────────────────────────
test('🔴 操作者在 shell 給的值永遠贏——自動來源不准覆蓋', () => {
  const t = tree({ '.': 'K=from-env-file\n' });
  try {
    const env = { K: 'from-operator' };
    const r = fill(['K'], { startDir: t.root, env, stopAt: t.root });
    assert.equal(env.K, 'from-operator', '自動來源蓋掉了人明確給的值＝把人的意圖弄丟');
    assert.deepEqual(r.resolved, [{ name: 'K', source: 'shell' }]);
  } finally { t.cleanup(); }
});

// ── ② 缺了照樣斷 ───────────────────────────────────────────────────────────
test('🔴 一份 .env 都沒有 ⇒ 算缺，不是算過（閘沒有被放寬）', () => {
  const t = tree({});
  try {
    const env = {};
    const r = fill(['NOPE'], { startDir: t.deep, env, stopAt: t.root });
    assert.deepEqual(r.missing, ['NOPE']);
    assert.deepEqual(r.resolved, []);
    assert.equal(env.NOPE, undefined);
  } finally { t.cleanup(); }
});

test('缺鑰匙的訊息說得出「缺哪個名字」與「查過哪幾份」', () => {
  const t = tree({ '.': 'SOMETHING_ELSE=x\n' });
  try {
    const r = fill(['MY_TOKEN'], { startDir: t.deep, env: {}, stopAt: t.root });
    const msg = missingCredentialError(r).message;
    assert.match(msg, /MY_TOKEN/);
    assert.match(msg, /credentials-map\.md/);
    assert.ok(msg.includes(join(t.root, '.env')), '要列出實際查過的路徑，人才知道該補去哪');
  } finally { t.cleanup(); }
});

// ── ③ D36：值永遠不外洩 ────────────────────────────────────────────────────
test('🔴 D36：來源說明裡只有名字與檔案路徑，**沒有值**', () => {
  const SECRET = 'ghp-DO-NOT-LEAK-4f3a9b';
  const t = tree({ '.': `TOKEN_A=${SECRET}\n` });
  try {
    const env = {};
    const r = fill(['TOKEN_A'], { startDir: t.deep, env, stopAt: t.root });
    assert.equal(env.TOKEN_A, SECRET, '值還是要真的拿到（拿得到才用得了）');

    const printed = [
      ...describeSources(r),
      JSON.stringify(r),                       // 回傳結構整包序列化也不准有
      missingCredentialError({ ...r, missing: ['TOKEN_A'] }).message,
    ].join('\n');
    assert.ok(!printed.includes(SECRET), `真身外洩了：${printed}`);
    assert.match(printed, /TOKEN_A/);          // 名字要在（不然人看不懂發生什麼事）
  } finally { t.cleanup(); }
});

test('🔴 D36：operator 給的值同樣不外洩', () => {
  const SECRET = 'operator-secret-9z';
  const t = tree({});
  try {
    const r = fill(['TOKEN_B'], { startDir: t.root, env: { TOKEN_B: SECRET }, stopAt: t.root });
    const printed = [...describeSources(r), JSON.stringify(r)].join('\n');
    assert.ok(!printed.includes(SECRET), `真身外洩了：${printed}`);
  } finally { t.cleanup(); }
});

// ── 逃生門 ─────────────────────────────────────────────────────────────────
test(`${ENV_FILES_OVERRIDE} 可以指定要查哪幾份（順序即優先序），且不放寬任何判準`, () => {
  const t = tree({ 'a': 'K=from-a\n', 'a/b': 'K=from-b\n' });
  try {
    const override = `${join(t.root, 'a', '.env')}:${join(t.root, 'a', 'b', '.env')}`;
    const env = {};
    const r = fill(['K'], { startDir: t.deep, env, override, stopAt: t.root });
    assert.equal(env.K, 'from-a', 'override 的順序就是優先序');
    // 指定的檔案不存在 ⇒ 直接不列入，不是靜默改用別的來源
    const r2 = fill(['K'], { startDir: t.deep, env: {}, override: join(t.root, 'nope', '.env') });
    assert.deepEqual(r2.searched, []);
    assert.deepEqual(r2.missing, ['K']);
  } finally { t.cleanup(); }
});

test('多把鑰匙可以來自不同層的 .env，各自記住自己的來源', () => {
  const t = tree({ '.': 'FAR=1\n', 'a/b': 'NEAR=1\n' });
  try {
    const env = {};
    const r = fill(['NEAR', 'FAR', 'GONE'], { startDir: t.deep, env, stopAt: t.root });
    assert.equal(r.resolved.find((x) => x.name === 'NEAR').source, join(t.root, 'a', 'b', '.env'));
    assert.equal(r.resolved.find((x) => x.name === 'FAR').source, join(t.root, '.env'));
    assert.deepEqual(r.missing, ['GONE']);
  } finally { t.cleanup(); }
});
