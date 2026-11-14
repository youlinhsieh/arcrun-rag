// password-reset-mail.test.mjs — inkstone/arcrun-rag#75：忘記密碼寄信是一條工作流，且在安裝器裡。
import fs from 'node:fs';
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const y = read('../portal-password-reset-mail.local.yaml');
const compile = read('../../installer/scripts/compile-workflows.mjs');
const wf = JSON.parse(read('../../installer/src/workflows.json')).find((w) => w.name === 'portal_password_reset_mail');
let pass = 0, fail = 0;
const t = (label, cond) => { cond ? (console.log('PASS:', label), pass++) : (console.log('FAIL:', label), fail++); };

t('YAML 名稱是 portal_password_reset_mail', /^name: portal_password_reset_mail$/m.test(y));
t('打郵差的 /api/send-password-reset，網址由 input.relay_base 帶（定義裡沒有寫死網域）', /url: "\{\{input\.relay_base\}\}\/api\/send-password-reset"/.test(y) && !/https?:\/\/[a-z]/i.test(y.replace(/#.*$/gm, '')));
t('只送 email／api_origin／ticket，不送連結（防釣魚中繼紅線）', /email: "\{\{input\.email\}\}"/.test(y) && /api_origin: "\{\{input\.api_origin\}\}"/.test(y) && /ticket: "\{\{input\.ticket\}\}"/.test(y) && !/link:/.test(y.replace(/#.*$/gm, '')));
t('沒有任何金鑰字樣（D36）', !/Bearer|token|secret/i.test(y.replace(/#.*$/gm, '')));
t('在安裝器編譯清單裡', compile.includes("'portal-password-reset-mail.local.yaml'"));
t('workflows.json 帶預編圖', !!(wf && wf.graph && wf.graph.nodes.length >= 2));
console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
