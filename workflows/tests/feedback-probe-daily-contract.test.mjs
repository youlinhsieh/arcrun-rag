// feedback-probe-daily.yaml 的契約（inkstone/arcrun-rag#282）。跑法：node workflows/tests/feedback-probe-daily-contract.test.mjs
// 靜態契約；引擎上的實跑（成功／相近票重送／失敗叫人／叫不了人時整次失敗）見票上 youlin 演練輸出。
import { execFileSync } from 'node:child_process';
import { renderFeedbackProbe } from '../../installer/scripts/render-feedback-probe.mjs';
let pass = 0, fail = 0;
const t = (l, c, x = '') => { if (c) { console.log('PASS:', l); pass++; } else { console.log('FAIL:', l, x); fail++; } };
const S = { kind: 'ahub', cypherUrl: 'https://ahub.example', ns: 'nsX' };
const { yaml } = renderFeedbackProbe(S);
const live = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const d = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: yaml, encoding: 'utf8' }));
const nodes = Object.keys(d.config);
const edges = d.flow.map((e) => e.split(' >> '));
t('渲染後不殘留佔位', !/__[A-Z][A-Z0-9_]*__/.test(live));
t('首節點是 cron（引擎只認首節點 cron 才登記排程）', edges[0][0] === 'daily_cron' && d.config.daily_cron.component === 'cron');
t('每條邊的兩端都是已定義的節點', edges.every(([a, , b]) => nodes.includes(a) && nodes.includes(b)));
t('金鑰只寫名字，沒有真身', live.includes('{{credential.ahub_token}}') && !/token: "?(?!\{\{credential)[A-Za-z0-9_]{12,}/.test(live));
t('所有 AHub 呼叫指向渲染進去的網址／namespace', (live.match(/https:\/\/ahub\.example\/webhooks\/named\/nsX\/ahub__[a-z_]+\/query/g) || []).length === 4);
const codeNodes = nodes.filter((n) => d.config[n].component === 'code');
t('code 節點的程式裡沒有相鄰的 {{ 或 }}（引擎會把 code 字串也當模板插值）', codeNodes.every((n) => !/\{\{|\}\}/.test(d.config[n].code.replace(/\\\{\\\{|\\\}\\\}|\\\{|\\\}/g, ''))), codeNodes.filter((n) => /\{\{|\}\}/.test(d.config[n].code.replace(/\\\{\\\{|\\\}\\\}|\\\{|\\\}/g, ''))).join(','));
t('judge1 與 judge2 程式相同（只差輸入）', d.config.judge1.code === d.config.judge2.code);
t('唯一故意丟錯的是 alert_done', codeNodes.filter((n) => /throw new Error/.test(d.config[n].code)).join() === 'alert_done');
t('不依賴 code 節點回 success:false（uncle6 1.4.64 沒有 #362）', codeNodes.every((n) => !/success: false/.test(d.config[n].code)));
t('警報開「要你做的事」帶 reopen、withdraw、keep', JSON.stringify(Object.keys(d.config.alert_request.body_json.body).sort()) === '["detail","keep","kind","reopen","title","withdraw"]');
const { yaml: y2 } = renderFeedbackProbe(S, { tokenLiteral: 'drill' });
t('演練可換假 token，正式渲染不會', y2.includes('token: "drill"') && !y2.includes('{{credential.ahub_token}}') && live.includes('{{credential.ahub_token}}'));
let threw = false; try { renderFeedbackProbe(S, { cron: '* *' }); } catch { threw = true; }
t('壞的 cron 渲染器當場丟', threw);
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
