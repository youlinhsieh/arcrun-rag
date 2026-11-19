/** inkstone/arcrun-rag#365：票號拿掉後不留「（；執行票）」這種殘句（prod 1.4.249 版本說明實撞）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTicketRefs } from './daemon-notes.mjs';

test('括號裡「意圖票；執行票 票號」拿掉票號後整個括號消失，不留殘句', () => {
  const out = stripTicketRefs('這版完成：小幫手修不了檔案時出現那張卡（inkstone/Arcrun#465；執行票 inkstone/arcrun-rag#362）');
  assert.equal(out, '這版完成：小幫手修不了檔案時出現那張卡');
  assert.doesNotMatch(out, /執行票|；|（\s*）/);
});

test('既有行為不變：只有票號的括號整個拿掉、句中票號只拿票號', () => {
  assert.equal(stripTicketRefs('修好某事（inkstone/arcrun-rag#362）'), '修好某事');
  assert.equal(stripTicketRefs('甲 inkstone/x#3 乙'), '甲 乙');
});
