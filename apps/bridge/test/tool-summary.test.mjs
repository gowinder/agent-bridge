import assert from "node:assert/strict";
import test from "node:test";

const { toolSummaryOf } = await import("../dist/tool-summary.js");

test("对象和 JSON 字符串两种参数都能取到 description", () => {
  assert.equal(toolSummaryOf({ description: "List home directory", command: "ls" }), "List home directory");
  assert.equal(toolSummaryOf('{"description":"Checked status item registration"}'), "Checked status item registration");
});

test("Codex 的 justification 也认，顺序是 description 优先", () => {
  assert.equal(toolSummaryOf({ justification: "Run tests" }), "Run tests");
  assert.equal(toolSummaryOf({ description: "A", justification: "B" }), "A");
});

test("去掉换行、截断到 200 字；没有说明或参数坏掉时返回 undefined", () => {
  assert.equal(toolSummaryOf({ description: "line one\nline two" }), "line one line two");
  assert.equal(toolSummaryOf({ description: "x".repeat(300) })?.length, 200);
  assert.equal(toolSummaryOf({ command: "ls" }), undefined);
  assert.equal(toolSummaryOf("not json"), undefined);
  assert.equal(toolSummaryOf(undefined), undefined);
});
