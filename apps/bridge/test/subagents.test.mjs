import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { subagentDirsFor, subagentTasks } from "../dist/subagents.js";
import { claudeTaskMessages } from "../dist/hosted/task-messages.js";

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

test("claude subagent transcript becomes task messages", () => {
  const f = fixture();
  addTask(f.subagents, "agent-d", { name: "reviewer" });
  const at = "2026-11-13T00:00:00.000Z";
  const lines = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "看下这个文件" }] }, timestamp: at },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "好" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
      timestamp: at,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "文件内容" }] }] },
      timestamp: at,
    },
    "{ 半行",
  ];
  writeFileSync(join(f.subagents, "agent-d.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const messages = claudeTaskMessages("cli-1", "agent-d", f.root);
  assert.deepEqual(
    messages.map((message) => [message.role, message.blocks.map((block) => block.type)]),
    [
      ["user", ["text"]],
      ["assistant", ["text", "tool"]],
      ["user", ["tool"]],
    ],
  );
  assert.equal(messages[1].blocks[1].text, '调用 Read {"file_path":"a.ts"}');
  assert.equal(messages[2].blocks[0].text, "文件内容");
  // taskId 只收 CLI 的子代理 id，路径拼接挡在外面。
  assert.equal(claudeTaskMessages("cli-1", "../../etc/passwd", f.root), null);
  assert.equal(claudeTaskMessages("cli-1", "agent-missing", f.root), null);
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
