import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8790);
const LOG = [];

function sse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const c of chunks) res.write(c);
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const lastUser = parsed?.messages?.findLast?.(m => m.role === 'user');
    const promptText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ');
    LOG.push({ url: req.url, model: parsed?.model, nMsgs: parsed?.messages?.length, stream: parsed?.stream, prompt: (promptText ?? '').slice(0, 60) });

    if (req.url?.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!req.url?.includes('/v1/messages')) {
      res.writeHead(404); res.end(); return;
    }

    const answer = 'MOCK-REPLY-' + LOG.length;
    if (parsed?.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      return;
    }
    const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    sse(res, [
      ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: parsed?.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
      ev('message_stop', { type: 'message_stop' }),
    ]);
  });
});

server.listen(PORT, '127.0.0.1', () => console.error('[mock] listening', PORT));
process.on('SIGTERM', () => { console.error(JSON.stringify(LOG, null, 1)); process.exit(0); });
