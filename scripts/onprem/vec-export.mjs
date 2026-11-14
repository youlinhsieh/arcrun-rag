// 唯讀：Vectorize index → JSONL（id, values, metadata）。env: CF_ACCOUNT, CF_TOKEN, INDEX, OUT
import { createWriteStream } from 'node:fs';
const A=process.env.CF_ACCOUNT,T=process.env.CF_TOKEN,N=process.env.INDEX,OUT=process.env.OUT;
const base=`https://api.cloudflare.com/client/v4/accounts/${A}/vectorize/v2/indexes/${N}`;
const h={Authorization:`Bearer ${T}`,'Content-Type':'application/json'};
const ids=[];let cursor;
for(;;){const u=`${base}/list?count=1000`+(cursor?`&cursor=${encodeURIComponent(cursor)}`:'');
 const r=await (await fetch(u,{headers:h})).json();if(!r.success)throw new Error(JSON.stringify(r.errors));
 ids.push(...r.result.vectors.map(v=>v.id));console.log('ids',ids.length);
 if(!r.result.isTruncated)break;cursor=r.result.nextCursor;}
const out=createWriteStream(OUT);let n=0;const B=20;
const chunks=[];for(let i=0;i<ids.length;i+=B)chunks.push(ids.slice(i,i+B));
async function worker(){for(;;){const c=chunks.pop();if(!c)return;
 for(let t=0;;t++){try{const r=await (await fetch(`${base}/get_by_ids`,{method:'POST',headers:h,body:JSON.stringify({ids:c})})).json();
  if(!r.success)throw new Error(JSON.stringify(r.errors));
  for(const v of r.result){out.write(JSON.stringify({id:v.id,values:v.values,metadata:v.metadata})+'\n');n++;}break;}
  catch(e){if(t>4)throw e;await new Promise(s=>setTimeout(s,1000*(t+1)));}}
 if(n%1000<B)console.log('got',n);}}
await Promise.all([1,2,3,4].map(worker));out.end();console.log('done',n,'of',ids.length);
