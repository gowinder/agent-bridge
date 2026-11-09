// Run snow 0.9.6 official Noise test vectors (cacophony + snow generated)
// through the UNMODIFIED p0/noise-interop/noise_wasm.wasm binary.
// The only thing controlled is env.host_random, which the wasm exposes as its
// sole randomness import; feeding the vector's fixed ephemeral keys makes the
// handshake byte-for-byte reproducible without touching lib.rs.
// Usage: node verify-vectors.mjs [wasmPath] [vectorDir] [file...]
// Vector source: crates.io snow 0.9.6 tarball -> snow-0.9.6/tests/vectors/{cacophony,snow}.txt
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WASM = process.argv[2] ?? path.join(ROOT, 'noise_wasm.wasm');
const VECDIR = process.argv[3] ?? process.env.SNOW_VECTORS ?? path.join(ROOT, 'snow-vectors');
const bytes = fs.readFileSync(WASM);

const HEX = b => Buffer.from(b).toString('hex');
const UNHEX = s => new Uint8Array(Buffer.from(s, 'hex'));

const PATTERNS = new Map([
  ['Noise_XXpsk3_25519_ChaChaPoly_SHA256', 0],
  ['Noise_IK_25519_ChaChaPoly_SHA256', 1],
  ['Noise_NN_25519_ChaChaPoly_SHA256', 2],
]);

function instantiate(randomQueue) {
  let inst = null;
  const state = { calls: [] };
  const imports = {
    env: {
      host_random(ptr, len) {
        state.calls.push(len);
        const next = randomQueue.shift();
        if (!next || next.length < len) throw new Error(`host_random(${len}) exhausted (queue left ${randomQueue.length})`);
        new Uint8Array(inst.exports.memory.buffer, ptr, len).set(next.subarray(0, len));
      },
    },
  };
  const mod = new WebAssembly.Module(bytes);
  inst = new WebAssembly.Instance(mod, imports);
  const e = inst.exports;
  const mem = () => new Uint8Array(e.memory.buffer);
  const allocIn = (u8) => {
    if (!u8 || u8.length === 0) return 0;
    const p = e.alloc(u8.length);
    mem().set(u8, p);
    return p;
  };
  const io = (fn, h, input) => {
    const ip = allocIn(input);
    const cap = (input?.length ?? 0) + 65535;
    const op = e.alloc(cap);
    const n = e[fn](h, ip, input?.length ?? 0, op, cap);
    if (ip) e.dealloc(ip, input.length);
    if (n < 0) { e.dealloc(op, cap); throw new Error(`${fn} failed ${n}`); }
    const out = mem().slice(op, op + n);
    e.dealloc(op, cap);
    return out;
  };
  return {
    e, state,
    keypair() { const pp = e.alloc(32), pu = e.alloc(32); if (e.gen_keypair(pp, pu) !== 0) throw new Error('gen_keypair'); const r = { priv: mem().slice(pp, pp + 32), pub: mem().slice(pu, pu + 32) }; e.dealloc(pp, 32); e.dealloc(pu, 32); return r; },
    newHS(pattern, initiator, localPriv, remotePub, psk, prologue) {
      const lp = allocIn(localPriv), rp = allocIn(remotePub), pk = allocIn(psk), pl = allocIn(prologue);
      const h = e.hs_new(pattern, initiator ? 1 : 0, lp, rp, pk, pl, prologue?.length ?? 0);
      if (lp) e.dealloc(lp, localPriv.length); if (rp) e.dealloc(rp, remotePub.length);
      if (pk) e.dealloc(pk, psk.length); if (pl) e.dealloc(pl, prologue.length);
      if (h < 0) throw new Error('hs_new ' + h);
      return h;
    },
    write: (h, payload) => io('hs_write', h, payload ?? new Uint8Array()),
    read: (h, msg) => io('hs_read', h, msg),
    finished: h => e.hs_finished(h) === 1,
    transport: h => { if (e.hs_into_transport(h) !== 0) throw new Error('into_transport'); },
    enc: (h, p) => io('enc', h, p),
    dec: (h, ct) => io('dec', h, ct),
  };
}

function runVector(v) {
  const patternId = PATTERNS.get(v.protocol_name);
  const ie = UNHEX(v.init_ephemeral), re = UNHEX(v.resp_ephemeral);
  const initRnd = [ie], respRnd = [re];
  const init = instantiate(initRnd);
  const resp = instantiate(respRnd);
  const prologueI = UNHEX(v.init_prologue), prologueR = UNHEX(v.resp_prologue);
  const psk = v.init_psks?.[0] ? UNHEX(v.init_psks[0]) : undefined;
  const respPsk = v.resp_psks?.[0] ? UNHEX(v.resp_psks[0]) : undefined;
  // The wasm takes a single psk arg for both sides; vectors use the same psks both sides.
  if (psk && respPsk && HEX(psk) !== HEX(respPsk)) throw new Error('asymmetric psks unsupported');
  const hi = init.newHS(patternId, true, v.init_static ? UNHEX(v.init_static) : undefined,
    v.init_remote_static ? UNHEX(v.init_remote_static) : undefined, psk, prologueI);
  const hr = resp.newHS(patternId, false, v.resp_static ? UNHEX(v.resp_static) : undefined,
    v.resp_remote_static ? UNHEX(v.resp_remote_static) : undefined, psk, prologueR);

  const msgs = v.messages;
  let handshakeMsgs = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (init.finished(hi) && resp.finished(hr)) break;
    const [send, recv, sh, rh] = i % 2 === 0 ? [init, resp, hi, hr] : [resp, init, hr, hi];
    const payload = UNHEX(msgs[i].payload);
    const out = send.write(sh, payload);
    if (HEX(out) !== msgs[i].ciphertext) {
      return { ok: false, where: `handshake msg ${i} ciphertext`, expected: msgs[i].ciphertext, actual: HEX(out) };
    }
    const plain = recv.read(rh, out);
    if (HEX(plain) !== msgs[i].payload) {
      return { ok: false, where: `handshake msg ${i} payload`, expected: msgs[i].payload, actual: HEX(plain) };
    }
    handshakeMsgs++;
  }
  if (!(init.finished(hi) && resp.finished(hr))) return { ok: false, where: 'handshake not finished', expected: 'finished', actual: 'incomplete' };
  init.transport(hi); resp.transport(hr);
  let transportMsgs = 0;
  const oneway = false; // NN/IK/XX are interactive; all vectors here alternate
  for (let i = handshakeMsgs; i < msgs.length; i++) {
    const initSends = oneway || i % 2 === 0;
    const [send, recv, sh, rh] = initSends ? [init, resp, hi, hr] : [resp, init, hr, hi];
    const payload = UNHEX(msgs[i].payload);
    const ct = send.enc(sh, payload);
    if (HEX(ct) !== msgs[i].ciphertext) {
      return { ok: false, where: `transport msg ${i} ciphertext`, expected: msgs[i].ciphertext, actual: HEX(ct) };
    }
    const plain = recv.dec(rh, ct);
    if (HEX(plain) !== msgs[i].payload) {
      return { ok: false, where: `transport msg ${i} payload`, expected: msgs[i].payload, actual: HEX(plain) };
    }
    transportMsgs++;
  }
  return { ok: true, handshakeMsgs, transportMsgs, randomCalls: [init.state.calls, resp.state.calls] };
}

const files = process.argv.slice(4);
const targets = files.length ? files : [VECDIR + '/cacophony.txt', VECDIR + '/snow.txt'];
let pass = 0, fail = 0, skip = 0;
const failures = [];
for (const f of targets) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const v of data.vectors ?? []) {
    if (!PATTERNS.has(v.protocol_name)) { skip++; continue; }
    try {
      const r = runVector(v);
      if (r.ok) { pass++; console.log(`PASS ${f.split('/').pop()} ${v.protocol_name} hs=${r.handshakeMsgs} tx=${r.transportMsgs} rng=${JSON.stringify(r.randomCalls)}`); }
      else { fail++; failures.push({ file: f, protocol: v.protocol_name, ...r }); console.log(`FAIL ${v.protocol_name} @ ${r.where}\n  expected ${r.expected}\n  actual   ${r.actual}`); }
    } catch (e) {
      fail++; failures.push({ file: f, protocol: v.protocol_name, error: e.message });
      console.log(`FAIL ${v.protocol_name} error: ${e.message}`);
    }
  }
}
console.log(`\nSUMMARY pass=${pass} fail=${fail} skipped(unsupported pattern)=${skip}`);
if (fail) process.exitCode = 1;
