import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_ADMIN_PORT,
  PREVIEW_ADMIN_PORT,
  readAdminPortFile,
  resolveAdminPort,
  writeAdminPortFile,
} from "../dist/admin.js";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "admin-port-test-"));
}

function withoutEnv(fn) {
  const saved = {
    port: process.env["AGENT_BRIDGE_ADMIN_PORT"],
    env: process.env["AGENT_BRIDGE_ENV"],
  };
  delete process.env["AGENT_BRIDGE_ADMIN_PORT"];
  delete process.env["AGENT_BRIDGE_ENV"];
  try {
    return fn();
  } finally {
    if (saved.port !== undefined) process.env["AGENT_BRIDGE_ADMIN_PORT"] = saved.port;
    if (saved.env !== undefined) process.env["AGENT_BRIDGE_ENV"] = saved.env;
  }
}

test("preview and production get different default ports", () => {
  withoutEnv(() => {
    const dir = stateDir();
    assert.equal(resolveAdminPort(dir, { relayUrl: "https://agent-bridge.example.dev" }), DEFAULT_ADMIN_PORT);
    assert.equal(
      resolveAdminPort(dir, { relayUrl: "https://agent-bridge-preview.gowinder.workers.dev" }),
      PREVIEW_ADMIN_PORT,
    );
    assert.equal(resolveAdminPort(dir, { relayUrl: "https://staging.example.dev" }), PREVIEW_ADMIN_PORT);
  });
});

test("AGENT_BRIDGE_ENV overrides the relay-based default", () => {
  withoutEnv(() => {
    const dir = stateDir();
    process.env["AGENT_BRIDGE_ENV"] = "preview";
    assert.equal(resolveAdminPort(dir, { relayUrl: "https://agent-bridge.example.dev" }), PREVIEW_ADMIN_PORT);
    process.env["AGENT_BRIDGE_ENV"] = "production";
    assert.equal(
      resolveAdminPort(dir, { relayUrl: "https://agent-bridge-preview.gowinder.workers.dev" }),
      DEFAULT_ADMIN_PORT,
    );
  });
});

test("admin-port file wins over the environment default", () => {
  withoutEnv(() => {
    const dir = stateDir();
    writeAdminPortFile(dir, 50001);
    assert.equal(readAdminPortFile(dir), 50001);
    assert.equal(resolveAdminPort(dir, { relayUrl: "https://agent-bridge-preview.gowinder.workers.dev" }), 50001);
  });
});

test("AGENT_BRIDGE_ADMIN_PORT wins over the file", () => {
  withoutEnv(() => {
    const dir = stateDir();
    writeAdminPortFile(dir, 50001);
    process.env["AGENT_BRIDGE_ADMIN_PORT"] = "50002";
    assert.equal(resolveAdminPort(dir), 50002);
  });
});

test("invalid file contents fall back to the default", () => {
  withoutEnv(() => {
    const dir = stateDir();
    writeFileSync(join(dir, "admin-port"), "not-a-port\n");
    assert.equal(readAdminPortFile(dir), null);
    assert.equal(resolveAdminPort(dir), DEFAULT_ADMIN_PORT);
  });
});

test("writeAdminPortFile rejects out-of-range ports", () => {
  withoutEnv(() => {
    const dir = stateDir();
    assert.throws(() => writeAdminPortFile(dir, 0));
    assert.throws(() => writeAdminPortFile(dir, 70_000));
  });
});
