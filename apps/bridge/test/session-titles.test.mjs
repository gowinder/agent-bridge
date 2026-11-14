import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostedSessionManager } from "../dist/hosted/manager.js";
import { Store } from "../dist/store.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = { write: () => true, end: () => undefined };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.emit("exit", 0, null);
    return true;
  }
}

function storeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "session-titles-"));
  return { dir, store: new Store(dir) };
}

function hostedHarness() {
  const root = mkdtempSync(join(tmpdir(), "hosted-title-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "hosted.json"), JSON.stringify({ dirs: [repo], idleTimeoutMs: 60_000 }));
  const manager = new HostedSessionManager({ stateDir, spawn: () => new FakeChild() });
  return { root, repo, stateDir, manager };
}

test("store keeps per-app session title overrides until cleared", () => {
  const { store } = storeHarness();
  try {
    assert.equal(store.sessionTitle("claude-code", "claude-code:abc"), null);
    store.setSessionTitle("claude-code", "claude-code:abc", "我的会话");
    assert.equal(store.sessionTitle("claude-code", "claude-code:abc"), "我的会话");
    // 同名会话在不同来源下互不影响。
    assert.equal(store.sessionTitle("codex", "claude-code:abc"), null);
    store.setSessionTitle("claude-code", "claude-code:abc", "改过的名字");
    assert.equal(store.sessionTitle("claude-code", "claude-code:abc"), "改过的名字");
    store.clearSessionTitle("claude-code", "claude-code:abc");
    assert.equal(store.sessionTitle("claude-code", "claude-code:abc"), null);
  } finally {
    store.close();
  }
});

test("hosted rename trims the title and persists it to sessions.json", (t) => {
  const h = hostedHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  const renamed = h.manager.rename(session.sessionId, "  新标题  ");
  assert.equal(renamed.title, "新标题");
  assert.equal(renamed.originalTitle, undefined);

  const id = session.sessionId.replace("hosted:", "");
  const registry = JSON.parse(readFileSync(join(h.stateDir, "hosted", "sessions.json"), "utf8"));
  const saved = registry.sessions.find((item) => item.id === id);
  assert.ok(saved);
  assert.equal(saved.title, "新标题");
});

test("hosted rename rejects an empty title and caps the length at 60", (t) => {
  const h = hostedHarness();
  t.after(() => h.manager.dispose());
  const session = h.manager.create({ path: h.repo });
  assert.throws(
    () => h.manager.rename(session.sessionId, "   "),
    (error) => error.code === "invalid_params",
  );
  const long = "长".repeat(80);
  assert.equal(h.manager.rename(session.sessionId, long).title.length, 60);
});
