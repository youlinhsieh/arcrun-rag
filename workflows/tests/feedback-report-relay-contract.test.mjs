// 轉送版 feedback_report（inkstone/arcrun-rag#282）的契約：youlin 上不得有任何金鑰，且只轉往 uncle6 的同名 trigger。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const live = readFileSync(new URL('../feedback-report.relay.yaml', import.meta.url), 'utf8')
  .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('轉送版不放任何金鑰（youlin 不放 ahub_token）', () => {
  assert.ok(!/credential\./.test(live));
  assert.ok(!/Authorization|token/i.test(live));
});

test('只轉到 uncle6 的 inbox-feedback/feedback_report trigger，且名字與收件端一致', () => {
  assert.match(live, /^name: feedback_report$/m);
  assert.match(live, /url: "https:\/\/arcrun-cypher-executor\.uncle6-me\.workers\.dev\/webhooks\/named\/inbox-feedback\/feedback_report\/trigger"/);
});

test('失敗時把 uncle6 的錯誤（含「重複候選=」）原樣帶回', () => {
  assert.match(live, /env\.error/);
  assert.match(live, /forward\.data\.body/);
});
