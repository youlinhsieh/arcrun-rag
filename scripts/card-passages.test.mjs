// 工單 B（Arcrun#343）：從已萃好的卡取原文層切段——契約測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUnits, buildPassages, withIds, passageIdPrefix, layerHash, cleanRows, MAX_RUNES } from './lib/card-passages.mjs';

const CARD = `---
tags: [x]
---

# 機台

## 摘要
這段摘要不准被嵌入。

## 重點
- 重點也不嵌

## 原文條列
以下是原檔文字層裡的條列段落。

### PDF 第 13 頁的條列：2.3.3 Z-axis
第 1 項｜Ram is secured on the saddle for up-down movement.
第 2 項｜Axial system on X/Y/Z-axis equip with mechanical anti-collision device to prevent
第 3 項｜operation error or accidental damage to ensure the safety.

### PDF 第 14 頁的條列：2.4.1 Milling Head Feature
第 1 項｜Fork structure design, both sides are equipped with bearing supports.

## 原文段落
### PDF 第 2 頁的段落
第 1 段｜2/26 Contents

### PDF 第 5 頁的段落
第 1 段｜5/26

第 2 段｜1.3 Control System
CNC controller: CNC HEIDENHAIN TNC7 Full 5-axis continuous. Include 5-axes the entire axis closed loop.

## 讀圖原文
以下是原檔圖片頁經機器辨識出的文字。

### PDF 第 11 頁的圖片辨識文字

## 2.3 Driving System

### 2.3.1 X-axis

* X-axis adopts 2 high-speed and heavy-duty roller guide ways on each column.

11/26

### PDF 第 12 頁的圖片辨識文字
2.3.2 Y-axis Crossbeam on Y-axis adopts Box in Box symmetrical structure design.

## 實體
- **Spindle**（工具）— 24,000rpm

## 關聯
- A >> 是 >> B
`;

test('只取四個原文層；摘要／重點／實體／關聯一個字都不進段落', () => {
  const ps = buildPassages('機台', CARD);
  const all = ps.map((p) => p.content).join('\n');
  assert.ok(!all.includes('這段摘要'));
  assert.ok(!all.includes('重點也不嵌'));
  assert.ok(!all.includes('24,000rpm'));
  assert.ok(!all.includes('>> 是 >>'));
  assert.deepEqual([...new Set(ps.map((p) => p.layer))].sort(), ['原文條列', '原文段落', '讀圖原文'].sort());
});

test('每段帶「卡名 › 層 › 頁」標題與頁碼；防撞章節答案在第 13 頁', () => {
  const ps = buildPassages('機台', CARD);
  const hit = ps.find((p) => /anti-collision/.test(p.content));
  assert.ok(hit, '找不到 anti-collision 段');
  assert.equal(hit.page, 13);
  assert.equal(hit.layer, '原文條列');
  assert.match(hit.heading, /^機台 › 原文條列 › PDF 第 13 頁：2\.3\.3 Z-axis$/);
  assert.ok(hit.content.startsWith(hit.heading + '\n'));
});

test('讀圖原文內文裡的 ## / ### 不會被當成章節邊界', () => {
  const ps = buildPassages('機台', CARD);
  const p11 = ps.find((p) => p.page === 11 && p.layer === '讀圖原文');
  assert.ok(p11);
  assert.match(p11.text, /2\.3 Driving System/);
  assert.match(p11.text, /2\.3\.1 X-axis/);
  assert.match(p11.text, /roller guide ways/);
});

test('列首編號（第 N 項｜）是卡加的、不是原稿，要拿掉；原稿文字一字不改', () => {
  assert.equal(cleanRows('第 1 項｜abc\n第 12 段｜def'), 'abc\ndef');
  const ps = buildPassages('機台', CARD);
  const hit = ps.find((p) => /anti-collision/.test(p.content));
  assert.ok(!/第 \d+ 項｜/.test(hit.content));
  assert.ok(hit.content.includes('Axial system on X/Y/Z-axis equip with mechanical anti-collision device to prevent'));
});

test('頁碼、章名這種雜訊（內容少於門檻）不成段', () => {
  const ps = buildPassages('機台', CARD);
  assert.ok(!ps.some((p) => p.page === 2), '第 2 頁只有「2/26 Contents」，不該成段');
});

test('不跨頁合併：第 13、14 頁的條列各自一段', () => {
  const ps = buildPassages('機台', CARD).filter((p) => p.layer === '原文條列');
  assert.deepEqual(ps.map((p) => p.page), [13, 14]);
});

test('超長單元在句界切開，每段不超過上限太多、idx 連續', () => {
  const longBody = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} describes the feature in detail.`).join(' ');
  const md = `## 原文段落\n### PDF 第 9 頁的段落\n第 1 段｜${longBody}\n`;
  const ps = buildPassages('長', md);
  assert.ok(ps.length >= 3, `應切成多段，實得 ${ps.length}`);
  ps.forEach((p, i) => { assert.equal(p.idx, i); assert.ok(Array.from(p.text).length <= MAX_RUNES); });
});

test('沒有原文層的舊卡＝零段落（不猜、不拿摘要湊）', () => {
  assert.deepEqual(buildPassages('舊卡', '# 舊卡\n\n## 摘要\n有摘要\n\n## 重點\n- 點\n'), []);
  assert.deepEqual(extractUnits(''), []);
});

test('段落 id 格式合 rag_ingest_passages 驗證、與小幫手切檔的命名空間不同、同卡穩定', () => {
  const ps = withIds(buildPassages('機台', CARD), 'm@x', 'lib', '機台');
  for (const p of ps) assert.match(p.id, /^psg-[0-9a-f]{16}-\d+$/);
  assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
  assert.equal(passageIdPrefix('m@x', 'lib', '機台'), passageIdPrefix('m@x', 'lib', '機台'));
  assert.notEqual(passageIdPrefix('m@x', 'lib', 'A'), passageIdPrefix('m@x', 'lib', 'B'));
  assert.equal(layerHash(ps), layerHash(withIds(buildPassages('機台', CARD), 'm@x', 'lib', '機台')));
  assert.notEqual(layerHash(ps), layerHash(buildPassages('機台', CARD.replace('anti-collision', 'anti-crash'))));
});

test('真資料格式：「第 N 頁的表格（第 1 段）」要認得、「無法逐字抽取的表格」說明不併進前一頁', () => {
  const md = `## 原文表格
### PDF 第 5 頁的表格（第 1 段）
第 1 列｜Rotate angle｜degree｜±115° / ±360° and some more text to pass the noise limit
### PDF 第 5 頁的表格（第 2 段）
第 1 列｜Spindle power S1 -100% (S6-40%)｜kW｜42 (55) and enough text to be kept here
### PDF 第 6 頁的表格
第 1 列｜Tool capacity｜T｜30 (opt. 60) and a few more words to be long enough
### 無法逐字抽取的表格
PDF 第 7、9 頁疑似有表格，但文字層的字被拆成單字元，無法逐字抽取，請查原檔。

## 原文段落
`;
  const ps = buildPassages('手冊', md);
  assert.deepEqual(ps.map((p) => p.page), [5, 6]);
  assert.match(ps[0].text, /Rotate angle/);
  assert.match(ps[0].text, /Spindle power/);
  assert.ok(!ps.some((p) => /無法逐字抽取/.test(p.text)), '說明小節不該被當原稿嵌入');
  assert.ok(!/疑似有表格/.test(ps[1].text));
});
