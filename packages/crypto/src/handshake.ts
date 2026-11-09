import { SecureChannel } from "./channel.js";
import type { KeyPair, Noise, NoisePattern } from "./noise.js";

export interface HandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  localKeys: KeyPair;
  remotePublicKey?: Uint8Array;
  psk?: Uint8Array;
  prologue?: Uint8Array;
}

export class NoiseHandshake {
  private readonly noise: Noise;
  private handle: number | null;

  constructor(noise: Noise, options: HandshakeOptions) {
    this.noise = noise;
    this.handle = noise.handshake(options);
  }

  private requireHandle(): number {
    if (this.handle === null) throw new Error("handshake already consumed");
    return this.handle;
  }

  get finished(): boolean {
    return this.noise.handshakeFinished(this.requireHandle());
  }

  write(payload?: Uint8Array): Uint8Array {
    return this.noise.writeHandshake(this.requireHandle(), payload);
  }

  read(message: Uint8Array): Uint8Array {
    return this.noise.readHandshake(this.requireHandle(), message);
  }

  get remoteStatic(): Uint8Array | null {
    return this.noise.remoteStatic(this.requireHandle());
  }

  intoChannel(): SecureChannel {
    const handle = this.requireHandle();
    this.noise.intoTransport(handle);
    this.handle = null;
    return new SecureChannel(this.noise, handle);
  }

  dispose(): void {
    if (this.handle === null) return;
    this.noise.free(this.handle);
    this.handle = null;
  }
}
