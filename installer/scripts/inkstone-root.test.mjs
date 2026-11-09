// inkstone-root.mjs／d20-guard.mjs 留痕的測試（inkstone/arcrun-rag#298 第二個缺口：留痕 ENOENT）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInkstoneRoot } from './inkstone-root.mjs';
import { logGithubContact, contactLogPath } from './d20-guard.mjs';

const MARK = ['system-dev', 'docs', '3-specs', 'autonomy-dispatch'];
const mk = (root) => { mkdirSync(join(root, ...MARK), { recursive: true }); return root; };
const noMain = () => null;
const NOFIX = { fixed: [] };

test('環境變數 INKSTONE_ROOT 贏過一切', () => {
  const r = resolveInkstoneRoot('/x/y', { env: { INKSTONE_ROOT: '/a/b' }, home: '/nope', mainCheckoutOf: noMain, ...NOFIX });
  assert.equal(r.root, '/a/b');
});

test('往上找：住在 InkStoneCo/products/arcrun-rag 的地端形狀', () => {
  const top = mk(mkdtempSync(join(tmpdir(), 'ink-')));
  const repo = join(top, 'products', 'arcrun-rag'); mkdirSync(repo, { recursive: true });
  assert.equal(resolveInkstoneRoot(repo, { env: {}, home: '/nope', mainCheckoutOf: noMain, ...NOFIX }).root, top);
});

test('雲端形狀：工作樹在 <rag>/.worktrees/x（往上兩層沒有頂層）⇒ 找到雲端固定落點，不是 <rag>', () => {
  const base = mkdtempSync(join(tmpdir(), 'cloud-'));
  const rag = join(base, 'rag'); const wt = join(rag, '.worktrees', 'arcrun-rag-351'); mkdirSync(wt, { recursive: true });
  const home = join(base, 'home'); const top = mk(join(home, 'inkstoneco', 'InkStoneCo'));
  const r = resolveInkstoneRoot(wt, { env: {}, home, mainCheckoutOf: () => rag, ...NOFIX });
  assert.equal(r.root, top);
  assert.notEqual(r.root, rag);
});

test('哪裡都找不到 ⇒ 退回舊算法，並且留痕會自己建目錄（不再 ENOENT）', () => {
  const base = mkdtempSync(join(tmpdir(), 'none-'));
  const wt = join(base, 'rag', '.worktrees', 'w'); mkdirSync(wt, { recursive: true });
  const r = resolveInkstoneRoot(wt, { env: {}, home: join(base, 'h'), mainCheckoutOf: noMain, ...NOFIX });
  assert.equal(r.root, join(base, 'rag'));
  assert.equal(existsSync(contactLogPath(r.root)), false);
  const line = logGithubContact(r.root, 'ARM: 1.0.0（測試）', 'push x\n換行會被拿掉');
  assert.match(readFileSync(contactLogPath(r.root), 'utf8'), /ARM: 1\.0\.0/);
  assert.equal(line.indexOf('\n'), line.length - 1, '內文的換行被拿掉，只剩結尾那一個');
});
