#!/usr/bin/env node
/**
 * resource-rule-gate.mjs — 「該用哪些資源」這個能力，整個 `installer/` 只准有一份實作。
 *
 * ── 這道閘為什麼存在（leo 2026-08-12：「做一個平台要減少 hotfix」）─────────────
 * `Leo/Arcrun#97`（我按了更新，工作流和登入全不見了）的成因不是規則寫錯，
 * 是**同一個能力有兩份實作**：`acr` 那條有規則、安裝器那條自己照名字 ensure。
 * 把安裝器接上共用規則只解掉了「這一次」——**下次有人再寫一支 ensureXxx 就又回去了**。
 * 所以接上不算完成，要留下一道會擋的閘。
 *
 * ── 這道閘的三條判準（票面要求）───────────────────────────────────────────────
 *   ① **會擋，不是只提醒**：任何一項不過就 exit 1，`ship.mjs` 的 preflight 直接拒絕出貨
 *      （放在 preflight 而不是 deploy 站：deploy 站有「線上已是這版就跳過」的快路徑，
 *        擺在那裡會出現「跳過部署＝也跳過檢查」的洞）。
 *   ② **判準看「有沒有在做那件事」，不是「字串有沒有出現」**：
 *      offender 的定義是「**這段程式碼會對 Cloudflare 的資源集合端點發 POST**」
 *      ——也就是它真的在建資源。函式名叫什麼、有沒有出現 `ensure` 這個字，完全不看。
 *      （所以測試裡那些**回應**這些路徑的假 server 不會被誤殺：它們沒有發出任何請求。）
 *   ③ **閘自己要能被測試**：全部是純函式＋路徑注入，
 *      `resource-rule-gate.test.mjs` 會餵它「乾淨的樹」「被抄了一份的樹」「鏡射被改過的樹」
 *      三種輸入，並斷言掃過的檔案數 > 0（防「檢查了 0 個卻通過」）。
 *
 * 用法：
 *   node installer/scripts/resource-rule-gate.mjs          # 全部檢查，不過就 exit 1
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkAgainstManifest, checkAgainstUpstream, findArcrunRoot } from './resource-rule-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..');

/** 掃描範圍：安裝器這一整包（worker 本體＋出貨腳本）。 */
export const SCAN_DIR = join('installer');
/** 共用規則的鏡射——它**就是**那一份實作，當然不算 offender。 */
export const MIRROR_REL = join('installer', 'oauth-prototype', 'shared', 'resource-rule');
/** 接上共用規則的那顆 worker。 */
export const WORKER_REL = join('installer', 'oauth-prototype', 'worker.js');

/**
 * 「建立資源」的端點＝**資源集合本身**。
 * 後面接 `/` 的是子資源（`/d1/database/<id>/query`、`/vectorize/v2/indexes/<n>/metadata-index/create`、
 * `/storage/kv/namespaces/<id>/values/<k>`）——那些不是在建資源，不算。
 */
export const CREATE_ENDPOINTS = [
  { kind: 'KV namespace', re: /storage\/kv\/namespaces(?![\w/])/ },
  { kind: 'D1 資料庫', re: /\/d1\/database(?![\w/])/ },
  { kind: 'Vectorize index', re: /vectorize\/v2\/indexes(?![\w/])/ },
];
const POST_RE = /['"`]POST['"`]/;
/** 真的把請求送出去的呼叫（`installFetch(` 這種測試替身的安裝器不算——`\b` 擋掉了）。 */
const HTTP_CALL_RE = /\b(fetch|cfFetch|cfRaw|doFetch|fetchImpl)\s*\(/;

/**
 * 把原始碼切成「一個個函式主體」＋「剩下的頂層程式碼」。
 *
 * 為什麼要切：判準是「**同一段程式碼**又指著資源集合端點、又發 POST」。
 * 整檔一起看會誤殺（例：同一個檔案裡一個函式在讀、另一個在寫別的東西）。
 *
 * 掃描時會跳過字串／樣板字串／註解裡的大括號，所以 `\`${a}\`` 這種不會把配對弄歪。
 * @param {string} src
 * @returns {Array<{ name: string, line: number, body: string }>}
 */
export function splitFunctionBodies(src) {
  const blocks = [];
  const covered = [];
  const headerRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(|(?:^|\n)\s{2,}(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = headerRe.exec(src)) !== null) {
    const name = m[1] || m[2] || m[3] || '(匿名)';
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    blocks.push({ name, line: src.slice(0, m.index).split('\n').length, body: src.slice(open, close + 1) });
    covered.push([open, close]);
    // 巢狀函式會被外層涵蓋——不跳過它們（多看一次不會漏，只會多報一次同一個位置，
    // 而報告是去重過的）。
  }
  // 🔴 **刻意不把「剩下的頂層程式碼」拼成一塊來看**：那是一堆互不相干的片段黏在一起，
  //   對它套「又有端點、又有 POST」這種且判準必然誤殺（實測：worker.test.mjs 的假 server
  //   片段＋別處的 fetch 被黏成同一塊，判成 offender）。頂層那條路改由 findHttpCalls()
  //   逐個「呼叫運算式」看——那個單位才是真的「同一段程式碼」。
  return blocks;
}

/**
 * 找出每一個真的送出請求的呼叫，回傳它的**整段參數文字**。
 *
 * 這是最保守的單位：`fetch(<這裡面>)`。同一個呼叫裡同時出現資源集合端點與 POST，
 * 才算「這行在建資源」——不會把兩件不相干的事黏在一起。
 * @returns {Array<{ line: number, text: string }>}
 */
export function findHttpCalls(src) {
  const out = [];
  const re = /\b(fetch|cfFetch|cfRaw|doFetch|fetchImpl)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(open, close + 1) });
  }
  return out;
}

/** 同 matchBrace，但配對小括號。 */
function matchParen(src, open) {
  let depth = 0;
  let i = open;
  let prevSig;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i); if (i < 0) return -1; i += 2; continue; }
    if (c === '/' && isRegexStart(prevSig)) { const j = skipRegex(src, i); if (j > 0) { i = j; prevSig = '/'; continue; } }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); if (i < 0) return -1; prevSig = '"'; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prevSig = c;
    else if (c === '\n') prevSig = '\n';
    i++;
  }
  return -1;
}

/** 從 `src[open]` 的 `{` 找到配對的 `}`，跳過字串／樣板／註解。找不到回 -1。 */
function matchBrace(src, open) {
  let depth = 0;
  let i = open;
  let prevSig;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i); if (i < 0) return -1; i += 2; continue; }
    if (c === '/' && isRegexStart(prevSig)) { const j = skipRegex(src, i); if (j > 0) { i = j; prevSig = '/'; continue; } }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); if (i < 0) return -1; prevSig = '"'; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prevSig = c;
    else if (c === '\n') prevSig = '\n';
    i++;
  }
  return -1;
}

/**
 * 這個 `/` 是**正規式的開頭**還是除號？
 *
 * 為什麼要判：正規式裡常有引號（`/['"]/`）。把它當普通字元走過去，
 * 那個引號會被誤認成字串開頭，接下來整段掃描就歪掉了（實測 worker.js 就會歪）。
 * 判準用前一個有意義的字元——夠用而且不會誤判實務上的除法。
 */
function isRegexStart(prevSig) {
  return prevSig === undefined || '(,=:[!&|?{};+-*%~^<>\n'.includes(prevSig);
}

/** 從 `src[i]` 的 `/` 跳到正規式結束（含 flags）後一位；跳脫與字元類 `[...]` 都算進去。 */
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return -1; // 正規式不跨行＝一開始就判錯了，交回呼叫端當普通字元處理
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
      return i;
    }
    i++;
  }
  return -1;
}

/** 從引號跳到對應的結束引號後一位（處理跳脫；樣板字串裡的 `${}` 一併吃掉）。 */
function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      const close = matchBrace(src, i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return -1;
}

/**
 * 這段程式碼有沒有在**建立 Cloudflare 資源**？
 * ＝同一段裡同時有「資源集合端點」「POST」「真的送得出去的呼叫」。
 *
 * 三個條件缺一不可，所以：
 *   · 測試裡那些**回應**這些路徑的假 server → 沒有送出任何請求，不算（實測過，不誤殺）
 *   · `/vectorize/v2/indexes/<n>/metadata-index/create` → 端點後面接 `/`＝子資源，不算
 *   · 讀清單（GET）→ 沒有 POST，不算
 * @param {string} body
 * @param {boolean} [requireCall]  false＝呼叫本身已經確定（findHttpCalls 的參數文字）
 * @returns {string|null} 命中的資源種類；沒有回 null
 */
export function createsCloudflareResource(body, requireCall = true) {
  if (!POST_RE.test(body)) return null;
  if (requireCall && !HTTP_CALL_RE.test(body)) return null;
  for (const ep of CREATE_ENDPOINTS) {
    if (ep.re.test(body)) return ep.kind;
  }
  return null;
}

/**
 * 把註解換成等長空白（行號與位移完全不變），字串／樣板原樣保留。
 *
 * 為什麼要這步：判準是「**程式碼**有沒有在做那件事」。註解裡引用端點、或寫著
 * 「以前這裡是 method: 'POST'」都不是在做那件事——不先剝掉就會誤殺
 * （本檔與 worker.js 的說明註解正好都同時提到端點與 POST）。
 */
export function blankComments(src) {
  let out = '';
  let i = 0;
  let prevSig;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      let end = src.indexOf('*/', i);
      end = end < 0 ? src.length : end + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === '/' && isRegexStart(prevSig)) {
      const end = skipRegex(src, i);
      if (end > 0) { out += src.slice(i, end); i = end; prevSig = '/'; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      if (end < 0) { out += src.slice(i); break; }
      out += src.slice(i, end);
      i = end;
      prevSig = '"';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    else if (c === '\n') prevSig = '\n';
    i++;
  }
  return out;
}

/** 遞迴列出要掃的 .js/.mjs（排除鏡射本身與 node_modules）。 */
export function filesToScan(repoRoot = REPO_ROOT, scanDir = SCAN_DIR, mirrorRel = MIRROR_REL) {
  const out = [];
  const walk = (relDir) => {
    const abs = join(repoRoot, relDir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const rel = join(relDir, name);
      if (rel === mirrorRel || name === 'node_modules' || name.startsWith('.')) continue;
      const st = statSync(join(repoRoot, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(mjs|js)$/.test(name)) out.push(rel);
    }
  };
  walk(scanDir);
  return out;
}

/**
 * 檢查①：`installer/` 底下（鏡射以外）沒有任何一段程式碼在自己建 Cloudflare 資源。
 * @returns {{ ok: boolean, problems: string[], scanned: string[], offenders: Array<{file: string, fn: string, line: number, kind: string}> }}
 */
export function checkSingleImplementation(repoRoot = REPO_ROOT, scanDir = SCAN_DIR, mirrorRel = MIRROR_REL) {
  const scanned = filesToScan(repoRoot, scanDir, mirrorRel);
  const offenders = [];
  for (const rel of scanned) {
    const src = blankComments(readFileSync(join(repoRoot, rel), 'utf8'));
    // ① 函式層：端點被拆進變數、POST 在另一行的寫法（deploy-all.mjs 當初就是這型）
    const reported = [];
    for (const blk of splitFunctionBodies(src)) {
      const kind = createsCloudflareResource(blk.body);
      if (!kind) continue;
      const endLine = blk.line + blk.body.split('\n').length;
      // 巢狀函式會被外層再報一次——同一段程式碼只報最外面那筆
      if (reported.some((r) => blk.line >= r.line && endLine <= r.endLine && r.kind === kind)) continue;
      reported.push({ line: blk.line, endLine, kind });
      offenders.push({ file: rel, fn: blk.name, line: blk.line, kind });
    }
    // ② 呼叫層（最保守、到處都適用）：`fetch(<端點…, method:'POST'…>)`。
    //    只報「不在上面那些函式裡」的（例如寫在模組頂層），不然同一件事會被報兩次。
    for (const call of findHttpCalls(src)) {
      const kind = createsCloudflareResource(call.text, false);
      if (!kind) continue;
      if (reported.some((r) => call.line >= r.line && call.line <= r.endLine && r.kind === kind)) continue;
      offenders.push({ file: rel, fn: `第 ${call.line} 行的呼叫`, line: call.line, kind });
    }
  }
  const problems = offenders.map((o) =>
    `${o.file}:${o.line} 的 \`${o.fn}\` 自己在建 ${o.kind}（對資源集合端點發 POST）。\n` +
    '       🔴 「要不要建、該用哪一顆」只准由 shared/resource-rule/ 決定——這正是 Arcrun#97 的病根。\n' +
    '         → 改成 import `./shared/resource-rule/cf-resource-api.mjs` 的 createCloudflareResourceApi()，\n' +
    '           並讓 planResources()／applyResourcePlan() 決定要不要建。');
  return { ok: offenders.length === 0, problems, scanned, offenders };
}

/**
 * 檢查②：安裝器**真的接上了**（不是鏡射躺在那裡沒人用）。
 * 判準同樣看行為：有沒有 import 共用層、有沒有真的呼叫規則那兩支。
 */
export function checkWiredUp(repoRoot = REPO_ROOT, workerRel = WORKER_REL, mirrorRel = MIRROR_REL) {
  const abs = join(repoRoot, workerRel);
  const problems = [];
  if (!existsSync(abs)) return { ok: false, problems: [`找不到 ${workerRel}`] };
  // 剝註解：說明文字裡提到 `resolveInstanceResources()` 不等於真的接上了
  const src = blankComments(readFileSync(abs, 'utf8'));
  const mirrorImport = mirrorRel.split(sep).slice(-2).join('/'); // 'shared/resource-rule'
  const importRe = new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"][^'"]*${mirrorImport}/`);
  if (!importRe.test(src)) {
    problems.push(`${workerRel} 沒有 import 共用規則（${mirrorImport}/）——鏡射放著沒人用＝這道閘白設。`);
  }
  const usesRule = /\bplanResources\s*\(/.test(src) && /\bapplyResourcePlan\s*\(/.test(src);
  const usesEntry = /\bresolveInstanceResources\s*\(/.test(src);
  if (!usesRule && !usesEntry) {
    problems.push(`${workerRel} 沒有呼叫共用規則（planResources＋applyResourcePlan 或 resolveInstanceResources）。`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 檢查③：兩份測試要真的綠（沒跑過的閘等於沒有閘）。
 *   · `resource-plan.test.mjs`      三種情境：沒裝過／裝過了／名字改過
 *   · `resource-rule-gate.test.mjs` **閘自己**：會不會抓、會不會誤殺、掃到 0 個檔算不算過
 * 第二份特別重要——`copy-contract.test.mjs` 那份文案閘就是沒人跑，於是從來沒擋過任何東西。
 */
export function runScenarioTests(repoRoot = REPO_ROOT) {
  const testRel = [
    join('installer', 'oauth-prototype', 'resource-plan.test.mjs'),
    join('installer', 'scripts', 'resource-rule-gate.test.mjs'),
  ];
  const r = spawnSync(process.execPath, ['--test', ...testRel], { cwd: repoRoot, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  const ok = r.status === 0 && !!pass && Number(pass[1]) > 0 && (!fail || Number(fail[1]) === 0);
  return {
    ok,
    problems: ok ? [] : [`測試沒通過（${testRel.join('、')}）：\n${out.split('\n').filter((l) => /^not ok|^# (pass|fail)/.test(l)).join('\n')}`],
    passed: pass ? Number(pass[1]) : 0,
  };
}

/** 全部跑一遍。回 `{ ok, sections }`——CLI 與測試共用同一個入口。 */
export function runGate(repoRoot = REPO_ROOT) {
  const sections = [];

  const mirror = checkAgainstManifest(join(repoRoot, MIRROR_REL));
  sections.push({ name: '鏡射與上游指紋相符', ...mirror,
    note: mirror.manifest ? `${Object.keys(mirror.manifest.files).length} 檔｜上游 Arcrun@${String(mirror.manifest.upstream_commit).slice(0, 7)}` : '' });

  // Arcrun repo 在場時（出貨機）再對原始檔驗一次
  try {
    const root = findArcrunRoot();
    const up = checkAgainstUpstream(root, join(repoRoot, MIRROR_REL));
    sections.push({ name: '鏡射與上游原始檔逐位元組相同', ...up, note: `${root}（HEAD ${String(up.head).slice(0, 7)}）` });
  } catch {
    sections.push({ name: '鏡射與上游原始檔逐位元組相同', ok: true, problems: [], note: '本機沒有 Arcrun repo，跳過（指紋那關已驗）' });
  }

  const single = checkSingleImplementation(repoRoot);
  // 🔴 防「檢查了 0 個卻通過」（同上游 single-implementation.test.ts 的 assert.ok(files.length > 0)）
  if (single.scanned.length === 0) {
    single.ok = false;
    single.problems = [`一個檔案都沒掃到（${SCAN_DIR}）——掃描範圍設錯了，這種「全綠」是假的。`];
  }
  sections.push({ name: '只有一份實作（沒人自己建 CF 資源）', ...single, note: `掃了 ${single.scanned.length} 個檔` });

  const wired = checkWiredUp(repoRoot);
  sections.push({ name: '安裝器真的接上共用規則', ...wired, note: '' });

  const scenarios = runScenarioTests(repoRoot);
  sections.push({ name: '三種情境測試＋閘自己的演練', ...scenarios, note: `${scenarios.passed} 項通過` });

  return { ok: sections.every((s) => s.ok), sections };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, sections } = runGate();
  for (const s of sections) {
    console.log(`${s.ok ? '✅' : '❌'} ${s.name}${s.note ? `（${s.note}）` : ''}`);
    for (const p of s.problems) console.log(`   - ${p}`);
  }
  if (!ok) {
    console.error('\n🔴 resource-rule 閘不過——拒絕出貨。');
    console.error('   這道閘擋的是「同一個能力被做成兩份實作」，那正是 Leo/Arcrun#97 的成因。');
    process.exit(1);
  }
  console.log('\n✅ resource-rule 閘全過。');
}
