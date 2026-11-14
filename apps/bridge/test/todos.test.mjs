import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../dist/store.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "todos-"));
  return new Store(dir);
}

test("新加的待办排在未完成列表最前面", () => {
  const store = harness();
  const first = store.addTodo("先记一条", "feature");
  const second = store.addTodo("再记一条", "bug");
  const list = store.listTodos();
  assert.deepEqual(
    list.open.map((item) => item.todoId),
    [second.todoId, first.todoId],
  );
  assert.equal(list.open[0].kind, "bug");
  assert.equal(list.open[0].checkedAt, null);
  assert.equal(list.doneTotal, 0);
  store.close();
});

test("勾选后从待办移到最近完成，取消勾选再回来", () => {
  const store = harness();
  const item = store.addTodo("要修的问题", "bug");
  const done = store.setTodoChecked(item.todoId, true);
  assert.equal(typeof done.checkedAt, "number");

  let list = store.listTodos();
  assert.equal(list.open.length, 0);
  assert.equal(list.done.length, 1);
  assert.equal(list.doneTotal, 1);

  store.setTodoChecked(item.todoId, false);
  list = store.listTodos();
  assert.equal(list.open.length, 1);
  assert.equal(list.doneTotal, 0);
  store.close();
});

test("已完成只取最近几条，doneTotal 报总数", () => {
  const store = harness();
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(store.addTodo(`第 ${i} 条`, "other").todoId);
  for (const id of ids) store.setTodoChecked(id, true);

  const list = store.listTodos(3);
  assert.equal(list.done.length, 3);
  assert.equal(list.doneTotal, 7);
  // 最近勾选的排在前面
  assert.deepEqual(
    list.done.map((item) => item.todoId),
    [ids[6], ids[5], ids[4]],
  );
  store.close();
});

test("删除待办；找不到时返回 false/null", () => {
  const store = harness();
  const item = store.addTodo("临时", "other");
  assert.equal(store.removeTodo(item.todoId), true);
  assert.equal(store.removeTodo(item.todoId), false);
  assert.equal(store.setTodoChecked(item.todoId, true), null);
  assert.equal(store.listTodos().open.length, 0);
  store.close();
});

test("重开同一个库仍能读到待办（换前端不丢）", () => {
  const dir = mkdtempSync(join(tmpdir(), "todos-persist-"));
  const first = new Store(dir);
  const item = first.addTodo("重启后还在", "feature");
  first.close();

  const second = new Store(dir);
  const list = second.listTodos();
  assert.equal(list.open.length, 1);
  assert.equal(list.open[0].todoId, item.todoId);
  assert.equal(list.open[0].title, "重启后还在");
  second.close();
});
