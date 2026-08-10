import fs from 'node:fs';
const y = fs.readFileSync(new URL('../rag-ingest.yaml', import.meta.url).pathname,'utf8');
const mIs = y.match(/function isDoc\(p\) \{ return[^\n]+\}/);
const mPg = y.match(/function pageOf\(p\) \{ return[^\n]+\}/);
if(!mIs||!mPg) throw new Error('抽不到函式');
const isDoc = new Function('p', mIs[0].replace(/^function isDoc\(p\) \{/,'').replace(/\}$/,''));
const pageOf = new Function('p', mPg[0].replace(/^function pageOf\(p\) \{/,'').replace(/\}$/,''));
let pass=0,fail=0;
const t=(l,c,e='')=>{c?(console.log('PASS:',l),pass++):(console.log('FAIL:',l,e),fail++)};

// 該收的
for(const f of ['a.md','dir/b.markdown','notes/c.txt','D.TXT','E.MD'])
  t(`收 ${f}`, isDoc(f)===true, 'got '+isDoc(f));
// 該擋的（二進位，放行=送亂碼進 LLM）
for(const f of ['x.pdf','y.docx','z.pptx','a.png','b.zip','noext'])
  t(`擋 ${f}`, isDoc(f)!==true, 'got '+isDoc(f));
// 非字串
for(const v of [null,undefined,123,{}])
  t(`擋非字串 ${JSON.stringify(v)}`, isDoc(v)!==true);
// pageOf 要跟 isDoc 同一組，否則頁名殘留副檔名
t('pageOf a.md -> a', pageOf('a.md')==='a', pageOf('a.md'));
t('pageOf c.txt -> c（不可殘留 .txt）', pageOf('notes/c.txt')==='notes/c', pageOf('notes/c.txt'));
t('pageOf b.markdown -> b', pageOf('dir/b.markdown')==='dir/b', pageOf('dir/b.markdown'));
t('pageOf D.TXT 大小寫', pageOf('D.TXT')==='D', pageOf('D.TXT'));
// 不可誤傷檔名中間的字串
t('a.md.txt 只去尾', pageOf('a.md.txt')==='a.md', pageOf('a.md.txt'));
t('readme.txt.md 只去尾', pageOf('readme.txt.md')==='readme.txt', pageOf('readme.txt.md'));
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
