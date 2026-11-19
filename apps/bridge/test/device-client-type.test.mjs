import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../dist/store.js";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "device-client-type-"));
}

function device(overrides = {}) {
  return {
    id: "d1",
    name: "Chrome",
    publicKey: "aa",
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    lastSeenAt: null,
    clientType: "web",
    ...overrides,
  };
}

test("旧库没有 client_type 列：打开时补列，老设备读出来是 web", () => {
  const dir = stateDir();
  const legacy = new DatabaseSync(join(dir, "bridge.db"));
  legacy.exec(
    `CREATE TABLE devices (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       public_key TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER,
       revoked_at INTEGER,
       last_seen_at INTEGER
     )`,
  );
  legacy
    .prepare("INSERT INTO devices (id, name, public_key, created_at) VALUES (?, ?, ?, ?)")
    .run("old-1", "旧浏览器", "aa", 1);
  legacy.close();

  const store = new Store(dir);
  const rows = store.devices();
  assert.deepEqual(
    rows.map((row) => [row.id, row.clientType]),
    [["old-1", "web"]],
  );
  // 补列之后新设备照常写入，mcp 能读回。
  store.saveDevice(device({ id: "mcp-1", name: "MCP 客户端", clientType: "mcp" }));
  assert.equal(store.device("mcp-1")?.clientType, "mcp");
  assert.equal(store.device("old-1")?.clientType, "web");
  store.close();
});

test("新建设备默认按 web，显式 mcp 可读回", () => {
  const store = new Store(stateDir());
  store.saveDevice(device());
  store.saveDevice(device({ id: "d2", name: "MCP 客户端", clientType: "mcp" }));

  const byId = new Map(store.devices().map((row) => [row.id, row.clientType]));
  assert.deepEqual(byId.get("d1"), "web");
  assert.deepEqual(byId.get("d2"), "mcp");
  store.close();
});

test("库里的未知 client_type 归一成 web", () => {
  const store = new Store(stateDir());
  store.db
    .prepare(
      `INSERT INTO devices (id, name, public_key, created_at, client_type)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("weird-1", "未知客户端", "bb", 1, "terminal");

  assert.equal(store.device("weird-1")?.clientType, "web");
  assert.equal(store.devices()[0]?.clientType, "web");
  store.close();
});

test("重命名设备不丢 clientType", () => {
  const store = new Store(stateDir());
  store.saveDevice(device({ id: "mcp-1", clientType: "mcp" }));
  const target = store.device("mcp-1");
  assert.ok(target);
  store.saveDevice({ ...target, name: "改过名的 MCP 客户端" });

  const row = store.device("mcp-1");
  assert.equal(row?.name, "改过名的 MCP 客户端");
  assert.equal(row?.clientType, "mcp");
  store.close();
});
