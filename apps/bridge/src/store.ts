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

/** 菜单栏「最近操作日志」的一条记录。 */
export interface DeviceEventRecord {
  at: number;
  line: string;
}

export interface InviteRecord {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/** A browser's Web Push registration; the endpoint is unique per browser profile. */
export interface PushSubscriptionRecord {
  endpoint: string;
  deviceId: string;
  p256dh: string;
  auth: string;
  createdAt: number;
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
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS device_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         device_id TEXT NOT NULL,
         at INTEGER NOT NULL,
         line TEXT NOT NULL
       )`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS device_events_device ON device_events (device_id, id DESC)",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
         endpoint TEXT PRIMARY KEY,
         device_id TEXT NOT NULL,
         p256dh TEXT NOT NULL,
         auth TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_titles (
         app_id TEXT NOT NULL,
         session_id TEXT NOT NULL,
         title TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY(app_id, session_id)
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

  /** 每台设备只保留最近 `keep` 条，插入时顺手删掉更早的，菜单栏不用翻全量历史。 */
  recordDeviceEvent(deviceId: string, line: string, keep = 200): void {
    this.db
      .prepare("INSERT INTO device_events (device_id, at, line) VALUES (?, ?, ?)")
      .run(deviceId, Date.now(), line);
    this.db
      .prepare(
        `DELETE FROM device_events WHERE device_id = ? AND id NOT IN (
           SELECT id FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(deviceId, deviceId, keep);
  }

  /** 最新的在最前面。 */
  deviceEvents(deviceId: string, limit = 200): DeviceEventRecord[] {
    return this.db
      .prepare("SELECT at, line FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT ?")
      .all(deviceId, limit)
      .map((row) => ({ at: Number(row["at"]), line: String(row["line"]) }));
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

  pushSubscriptions(deviceId?: string): PushSubscriptionRecord[] {
    const rows = deviceId
      ? this.db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at DESC").all(deviceId)
      : this.db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all();
    return rows.map((row) => ({
      endpoint: String(row["endpoint"]),
      deviceId: String(row["device_id"]),
      p256dh: String(row["p256dh"]),
      auth: String(row["auth"]),
      createdAt: Number(row["created_at"]),
    }));
  }

  savePushSubscription(record: PushSubscriptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           device_id = excluded.device_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth`,
      )
      .run(record.endpoint, record.deviceId, record.p256dh, record.auth, record.createdAt);
  }

  deletePushSubscription(endpoint: string, deviceId?: string): void {
    if (deviceId) {
      this.db
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?")
        .run(endpoint, deviceId);
      return;
    }
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  clearExpiredInvites(now = Date.now()): void {
    this.db.prepare("DELETE FROM invites WHERE expires_at < ?").run(now - 24 * 3600 * 1000);
  }

  /** Bridge 侧给非托管会话设置的显示名；没有覆盖时返回 null。 */
  sessionTitle(appId: string, sessionId: string): string | null {
    const row = this.db
      .prepare("SELECT title FROM session_titles WHERE app_id = ? AND session_id = ?")
      .get(appId, sessionId);
    return row ? String(row["title"]) : null;
  }

  setSessionTitle(appId: string, sessionId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO session_titles (app_id, session_id, title, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(app_id, session_id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at`,
      )
      .run(appId, sessionId, title, Date.now());
  }

  clearSessionTitle(appId: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM session_titles WHERE app_id = ? AND session_id = ?")
      .run(appId, sessionId);
  }

  hostName(): string {
    return this.meta("host_name") ?? hostname();
  }

  close(): void {
    this.db.close();
  }
}
