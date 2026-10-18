/**
 * 跑法：node --test installer/scripts/daemon-stale-keys.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropStaleDaemonKeys } from './daemon-stale-keys.mjs';

const base = {
  version: '0.18.112', built: 'x', notes: 'n',
  mac: { file: 'daemon/Arcrun-0.18.112.dmg', sha256: 'a' },
  win: { file: 'daemon/Arcrun-win-0.18.112.exe', sha256: 'b' },
};

test('舊版 msix 殘留（prod 實撞）⇒ 移除，其餘不動', () => {
  const d = { ...base, msix: { file: 'daemon/Arcrun-0.18.99.msix', sha256: 'c' } };
  const r = dropStaleDaemonKeys(d, '0.18.112');
  assert.equal('msix' in r.daemon, false);
  assert.equal(r.dropped.length, 1);
  assert.deepEqual(r.daemon.mac, base.mac);
  assert.deepEqual(r.daemon.win, base.win);
  assert.equal(r.daemon.notes, 'n');
  assert.ok('msix' in d, '不得改動輸入物件');
});

test('stage 形狀（本來就沒有 msix）⇒ 原封不動', () => {
  const r = dropStaleDaemonKeys(base, '0.18.112');
  assert.deepEqual(r.daemon, base);
  assert.deepEqual(r.dropped, []);
});

test('這一版的 msix 有打 ⇒ 保留', () => {
  const d = { ...base, msix: { file: 'daemon/Arcrun-0.18.112.msix', sha256: 'c' } };
  const r = dropStaleDaemonKeys(d, '0.18.112');
  assert.deepEqual(r.daemon.msix, d.msix);
  assert.deepEqual(r.dropped, []);
});

test('mac 也是舊版 ⇒ 一併移除（讓 daemon-check 以「缺平台」擋下，而不是放行舊檔）', () => {
  const d = { ...base, mac: { file: 'daemon/Arcrun-0.18.99.dmg', sha256: 'a' } };
  const r = dropStaleDaemonKeys(d, '0.18.112');
  assert.equal('mac' in r.daemon, false);
});

test('空輸入不丟例外', () => {
  assert.deepEqual(dropStaleDaemonKeys(null, '1').daemon, {});
});
