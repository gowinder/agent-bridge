import {
  CHUNK_TTL_MS,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
  parseWireMessage,
  type WireMessage,
} from "@craftstead/protocol";
import {
  concatBytes,
  fromBase64,
  toBase64,
  type Noise,
} from "./noise.js";
import type { NoiseHandshake } from "./handshake.js";

const CHUNK_PAYLOAD_BYTES = 20_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PendingMessage {
  total: number;
  parts: Uint8Array[];
  received: number;
  size: number;
  startedAt: number;
}

export class SecureChannel {
  private readonly noise: Noise;
  private readonly handle: number;
  private readonly pending = new Map<string, PendingMessage>();
  private closed = false;

  constructor(noise: Noise, handle: number) {
    this.noise = noise;
    this.handle = handle;
  }

  static fromHandshake(handshake: NoiseHandshake): SecureChannel {
    return handshake.intoChannel();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Serialize one protocol message into one or more authenticated frames. */
  seal(message: WireMessage): Uint8Array[] {
    if (this.closed) throw new Error("channel closed");
    const bytes = encoder.encode(JSON.stringify(message));
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("message too large");
    if (bytes.length <= MAX_FRAME_BYTES) {
      return [this.noise.encrypt(this.handle, bytes)];
    }
    const total = Math.ceil(bytes.length / CHUNK_PAYLOAD_BYTES);
    const messageId = crypto.randomUUID();
    const frames: Uint8Array[] = [];
    for (let seq = 0; seq < total; seq += 1) {
      const slice = bytes.subarray(seq * CHUNK_PAYLOAD_BYTES, (seq + 1) * CHUNK_PAYLOAD_BYTES);
      const chunk: WireMessage = {
        v: 1,
        kind: "chunk",
        messageId,
        seq,
        total,
        data: toBase64(slice),
      };
      frames.push(this.noise.encrypt(this.handle, encoder.encode(JSON.stringify(chunk))));
    }
    return frames;
  }

  /**
   * Decrypt one frame. Returns a message when a complete one is available,
   * otherwise null (chunk buffered or invalid).
   */
  open(frame: Uint8Array): WireMessage | null {
    if (this.closed) return null;
    let plaintext: Uint8Array;
    try {
      plaintext = this.noise.decrypt(this.handle, frame);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(plaintext));
    } catch {
      return null;
    }
    const message = parseWireMessage(parsed);
    if (!message) return null;
    if (message.kind !== "chunk") return message;
    return this.acceptChunk(message);
  }

  private acceptChunk(message: Extract<WireMessage, { kind: "chunk" }>): WireMessage | null {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.startedAt > CHUNK_TTL_MS) this.pending.delete(id);
    }
    let entry = this.pending.get(message.messageId);
    if (!entry) {
      if (this.pending.size >= MAX_PENDING_MESSAGES) return null;
      entry = {
        total: message.total,
        parts: new Array<Uint8Array>(message.total),
        received: 0,
        size: 0,
        startedAt: now,
      };
      this.pending.set(message.messageId, entry);
    }
    if (entry.total !== message.total || entry.parts[message.seq]) return null;
    const part = fromBase64(message.data);
    entry.size += part.length;
    if (entry.size > MAX_MESSAGE_BYTES) {
      this.pending.delete(message.messageId);
      return null;
    }
    entry.parts[message.seq] = part;
    entry.received += 1;
    if (entry.received < entry.total) return null;
    this.pending.delete(message.messageId);
    const bytes = concatBytes(...entry.parts);
    try {
      return parseWireMessage(JSON.parse(decoder.decode(bytes)));
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.noise.free(this.handle);
  }
}
