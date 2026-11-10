import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { FileUploadBeginResult, FileUploadFinishResult } from "@agent-bridge/protocol";
import { RpcError } from "./adapters/types.js";

/** Raw bytes per chunk; base64 keeps the frame under the relay's 64 KiB limit. */
export const UPLOAD_CHUNK_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PENDING_BYTES = 100 * 1024 * 1024;
/** Bounds open file descriptors as well as queue memory. */
const MAX_PENDING_UPLOADS = 16;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
/** Finished uploads stay readable this long, then are swept. */
const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface PendingUpload {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  fd: number;
  received: number;
  nextIndex: number;
  createdAt: number;
}

function safeName(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, "");
  const cleaned = base.replace(/[^\w.\- ()一-龥]+/g, "_").replace(/^[.\s]+/, "");
  return cleaned.slice(0, 120) || "file";
}

export class UploadStore {
  private readonly root: string;
  private readonly pending = new Map<string, PendingUpload>();
  private lastSweep = 0;

  constructor(stateDir: string) {
    this.root = join(stateDir, "uploads");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  begin(sessionId: string, name: string, mime: string, size: number): FileUploadBeginResult {
    this.prune();
    this.sweepFinished();
    if (!Number.isInteger(size) || size <= 0) throw new RpcError("invalid_params", "文件为空");
    if (size > MAX_FILE_BYTES) throw new RpcError("invalid_params", "单个文件不能超过 25 MB");
    if (this.pending.size >= MAX_PENDING_UPLOADS) {
      throw new RpcError("rate_limited", "待完成的上传过多，请稍后再试");
    }
    const inFlight = [...this.pending.values()].reduce((sum, item) => sum + item.size, 0);
    if (inFlight + size > MAX_PENDING_BYTES) {
      throw new RpcError("rate_limited", "待完成的上传过多，请稍后再试");
    }
    const id = randomUUID();
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = safeName(name);
    const path = join(dir, safe);
    const fd = openSync(path, "w", 0o600);
    this.pending.set(id, {
      id,
      sessionId,
      name: safe,
      mime: mime || "application/octet-stream",
      size,
      path,
      fd,
      received: 0,
      nextIndex: 0,
      createdAt: Date.now(),
    });
    return { uploadId: id, chunkSize: UPLOAD_CHUNK_BYTES };
  }

  chunk(uploadId: string, index: number, data: string): { uploadId: string; received: number } {
    const upload = this.pending.get(uploadId);
    if (!upload) throw new RpcError("not_found", "上传不存在或已过期");
    if (index !== upload.nextIndex) throw new RpcError("invalid_params", "分片顺序错误");
    const buffer = Buffer.from(data, "base64");
    if (upload.received + buffer.length > upload.size) {
      throw new RpcError("invalid_params", "分片超出文件大小");
    }
    writeSync(upload.fd, buffer);
    upload.received += buffer.length;
    upload.nextIndex += 1;
    return { uploadId, received: upload.received };
  }

  finish(uploadId: string): FileUploadFinishResult {
    const upload = this.pending.get(uploadId);
    if (!upload) throw new RpcError("not_found", "上传不存在或已过期");
    closeSync(upload.fd);
    this.pending.delete(uploadId);
    if (upload.received !== upload.size) {
      rmSync(dirname(upload.path), { recursive: true, force: true });
      throw new RpcError("invalid_params", "文件不完整，请重新上传");
    }
    return {
      uploadId,
      name: upload.name,
      mime: upload.mime,
      size: upload.size,
      path: upload.path,
      kind: upload.mime.startsWith("image/") ? "image" : "file",
    };
  }

  /** Rejects any attachment path that did not come from an upload. */
  resolvePath(path: string): string {
    const absolute = resolve(path);
    if (!absolute.startsWith(this.root + sep)) {
      throw new RpcError("invalid_params", "附件路径不在上传目录内");
    }
    if (!existsSync(absolute)) throw new RpcError("not_found", "附件不存在，请重新上传");
    return absolute;
  }

  private prune(now = Date.now()): void {
    for (const [id, upload] of this.pending) {
      if (now - upload.createdAt < UPLOAD_TTL_MS) continue;
      try {
        closeSync(upload.fd);
        rmSync(dirname(upload.path), { recursive: true, force: true });
      } catch {
        // best effort
      }
      this.pending.delete(id);
    }
  }

  /** Deletes attachments that finished uploading long ago, so the upload dir cannot grow forever. */
  private sweepFinished(now = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (this.pending.has(entry)) continue;
      const path = join(this.root, entry);
      try {
        if (now - statSync(path).mtimeMs > FINISHED_TTL_MS) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
    }
  }
}
