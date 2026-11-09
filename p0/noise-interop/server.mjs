import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadNoise, hex, unhex } from './glue.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT ?? 8788);
const PSK = unhex(process.env.P0PSK);
const STATE = { conns: [], transport: { sent: 0, recv: 0, decFails: 0 }, errors: [] };

const n = await loadNoise(fs.readFileSync(path.join(ROOT, 'noise_wasm.wasm')));
const bridgeStatic = n.keypair();
console.error('[bridge] static pub', hex(bridgeStatic.pub));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/report') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...STATE, bridgeStaticPub: hex(bridgeStatic.pub), bridgePriv: hex(bridgeStatic.priv) }, null, 1));
    return;
  }
  const f = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/bridge' });
let seq = 0;

wss.on('connection', ws => {
  const id = ++seq;
  const rec = { id, phase: null, handshakeOk: false, remoteStatic: null, note: '', msgs: 0 };
  STATE.conns.push(rec);
  let h = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.phase) {
      rec.phase = m.phase;
      const isIK = m.phase === 'ik';
      try {
        h = n.handshake({
          pattern: isIK ? 1 : 0,
          initiator: false,
          localPriv: bridgeStatic.priv,
          remotePub: isIK ? unhex(m.myStaticPub) : undefined,
          psk: isIK ? undefined : PSK,
          prologue: new TextEncoder().encode('agent-bridge/p0/v1|host=test-host|conn=' + (m.connId ?? id)),
        });
      } catch (e) {
        rec.note = 'hs_new failed: ' + e.message; STATE.errors.push(rec.note); ws.close(); return;
      }
      ws.send(JSON.stringify({ myStaticPub: hex(bridgeStatic.pub) }));
      return;
    }

    if (m.t === 'hs') {
      try {
        n.hsRead(h, unhex(m.b64));
        if (n.finished(h)) {
          rec.remoteStatic = hex(n.remoteStatic(h));
          n.intoTransport(h);
          rec.handshakeOk = true;
          ws.send(JSON.stringify({ t: 'ready', remoteStatic: rec.remoteStatic }));
          return;
        }
        const out = n.hsWrite(h, new Uint8Array());
        ws.send(JSON.stringify({ t: 'hs', b64: hex(out) }));
        if (n.finished(h)) {
          rec.remoteStatic = hex(n.remoteStatic(h));
          n.intoTransport(h);
          rec.handshakeOk = true;
          ws.send(JSON.stringify({ t: 'ready', remoteStatic: rec.remoteStatic }));
        }
      } catch (e) {
        rec.note = 'handshake failed at msg: ' + e.message;
        STATE.errors.push('conn' + id + ' ' + rec.note);
        ws.send(JSON.stringify({ t: 'hs-fail', error: e.message }));
        ws.close();
      }
      return;
    }

    if (m.t === 'data') {
      if (m.replay) {
        try { n.dec(h, unhex(m.b64)); rec.note = 'REPLAY ACCEPTED (BUG)'; }
        catch (e) { rec.note = 'replay rejected: ' + e.message; STATE.transport.decFails++; }
        ws.send(JSON.stringify({ t: 'replay-result', rejected: rec.note.startsWith('replay rejected') }));
        return;
      }
      try {
        const plain = n.dec(h, unhex(m.b64));
        STATE.transport.recv++; rec.msgs++;
        const text = new TextDecoder().decode(plain);
        let p = null; try { p = JSON.parse(text); } catch {}
        const reply = JSON.stringify({ echoSeq: p?.seq ?? null, echoLen: plain.length, head: (p?.text ?? text).slice(0, 12) });
        const ct = n.enc(h, new TextEncoder().encode(reply));
        STATE.transport.sent++;
        ws.send(JSON.stringify({ t: 'data', b64: hex(ct), plainLen: plain.length }));
      } catch (e) {
        STATE.transport.decFails++;
        STATE.errors.push('conn' + id + ' dec failed: ' + e.message);
        ws.send(JSON.stringify({ t: 'data-fail', error: e.message }));
      }
    }
  });
  ws.on('close', () => { if (h) n.free(h); });
});

server.listen(PORT, '127.0.0.1', () => console.error('[bridge] listening', PORT));
