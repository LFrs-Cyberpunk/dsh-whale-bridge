// Minimal OpenAI-compatible stub used ONLY to prove the DSH ACP transport end to
// end without a real API key. It never leaves 127.0.0.1 and answers one fixed line.
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 18080);
const REPLY = '本地假模型：这条回复来自桥接测试用的桩服务。';

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const base = { id: 'fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-1' };
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n');
  for (let i = 0; i < REPLY.length; i += 60) {
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: REPLY.slice(i, i + 60) }, finish_reason: null }] }) + '\n\n');
  }
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function json(res) {
  const body = {
    id: 'fake', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'fake-1',
    choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (!/chat\/completions$/.test(req.url || '')) { res.writeHead(404); res.end('{}'); return; }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    if (body.stream === true) sse(res); else json(res);
  });
});

server.listen(PORT, '127.0.0.1', () => process.stdout.write(`fake-llm listening on http://127.0.0.1:${PORT}/v1\n`));
process.on('SIGTERM', () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });
