// sync-license.mjs — 把 repo 根的 LICENSE.md 內容寫成 license-text.js，讓 landing 的 /license 頁有全文。
// 真相源只有 LICENSE.md；license-text.js 是機器產物，license-contract.test.mjs 會比對兩者，不一致就失敗。
// 跑法：node landing/sync-license.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, '..', 'LICENSE.md'), 'utf8');
const out = `// 機器產物：由 landing/sync-license.mjs 從 repo 根 LICENSE.md 產生，請勿手改。\n`
  + `export const LICENSE_TEXT = ${JSON.stringify(text)};\n`;
writeFileSync(join(here, 'license-text.js'), out);
console.log(`license-text.js 已更新（${text.length} 字元）`);
