import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { subagentDirsFor, subagentTasks } from "../dist/subagents.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subagents-test-"));
  const project = join(root, "-tmp-repo");
  const subagents = join(project, "cli-1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(project, "cli-1.jsonl"), "{}\n");
  return { root, subagents };
}

function addTask(subagents, taskId, meta, ageMs = 0) {
  writeFileSync(join(subagents, `${taskId}.meta.json`), JSON.stringify(meta));
  const jsonl = join(subagents, `${taskId}.jsonl`);
  writeFileSync(jsonl, "{}\n");
  if (ageMs > 0) {
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(jsonl, at, at);
    utimesSync(join(subagents, `${taskId}.meta.json`), at, at);
  }
}

test("subagent meta files under the CLI session become rail tasks", () => {
  const f = fixture();
  addTask(f.subagents, "agent-a", {
    name: "reviewer",
    description: "审查改动",
    agentType: "code-review",
    spawnDepth: 1,
    pickedEffortModel: "opus",
  });
  addTask(f.subagents, "agent-b", { description: "只给了描述" }, 60 * 60_000);

  assert.deepEqual(subagentDirsFor(["cli-1"], f.root), [f.subagents]);

  const tasks = subagentTasks(["cli-1"], 20, f.root);
  assert.equal(tasks.length, 2);
  const running = tasks.find((task) => task.taskId === "agent-a");
  assert.equal(running.status, "running");
  assert.equal(running.name, "reviewer");
  assert.equal(running.detail, "审查改动");
  assert.equal(running.agentType, "code-review");
  assert.equal(running.model, "opus");
  assert.equal(running.depth, 1);
  assert.equal(running.kind, "subagent");

  const stale = tasks.find((task) => task.taskId === "agent-b");
  assert.equal(stale.status, "done");
  assert.equal(stale.name, "只给了描述");
  assert.equal(stale.detail, undefined);
});

test("a finished subagent is done even when its files are fresh", () => {
  const f = fixture();
  addTask(f.subagents, "agent-c", { name: "done one", finished: true });
  const [task] = subagentTasks(["cli-1"], 20, f.root);
  assert.equal(task.status, "done");
});

test("unknown sessions and a missing projects dir yield no tasks", () => {
  const f = fixture();
  assert.deepEqual(subagentTasks(["nope"], 20, f.root), []);
  assert.deepEqual(subagentTasks([undefined], 20, join(f.root, "missing")), []);
});
