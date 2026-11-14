import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { preparePiAgentDir } from "../dist/hosted/pi-agent-dir.js";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-dir-test-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "settings.json"), JSON.stringify({}));
  return { source, target };
}

test("sessions is linked whole and survives a rebuild", () => {
  const { source, target } = dirs();
  const sessions = join(source, "sessions", "--repo--");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s1.jsonl"), "{}\n");

  preparePiAgentDir(target, { model: "group/dsgroup" }, source);
  assert.ok(lstatSync(join(target, "sessions")).isSymbolicLink());

  // pi 经由这条链接写下的会话，实际落在源目录里。
  writeFileSync(join(target, "sessions", "--repo--", "s2.jsonl"), "{}\n");

  // 下一次启动会重建整个 agent 目录；会话不能跟着消失。
  preparePiAgentDir(target, { model: "group/dsgroup" }, source);
  assert.deepEqual(readdirSync(join(source, "sessions", "--repo--")).sort(), ["s1.jsonl", "s2.jsonl"]);
  assert.ok(lstatSync(join(target, "sessions")).isSymbolicLink());
});

test("sessions is created in the source when it does not exist yet", () => {
  const { source, target } = dirs();
  preparePiAgentDir(target, { thinking: "high" }, source);
  assert.ok(lstatSync(join(target, "sessions")).isSymbolicLink());
  assert.ok(existsSync(join(source, "sessions")));
});

test("sessions left as a real directory by older versions are moved back first", () => {
  const { source, target } = dirs();
  mkdirSync(join(target, "sessions", "--repo--"), { recursive: true });
  writeFileSync(join(target, "sessions", "--repo--", "old.jsonl"), "old\n");

  preparePiAgentDir(target, { model: "group/dsgroup" }, source);
  assert.ok(existsSync(join(source, "sessions", "--repo--", "old.jsonl")));
  assert.ok(lstatSync(join(target, "sessions")).isSymbolicLink());
});

test("missions and pi-subagents are linked whole as well", () => {
  const { source, target } = dirs();
  for (const name of ["missions", "pi-subagents"]) {
    mkdirSync(join(source, name), { recursive: true });
    writeFileSync(join(source, name, "entry.json"), "{}");
  }
  preparePiAgentDir(target, { reserveTokens: 250_000 }, source);
  for (const name of ["missions", "pi-subagents"]) {
    assert.ok(lstatSync(join(target, name)).isSymbolicLink());
    assert.ok(existsSync(join(source, name, "entry.json")));
  }
});

test("read-only resources stay as real directories", () => {
  const { source, target } = dirs();
  mkdirSync(join(source, "npm", "pkg"), { recursive: true });
  writeFileSync(join(source, "npm", "pkg", "index.js"), "export {};\n");
  preparePiAgentDir(target, { model: "group/dsgroup" }, source);
  // npm 必须是真的目录：pi 解析已安装的包时软链会被当成没装。
  assert.equal(lstatSync(join(target, "npm")).isSymbolicLink(), false);
  assert.ok(existsSync(join(target, "npm", "pkg", "index.js")));
});
