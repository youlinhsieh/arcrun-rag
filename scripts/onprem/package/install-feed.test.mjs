/**
 * install.sh 的更新來源預設值（inkstone/arcrun-rag#394）：用假 docker 實跑 `./install.sh up`，看 docker run 帶了什麼環境變數。
 *   不設        → 預設 https://install.arcrun.dev/onprem/latest.json
 *   設成空字串  → 不帶（不能連外的公司清掉；不會被預設值補回來）
 *   設成別的    → 照給的
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT = 'https://install.arcrun.dev/onprem/latest.json';

function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'install-feed-'));
  const bin = join(d, 'bin'), pkg = join(d, 'pkg');
  mkdirSync(bin); mkdirSync(join(pkg, 'images'), { recursive: true }); mkdirSync(join(pkg, 'kb'));
  copyFileSync(join(HERE, 'install.sh'), join(pkg, 'install.sh')); chmodSync(join(pkg, 'install.sh'), 0o755);
  writeFileSync(join(pkg, 'kb', 'MANIFEST.json'), '{"tenant":"t1"}');
  writeFileSync(join(pkg, 'images', 'arcrun-private-cloud-1.0.tar.gz'), '');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> "$LOGF"
case "$1" in
  info) exit 0;; version) echo amd64;; image) exit 0;;
  inspect) case "$*" in *Health*) echo healthy;; *) exit 1;; esac;;
  exec) echo '{"install_id":"X"}';;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sha256sum'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return { d, bin, pkg, log: join(d, 'log') };
}
function up(extraEnv, unset) {
  const s = sandbox();
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, LOGF: s.log, ...extraEnv };
  if (unset) delete env.ARCRUN_UPDATE_FEED;
  writeFileSync(s.log, '');
  const r = spawnSync('bash', [join(s.pkg, 'install.sh'), 'up'], { env, encoding: 'utf8' });
  const run = readFileSync(s.log, 'utf8').split('\n').find((l) => l.startsWith('docker run')) || '';
  return { r, run, out: r.stdout };
}

test('不設：容器帶預設的官方 latest.json，輸出也說出更新來源', () => {
  const { r, run, out } = up({}, true);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(run.includes(`ARCRUN_UPDATE_FEED=${DEFAULT}`), run);
  assert.ok(out.includes(DEFAULT));
});

test('設成空字串：不帶更新來源（不能連外），輸出說「未設」', () => {
  const { r, run, out } = up({ ARCRUN_UPDATE_FEED: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!run.includes('ARCRUN_UPDATE_FEED'), run);
  assert.match(out, /未設/);
});

test('設成別的網址：照給的（例如 stage、公司內部鏡像）', () => {
  const { r, run } = up({ ARCRUN_UPDATE_FEED: 'https://mirror.corp.test/latest.json' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(run.includes('ARCRUN_UPDATE_FEED=https://mirror.corp.test/latest.json'), run);
  assert.ok(!run.includes(DEFAULT));
});
