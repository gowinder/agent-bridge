import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalRelayUrl, migrateRelayUrls } from "../dist/relay-url.js";
import { Store } from "../dist/store.js";

test("旧预览中继地址改成自有域名，其余原样保留", () => {
  assert.equal(
    canonicalRelayUrl("https://agent-bridge-preview.gowinder.workers.dev"),
    "https://agent-bridge-preview.craftstead.app",
  );
  assert.equal(
    canonicalRelayUrl("https://agent-bridge-preview.gowinder.workers.dev/"),
    "https://agent-bridge-preview.craftstead.app",
  );
  assert.equal(
    canonicalRelayUrl("https://agent-bridge.craftstead.app"),
    "https://agent-bridge.craftstead.app",
  );
  assert.equal(canonicalRelayUrl(null), null);
  assert.equal(canonicalRelayUrl(""), "");
});

test("打开状态目录时改写旧的 relay_url 与 web_url", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-url-test-"));
  const legacy = "https://agent-bridge-preview.gowinder.workers.dev";
  const store = new Store(dir);
  store.setMeta("relay_url", legacy);
  store.setMeta("web_url", legacy);
  store.setMeta("room_id", "room-1");
  store.close();

  const reopened = new Store(dir);
  assert.equal(reopened.meta("relay_url"), "https://agent-bridge-preview.craftstead.app");
  assert.equal(reopened.meta("web_url"), "https://agent-bridge-preview.craftstead.app");
  assert.equal(reopened.meta("room_id"), "room-1");
  reopened.close();
});

test("migrateRelayUrls 报告是否改写", () => {
  const meta = new Map();
  const store = {
    meta: (key) => (meta.has(key) ? meta.get(key) : null),
    setMeta: (key, value) => meta.set(key, value),
  };
  meta.set("relay_url", "https://agent-bridge-preview.craftstead.app");
  assert.equal(migrateRelayUrls(store), false);

  meta.set("relay_url", "https://agent-bridge-preview.gowinder.workers.dev");
  assert.equal(migrateRelayUrls(store), true);
  assert.equal(meta.get("relay_url"), "https://agent-bridge-preview.craftstead.app");
  assert.equal(meta.has("web_url"), false);
});
