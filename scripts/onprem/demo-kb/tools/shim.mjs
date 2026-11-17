// 示範知識庫建置用：把「Ollama／OpenAI 相容」請求轉給 Cloudflare Workers AI（youlin stage 帳號）。
// 只在建置機上跑；金鑰只從環境變數讀、不寫檔、不進快照。
import { createServer } from 'node:http';
const A = process.env.CF_ACCOUNT, T = process.env.CF_TOKEN;
const CHAT = process.env.CHAT_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
const EMB = '@cf/baai/bge-m3';
const cf = async (path, body) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/ai${path}`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`CF ${r.status} ${t.slice(0, 300)}`);
  return j;
};
const stats = { embed: 0, chat: 0, err: 0 };
createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8'); let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
  const send = (j, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (p === '/__stats') return send(stats);
    if (p === '/api/tags') return send({ models: [{ name: 'bge-m3:latest' }, { name: 'qwen2.5:7b' }, { name: 'demo-chat' }] });
    if (p === '/api/embed' || p === '/api/embeddings') {
      const input = [].concat(b.input ?? b.prompt ?? []);
      const out = [];
      for (let i = 0; i < input.length; i += 50) { const j = await cf('/run/' + EMB, { text: input.slice(i, i + 50) }); out.push(...j.result.data); }
      stats.embed += input.length;
      return p === '/api/embed' ? send({ model: 'bge-m3', embeddings: out }) : send({ embedding: out[0] });
    }
    if (p === '/api/chat') {
      const j = await cf('/v1/chat/completions', { model: CHAT, messages: b.messages, temperature: b.options?.temperature ?? 0, max_tokens: 512 });
      stats.chat++;
      return send({ model: b.model, message: { role: 'assistant', content: j.choices?.[0]?.message?.content ?? '' }, done: true });
    }
    if (p === '/v1/chat/completions' || p === '/chat/completions') {
      const body = { ...b, model: CHAT }; if (body.max_tokens > 8192) body.max_tokens = 8192;
      const j = await cf('/v1/chat/completions', body);
      stats.chat++;
      return send(j);
    }
    if (p === '/v1/models') return send({ object: 'list', data: [{ id: 'demo-chat', object: 'model' }] });
    return send({ error: 'not found ' + p }, 404);
  } catch (e) { stats.err++; console.error(p, e.message); return send({ error: e.message }, 502); }
}).listen(11434, '0.0.0.0', () => console.log('shim on :11434 chat=' + CHAT));
