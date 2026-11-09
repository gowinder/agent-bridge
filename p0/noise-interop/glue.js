// Shared wasm glue: works in Node (globalThis.crypto) and browsers.
export async function loadNoise(wasmUrl) {
  const bytes = (wasmUrl instanceof ArrayBuffer || ArrayBuffer.isView(wasmUrl))
    ? wasmUrl
    : await (await fetch(wasmUrl)).arrayBuffer();
  let inst = null;
  const imports = {
    env: {
      host_random(ptr, len) {
        const mem = new Uint8Array(inst.exports.memory.buffer, ptr, len);
        crypto.getRandomValues(mem);
      },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  inst = instance;
  return new Noise(inst.exports);
}

export class Noise {
  constructor(e) { this.e = e; }
  get memory() { return this.e.memory; }
  bytes(ptr, len) { return new Uint8Array(this.e.memory.buffer, ptr, len); }

  _in(bytes) {
    if (!bytes || bytes.length === 0) return 0;
    const p = this.e.alloc(bytes.length);
    this.bytes(p, bytes.length).set(bytes);
    return p;
  }
  _free(p, n) { if (p) this.e.dealloc(p, n); }

  keypair() {
    const pp = this.e.alloc(32), pu = this.e.alloc(32);
    if (this.e.gen_keypair(pp, pu) !== 0) throw new Error('gen_keypair failed');
    const priv = this.bytes(pp, 32).slice(), pub = this.bytes(pu, 32).slice();
    this.e.dealloc(pp, 32); this.e.dealloc(pu, 32);
    return { priv, pub };
  }

  handshake({ pattern = 0, initiator = true, localPriv, remotePub, psk, prologue } = {}) {
    const lp = this._in(localPriv), rp = this._in(remotePub), pk = this._in(psk), pl = this._in(prologue);
    const h = this.e.hs_new(pattern, initiator ? 1 : 0, lp, rp, pk, pl, prologue ? prologue.length : 0);
    this._free(lp, localPriv?.length); this._free(rp, remotePub?.length);
    this._free(pk, psk?.length); this._free(pl, prologue?.length);
    if (h < 0) throw new Error('hs_new failed ' + h);
    return h;
  }

  _io(fn, h, input, extra = 0) {
    const ip = this._in(input), cap = (input?.length ?? 0) + 128 + extra, op = this.e.alloc(cap);
    const n = this.e[fn](h, ip, input?.length ?? 0, op, cap);
    this._free(ip, input?.length);
    if (n < 0) { this.e.dealloc(op, cap); throw new Error(fn + ' failed ' + n); }
    const out = this.bytes(op, n).slice();
    this.e.dealloc(op, cap);
    return out;
  }

  hsWrite(h, payload = new Uint8Array()) { return this._io('hs_write', h, payload); }
  hsRead(h, msg) { return this._io('hs_read', h, msg); }
  finished(h) { return this.e.hs_finished(h) === 1; }
  intoTransport(h) { const r = this.e.hs_into_transport(h); if (r !== 0) throw new Error('into_transport ' + r); return h; }
  enc(h, plain) { return this._io('enc', h, plain); }
  dec(h, ct) { return this._io('dec', h, ct); }
  remoteStatic(h) {
    const p = this.e.alloc(32);
    const n = this.e.hs_remote_static(h, p);
    const out = n > 0 ? this.bytes(p, n).slice() : null;
    this.e.dealloc(p, 32);
    return out;
  }
  free(h) { this.e.conn_free(h); }
}

export const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
export const unhex = s => s ? new Uint8Array(s.match(/../g).map(h => parseInt(h, 16))) : new Uint8Array();
export const b64 = b => btoa(String.fromCharCode(...b));
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
