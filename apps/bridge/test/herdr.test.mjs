import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightedOption, keyPlan } from "../dist/adapters/herdr.js";

const PANE = [
  "│ 是否开工 ─────────────────────────────── │",
  "│ ❯ 1. 做最小版 supervisor（推荐）          │",
  "│   2. 暂不做，保持重放兜底                 │",
  "│   3. 先做原型验证                         │",
  "│ Enter to select · ↑/↓ to navigate         │",
].join("\n");

const LABELS = ["做最小版 supervisor（推荐）", "暂不做，保持重放兜底", "先做原型验证"];

test("高亮行认出当前选中的选项", () => {
  assert.equal(highlightedOption(PANE, LABELS), 0);
  const moved = PANE.replace("❯ 1.", "  1.").replace("   2.", "❯ 2.");
  assert.equal(highlightedOption(moved, LABELS), 1);
});

test("没有高亮行就返回 null，不瞎按", () => {
  assert.equal(highlightedOption("Enter to select", LABELS), null);
  assert.equal(highlightedOption(PANE, []), null);
});

test("标签互为前缀时取更长的那条", () => {
  const pane = "❯ 2. 合并 PR 并打标签";
  assert.equal(highlightedOption(pane, ["合并", "合并 PR 并打标签"]), 1);
});

test("按键计划按相对位置给上下键，最后 Enter", () => {
  assert.deepEqual(keyPlan(0, 2), ["down", "down", "enter"]);
  assert.deepEqual(keyPlan(2, 0), ["up", "up", "enter"]);
  assert.deepEqual(keyPlan(1, 1), ["enter"]);
});
