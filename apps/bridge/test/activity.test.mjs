import assert from "node:assert/strict";
import { test } from "node:test";
import { describeActivity } from "../dist/sessions.js";

function request(method, params = {}) {
  return { v: 1, kind: "request", id: "1", method, params };
}

test("file browsing lands in the activity log with a readable path", () => {
  assert.equal(
    describeActivity(request("fs.list", { root: "/repo", path: "/repo/src" })),
    "浏览项目目录「/repo/src」",
  );
  assert.equal(describeActivity(request("fs.read", { root: "/repo", path: "/repo/README.md" })), "查看文件「/repo/README.md」");
  // 会话名要给上下文，不然日志里分不清是哪个会话在看文件。
  assert.match(describeActivity(request("fs.read", { root: "/repo", path: "/repo/a.ts", sessionId: "s1" })) ?? "", /会话/);
});

test("very long paths keep the tail, which is the part that identifies the file", () => {
  const long = `/repo/${"深".repeat(80)}/nested/deep/file.ts`;
  const line = describeActivity(request("fs.read", { root: "/repo", path: long })) ?? "";
  assert.ok(line.length < 90, line);
  assert.ok(line.includes("…"));
  assert.ok(line.includes("file.ts"));
});

test("polled methods stay out of the log", () => {
  for (const method of ["session.list", "message.list", "hosted.dirs", "host.info"]) {
    assert.equal(describeActivity(request(method)), null, method);
  }
});
