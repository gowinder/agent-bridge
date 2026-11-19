import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuplicateTagName, Store } from "../dist/store.js";

function harness() {
  return new Store(mkdtempSync(join(tmpdir(), "tags-")));
}

test("标签库按创建顺序，重名被挡住", () => {
  const store = harness();
  const first = store.saveTag({ name: "重要", color: "red" });
  const second = store.saveTag({ name: "待跟进", color: "blue" });
  assert.deepEqual(store.listTags(), [first, second]);
  assert.throws(() => store.saveTag({ name: "重要", color: "green" }), DuplicateTagName);
  // 改自己的名字不算重名。
  const renamed = store.saveTag({ tagId: first.tagId, name: "很急", color: "orange" });
  assert.deepEqual(renamed, { tagId: first.tagId, name: "很急", color: "orange" });
  assert.deepEqual(store.listTags(), [renamed, second]);
});

test("一个会话可以挂多个标签，整份替换", () => {
  const store = harness();
  const a = store.saveTag({ name: "a", color: "red" });
  const b = store.saveTag({ name: "b", color: "green" });
  store.setSessionTags("hosted", "s1", [a.tagId, b.tagId]);
  assert.deepEqual(
    store.sessionTags("hosted", "s1").map((tag) => tag.name),
    ["a", "b"],
  );
  // 重复 id 去重，换成只剩 b。
  store.setSessionTags("hosted", "s1", [b.tagId, b.tagId]);
  assert.deepEqual(
    store.sessionTags("hosted", "s1").map((tag) => tag.name),
    ["b"],
  );
  // 不同 app 的同名 sessionId 互不影响。
  assert.deepEqual(store.sessionTags("claude-code", "s1"), []);
});

test("不存在的标签 id 写不进去，删标签会断开所有会话", () => {
  const store = harness();
  const keep = store.saveTag({ name: "keep", color: "gray" });
  const gone = store.saveTag({ name: "gone", color: "purple" });
  store.setSessionTags("hosted", "s1", [keep.tagId, "missing", gone.tagId]);
  assert.equal(store.sessionTags("hosted", "s1").length, 2);

  const all = store.allSessionTags();
  assert.deepEqual(all.get("hosted\u0000s1")?.map((tag) => tag.name), ["keep", "gone"]);

  store.deleteTag(gone.tagId);
  assert.deepEqual(store.listTags(), [keep]);
  assert.deepEqual(
    store.sessionTags("hosted", "s1").map((tag) => tag.name),
    ["keep"],
  );
  assert.equal(store.allSessionTags().get("hosted\u0000s1")?.length, 1);
});

test("标签在重开数据库后还在", () => {
  const dir = mkdtempSync(join(tmpdir(), "tags-"));
  const first = new Store(dir);
  const tag = first.saveTag({ name: "持久", color: "yellow" });
  first.setSessionTags("hosted", "s1", [tag.tagId]);
  first.close?.();

  const again = new Store(dir);
  assert.deepEqual(again.listTags(), [tag]);
  assert.deepEqual(again.sessionTags("hosted", "s1"), [tag]);
});
