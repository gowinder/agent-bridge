import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Devtools } from "../dist/devtools.js";
import { Store } from "../dist/store.js";

/**
 * 工程目录故意走一层符号链接：索引里存的是纯字符串归一后的 cwd（每几秒重建，
 * 不能 realpath 受保护目录），而 macOS 的临时目录本身就在 `/var` → `/private/var`
 * 这条链接下面，正好复现「realpath 后的子路径不以原字符串开头」的情况。
 */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ab-devtools-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "note.txt"), "hello");
  mkdirSync(join(project, "sub"), { recursive: true });
  writeFileSync(join(project, "sub", "inner.txt"), "inner");
  const link = join(dir, "link");
  symlinkSync(project, link);
  const store = new Store(join(dir, "state"));
  store.setMeta("devtools_files_enabled", "1");
  const adapters = {
    projects: async () => ({ projects: [{ projectId: "p1", name: "p", cwd: link }] }),
    session: async (id) => {
      if (id !== "s1") throw new Error("unknown session");
      return { session: { projectId: "p1", cwd: link } };
    },
  };
  const devtools = new Devtools(store, adapters, () => {});
  return { dir, link, store, devtools };
}

test("symbolic-linked project root still serves files and directories", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const file = await h.devtools.readFile("s1", h.link, "note.txt");
  assert.equal(file.text, "hello");
  const list = await h.devtools.listDirs("s1", h.link);
  assert.ok(list.entries.some((entry) => entry.name === "sub"));
  // 根目录自己不带 parent，子目录带。
  assert.equal(list.parent, null);
  const sub = await h.devtools.listDirs("s1", h.link, "sub");
  assert.ok(sub.entries.some((entry) => entry.name === "inner.txt"));
  assert.equal(sub.parent, list.path);
});

test("files capability still gates paths outside the project", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  h.store.setMeta("devtools_files_enabled", "0");
  await assert.rejects(
    () => h.devtools.readFile("s1", h.link, "note.txt"),
    (error) => error.code === "unsupported",
  );
  // 相对路径跳到项目外也必须拦住（越界判定与开关无关）。
  h.store.setMeta("devtools_files_enabled", "1");
  writeFileSync(join(h.dir, "outside.txt"), "secret");
  await assert.rejects(
    () => h.devtools.readFile("s1", h.link, "../outside.txt"),
    (error) => error.code === "unauthorized",
  );
});
