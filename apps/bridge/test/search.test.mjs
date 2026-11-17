import assert from "node:assert/strict";
import test from "node:test";

const { searchSessionTexts } = await import("../dist/sessions.js");

/** 一个按 sessionId 返回固定消息的假适配器；pages 用来验证分页拼接。 */
function fakeSource(table) {
  return {
    async messages(sessionId, params) {
      const pages = table[sessionId] ?? [];
      const page = params.before === undefined ? 0 : Number(params.before);
      const messages = pages[page] ?? [];
      const next = page + 1 < pages.length ? String(page + 1) : undefined;
      return {
        messages: messages.map((text, index) => ({
          messageId: `${sessionId}-${page}-${index}`,
          sessionId,
          role: "user",
          createdAt: 0,
          blocks: [{ type: "text", text }],
        })),
        completeness: "partial",
        ...(next ? { nextBefore: next } : {}),
      };
    },
  };
}

test("按对话正文匹配，且不区分大小写", async () => {
  const source = fakeSource({
    a: [["数据库连接池配置"]],
    b: [["CSS 折叠动画"]],
  });
  const result = await searchSessionTexts(source, "连接池", ["a", "b"]);
  assert.deepEqual(result.matches, ["a"]);
  assert.equal(result.searched, 2);
});

test("分词后要求全部命中，而且会翻页取更早的消息", async () => {
  const source = fakeSource({
    // 第 0 页是最新的一页，第 1 页更早；关键词只出现在更早那一页
    deep: [["最近在改样式"], ["旧的：webhook 重试两次后放弃"]],
  });
  const hit = await searchSessionTexts(source, "webhook 重试", ["deep"]);
  assert.deepEqual(hit.matches, ["deep"]);

  const miss = await searchSessionTexts(source, "webhook 超时", ["deep"]);
  assert.deepEqual(miss.matches, []);
});

test("读不到 transcript 的会话跳过，不影响其它会话", async () => {
  const source = {
    async messages(sessionId) {
      if (sessionId === "broken") throw new Error("boom");
      return {
        messages: [
          {
            messageId: "1",
            sessionId,
            role: "assistant",
            createdAt: 0,
            blocks: [{ type: "text", text: "部署脚本已经改好了" }],
          },
        ],
        completeness: "complete",
      };
    },
  };
  const result = await searchSessionTexts(source, "部署", ["broken", "ok"]);
  assert.deepEqual(result.matches, ["ok"]);
  assert.equal(result.searched, 1);
});

test("最老那一页的内容也能搜到（不只看尾部）", async () => {
  // 三页加起来六百多 KB：旧实现只留尾部 400KB，最老那页会被截掉
  const filler = "填充".repeat(50_000);
  const source = fakeSource({
    old: [["最近在改界面"], [`中间一大段：${filler}`], ["早期的决定：工人上限 200"]],
  });
  const result = await searchSessionTexts(source, "工人", ["old"]);
  assert.deepEqual(result.matches, ["old"]);
});

test("空关键词与重复 sessionId", async () => {
  const source = fakeSource({ x: [["hello world"]] });
  assert.deepEqual(await searchSessionTexts(source, "   ", ["x"]), { matches: [], searched: 0 });
  const dup = await searchSessionTexts(source, "hello", ["x", "x", "x"]);
  assert.deepEqual(dup.matches, ["x"]);
  assert.equal(dup.searched, 1);
});
