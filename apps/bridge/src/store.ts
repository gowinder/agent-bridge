import { chmodSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DeviceRecord {
  id: string;
  name: string;
  publicKey: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
}

export interface InviteRecord {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export function defaultStateDir(): string {
  return process.env["AGENT_BRIDGE_HOME"] ?? join(homedir(), "Library", "Application Support", "AgentBridge");
}

function asNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export class Store {
  readonly dir: string;
  readonly db: DatabaseSync;

  constructor(dir = defaultStateDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "bridge.db");
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS devices (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         public_key TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER,
         revoked_at INTEGER,
         last_seen_at INTEGER
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS invites (
         id TEXT PRIMARY KEY,
         token TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         used_at INTEGER
       )`,
    );
  }

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row["value"]) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  device(id: string): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      publicKey: String(row["public_key"]),
      createdAt: Number(row["created_at"]),
      expiresAt: asNumber(row["expires_at"]),
      revokedAt: asNumber(row["revoked_at"]),
      lastSeenAt: asNumber(row["last_seen_at"]),
    };
  }

  devices(): DeviceRecord[] {
    return this.db
      .prepare("SELECT * FROM devices ORDER BY created_at DESC")
      .all()
      .map((row) => ({
        id: String(row["id"]),
        name: String(row["name"]),
        publicKey: String(row["public_key"]),
        createdAt: Number(row["created_at"]),
        expiresAt: asNumber(row["expires_at"]),
        revokedAt: asNumber(row["revoked_at"]),
        lastSeenAt: asNumber(row["last_seen_at"]),
      }));
  }

  saveDevice(device: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, public_key, created_at, expires_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           public_key = excluded.public_key,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at`,
      )
      .run(
        device.id,
        device.name,
        device.publicKey,
        device.createdAt,
        device.expiresAt,
        device.revokedAt,
        device.lastSeenAt,
      );
  }

  revokeDevice(id: string): void {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  }

  saveInvite(invite: InviteRecord): void {
    this.db
      .prepare(
        "INSERT INTO invites (id, token, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(invite.id, invite.token, invite.createdAt, invite.expiresAt, invite.usedAt);
  }

  invite(id: string): InviteRecord | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: String(row["id"]),
      token: String(row["token"]),
      createdAt: Number(row["created_at"]),
      expiresAt: Number(row["expires_at"]),
      usedAt: asNumber(row["used_at"]),
    };
  }

  markInviteUsed(id: string): void {
    this.db.prepare("UPDATE invites SET used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  clearExpiredInvites(now = Date.now()): void {
    this.db.prepare("DELETE FROM invites WHERE expires_at < ?").run(now - 24 * 3600 * 1000);
  }

  hostName(): string {
    return this.meta("host_name") ?? hostname();
  }

  close(): void {
    this.db.close();
  }
}
