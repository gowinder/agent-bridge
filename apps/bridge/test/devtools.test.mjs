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
    // 枚举闸门的基础根来自托管白名单，测试里没有托管会话。
    hostedDirs: () => ({ enabled: false, dirs: [], idleTimeoutMs: 0, permissionModes: [], allowBypassPermissions: false }),
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

test("binary files download as base64 instead of failing the preview", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  // 带 NUL 的假 PDF：文本通道认成二进制，下载通道要原样吐回来。
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0xff, 0x10]);
  writeFileSync(join(h.link, "doc.pdf"), bytes);
  await assert.rejects(
    () => h.devtools.readFile("s1", h.link, "doc.pdf"),
    (error) => error.code === "invalid_params",
  );
  const raw = await h.devtools.readFile("s1", h.link, "doc.pdf", true);
  assert.equal(raw.mime, "application/pdf");
  assert.equal(raw.truncated, false);
  assert.deepEqual(Buffer.from(raw.dataBase64, "base64"), bytes);
});

test("binary download refuses files past the single-message limit", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  writeFileSync(join(h.link, "big.zip"), Buffer.alloc(4 * 1024 * 1024, 1));
  await assert.rejects(
    () => h.devtools.readFile("s1", h.link, "big.zip", true),
    (error) => error.code === "invalid_params" && /太大/.test(error.message),
  );
});

test("binary download still needs the files capability", async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  writeFileSync(join(h.link, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
  h.store.setMeta("devtools_files_enabled", "0");
  // binary 只是换读取方式，不能当成绕过「文件浏览」开关的后门。
  await assert.rejects(
    () => h.devtools.readFile("s1", h.link, "doc.pdf", true),
    (error) => error.code === "unsupported",
  );
});
