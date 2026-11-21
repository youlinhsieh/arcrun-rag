/** apps-feed-fingerprint.test.mjs — App 市集目錄指紋：穩定、只認 id／版本／包內容、不認 generated_at（inkstone/Arcrun#471）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appsFeedFingerprintFromDir, appsFeedFingerprint } from './apps-feed-fingerprint.mjs';

function feed(apps, generatedAt) {
  const dir = mkdtempSync(join(tmpdir(), 'afp-'));
  mkdirSync(join(dir, 'packages'));
  for (const x of apps) writeFileSync(join(dir, 'packages', `${x.id}-${x.version}.json`), JSON.stringify({ exported_at: generatedAt, app: { id: x.id }, declaration: { body: x.sha } }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 1, generated_at: generatedAt, apps: apps.map((a) => ({ id: a.id, version: a.version, package: { url: `packages/${a.id}-${a.version}.json`, sha256: 'declared-' + generatedAt } })) }));
  return dir;
}

test('指紋不受 generated_at 影響；App 版本或包內容一變就變；順序不影響', () => {
  const a = feed([{ id: 'ahub', version: '0.53.0', sha: 'aa' }, { id: 'loops', version: '0.4.0', sha: 'bb' }], '2026-11-21T01:00:00Z');
  const b = feed([{ id: 'loops', version: '0.4.0', sha: 'bb' }, { id: 'ahub', version: '0.53.0', sha: 'aa' }], '2026-11-22T09:00:00Z');
  const c = feed([{ id: 'ahub', version: '0.54.0', sha: 'aa' }, { id: 'loops', version: '0.4.0', sha: 'bb' }], '2026-11-21T01:00:00Z');
  const d = feed([{ id: 'ahub', version: '0.53.0', sha: 'ZZ' }, { id: 'loops', version: '0.4.0', sha: 'bb' }], '2026-11-21T01:00:00Z');
  try {
    const fa = appsFeedFingerprintFromDir(a);
    assert.match(fa, /^[0-9a-f]{64}$/);
    assert.equal(fa, appsFeedFingerprintFromDir(b));
    assert.notEqual(fa, appsFeedFingerprintFromDir(c), '版本變要變');
    assert.notEqual(fa, appsFeedFingerprintFromDir(d), '包內容變要變');
  } finally { for (const x of [a, b, c, d]) rmSync(x, { recursive: true, force: true }); }
});

test('沒有目錄／沒有 app-market 的來源 ⇒ 空字串（不加後綴、不虛增版號）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'afp-'));
  try {
    assert.equal(appsFeedFingerprintFromDir(empty), '');
    assert.equal(appsFeedFingerprint(empty), '');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('真的 Arcrun 來源連跑兩次指紋相同（若本機有來源）', () => {
  const src = process.env.ARCRUN_REPO_ROOT;
  if (!src) return;
  assert.equal(appsFeedFingerprint(src), appsFeedFingerprint(src));
});
