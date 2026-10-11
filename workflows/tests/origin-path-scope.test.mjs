// inkstone/Arcrun#92 c18986：列「舊 block」的請求必須把範圍縮到「這張卡自己」（origin_path），
// 不能只靠 page_name——各資料夾都有的 00-INDEX.md 共用同一頁名，撈回的列數隨庫累積，
// 即使 view=identity 也會在 leo21c 量級越過 http_request 的 64 KiB 回應上限（實測 67,480 bytes）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const CASES = [
  ['rag_ingest_card', 'list_old_blocks', 'workflows/rag-ingest-card.local.yaml'],
  ['rag_takedown_direct', 'list_dead_blocks', 'workflows/rag-takedown-direct.local.yaml'],
];

for (const [wfName, node, yamlPath] of CASES) {
  test(`${yamlPath}：${node} 帶 view=identity 與 origin_path`, () => {
    const y = read(yamlPath);
    const m = y.match(new RegExp(node + ':[\\s\\S]*?url:\\s*"([^"]*)"'));
    assert.ok(m, `找不到 ${node}`);
    assert.match(m[1], /view=identity/);
    assert.match(m[1], /origin_path=\{\{prep\.data\.path_enc\}\}/);
  });
  test(`${yamlPath}：prep 有算 path_enc`, () => {
    assert.match(read(yamlPath), /path_enc:\s*encodeURIComponent\(path\)/);
  });
  for (const f of ['installer/src/workflows.json', 'installer/oauth-prototype/workflows.json']) {
    test(`${f}：${wfName}.${node} 預編圖帶 origin_path`, () => {
      const wf = JSON.parse(read(f));
      const list = Array.isArray(wf) ? wf : Object.values(wf);
      const w = list.find((x) => x && x.name === wfName);
      assert.ok(w, `找不到 ${wfName}`);
      assert.match(w.config[node].url, /origin_path=\{\{prep\.data\.path_enc\}\}/);
    });
  }
}
