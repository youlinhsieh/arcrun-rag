import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tomlVar, hasOnpremBinding } from './ship-onprem-prod.mjs';

const T = `name = "x"\n[vars]\nA = "1"\nBUNDLE_BASE = "https://b/1"\n[env.s.vars]\nBUNDLE_BASE = "stage"\n`;
test('tomlVar 只讀頂層 [vars]，不讀 env 段', () => {
  assert.equal(tomlVar(T, 'BUNDLE_BASE'), 'https://b/1');
  assert.equal(tomlVar(T, 'NOPE'), null);
});
test('hasOnpremBinding 註解掉的不算', () => {
  assert.equal(hasOnpremBinding('# [[r2_buckets]]\n# binding = "ONPREM"\n'), false);
  assert.equal(hasOnpremBinding('[[r2_buckets]]\nbinding = "ONPREM"\nbucket_name = "arcrun-onprem"\n'), true);
});
