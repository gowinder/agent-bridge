import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sessionTokensOf,
  tokenUsageFromClaude,
  tokenUsageFromPi,
} from "../dist/context-usage.js";

test("claude and pi usage shapes both normalise to the same four numbers", () => {
  assert.deepEqual(
    tokenUsageFromClaude({
      input_tokens: 1200,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 300,
      output_tokens: 450,
    }),
    { input: 1200, cacheRead: 8000, cacheWrite: 300, output: 450 },
  );
  assert.deepEqual(
    tokenUsageFromPi({ input: 1200, cacheRead: 8000, cacheWrite: 300, output: 450 }),
    { input: 1200, cacheRead: 8000, cacheWrite: 300, output: 450 },
  );

  // 全零、坏值、会话级汇总（带 turns）都不算一次调用。
  assert.equal(tokenUsageFromClaude({ input_tokens: 0, output_tokens: 0 }), undefined);
  assert.equal(tokenUsageFromClaude("nope"), undefined);
  assert.equal(tokenUsageFromPi({ turns: 3, totalTokens: 900 }), undefined);
});

test("turns are cut at user messages and totals add up", () => {
  const usage = (input, cacheRead, cacheWrite, output) => ({ input, cacheRead, cacheWrite, output });
  const messages = [
    { messageId: "u1", role: "user", blocks: [] },
    { messageId: "a1", role: "assistant", blocks: [], usage: usage(100, 900, 0, 50) },
    { messageId: "a2", role: "assistant", blocks: [], usage: usage(20, 980, 0, 30) },
    { messageId: "u2", role: "user", blocks: [] },
    { messageId: "a3", role: "assistant", blocks: [], usage: usage(40, 1900, 0, 80) },
    // 没有用量的助手消息（例如纯工具调用）不产生回合。
    { messageId: "a4", role: "assistant", blocks: [] },
  ];
  const tokens = sessionTokensOf(messages);
  assert.equal(tokens.input, 160);
  assert.equal(tokens.cacheRead, 3780);
  assert.equal(tokens.output, 160);
  assert.deepEqual(
    tokens.turns.map((turn) => turn.messageId),
    ["u1", "u2"],
  );
  assert.deepEqual(tokens.turns[0].usage, usage(120, 1880, 0, 80));
  assert.deepEqual(tokens.turns[1].usage, usage(40, 1900, 0, 80));

  // 没有任何用量时返回 undefined，前端据此整块不显示。
  assert.equal(sessionTokensOf([{ messageId: "u1", role: "user", blocks: [] }]), undefined);
});

test("assistant messages with no preceding user message still form a turn", () => {
  const tokens = sessionTokensOf([
    { messageId: "a0", role: "assistant", blocks: [], usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 7 } },
  ]);
  assert.equal(tokens.input, 5);
  assert.equal(tokens.turns[0].messageId, "a0");
});
