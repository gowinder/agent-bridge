export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export type WasmSource = ArrayBuffer | ArrayBufferView | Uint8Array;

export interface NoiseWasmExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  gen_keypair(outPriv: number, outPub: number): number;
  hs_new(
    pattern: number,
    initiator: number,
    localPriv: number,
    remotePub: number,
    psk: number,
    prologue: number,
    prologueLen: number,
  ): number;
  hs_write(h: number, inPtr: number, inLen: number, out: number, cap: number): number;
  hs_read(h: number, inPtr: number, inLen: number, out: number, cap: number): number;
  hs_finished(h: number): number;
  hs_remote_static(h: number, out: number): number;
  hs_into_transport(h: number): number;
  enc(h: number, inPtr: number, inLen: number, out: number, cap: number): number;
  dec(h: number, inPtr: number, inLen: number, out: number, cap: number): number;
  conn_free(h: number): void;
}

const PATTERNS = { xxpsk3: 0, ik: 1, nn: 2 } as const;
export type NoisePattern = keyof typeof PATTERNS;

export async function loadNoise(source: WasmSource | Response): Promise<Noise> {
  let bytes: ArrayBuffer;
  if (source instanceof Response) {
    bytes = await source.arrayBuffer();
  } else if (source instanceof ArrayBuffer) {
    bytes = source;
  } else {
    bytes = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;
  }
  let instance: WebAssembly.Instance | undefined;
  const imports = {
    env: {
      host_random(ptr: number, len: number): void {
        if (!instance) throw new Error("noise: memory not ready");
        const memory = instance.exports["memory"] as WebAssembly.Memory;
        const mem = new Uint8Array(memory.buffer, ptr, len);
        globalThis.crypto.getRandomValues(mem);
      },
    },
  };
  const compiled = await WebAssembly.instantiate(bytes, imports);
  instance = compiled.instance;
  return new Noise(compiled.instance.exports as unknown as NoiseWasmExports);
}

export class Noise {
  readonly exports: NoiseWasmExports;

  constructor(exports: NoiseWasmExports) {
    this.exports = exports;
  }

  private view(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len);
  }

  private input(bytes?: Uint8Array): { ptr: number; len: number } {
    if (!bytes || bytes.length === 0) return { ptr: 0, len: 0 };
    const ptr = this.exports.alloc(bytes.length);
    this.view(ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  private release(input: { ptr: number; len: number }): void {
    if (input.ptr !== 0) this.exports.dealloc(input.ptr, input.len);
  }

  generateKeyPair(): KeyPair {
    const priv = this.exports.alloc(32);
    const pub = this.exports.alloc(32);
    if (this.exports.gen_keypair(priv, pub) !== 0) {
      this.exports.dealloc(priv, 32);
      this.exports.dealloc(pub, 32);
      throw new Error("gen_keypair failed");
    }
    const keyPair = {
      privateKey: this.view(priv, 32).slice(),
      publicKey: this.view(pub, 32).slice(),
    };
    this.exports.dealloc(priv, 32);
    this.exports.dealloc(pub, 32);
    return keyPair;
  }

  handshake(options: {
    pattern: NoisePattern;
    initiator: boolean;
    localKeys: KeyPair;
    remotePublicKey?: Uint8Array;
    psk?: Uint8Array;
    prologue?: Uint8Array;
  }): number {
    if (options.pattern === "xxpsk3" && options.psk?.length !== 32) {
      throw new Error("xxpsk3 requires a 32-byte psk");
    }
    const local = this.input(options.localKeys.privateKey);
    const remote = this.input(options.remotePublicKey);
    const psk = this.input(options.psk);
    const prologue = this.input(options.prologue);
    const handle = this.exports.hs_new(
      PATTERNS[options.pattern],
      options.initiator ? 1 : 0,
      local.ptr,
      remote.ptr,
      psk.ptr,
      prologue.ptr,
      prologue.len,
    );
    this.release(local);
    this.release(remote);
    this.release(psk);
    this.release(prologue);
    if (handle < 0) throw new Error(`hs_new failed: ${handle}`);
    return handle;
  }

  private io(
    fn: "hs_write" | "hs_read" | "enc" | "dec",
    handle: number,
    input?: Uint8Array,
  ): Uint8Array {
    const source = this.input(input);
    const capacity = (input?.length ?? 0) + 256;
    const out = this.exports.alloc(capacity);
    const written = this.exports[fn](handle, source.ptr, source.len, out, capacity);
    this.release(source);
    if (written < 0) {
      this.exports.dealloc(out, capacity);
      throw new Error(`${fn} failed: ${written}`);
    }
    const result = this.view(out, written).slice();
    this.exports.dealloc(out, capacity);
    return result;
  }

  writeHandshake(handle: number, payload?: Uint8Array): Uint8Array {
    return this.io("hs_write", handle, payload);
  }

  readHandshake(handle: number, message: Uint8Array): Uint8Array {
    return this.io("hs_read", handle, message);
  }

  handshakeFinished(handle: number): boolean {
    return this.exports.hs_finished(handle) === 1;
  }

  remoteStatic(handle: number): Uint8Array | null {
    const out = this.exports.alloc(32);
    const written = this.exports.hs_remote_static(handle, out);
    const result = written > 0 ? this.view(out, written).slice() : null;
    this.exports.dealloc(out, 32);
    return result;
  }

  intoTransport(handle: number): void {
    const code = this.exports.hs_into_transport(handle);
    if (code !== 0) throw new Error(`into_transport failed: ${code}`);
  }

  encrypt(handle: number, plaintext: Uint8Array): Uint8Array {
    return this.io("enc", handle, plaintext);
  }

  decrypt(handle: number, ciphertext: Uint8Array): Uint8Array {
    return this.io("dec", handle, ciphertext);
  }

  free(handle: number): void {
    this.exports.conn_free(handle);
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
