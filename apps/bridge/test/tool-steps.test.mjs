import assert from "node:assert/strict";
import test from "node:test";

const { stepView } = await import("../../web/src/tool-steps.ts");

const block = (text) => ({ type: "tool", text });

test("`调用 bash {json}` 与 `Bash 命令` 两种写法都拆成动作 + 目标", () => {
  const json = stepView(block('调用 bash {"command":"cd /Users/x/proj && ls games"}'));
  assert.equal(json.label, "运行");
  assert.equal(json.detail, "cd /Users/x/proj && ls games");
  assert.match(json.body, /"command":/);

  const plain = stepView(block("Bash pwd; ls -la"));
  assert.equal(plain.label, "运行");
  assert.equal(plain.detail, "pwd; ls -la");
  assert.equal(plain.body, "pwd; ls -la");
});

test("读取/编辑/搜索/写入按各自的参数取目标", () => {
  assert.equal(stepView(block('调用 Read {"file_path":"/a/b/AGENTS.md"}')).detail, "/a/b/AGENTS.md");
  assert.equal(stepView(block('调用 Edit {"file_path":"/a/b/c.js","old_string":"x"}')).label, "编辑");
  assert.equal(stepView(block('调用 Grep {"pattern":"工人","path":"/a"}')).detail, "工人");
  assert.equal(stepView(block('调用 Write {"path":"/a/new.md","content":"hi"}')).label, "写入");
});

test("被截断的参数：值没有收尾引号，也能取到命令", () => {
  const view = stepView(block('调用 bash {"command":"cd /Users/x && node --test tests/siege'));
  assert.equal(view.label, "运行");
  assert.match(view.detail, /^cd \/Users\/x && node --test/);
  // 解析不了就得原样给，不能丢内容
  assert.match(view.body, /^\{/);
});

test("长命令留头部、长路径留尾部，最长 64 字", () => {
  const longCmd = stepView(block(`Bash ${"a".repeat(30)} ${"b".repeat(60)}`));
  assert.equal(longCmd.detail.length, 64);
  assert.ok(longCmd.detail.endsWith("…"));

  const longPath = `/Users/x/${"d".repeat(80)}/AGENTS.md`;
  const path = stepView(block(`调用 Read {"file_path":"${longPath}"}`));
  assert.equal(path.detail.length, 64);
  assert.ok(path.detail.startsWith("…"));
  assert.ok(path.detail.endsWith("AGENTS.md"));
});

test("MCP 工具名与不认识的工具：标签退回名字，取不到目标就只给标签", () => {
  const mcp = stepView(block("调用 mcp__ccd_session__list_sessions {\"limit\":10}"));
  assert.equal(mcp.label, "list sessions");
  assert.equal(mcp.detail, "");

  const custom = stepView(block('调用 my_custom_tool {"query":"找这个"}'));
  assert.equal(custom.detail, "找这个");
});

test("不是工具调用的文本原样保留", () => {
  const view = stepView(block("thinking through the problem"));
  assert.equal(view.label, "");
  assert.equal(view.detail, "thinking through the problem");
  assert.equal(view.body, "thinking through the problem");
});
