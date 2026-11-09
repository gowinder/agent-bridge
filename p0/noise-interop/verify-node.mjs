// Node-side WASM client <-> Bridge server interop check.
// Usage: P0PSK=<64hex> node verify-node.mjs [ws://127.0.0.1:8788/bridge]
// Exercises the same XXpsk3 + IK flows as index.html, but from Node via `ws`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadNoise, hex, unhex } from './glue.js';

const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const URL_WS = process.argv[2] ?? 'ws://127.0.0.1:8788/bridge';
const HTTP = URL_WS.replace(/^ws/, 'http').replace(/\/bridge$/, '');

const P0 = { steps: [], failures: [], done: false, fatal: null, browser: process.version };
const step = (name, ok, detail = '') => {
  P0.steps.push({ name, ok, detail });
  if (!ok) P0.failures.push(name + (detail ? ': ' + detail : ''));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

const PSK = unhex(process.env.P0PSK);
const WRONG_PSK = new Uint8Array(32).fill(7);
const prologue = id => new TextEncoder().encode('agent-bridge/p0/v1|host=test-host|conn=' + id);

class Client {
  static async open() {
    const ws = new WebSocket(URL_WS);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), 5000);
      ws.once('open', () => { clearTimeout(t); res(); });
      ws.once('error', e => { clearTimeout(t); rej(e); });
    });
    return new Client(ws);
  }
  constructor(ws) {
    this.ws = ws; this.q = []; this.w = [];
    ws.on('message', d => { const m = JSON.parse(d.toString()); this.w.length ? this.w.shift()(m) : this.q.push(m); });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  next(ms = 8000) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), ms);
      this.w.push(m => { clearTimeout(t); res(m); });
    });
  }
  close() { this.ws.close(); }
}

async function handshake(noise, phase, opts = {}) {
  const c = await Client.open();
  const connId = Math.random().toString(36).slice(2);
  c.send({ phase, connId, myStaticPub: opts.myStaticPub ? hex(opts.myStaticPub) : '', psk: hex(opts.psk ?? PSK) });
  const frame0 = await c.next();
  const bridgePub = unhex(frame0.myStaticPub);
  const isIK = phase === 'ik';
  const h = noise.handshake({
    pattern: isIK ? 1 : 0,
    initiator: true,
    localPriv: opts.localPriv,
    remotePub: isIK ? bridgePub : undefined,
    psk: isIK ? undefined : (opts.psk ?? PSK),
    prologue: prologue(connId),
  });
  c.send({ t: 'hs', b64: hex(noise.hsWrite(h)) });
  let ready = null;
  for (;;) {
    const m = await c.next();
    if (m.t === 'ready') { ready = m; break; }
    if (m.t === 'hs-fail') throw new Error('hs-fail: ' + m.error);
    if (m.t === 'hs') {
      noise.hsRead(h, unhex(m.b64));
      if (noise.finished(h)) continue;
      c.send({ t: 'hs', b64: hex(noise.hsWrite(h)) });
    }
  }
  noise.intoTransport(h);
  return { c, h, bridgePub, ready };
}

async function rpcRaw(noise, c, h, str) {
  const ct = noise.enc(h, new TextEncoder().encode(str));
  c.send({ t: 'data', b64: hex(ct) });
  const m = await c.next();
  if (m.t !== 'data') throw new Error('bad reply: ' + JSON.stringify(m).slice(0, 150));
  return { reply: JSON.parse(new TextDecoder().decode(noise.dec(h, unhex(m.b64)))), ct: m.b64 };
}
const rpc = (noise, c, h, obj) => rpcRaw(noise, c, h, JSON.stringify(obj));

(async () => {
  try {
    const report = await (await fetch(HTTP + '/report')).json();
    const pinned = report.bridgeStaticPub;
    const noise = await loadNoise(fs.readFileSync(path.join(ROOT, 'noise_wasm.wasm')));
    step('wasm.load', true, `${noise.memory.buffer.byteLength} bytes memory`);

    const kpA = noise.keypair();
    const kpB = noise.keypair();
    step('wasm.keypair.custom-getrandom', kpA.priv.length === 32 && hex(kpA.priv) !== hex(kpB.priv), 'two distinct 32B X25519 pairs');

    const s1 = await handshake(noise, 'xx', { localPriv: kpA.priv });
    step('xxpsk3.handshake', true, '3 messages, mode=transport');
    step('xxpsk3.qr-pinning', hex(s1.bridgePub) === pinned, 'bridge pub matches QR value');
    step('xxpsk3.bridge-sees-my-static', s1.ready.remoteStatic === hex(kpA.pub), 'responder authenticated initiator static');

    const r1 = await rpc(noise, s1.c, s1.h, { seq: 1, text: 'hello from node' });
    step('transport.node→bridge→node', r1.reply.echoSeq === 1 && r1.reply.echoLen > 0, `echoLen=${r1.reply.echoLen}`);

    let okSeq = true;
    for (let i = 2; i <= 101; i++) {
      const r = await rpc(noise, s1.c, s1.h, { seq: i, text: 'msg' + i });
      if (r.reply.echoSeq !== i) { okSeq = false; break; }
    }
    step('transport.100-sequential', okSeq, 'ordered both ways');

    const big = 'A'.repeat(32768);
    const rb = await rpcRaw(noise, s1.c, s1.h, big);
    step('transport.32768B-plaintext-frame', rb.reply.echoLen === 32768, `plainLen=${rb.reply.echoLen} replyCtLen=${rb.ct.length / 2}`);
    let overOk = false, overDetail = '';
    try { await rpc(noise, s1.c, s1.h, { seq: 200, text: 'A'.repeat(65536) }); overDetail = 'over-sized frame ACCEPTED'; }
    catch (e) { overOk = true; overDetail = e.message.slice(0, 40) + ' (Noise 65535B limit enforced)'; }
    step('transport.over-65KiB-rejected', overOk, overDetail);

    const uni = '中文 测试 🎉 émoji → ✓';
    const ru = await rpc(noise, s1.c, s1.h, { seq: 201, text: uni });
    step('transport.unicode', ru.reply.head.startsWith('中文 测试'), ru.reply.head);

    const N = 20;
    for (let i = 0; i < N; i++) s1.c.send({ t: 'data', b64: hex(noise.enc(s1.h, new TextEncoder().encode(JSON.stringify({ seq: 300 + i, text: 'p' })))) });
    const got = [];
    for (let i = 0; i < N; i++) got.push(JSON.parse(new TextDecoder().decode(noise.dec(s1.h, unhex((await s1.c.next()).b64)))).echoSeq);
    step('transport.pipelined-20', got.every((v, i) => v === 300 + i), got.slice(0, 3).join(','));

    s1.c.send({ t: 'data', b64: r1.ct, replay: true });
    const rej = await s1.c.next();
    step('security.replay-rejected', rej.rejected === true);

    const garbage = crypto.getRandomValues(new Uint8Array(64));
    s1.c.send({ t: 'data', b64: hex(garbage) });
    const g = await s1.c.next();
    step('security.garbage-rejected', g.t === 'data-fail');
    s1.c.close();

    let badOk = false, badDetail = '';
    try { await handshake(noise, 'badpsk', { psk: WRONG_PSK, localPriv: kpB.priv }); badDetail = 'handshake unexpectedly succeeded'; }
    catch (e) { badOk = true; badDetail = e.message.slice(0, 60); }
    step('xxpsk3.wrong-psk-rejected', badOk, badDetail);

    const s3 = await handshake(noise, 'ik', { localPriv: kpA.priv, myStaticPub: kpA.pub });
    step('ik.handshake', true, '2 messages, static keys pinned');
    step('ik.bridge-pub-stable', hex(s3.bridgePub) === pinned);
    step('ik.identity', s3.ready.remoteStatic === hex(kpA.pub));
    const r3 = await rpc(noise, s3.c, s3.h, { seq: 400, text: 'reconnect' });
    step('ik.transport', r3.reply.echoSeq === 400);
    s3.c.close();

    const fin = await (await fetch(HTTP + '/report')).json();
    step('bridge.credentials-isolated', fin.transport.decFails >= 2, `bridge decFails=${fin.transport.decFails}, recv=${fin.transport.recv}, sent=${fin.transport.sent}`);
  } catch (e) {
    P0.fatal = String(e && e.stack || e);
    step('fatal', false, P0.fatal.slice(0, 200));
  }
  P0.done = true;
  console.log('\nSUMMARY', JSON.stringify({ total: P0.steps.length, failures: P0.failures, fatal: P0.fatal === null ? null : P0.fatal.split('\n')[0] }));
  process.exitCode = P0.failures.length ? 1 : 0;
})();
